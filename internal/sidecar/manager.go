// Package sidecar owns the lifecycle of the Python child process that
// hosts imference_engine.Engine. Communication is JSON-lines over
// stdin/stdout (runqy-python's protocol — same wire format the cloud
// GPU workers under Runqy use). No HTTP, no port management.
//
//   Go → Python (stdin)  : {"task_id":"...","payload":{...}}
//   Python → Go (stdout) : {"task_id":"...","result":{...},"error":null,"retry":false}
//                          or {"status":"ready"}      (sent once after @load)
//                          or {"status":"error","error":"..."} (load failure)
//   Python → Go (stderr) : free-form logs, streamed live into logbus
package sidecar

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

const (
	readyTimeout     = 5 * time.Minute   // ~time to import torch + load engine
	stopGraceTimeout = 3 * time.Second
)

// StatusListener is invoked on every state transition. Manager keeps no
// reference to the wails runtime — the caller (app.go) wires the listener
// to runtime.EventsEmit so this package stays free of Wails deps and
// remains unit-testable.
type StatusListener func(types.SidecarStatus)

// Manager is goroutine-safe. The hot path (Send) takes stdinMu while
// writing a request line; readers fan out to per-task channels under
// pendingMu.
type Manager struct {
	scriptPath string
	logDir     string
	listener   StatusListener
	bus        *logbus.Bus

	mu     sync.RWMutex
	status types.SidecarStatus
	cmd    *exec.Cmd
	job    *jobObject // safety net — Windows kernel kill-on-job-close
	cancel context.CancelFunc

	stdin   io.WriteCloser
	stdinMu sync.Mutex // serialize writes

	pendingMu sync.Mutex
	pending   map[string]chan stdioResponse

	device atomic.Value // string, parsed from stderr's "ready on cuda:0 device"
}

type stdioRequest struct {
	TaskID  string `json:"task_id"`
	Payload any    `json:"payload"`
}

type stdioResponse struct {
	TaskID string          `json:"task_id"`
	Result json.RawMessage `json:"result"`
	Error  string          `json:"error"`
	Retry  bool            `json:"retry"`
	Status string          `json:"status"` // "ready" / "error" / "" for normal responses
}

// New builds an idle manager. scriptPath should point to sidecar/main.py.
// logDir is where sidecar.log gets written.
func New(scriptPath, logDir string, listener StatusListener, bus *logbus.Bus) *Manager {
	return &Manager{
		scriptPath: scriptPath,
		logDir:     logDir,
		listener:   listener,
		bus:        bus,
		status:     types.SidecarStatus{State: "idle"},
		pending:    make(map[string]chan stdioResponse),
	}
}

// Status returns a snapshot of the current state.
func (m *Manager) Status() types.SidecarStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

// Port is preserved as 0 on this transport — kept for frontend type
// compatibility, no longer meaningful with stdio.
func (m *Manager) Port() int { return 0 }

func (m *Manager) setStatus(next types.SidecarStatus) {
	m.mu.Lock()
	m.status = next
	m.mu.Unlock()
	level := logbus.LevelInfo
	if next.State == "error" {
		level = logbus.LevelError
	}
	m.bus.Publish(level, "sidecar", "state="+next.State, map[string]any{
		"device":  next.Device,
		"message": next.Message,
	})
	if m.listener != nil {
		m.listener(next)
	}
}

// Start spawns the sidecar using the given Python interpreter and SDXL
// weights path. Idempotent: a no-op if already starting or ready.
func (m *Manager) Start(parentCtx context.Context, pythonPath, sdxlPath string) error {
	if state := m.Status().State; state == "starting" || state == "ready" {
		return nil
	}
	if pythonPath == "" || sdxlPath == "" {
		m.setStatus(types.SidecarStatus{
			State:   "error",
			Message: "Settings incomplete: set Python path and SDXL weights path.",
		})
		return errors.New("sidecar: settings incomplete")
	}

	m.setStatus(types.SidecarStatus{State: "starting"})

	runCtx, cancel := context.WithCancel(parentCtx)
	cmd := exec.CommandContext(runCtx, pythonPath, m.scriptPath)
	cmd.Env = append(os.Environ(),
		"IMFERENCE_LOCAL_SDXL_PATH="+sdxlPath,
		"PYTHONUNBUFFERED=1", // critical so per-line writes flush immediately
	)
	cmd.SysProcAttr = hideWindowAttr()

	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		m.setStatus(types.SidecarStatus{State: "error", Message: "stdin pipe: " + err.Error()})
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		m.setStatus(types.SidecarStatus{State: "error", Message: "stdout pipe: " + err.Error()})
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cancel()
		m.setStatus(types.SidecarStatus{State: "error", Message: "stderr pipe: " + err.Error()})
		return err
	}

	if err := cmd.Start(); err != nil {
		cancel()
		m.setStatus(types.SidecarStatus{State: "error", Message: "spawn failed: " + err.Error()})
		return err
	}

	// Pin the child to a Job Object so a parent crash (Task Manager kill,
	// BSOD, etc.) reliably kills the python.exe too. No-op on non-Windows.
	job, jerr := newJobKillOnClose()
	if jerr != nil {
		m.bus.Warn("sidecar", "JobObject create failed; orphan-risk on parent crash", map[string]any{"err": jerr.Error()})
	} else if aerr := job.assign(cmd.Process.Pid); aerr != nil {
		m.bus.Warn("sidecar", "JobObject assign failed; orphan-risk", map[string]any{"err": aerr.Error()})
		job.close()
		job = nil
	}

	m.mu.Lock()
	m.cmd = cmd
	m.job = job
	m.cancel = cancel
	m.stdin = stdin
	m.mu.Unlock()

	// Three goroutines:
	//   1. stderr → logbus (forever, until pipe closes)
	//   2. stdout → dispatch (forever)
	//   3. process watcher → flips status to "error" on unexpected exit
	readyCh := make(chan stdioResponse, 1) // buffered so the reader never blocks
	go m.streamStderr(stderr)
	go m.readStdout(stdout, readyCh)
	exitDone := make(chan struct{})
	go m.watchExit(cmd, exitDone)

	// Wait for {"status":"ready"} or {"status":"error"} or timeout/exit.
	select {
	case msg := <-readyCh:
		if msg.Status == "ready" {
			m.setStatus(types.SidecarStatus{State: "ready", Device: m.currentDevice()})
			return nil
		}
		// "error" message from runqy_python's @load failure path.
		err := errors.New(msg.Error)
		_ = m.Stop()
		m.setStatus(types.SidecarStatus{State: "error", Message: err.Error()})
		return err
	case <-time.After(readyTimeout):
		err := fmt.Errorf("sidecar didn't become ready within %s", readyTimeout)
		_ = m.Stop()
		m.setStatus(types.SidecarStatus{State: "error", Message: err.Error()})
		return err
	case <-exitDone:
		err := errors.New("sidecar exited before becoming ready — see logs in the LogPanel")
		m.setStatus(types.SidecarStatus{State: "error", Message: err.Error()})
		return err
	case <-runCtx.Done():
		return runCtx.Err()
	}
}

// currentDevice returns the device string captured from stderr, or "unknown".
func (m *Manager) currentDevice() string {
	if v := m.device.Load(); v != nil {
		if s, ok := v.(string); ok && s != "" {
			return s
		}
	}
	return "unknown"
}

// Stop kills the running sidecar. Tries graceful shutdown first (close
// stdin → Python sees EOF and exits cleanly), falls back to the Job
// Object + SIGKILL after grace period.
func (m *Manager) Stop() error {
	m.mu.Lock()
	cmd := m.cmd
	job := m.job
	cancel := m.cancel
	stdin := m.stdin
	m.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		if m.Status().State != "error" {
			m.setStatus(types.SidecarStatus{State: "stopped"})
		}
		return nil
	}

	// Graceful: close stdin → for-loop in Python exits → process exits.
	if stdin != nil {
		_ = stdin.Close()
	}

	// Reap with grace period.
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()

	select {
	case <-done:
		// Clean exit, good.
	case <-time.After(stopGraceTimeout):
		// Nuclear: close the job (kernel kills child immediately on Windows),
		// then SIGKILL as backup.
		if job != nil {
			job.close()
		}
		_ = cmd.Process.Kill()
		<-done
	}

	if cancel != nil {
		cancel()
	}

	m.mu.Lock()
	m.cmd = nil
	m.cancel = nil
	m.stdin = nil
	if m.job != nil {
		m.job.close()
		m.job = nil
	}
	m.mu.Unlock()

	// Fail any in-flight requests so callers don't hang.
	m.failAllPending(errors.New("sidecar stopped"))

	if m.Status().State != "error" {
		m.setStatus(types.SidecarStatus{State: "stopped"})
	}
	return nil
}

func (m *Manager) Restart(ctx context.Context, pythonPath, sdxlPath string) error {
	_ = m.Stop()
	return m.Start(ctx, pythonPath, sdxlPath)
}

// ----------------------------------------------------------------------
// I/O goroutines
// ----------------------------------------------------------------------

// deviceLogRE captures the device from the sidecar's "Sidecar ready on
// cuda:0 device" log line, set in sidecar/main.py:setup(). Updates an
// atomic.Value so Status() can read it without locks.
var deviceLogRE = regexp.MustCompile(`Sidecar ready on (\S+) device`)

// streamStderr reads child stderr line by line and republishes into the
// logbus. Engine + Python logs ("Loading SDXL pipeline…", "BatchSizer:…",
// tracebacks) flow here unmodified — that's the point of switching off
// HTTP: the LogPanel sees engine internals for free.
func (m *Manager) streamStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		// Side-effect: sniff the device line so Status() can report it.
		if m.currentDevice() == "unknown" {
			if matches := deviceLogRE.FindStringSubmatch(line); matches != nil {
				m.device.Store(matches[1])
				// Promote to the SidecarStatus too, in case we're already "ready".
				if m.Status().State == "ready" {
					m.setStatus(types.SidecarStatus{State: "ready", Device: matches[1]})
				}
			}
		}
		m.bus.Trace("engine", line, nil)
	}
}

// readStdout reads JSON-lines from the child stdout. Dispatches by shape:
//   - {"status":"ready"} or {"status":"error",...} → send to readyCh
//     (only the first one matters; subsequent are dropped silently).
//   - {"task_id":"...","result":...} → look up pending channel, send,
//     remove from map.
//   - malformed lines → log a warning, keep going.
func (m *Manager) readStdout(r io.Reader, readyCh chan<- stdioResponse) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // big base64 PNGs
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		var resp stdioResponse
		if err := json.Unmarshal([]byte(line), &resp); err != nil {
			m.bus.Warn("sidecar", "malformed JSON on stdout", map[string]any{
				"line": truncate(line, 200),
				"err":  err.Error(),
			})
			continue
		}
		if resp.Status != "" {
			// Status messages don't have task_id — route to startup signal.
			select {
			case readyCh <- resp:
			default:
				// readyCh already drained; ignore late status messages.
			}
			continue
		}
		// Task response — dispatch to pending channel.
		m.pendingMu.Lock()
		ch, ok := m.pending[resp.TaskID]
		if ok {
			delete(m.pending, resp.TaskID)
		}
		m.pendingMu.Unlock()
		if !ok {
			m.bus.Warn("sidecar", "stdout response for unknown task_id", map[string]any{
				"task_id": resp.TaskID,
			})
			continue
		}
		ch <- resp
	}
	// Scanner ended (pipe closed). Fail all pending so callers unblock.
	if err := scanner.Err(); err != nil {
		m.bus.Warn("sidecar", "stdout scanner error", map[string]any{"err": err.Error()})
	}
	m.failAllPending(errors.New("sidecar stdout closed"))
}

// watchExit signals exitDone when the child terminates. Used by Start
// to abort the ready-wait if the process dies during boot, and to flip
// status to "error" if the process dies AFTER becoming ready.
func (m *Manager) watchExit(cmd *exec.Cmd, exitDone chan<- struct{}) {
	_, _ = cmd.Process.Wait()
	close(exitDone)
	state := m.Status().State
	if state == "starting" || state == "ready" {
		m.setStatus(types.SidecarStatus{
			State:   "error",
			Message: "sidecar exited unexpectedly — see logs in the LogPanel",
		})
		m.failAllPending(errors.New("sidecar exited unexpectedly"))
	}
}

// failAllPending drains the pending map, signaling all waiters with the
// given error so they don't hang forever. Safe to call multiple times.
func (m *Manager) failAllPending(err error) {
	m.pendingMu.Lock()
	defer m.pendingMu.Unlock()
	for id, ch := range m.pending {
		select {
		case ch <- stdioResponse{TaskID: id, Error: err.Error()}:
		default:
		}
		delete(m.pending, id)
	}
}

// ----------------------------------------------------------------------
// Send — the only outbound primitive. Used by client.go's Generate.
// ----------------------------------------------------------------------

// Send writes a JSON-line task request to the child's stdin and waits
// for the matching response (or ctx cancellation, or process death).
// Returns the raw result bytes — the caller is responsible for
// unmarshalling into a specific shape.
func (m *Manager) Send(ctx context.Context, payload any) (json.RawMessage, error) {
	m.mu.RLock()
	stdin := m.stdin
	m.mu.RUnlock()
	if stdin == nil {
		return nil, errors.New("sidecar: not running")
	}

	taskID, err := newTaskID()
	if err != nil {
		return nil, fmt.Errorf("sidecar: new task id: %w", err)
	}
	ch := make(chan stdioResponse, 1)
	m.pendingMu.Lock()
	m.pending[taskID] = ch
	m.pendingMu.Unlock()

	defer func() {
		m.pendingMu.Lock()
		delete(m.pending, taskID)
		m.pendingMu.Unlock()
	}()

	req := stdioRequest{TaskID: taskID, Payload: payload}
	buf, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("sidecar: marshal request: %w", err)
	}
	buf = append(buf, '\n')

	m.stdinMu.Lock()
	_, werr := stdin.Write(buf)
	m.stdinMu.Unlock()
	if werr != nil {
		return nil, fmt.Errorf("sidecar: stdin write: %w", werr)
	}

	select {
	case resp := <-ch:
		if resp.Error != "" {
			return nil, fmt.Errorf("sidecar: %s", resp.Error)
		}
		return resp.Result, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// newTaskID returns a 16-byte random hex string. Cheap, collision-free
// for our scale (≪ 2^64 in-flight requests at a time).
func newTaskID() (string, error) {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ----------------------------------------------------------------------
// Misc utilities
// ----------------------------------------------------------------------

func (m *Manager) openLog() (*os.File, error) {
	if err := os.MkdirAll(m.logDir, 0o755); err != nil {
		return nil, fmt.Errorf("sidecar: mkdir log dir: %w", err)
	}
	path := filepath.Join(m.logDir, "sidecar.log")
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, fmt.Errorf("sidecar: open log: %w", err)
	}
	fmt.Fprintf(f, "\n--- spawn @ %s ---\n", time.Now().Format(time.RFC3339))
	return f, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// Compile-time guard that syscall is still referenced (we don't use
// SIGTERM here — graceful shutdown is via stdin EOF — but keeping the
// import lets the JobObject path on Windows compile cleanly).
var _ = syscall.SIGTERM
