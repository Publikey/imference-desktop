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
	"bytes"
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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"imference-desktop-go/internal/gpu"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

const (
	readyTimeout = 5 * time.Minute // ~import torch + load engine (SDXL: ~365 MB base config/VAE from CDN)
	// readyTimeoutColdBase covers a first-time Z-Image load: register_model pulls
	// the shared base-components (~8–10 GB Qwen text-encoder + VAE) from the CDN
	// at load time, before the sidecar reports ready. Cached afterwards, so later
	// boots fall back to the short timeout. Download progress streams to the
	// LogPanel via the engine's stderr in the meantime.
	readyTimeoutColdBase = 30 * time.Minute
	stopGraceTimeout     = 3 * time.Second
)

// imageModelCDN mirrors the engine's image base-components (SDXL config + VAE,
// Z-Image tokenizer/text-encoder/VAE) so a cold load never touches
// huggingface.co. Wired into the sidecar as IMAGE_MODEL_CDN
// (RuntimeConfig.model_cdn): the engine reads <cdn>/<repo>/.manifest.json then
// pulls each file over plain HTTP. A developer can export IMAGE_MODEL_CDN before
// launch to point elsewhere — or set it empty to fall back to HuggingFace.
const imageModelCDN = "https://gen-models.ml-cnd-gen.cc/image"

// modelCacheDir is the persistent, symlink-free offline model tree the engine
// fills from the CDN (IMAGE_MODEL_CACHE / RuntimeConfig.model_cache_dir). Under
// UserCacheDir alongside the venv + downloaded weights — large, regenerable
// assets, not roamable user config.
func modelCacheDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate UserCacheDir: %w", err)
	}
	return filepath.Join(cache, "imference-desktop-go", "model-cache"), nil
}

// runtimeEnv translates the user's host-tuning settings into the engine's
// IMAGE_*/WAN_* env contract. It only emits a var when the user picked a
// meaningful (non-default, non-"auto") value, so anything left alone falls
// through to the engine's host-adaptive defaults — and there's no precedence
// fight with a developer's pre-set shell env.
func bool01(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// autoOffloadVRAMThresholdGiB: SDXL / Z-Image at full residency peak ~8.8 GiB at
// 1024². GPUs below this threshold oversubscribe VRAM and spill to WDDM shared
// system memory (measured ~50× slowdown on an 8 GiB card — 12 min vs 12 s for a
// 20-step run), so Auto mode enables enable_model_cpu_offload for them. Cards
// at/above it hold the whole pipe and are fastest at full residency, so Auto
// leaves offload off. 12 GiB keeps the common 6/8/10/11 GiB consumer cards safe
// while letting 12 GiB+ run full residency.
const autoOffloadVRAMThresholdGiB = 12.0

// resolveCPUOffload maps the tri-state offload setting to the sidecar's
// IMAGE_ENABLE_CPU_OFFLOAD value ("0"/"1") plus a human-readable reason for the
// log. An explicit *bool (user picked On/Off in Settings) always wins. nil =
// Auto: enable offload only on a discrete GPU (NVIDIA or AMD — both present as
// torch device "cuda") whose total VRAM is below the threshold — the case where
// full residency would spill and crawl. cpu/mps, or a GPU we can't measure,
// leaves it off (we never silently slow a machine we couldn't probe).
func resolveCPUOffload(setting *bool, device string) (value string, reason string) {
	if setting != nil {
		if *setting {
			return "1", "explicit On (Settings)"
		}
		return "0", "explicit Off (Settings)"
	}
	dev := strings.ToLower(strings.TrimSpace(device))
	if dev != "" && dev != "auto" && !strings.HasPrefix(dev, "cuda") {
		return "0", "Auto: device=" + dev + " (offload applies to CUDA/ROCm GPUs only)"
	}
	info := gpu.Detect(context.Background())
	if (info.Vendor != gpu.VendorNVIDIA && info.Vendor != gpu.VendorAMD) || info.VRAMGiB <= 0 {
		return "0", "Auto: VRAM undetectable (no NVIDIA/AMD probe succeeded) — leaving offload off"
	}
	g := strconv.FormatFloat(info.VRAMGiB, 'f', 1, 64)
	thr := strconv.FormatFloat(autoOffloadVRAMThresholdGiB, 'f', 0, 64)
	label := string(info.Vendor)
	if gib := info.VRAMGiB; gib < autoOffloadVRAMThresholdGiB {
		return "1", "Auto: " + g + " GiB VRAM (" + label + ") < " + thr +
			" GiB threshold — enabling offload to avoid VRAM spill"
	}
	return "0", "Auto: " + g + " GiB VRAM (" + label + ") ≥ " + thr + " GiB — full residency (offload off)"
}

// runtimeEnv builds the engine's env from the user's settings for the ACTIVE
// backend. SDXL and Z-Image both use the engine's IMAGE_* contract, but the
// desktop keeps a separate settings block for each — only one image backend
// loads per sidecar, so we emit IMAGE_* from the block matching `backend`.
func (m *Manager) runtimeEnv(rt types.EngineRuntimeSettings, backend string) []string {
	var env []string
	set := func(key, val string) {
		if v := strings.TrimSpace(val); v != "" && v != "auto" {
			env = append(env, key+"="+v)
		}
	}

	// One unified Image block drives every image backend (they share the engine's
	// IMAGE_* contract; only one loads per sidecar). UseTinyVAE only affects
	// SDXL/SD1.5 — the engine ignores it for the others, so emitting it is a no-op
	// there. cpuOffload is tri-state (*bool): nil = Auto.
	img := rt.Image
	device, maxGPU, maxCPU := img.Device, img.MaxGPUModels, img.MaxCPUModels
	cpuOffload := img.EnableCPUOffload
	tinyVAE := img.UseTinyVAE

	// Device + the two boolean perf knobs are emitted UNCONDITIONALLY (device as
	// auto|value, bools as explicit 0/1) so the UI is authoritative: a stray
	// IMAGE_* left in the launching shell would otherwise silently override the
	// toggles (e.g. IMAGE_ENABLE_CPU_OFFLOAD=1 forcing painfully slow gens).
	// Duplicate env keys resolve to the last value and ours is appended last.
	dev := strings.TrimSpace(device)
	if dev == "" {
		dev = "auto"
	}
	// Auto mode probes VRAM and may flip offload on for small cards — log the
	// decision so a surprised user can see WHY offload engaged (or didn't) in the
	// LogPanel. An explicit Settings toggle short-circuits the probe.
	offloadVal, offloadReason := resolveCPUOffload(cpuOffload, dev)
	if m.bus != nil {
		m.bus.Info("sidecar", "CPU offload — "+offloadReason,
			map[string]any{"backend": backend, "IMAGE_ENABLE_CPU_OFFLOAD": offloadVal})
	}
	env = append(env,
		"IMAGE_DEVICE="+dev,
		"IMAGE_USE_TINY_VAE="+bool01(tinyVAE),
		"IMAGE_ENABLE_CPU_OFFLOAD="+offloadVal,
	)
	set("MAX_GPU_MODELS", maxGPU)
	set("MAX_CPU_MODELS", maxCPU)

	// WAN video backend (applies once video is enabled).
	wan := rt.Wan
	set("WAN_DEVICE", wan.Device)
	set("WAN_PROFILE", wan.MemoryProfile)
	set("WAN_TEXT_ENCODER_QUANT", wan.TextEncoderQuant)
	set("WAN_MAX_RESIDENT", wan.MaxResident)
	// These two default to true in the engine — only forward an explicit disable.
	if wan.VAETiling != nil && !*wan.VAETiling {
		env = append(env, "WAN_VAE_TILING=false")
	}
	if wan.EnableOffload != nil && !*wan.EnableOffload {
		env = append(env, "WAN_ENABLE_OFFLOAD=false")
	}
	return env
}

// engineEnv wires the engine's CDN + offline-cache contract into the sidecar's
// environment. Each var is defaulted only when the launching environment hasn't
// already set it, so a developer can override (or disable, by exporting an empty
// value) without touching code.
func (m *Manager) engineEnv(env []string) []string {
	if _, ok := os.LookupEnv("IMAGE_MODEL_CDN"); !ok {
		env = append(env, "IMAGE_MODEL_CDN="+imageModelCDN)
	}
	if _, ok := os.LookupEnv("IMAGE_MODEL_CACHE"); !ok {
		if dir, err := modelCacheDir(); err != nil {
			m.bus.Warn("sidecar", "model cache dir unavailable; engine may re-fetch base-components each boot", map[string]any{"err": err.Error()})
		} else {
			env = append(env, "IMAGE_MODEL_CACHE="+dir)
		}
	}
	return env
}

// StatusListener is invoked on every state transition. Manager keeps no
// reference to the wails runtime — the caller (app.go) wires the listener
// to runtime.EventsEmit so this package stays free of Wails deps and
// remains unit-testable.
type StatusListener func(types.SidecarStatus)

// ProgressListener is invoked once per denoise step during a local generation
// (parsed from the engine's stderr progress bar). Wired by the caller (app.go)
// to a Wails event, same as StatusListener, so this package stays Wails-free.
type ProgressListener func(types.GenerateProgress)

// Manager is goroutine-safe. The hot path (Send) takes stdinMu while
// writing a request line; readers fan out to per-task channels under
// pendingMu.
type Manager struct {
	scriptPath string
	logDir     string
	listener   StatusListener
	progress   ProgressListener
	inferring  atomic.Bool // true between "Inference chunk" and the 100% step
	stopping   atomic.Bool // true during an intentional Stop, so watchExit doesn't cry "error"
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

// SetProgressListener wires per-step generation progress to the caller. Set once
// at startup, before any generation runs.
func (m *Manager) SetProgressListener(fn ProgressListener) { m.progress = fn }

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

// Start spawns the sidecar using the given Python interpreter and weights path.
// model carries the selected catalog entry so the right engine backend (SDXL vs
// Z-Image), its base-components repo, and the Z-Image shift are wired into the
// sidecar's environment. nil model → defaults to the SDXL backend.
// rt carries the host-machine tuning knobs (device, VAE mode, offload, residency
// caps, WAN quantization) the user set in Settings, forwarded as IMAGE_*/WAN_*
// env the engine reads via from_env. Zero value → engine defaults.
// Idempotent: a no-op if already starting or ready.
func (m *Manager) Start(parentCtx context.Context, pythonPath, sdxlPath string, model *types.ModelInfo, rt types.EngineRuntimeSettings) error {
	if state := m.Status().State; state == "starting" || state == "ready" {
		return nil
	}
	if m.scriptPath == "" {
		m.setStatus(types.SidecarStatus{
			State:   "error",
			Message: "Local engine not available in this build (sidecar script missing).",
		})
		return errors.New("sidecar: script path not set")
	}
	if pythonPath == "" || sdxlPath == "" {
		m.setStatus(types.SidecarStatus{
			State:   "error",
			Message: "Settings incomplete: set Python path and SDXL weights path.",
		})
		return errors.New("sidecar: settings incomplete")
	}

	m.stopping.Store(false) // fresh launch — a later exit is unexpected again
	m.setStatus(types.SidecarStatus{State: "starting"})

	runCtx, cancel := context.WithCancel(parentCtx)
	cmd := exec.CommandContext(runCtx, pythonPath, m.scriptPath)
	backend := "sdxl"
	var baseModel string
	var shift float64
	if model != nil {
		if model.BackendType != "" {
			backend = model.BackendType
		}
		baseModel = model.BaseModel
		shift = model.ShiftDefault
	}
	env := append(os.Environ(),
		"IMFERENCE_LOCAL_SDXL_PATH="+sdxlPath,
		"IMFERENCE_LOCAL_BACKEND="+backend,
		"PYTHONUNBUFFERED=1", // critical so per-line writes flush immediately
	)
	if baseModel != "" {
		env = append(env, "IMFERENCE_LOCAL_BASE_MODEL="+baseModel)
	}
	if shift > 0 {
		env = append(env, fmt.Sprintf("IMFERENCE_BACKEND_SHIFT=%g", shift))
	}
	env = append(env, m.runtimeEnv(rt, backend)...)
	cmd.Env = m.engineEnv(env)

	// A configured base_model (Z-Image) pulls a large shared base at register
	// time on the first load, so allow a much longer ready window. Cheap on warm
	// boots — the engine returns from cache well before this fires.
	readyWait := readyTimeout
	if baseModel != "" {
		readyWait = readyTimeoutColdBase
	}
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
	case <-time.After(readyWait):
		err := fmt.Errorf("sidecar didn't become ready within %s", readyWait)
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
	// Mark the stop intentional *before* the process can exit, so watchExit
	// treats the imminent termination as expected (not a crash → "error").
	// Reset by the next Start().
	m.stopping.Store(true)

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

func (m *Manager) Restart(ctx context.Context, pythonPath, sdxlPath string, model *types.ModelInfo, rt types.EngineRuntimeSettings) error {
	_ = m.Stop()
	return m.Start(ctx, pythonPath, sdxlPath, model, rt)
}

// ----------------------------------------------------------------------
// I/O goroutines
// ----------------------------------------------------------------------

// deviceLogRE captures the device from the sidecar's "Sidecar ready on
// cuda:0 device" log line, set in sidecar/main.py:setup(). Updates an
// atomic.Value so Status() can read it without locks.
var deviceLogRE = regexp.MustCompile(`Sidecar ready on (\S+) device`)

// tqdmRE parses a tqdm progress bar line, e.g. " 45%|████▌ | 9/20 [04:52<05:57,
// 32.5s/it]" -> percent=45, step=9, total=20. The engine's denoise loop (and its
// component loaders) render these to stderr with carriage returns.
var tqdmRE = regexp.MustCompile(`(\d+)%\|[^|]*\|\s*(\d+)/(\d+)`)

// scanLinesOrCR splits on either '\n' or '\r' so tqdm's in-place redraws (which
// use '\r', not '\n') surface as individual tokens instead of one giant line
// that only flushes at the end. Empty tokens (from "\r\n") are dropped by the
// caller's blank-line check.
func scanLinesOrCR(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.IndexAny(data, "\r\n"); i >= 0 {
		return i + 1, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil // need more data
}

// streamStderr reads child stderr and republishes into the logbus. Engine +
// Python logs ("Loading SDXL pipeline…", "BatchSizer:…", tracebacks) flow here
// unmodified — that's the point of switching off HTTP: the LogPanel sees engine
// internals for free. Denoise progress-bar redraws are intercepted and turned
// into "generate:progress" events instead of spamming the log.
func (m *Manager) streamStderr(r io.Reader) {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	scanner.Split(scanLinesOrCR)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		// The engine logs "Inference chunk 1-1/1 …" right before the denoise
		// loop — gate progress parsing on it so the earlier component/fetch
		// progress bars don't drive the UI's step counter.
		if strings.Contains(line, "Inference chunk") {
			m.inferring.Store(true)
		}
		if m.inferring.Load() {
			if pm := tqdmRE.FindStringSubmatch(line); pm != nil {
				pct, _ := strconv.Atoi(pm[1])
				step, _ := strconv.Atoi(pm[2])
				total, _ := strconv.Atoi(pm[3])
				if m.progress != nil {
					m.progress(types.GenerateProgress{Step: step, Total: total, Percent: pct})
				}
				if total > 0 && step >= total {
					m.inferring.Store(false)
				}
				continue // don't log every redraw
			}
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
	// An intentional Stop() closes stdin → the child exits cleanly; that's not a
	// crash, so don't flip to "error" (Stop sets its own "stopped" status).
	if !m.stopping.Load() && (state == "starting" || state == "ready") {
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
