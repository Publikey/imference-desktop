package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/types"
)

// App is the Wails-bound facade. Every method on *App becomes a
// `window.go.main.App.X(...)` Promise-returning function in the frontend,
// with TypeScript types auto-generated under frontend/wailsjs/.
//
// All persistent state lives in the three substructs (settings, sidecar,
// cloud). App's job is to wire requests + emit status events; it owns no
// business logic.
type App struct {
	ctx context.Context

	settings *settings.Store
	sidecar  *sidecar.Manager
	cloud    *cloud.Client
}

func NewApp() *App {
	store, err := settings.New()
	if err != nil {
		// Failing here would mean we can't find UserConfigDir on this OS —
		// effectively a misconfigured host. Surface to stderr; the UI will
		// still come up but every settings call will panic. Acceptable
		// trade-off for a POC; production would use a logger and fail soft.
		panic(fmt.Errorf("settings store: %w", err))
	}

	logDir, _ := os.UserConfigDir()
	logDir = filepath.Join(logDir, "imference-desktop-go")

	scriptPath, err := resolveSidecarScript()
	if err != nil {
		panic(fmt.Errorf("locate sidecar script: %w", err))
	}

	a := &App{
		settings: store,
		cloud:    cloud.New(),
	}
	a.sidecar = sidecar.New(scriptPath, logDir, a.broadcastSidecarStatus)
	return a
}

// startup is called by Wails once the BrowserWindow is alive. We capture
// the context so we can EventsEmit later, then attempt a first sidecar
// spawn. If settings are empty the spawn fails fast and the UI shows
// "local: error" on first paint, prompting the user toward ⚙.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	go func() {
		s := a.settings.Get()
		_ = a.sidecar.Start(a.ctx, s.PythonPath, s.SDXLPath)
	}()
}

// onBeforeClose runs when the user clicks the X. Returning false lets the
// window close. We block long enough to SIGTERM the sidecar gracefully —
// the manager's Stop() has its own 3 s SIGKILL deadline so this is bounded.
func (a *App) onBeforeClose(_ context.Context) bool {
	a.sidecar.Stop()
	return false
}

func (a *App) broadcastSidecarStatus(s types.SidecarStatus) {
	if a.ctx == nil {
		return // Wails hasn't called startup yet — nothing to emit to.
	}
	runtime.EventsEmit(a.ctx, "sidecar:status", s)
}

// ------------------------------------------------------------------------
// Bound methods (visible to the renderer as window.go.main.App.<Method>)
// ------------------------------------------------------------------------

func (a *App) GetSettings() types.Settings {
	return a.settings.Get()
}

// SaveSettings overwrites settings on disk and restarts the sidecar in the
// background if the Python or SDXL paths changed. Returns the new settings
// for the renderer to re-sync its local state.
func (a *App) SaveSettings(next types.Settings) (types.Settings, error) {
	prev := a.settings.Get()
	saved, err := a.settings.Save(next)
	if err != nil {
		return types.Settings{}, err
	}
	if settings.SidecarConfigChanged(prev, saved) {
		go func() {
			_ = a.sidecar.Restart(a.ctx, saved.PythonPath, saved.SDXLPath)
		}()
	}
	return saved, nil
}

func (a *App) GetSidecarStatus() types.SidecarStatus {
	return a.sidecar.Status()
}

func (a *App) RestartSidecar() error {
	s := a.settings.Get()
	return a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath)
}

// GenerateCloud is the only HTTP surface to imference.com. Frontend never
// touches the network directly — keeps auth-key handling in Go and gives
// us a single point to add retries / progress events later.
func (a *App) GenerateCloud(req types.GenerationRequest) (types.GenerationResult, error) {
	s := a.settings.Get()
	if s.APIKey == "" {
		return types.GenerationResult{}, errors.New("Cloud API key not set")
	}
	if s.CloudModel == "" {
		return types.GenerationResult{}, errors.New("Cloud model not set")
	}
	return a.cloud.Generate(a.ctx, s.APIKey, s.CloudModel, req)
}

// GenerateLocal dispatches to the running Python sidecar. The sidecar
// itself is single-threaded (the Engine is stateful) so concurrent calls
// queue up server-side; that's intentional for the POC.
func (a *App) GenerateLocal(req types.GenerationRequest) (types.GenerationResult, error) {
	return a.sidecar.Generate(a.ctx, req)
}

// resolveSidecarScript finds sidecar/main.py relative to the running binary.
// `wails dev` runs from the project root so a simple "sidecar/main.py" works;
// `wails build` packs the binary into build/bin/ so we walk up to look for
// the sidecar dir. POC ships dev-mode only — the prod branch is here for
// completeness, not because we test it.
func resolveSidecarScript() (string, error) {
	candidates := []string{
		filepath.Join("sidecar", "main.py"),                     // wails dev
		filepath.Join("..", "..", "sidecar", "main.py"),         // wails build → build/bin/<exe>
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if _, err := os.Stat(abs); err == nil {
			return abs, nil
		}
	}
	return "", fmt.Errorf("sidecar/main.py not found (tried %v)", candidates)
}
