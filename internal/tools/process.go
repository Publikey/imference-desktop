package tools

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
)

// process is one running tools sidecar (sidecar/tools_main.py): the runqy
// stdio JSON-lines protocol, like internal/sidecar's Manager, minus everything
// generation-specific (model env, offload, tqdm parsing). A dead process is
// discarded and a new one started on the next use.
//
//	Go -> Python (stdin)  : {"task_id": "...", "payload": {...}}
//	Python -> Go (stdout) : {"task_id": "...", "result": {...}, "error": null}
//	                        or {"status": "ready"} / {"status": "error", "error": "..."}
//	Python -> Go (stderr) : logs, and "IMTOOL_PROGRESS {json}" progress lines
type process struct {
	bus        *logbus.Bus
	onProgress func(taskID, stage string, fraction float64)

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdinM sync.Mutex

	pendingMu sync.Mutex
	pending   map[string]chan stdioResponse
	exited    chan struct{} // closed when the child exits
	exitErr   error
}

type stdioRequest struct {
	TaskID  string `json:"task_id"`
	Payload any    `json:"payload"`
}

type stdioResponse struct {
	TaskID string          `json:"task_id"`
	Result json.RawMessage `json:"result"`
	Error  *string         `json:"error"`
	Status string          `json:"status"`
}

// ProgressPrefix marks a progress line on the sidecar's stderr.
const ProgressPrefix = "IMTOOL_PROGRESS "

// maxStdoutLine bounds one protocol line. Results only carry file paths, so
// this is generous; it matches the generation sidecar's reader.
const maxStdoutLine = 4 * 1024 * 1024

// startProcess spawns python script with env and waits for {"status":"ready"}.
func startProcess(ctx context.Context, python, script string, env []string, readyTimeout time.Duration,
	bus *logbus.Bus, onProgress func(string, string, float64)) (*process, error) {
	cmd := exec.Command(python, script)
	cmd.Env = env
	cmd.SysProcAttr = hideWindowAttr()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("tools: spawn %s: %w", python, err)
	}
	p := &process{
		bus: bus, onProgress: onProgress, cmd: cmd, stdin: stdin,
		pending: map[string]chan stdioResponse{}, exited: make(chan struct{}),
	}
	ready := make(chan stdioResponse, 1)
	stderrTail := &tailBuffer{max: 4096}
	var readers sync.WaitGroup
	readers.Add(2)
	go func() { defer readers.Done(); p.readStderr(stderr, stderrTail) }()
	go func() { defer readers.Done(); p.readStdout(stdout, ready) }()
	go func() {
		err := cmd.Wait()
		readers.Wait()
		p.exitErr = err
		close(p.exited)
		p.failAll(errors.New("tools sidecar exited"))
	}()

	timer := time.NewTimer(readyTimeout)
	defer timer.Stop()
	select {
	case msg := <-ready:
		if msg.Status == "ready" {
			return p, nil
		}
		p.kill()
		e := "tools sidecar failed to start"
		if msg.Error != nil && *msg.Error != "" {
			e = *msg.Error
		}
		return nil, errors.New(e)
	case <-p.exited:
		msg := "tools sidecar exited before becoming ready"
		if tail := strings.TrimSpace(stderrTail.String()); tail != "" {
			msg += ": " + lastLines(tail, 3)
		}
		return nil, errors.New(msg)
	case <-timer.C:
		p.kill()
		return nil, fmt.Errorf("tools sidecar not ready within %s", readyTimeout)
	case <-ctx.Done():
		p.kill()
		return nil, ctx.Err()
	}
}

func (p *process) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

// send writes one task and waits for its response.
func (p *process) send(ctx context.Context, payload any) (json.RawMessage, error) {
	if !p.alive() {
		return nil, errors.New("tools sidecar is not running")
	}
	var b [8]byte
	_, _ = rand.Read(b[:])
	id := hex.EncodeToString(b[:])
	ch := make(chan stdioResponse, 1)
	p.pendingMu.Lock()
	p.pending[id] = ch
	p.pendingMu.Unlock()
	defer func() {
		p.pendingMu.Lock()
		delete(p.pending, id)
		p.pendingMu.Unlock()
	}()
	line, err := json.Marshal(stdioRequest{TaskID: id, Payload: payload})
	if err != nil {
		return nil, err
	}
	p.stdinM.Lock()
	_, err = p.stdin.Write(append(line, '\n'))
	p.stdinM.Unlock()
	if err != nil {
		return nil, fmt.Errorf("tools sidecar stdin: %w", err)
	}
	select {
	case r := <-ch:
		if r.Error != nil && *r.Error != "" {
			return nil, errors.New(*r.Error)
		}
		return r.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// stop closes stdin (the runqy loop exits on EOF) and kills after grace.
func (p *process) stop(grace time.Duration) {
	_ = p.stdin.Close()
	select {
	case <-p.exited:
	case <-time.After(grace):
		p.kill()
	}
}

// kill terminates the child immediately (a running ONNX/torch call cannot be
// interrupted cooperatively).
func (p *process) kill() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.exited:
	case <-time.After(5 * time.Second):
	}
}

func (p *process) failAll(err error) {
	p.pendingMu.Lock()
	defer p.pendingMu.Unlock()
	msg := err.Error()
	for id, ch := range p.pending {
		select {
		case ch <- stdioResponse{TaskID: id, Error: &msg}:
		default:
		}
		delete(p.pending, id)
	}
}

func (p *process) readStdout(r io.Reader, ready chan<- stdioResponse) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), maxStdoutLine)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var resp stdioResponse
		if err := json.Unmarshal(line, &resp); err != nil {
			p.bus.Warn("tools", "malformed JSON on tools sidecar stdout", map[string]any{"line": truncate(string(line), 200)})
			continue
		}
		if resp.Status != "" {
			select {
			case ready <- resp:
			default:
			}
			continue
		}
		p.pendingMu.Lock()
		ch, ok := p.pending[resp.TaskID]
		delete(p.pending, resp.TaskID)
		p.pendingMu.Unlock()
		if ok {
			ch <- resp
		}
	}
	if err := sc.Err(); err != nil {
		p.bus.Warn("tools", "tools sidecar stdout error", map[string]any{"err": err.Error()})
	}
}

func (p *process) readStderr(r io.Reader, tail *tailBuffer) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		line := strings.TrimRight(sc.Text(), "\r")
		if line == "" {
			continue
		}
		if taskID, stage, frac, ok := ParseProgressLine(line); ok {
			if p.onProgress != nil {
				p.onProgress(taskID, stage, frac)
			}
			continue
		}
		tail.Write(line + "\n")
		p.bus.Trace("tools-engine", line, nil)
	}
}

// ParseProgressLine decodes an "IMTOOL_PROGRESS {json}" stderr line.
func ParseProgressLine(line string) (taskID, stage string, fraction float64, ok bool) {
	rest, found := strings.CutPrefix(line, ProgressPrefix)
	if !found {
		return "", "", 0, false
	}
	var ev struct {
		TaskID   string  `json:"task_id"`
		Stage    string  `json:"stage"`
		Fraction float64 `json:"fraction"`
	}
	if err := json.Unmarshal([]byte(rest), &ev); err != nil || ev.Stage == "" {
		return "", "", 0, false
	}
	return ev.TaskID, ev.Stage, ev.Fraction, true
}

// tailBuffer keeps the last max bytes written (the startup error message).
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (t *tailBuffer) Write(s string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, s...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

func lastLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return strings.Join(lines, " | ")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
