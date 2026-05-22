// Package sidecar owns the lifecycle of the Python FastAPI sidecar that
// wraps imference_engine.Engine. Equivalent of src/main/sidecar.ts in the
// Electron POC, but idiomatic Go: every blocking operation is
// context-aware, status broadcasts go through a callback that the App layer
// wires to wails runtime.EventsEmit.
package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

const (
	healthPollInterval = 250 * time.Millisecond
	healthTimeout      = 30 * time.Second
	stopGraceTimeout   = 3 * time.Second
)

// StatusListener is invoked on every state transition. Manager keeps no
// reference to the wails runtime — the caller (app.go) wires the listener
// to runtime.EventsEmit so this package stays free of Wails deps and
// remains unit-testable.
type StatusListener func(types.SidecarStatus)

// Manager is goroutine-safe. The only piece of mutable state is `status`
// and the in-flight `cmd`; both live under `mu`.
type Manager struct {
	scriptPath string
	logDir     string
	listener   StatusListener
	bus        *logbus.Bus

	mu     sync.RWMutex
	status types.SidecarStatus
	cmd    *exec.Cmd
	job    *jobObject         // Windows Job Object — kills the child if parent dies any way
	cancel context.CancelFunc // cancels the per-run context (kills the process)
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
	}
}

// Status returns a snapshot of the current state.
func (m *Manager) Status() types.SidecarStatus {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.status
}

// Port is a convenience for the generation path; returns 0 if not ready.
func (m *Manager) Port() int {
	s := m.Status()
	if s.State != "ready" {
		return 0
	}
	return s.Port
}

func (m *Manager) setStatus(next types.SidecarStatus) {
	m.mu.Lock()
	m.status = next
	m.mu.Unlock()
	level := logbus.LevelInfo
	if next.State == "error" {
		level = logbus.LevelError
	}
	m.bus.Publish(level, "sidecar", "state="+next.State, map[string]any{
		"port":    next.Port,
		"device":  next.Device,
		"message": next.Message,
	})
	if m.listener != nil {
		m.listener(next)
	}
}

// Start spawns the sidecar using the given Python interpreter and SDXL
// weights path. Idempotent: a no-op if already starting or ready. The
// caller should call Stop first to force a restart.
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

	port, err := freePort()
	if err != nil {
		m.setStatus(types.SidecarStatus{State: "error", Message: err.Error()})
		return err
	}
	m.setStatus(types.SidecarStatus{State: "starting", Port: port})

	runCtx, cancel := context.WithCancel(parentCtx)
	cmd := exec.CommandContext(runCtx, pythonPath, m.scriptPath)
	cmd.Env = append(os.Environ(),
		"IMFERENCE_LOCAL_SDXL_PATH="+sdxlPath,
		"IMFERENCE_SIDECAR_PORT="+strconv.Itoa(port),
		"IMFERENCE_SIDECAR_HOST=127.0.0.1",
		"PYTHONUNBUFFERED=1",
	)
	cmd.SysProcAttr = hideWindowAttr()

	logFile, err := m.openLog()
	if err != nil {
		cancel()
		m.setStatus(types.SidecarStatus{State: "error", Message: err.Error()})
		return err
	}
	cmd.Stdout = logFile
	cmd.Stderr = logFile

	if err := cmd.Start(); err != nil {
		cancel()
		_ = logFile.Close()
		m.setStatus(types.SidecarStatus{State: "error", Message: "spawn failed: " + err.Error()})
		return err
	}

	// Pin the child to a Windows Job Object with KillOnJobClose. Two reasons:
	//   1. If wails dev dies any way (Ctrl+C, X button, Task Manager hard
	//      kill, crash, BSOD), the kernel auto-closes our handles, the
	//      job-close flag fires, and the python.exe is gone within ms — no
	//      more 7 GB orphans grinding through inference after we're dead.
	//   2. Our own Stop() can rely on `job.close()` instead of poking with
	//      SIGTERM (a no-op on Windows) and then Kill (which works but skips
	//      the job's clean teardown).
	// No-op on non-Windows. If creating the job itself fails (rare), we log
	// and continue — the sidecar still starts, just without the safety net.
	job, jerr := newJobKillOnClose()
	if jerr != nil {
		m.bus.Warn("sidecar", "JobObject create failed; sidecar will become an orphan if parent crashes", map[string]any{
			"err": jerr.Error(),
		})
	} else if aerr := job.assign(cmd.Process.Pid); aerr != nil {
		m.bus.Warn("sidecar", "JobObject assign failed; orphan-risk on parent crash", map[string]any{
			"err": aerr.Error(),
			"pid": cmd.Process.Pid,
		})
		job.close()
		job = nil
	}

	m.mu.Lock()
	m.cmd = cmd
	m.job = job
	m.cancel = cancel
	m.mu.Unlock()

	// Watch for unexpected exits. If the process dies while we're starting
	// or ready, flip status to error so the UI gets a meaningful pill.
	exitDone := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		_ = logFile.Close()
		close(exitDone)
		current := m.Status()
		if current.State == "starting" || current.State == "ready" {
			m.setStatus(types.SidecarStatus{
				State:   "error",
				Message: "sidecar exited unexpectedly — see sidecar.log",
			})
		}
		m.mu.Lock()
		if m.cmd == cmd {
			m.cmd = nil
			m.cancel = nil
			if m.job != nil {
				m.job.close()
				m.job = nil
			}
		}
		m.mu.Unlock()
	}()

	// Block until healthz comes up or the process dies, whichever first.
	healthCtx, healthCancel := context.WithTimeout(runCtx, healthTimeout)
	defer healthCancel()
	device, healthErr := waitHealthy(healthCtx, port, exitDone)
	if healthErr != nil {
		// Tear down and propagate.
		cancel()
		<-exitDone
		m.setStatus(types.SidecarStatus{State: "error", Message: healthErr.Error()})
		return healthErr
	}

	m.setStatus(types.SidecarStatus{State: "ready", Port: port, Device: device})
	return nil
}

// Stop kills the running sidecar. On Windows, closing the Job Object
// triggers JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE → child dies in ms. As a
// belt-and-suspenders (and the non-Windows path), we still SIGTERM/Kill
// with a 3 s grace. Safe to call when nothing is running.
func (m *Manager) Stop() {
	m.mu.Lock()
	cmd := m.cmd
	job := m.job
	cancel := m.cancel
	m.mu.Unlock()

	if cmd == nil || cmd.Process == nil {
		if m.Status().State != "error" {
			m.setStatus(types.SidecarStatus{State: "stopped"})
		}
		return
	}

	// Fast path on Windows: closing the job kills the child immediately via
	// the kernel. No-op elsewhere.
	if job != nil {
		job.close()
	}

	// Belt-and-suspenders: explicit SIGTERM (no-op on Windows since the job
	// already did the work) then SIGKILL after the grace window.
	_ = cmd.Process.Signal(syscall.SIGTERM)
	done := make(chan struct{})
	go func() {
		_, _ = cmd.Process.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopGraceTimeout):
		_ = cmd.Process.Kill()
		<-done
	}
	if cancel != nil {
		cancel()
	}
	m.mu.Lock()
	m.job = nil
	m.mu.Unlock()
	if m.Status().State != "error" {
		m.setStatus(types.SidecarStatus{State: "stopped"})
	}
}

// Restart = Stop + Start.
func (m *Manager) Restart(ctx context.Context, pythonPath, sdxlPath string) error {
	m.Stop()
	return m.Start(ctx, pythonPath, sdxlPath)
}

// freePort asks the kernel for any free TCP port on loopback. The brief
// race between Close() and the sidecar's bind() is acceptable for a
// localhost-only POC — the spawn watchdog catches a collision via the
// process exit + healthz timeout.
func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("sidecar: free port: %w", err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

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

type healthBody struct {
	OK     bool   `json:"ok"`
	Device string `json:"device"`
}

// waitHealthy polls /healthz until it returns 200 OK or the context expires
// or the process dies (signaled via exitDone). Returns the device string
// reported by the sidecar.
func waitHealthy(ctx context.Context, port int, exitDone <-chan struct{}) (string, error) {
	client := &http.Client{Timeout: 2 * time.Second}
	url := fmt.Sprintf("http://127.0.0.1:%d/healthz", port)
	ticker := time.NewTicker(healthPollInterval)
	defer ticker.Stop()

	tryOnce := func() (string, bool) {
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := client.Do(req)
		if err != nil {
			return "", false
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			io.Copy(io.Discard, resp.Body)
			return "", false
		}
		var body healthBody
		if json.NewDecoder(resp.Body).Decode(&body) != nil || !body.OK {
			return "", false
		}
		return body.Device, true
	}

	if device, ok := tryOnce(); ok {
		return device, nil
	}
	for {
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("sidecar didn't become healthy within %s", healthTimeout)
		case <-exitDone:
			return "", errors.New("sidecar exited before becoming healthy — see sidecar.log")
		case <-ticker.C:
			if device, ok := tryOnce(); ok {
				return device, nil
			}
		}
	}
}
