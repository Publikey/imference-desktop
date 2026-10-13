package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
)

// LaunchConfig is how to start the tools sidecar. Resolved at each start (the
// Python path changes when the engine is (re)installed).
type LaunchConfig struct {
	Python string   // the engine venv interpreter
	Script string   // sidecar/tools_main.py
	Env    []string // full environment (os.Environ() + TOOLS_* / IMFERENCE_TOOLS_DEVICE)
}

// Progress is one "tools:progress" event.
type Progress struct {
	JobID    string  `json:"jobId"`
	ToolID   string  `json:"toolId"`
	Stage    string  `json:"stage"` // starting | downloading_weights | loading | running | encoding | uploading | queued | downloading
	Fraction float64 `json:"fraction"`
}

// EngineRequest is one local run, in the engine's terms.
type EngineRequest struct {
	JobID     string
	ToolID    string
	Inputs    map[string]any // name -> path, or []string for multiple inputs
	Params    map[string]any
	OutputDir string
	Device    string // "" = the sidecar's default (IMFERENCE_TOOLS_DEVICE / auto)
}

// EngineResult mirrors ToolResult.to_dict().
type EngineResult struct {
	ToolID      string         `json:"tool_id"`
	ToolVersion string         `json:"tool_version"`
	Outputs     []EngineOutput `json:"outputs"`
	Params      map[string]any `json:"params"`
	DurationMs  int64          `json:"duration_ms"`
	Runtime     string         `json:"runtime"`
	Stages      []string       `json:"stages"`
}

type EngineOutput struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Format string `json:"format"`
	Path   string `json:"path"`
	Text   string `json:"text,omitempty"`
	Data   any    `json:"data,omitempty"`
	Width  int    `json:"width,omitempty"`
	Height int    `json:"height,omitempty"`
}

// Seed returns data.seed for the generation tools (0 when absent).
func (o EngineOutput) Seed() int {
	if m, ok := o.Data.(map[string]any); ok {
		if f, ok := m["seed"].(float64); ok {
			return int(f)
		}
	}
	return 0
}

// DecodeRunResult decodes {"ok": true, "result": ...} / {"ok": false, "error": ...}
// (tools sidecar) or {"tool": ...} / {"tool_error": ...} (generation sidecar).
func DecodeRunResult(raw json.RawMessage) (*EngineResult, *Error) {
	var env struct {
		OK        *bool           `json:"ok"`
		Result    json.RawMessage `json:"result"`
		Error     json.RawMessage `json:"error"`
		Tool      json.RawMessage `json:"tool"`
		ToolError json.RawMessage `json:"tool_error"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, &Error{Code: CodeInternal, Message: "unreadable tool result: " + err.Error()}
	}
	body := env.Result
	switch {
	case len(env.ToolError) > 0 && string(env.ToolError) != "null":
		return nil, parseEngineError(env.ToolError)
	case len(env.Tool) > 0 && string(env.Tool) != "null":
		body = env.Tool
	case env.OK != nil && !*env.OK:
		return nil, parseEngineError(env.Error)
	}
	var res EngineResult
	if err := json.Unmarshal(body, &res); err != nil || res.ToolID == "" {
		return nil, &Error{Code: CodeInternal, Message: "tool returned no result"}
	}
	return &res, nil
}

// Manager owns the tools sidecar: started lazily on the first local run,
// serialized (one tool at a time — the runqy loop is single-threaded), models
// released and the process stopped after IdleTimeout without use.
type Manager struct {
	bus        *logbus.Bus
	launch     func() (LaunchConfig, error)
	onProgress func(Progress)

	// IdleTimeout stops the sidecar after this long unused (models released
	// first). 0 disables the idle stop.
	IdleTimeout  time.Duration
	ReadyTimeout time.Duration

	sem chan struct{} // run slot: one op at a time

	mu        sync.Mutex
	proc      *process
	idle      *time.Timer
	jobID     string // the job currently running
	toolID    string
	cancelled map[string]bool
	probe     *Probe
}

// NewManager builds an idle manager. launch resolves the interpreter + script
// + env at each start; onProgress receives every stage update (may be nil).
func NewManager(bus *logbus.Bus, launch func() (LaunchConfig, error), onProgress func(Progress)) *Manager {
	return &Manager{
		bus: bus, launch: launch, onProgress: onProgress,
		IdleTimeout: 10 * time.Minute, ReadyTimeout: 2 * time.Minute,
		sem: make(chan struct{}, 1), cancelled: map[string]bool{},
	}
}

func (m *Manager) emit(p Progress) {
	if m.onProgress != nil {
		m.onProgress(p)
	}
}

// acquire takes the run slot (or gives up with ctx).
func (m *Manager) acquire(ctx context.Context) error {
	select {
	case m.sem <- struct{}{}:
		m.mu.Lock()
		if m.idle != nil {
			m.idle.Stop()
		}
		m.mu.Unlock()
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (m *Manager) releaseSlot() {
	<-m.sem
	m.armIdle()
}

func (m *Manager) armIdle() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.IdleTimeout <= 0 || m.proc == nil {
		return
	}
	if m.idle != nil {
		m.idle.Stop()
	}
	m.idle = time.AfterFunc(m.IdleTimeout, m.idleStop)
}

// idleStop frees the models then stops the process, unless a run started.
func (m *Manager) idleStop() {
	select {
	case m.sem <- struct{}{}:
	default:
		return // busy: the run re-arms the timer when it ends
	}
	defer func() { <-m.sem }()
	m.mu.Lock()
	p := m.proc
	m.proc = nil
	m.mu.Unlock()
	if p == nil {
		return
	}
	m.bus.Info("tools", "tools sidecar idle — releasing models and stopping", nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	_, _ = p.send(ctx, map[string]any{"op": "release"})
	cancel()
	p.stop(3 * time.Second)
}

// ensure starts the sidecar when it isn't running. Caller holds the slot.
func (m *Manager) ensure(ctx context.Context, jobID, toolID string) (*process, error) {
	m.mu.Lock()
	p := m.proc
	m.mu.Unlock()
	if p != nil && p.alive() {
		return p, nil
	}
	cfg, err := m.launch()
	if err != nil {
		return nil, &Error{Code: CodeUnsupportedRuntime, Message: err.Error()}
	}
	if jobID != "" {
		m.emit(Progress{JobID: jobID, ToolID: toolID, Stage: "starting"})
	}
	m.bus.Info("tools", "starting tools sidecar", map[string]any{"python": cfg.Python, "script": cfg.Script})
	p, err = startProcess(ctx, cfg.Python, cfg.Script, cfg.Env, m.ReadyTimeout, m.bus, m.onEngineProgress)
	if err != nil {
		m.bus.Error("tools", "tools sidecar failed to start", map[string]any{"err": err.Error()})
		return nil, &Error{Code: CodeUnsupportedRuntime, Message: err.Error()}
	}
	m.mu.Lock()
	m.proc = p
	m.mu.Unlock()
	// Probe once per start: the badges switch from guesses to facts.
	pctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	if raw, perr := p.send(pctx, map[string]any{"op": "probe"}); perr == nil {
		var pr Probe
		if json.Unmarshal(raw, &pr) == nil {
			m.mu.Lock()
			m.probe = &pr
			m.mu.Unlock()
			m.bus.Info("tools", "tools runtime probed", map[string]any{"providers": pr.Providers, "ffmpeg": pr.FFmpeg, "torch": pr.TorchDevice})
		}
	}
	cancel()
	return p, nil
}

// onEngineProgress forwards the sidecar's progress lines (task_id = job id).
func (m *Manager) onEngineProgress(jobID, stage string, frac float64) {
	m.mu.Lock()
	toolID := ""
	if jobID == m.jobID {
		toolID = m.toolID
	}
	m.mu.Unlock()
	m.emit(Progress{JobID: jobID, ToolID: toolID, Stage: stage, Fraction: frac})
}

// Run executes one tool locally and waits for it.
func (m *Manager) Run(ctx context.Context, req EngineRequest) (*EngineResult, *Error) {
	if err := m.acquire(ctx); err != nil {
		return nil, &Error{Code: CodeCancelled, Message: err.Error()}
	}
	defer m.releaseSlot()
	m.mu.Lock()
	if m.cancelled[req.JobID] {
		delete(m.cancelled, req.JobID)
		m.mu.Unlock()
		return nil, &Error{Code: CodeCancelled, Message: "cancelled"}
	}
	m.jobID, m.toolID = req.JobID, req.ToolID
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.jobID, m.toolID = "", ""
		delete(m.cancelled, req.JobID)
		m.mu.Unlock()
	}()

	p, err := m.ensure(ctx, req.JobID, req.ToolID)
	if err != nil {
		return nil, AsError(err)
	}
	payload := map[string]any{
		"op": "run", "job_id": req.JobID, "tool_id": req.ToolID,
		"inputs": req.Inputs, "params": req.Params, "output_dir": req.OutputDir,
	}
	if req.Device != "" {
		payload["device"] = req.Device
	}
	start := time.Now()
	raw, serr := p.send(ctx, payload)
	if serr != nil {
		m.mu.Lock()
		wasCancelled := m.cancelled[req.JobID]
		m.mu.Unlock()
		if wasCancelled || errors.Is(serr, context.Canceled) {
			return nil, &Error{Code: CodeCancelled, Message: "cancelled"}
		}
		m.bus.Error("tools", "tool run failed", map[string]any{"tool": req.ToolID, "err": serr.Error()})
		return nil, &Error{Code: CodeInternal, Message: serr.Error()}
	}
	res, terr := DecodeRunResult(raw)
	if terr != nil {
		m.bus.Warn("tools", "tool error", map[string]any{"tool": req.ToolID, "code": terr.Code, "msg": terr.Message})
		return nil, terr
	}
	m.bus.Info("tools", "tool done", map[string]any{"tool": req.ToolID, "runtime": res.Runtime, "duration": time.Since(start).String()})
	return res, nil
}

// Cancel stops jobID: a queued run never starts, a running one is killed with
// its process (a running ONNX/torch call cannot be interrupted any other way;
// the next run starts a fresh sidecar). Returns whether the job was known.
func (m *Manager) Cancel(jobID string) bool {
	m.mu.Lock()
	m.cancelled[jobID] = true
	running := m.jobID == jobID
	p := m.proc
	if running {
		m.proc = nil
	}
	m.mu.Unlock()
	if running && p != nil {
		m.bus.Info("tools", "cancelling tool run — killing the tools sidecar", map[string]any{"job": jobID})
		p.kill()
	}
	return running
}

// Release frees the warm models (ONNX sessions, Florence-2) without stopping
// the process. No-op when the sidecar isn't running.
func (m *Manager) Release(ctx context.Context) error {
	m.mu.Lock()
	p := m.proc
	m.mu.Unlock()
	if p == nil || !p.alive() {
		return nil
	}
	if err := m.acquire(ctx); err != nil {
		return err
	}
	defer m.releaseSlot()
	_, err := p.send(ctx, map[string]any{"op": "release"})
	return err
}

// ProbeNow starts the sidecar if needed and returns a fresh probe.
func (m *Manager) ProbeNow(ctx context.Context) (*Probe, error) {
	if err := m.acquire(ctx); err != nil {
		return nil, err
	}
	defer m.releaseSlot()
	if _, err := m.ensure(ctx, "", ""); err != nil {
		return nil, err
	}
	return m.CachedProbe(), nil
}

// CachedProbe returns the last probe (nil before the first start).
func (m *Manager) CachedProbe() *Probe {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.probe
}

// Running reports whether the sidecar process is up.
func (m *Manager) Running() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.proc != nil && m.proc.alive()
}

// Stop releases models and stops the process now (app shutdown).
func (m *Manager) Stop() {
	m.mu.Lock()
	p := m.proc
	m.proc = nil
	if m.idle != nil {
		m.idle.Stop()
	}
	m.mu.Unlock()
	if p == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, _ = p.send(ctx, map[string]any{"op": "release"})
	p.stop(2 * time.Second)
}

// String is for logs.
func (r EngineRequest) String() string { return fmt.Sprintf("%s(%s)", r.ToolID, r.JobID) }
