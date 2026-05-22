package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/imagesink"
	"imference-desktop-go/internal/installer"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
)

// App is the Wails-bound facade. Every method on *App becomes a
// `window.go.main.App.X(...)` Promise-returning function in the frontend,
// with TypeScript types auto-generated under frontend/wailsjs/.
//
// All persistent state lives in the five substructs (settings, sidecar,
// cloud, installer, bus). App's job is to wire requests + emit status events;
// it owns no business logic.
type App struct {
	ctx context.Context

	bus       *logbus.Bus
	settings  *settings.Store
	sidecar   *sidecar.Manager
	cloud     *cloud.Client
	installer *installer.Installer
}

func NewApp() *App {
	bus := logbus.New()

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
		bus:       bus,
		settings:  store,
		cloud:     cloud.New(bus),
		installer: installer.New(bus),
	}
	a.sidecar = sidecar.New(scriptPath, logDir, a.broadcastSidecarStatus, bus)
	return a
}

// startup is called by Wails once the BrowserWindow is alive. We capture
// the context so we can EventsEmit later, then attempt a first sidecar
// spawn. If settings are empty the spawn fails fast and the UI shows
// "local: error" on first paint, prompting the user toward ⚙.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	// Wire the bus emitter now that we have a wails context — every
	// Publish() from this point streams to the renderer's <LogPanel/>.
	a.bus.SetEmitter(func(eventName string, data ...any) {
		runtime.EventsEmit(a.ctx, eventName, data...)
	})
	a.bus.Info("app", "startup", nil)
	go func() {
		s := a.settings.Get()
		_ = a.sidecar.Start(a.ctx, s.PythonPath, s.SDXLPath)
	}()
}

// onBeforeClose runs when the user clicks the X. Returning false lets the
// window close. We block long enough to SIGTERM the sidecar gracefully —
// the manager's Stop() has its own 3 s SIGKILL deadline so this is bounded.
func (a *App) onBeforeClose(_ context.Context) bool {
	a.bus.Info("app", "onBeforeClose — stopping sidecar", nil)
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
		a.bus.Error("app", "SaveSettings failed", map[string]any{"err": err.Error()})
		return types.Settings{}, err
	}
	restart := settings.SidecarConfigChanged(prev, saved)
	a.bus.Info("app", "SaveSettings ok", map[string]any{"sidecarRestart": restart})
	if restart {
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
	a.bus.Info("app", "RestartSidecar requested", nil)
	return a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath)
}

// GenerateCloud is the only HTTP surface to imference.com. Frontend never
// touches the network directly — keeps auth-key/wallet handling in Go and
// gives us a single point to add retries / progress events later.
//
// Dispatches based on settings.PaymentMode:
//   - "x402"   : signs each request with the local wallet (Base mainnet USDC)
//   - default  : "bearer" — uses settings.APIKey
func (a *App) GenerateCloud(req types.GenerationRequest) (types.GenerationResult, error) {
	s := a.settings.Get()
	if s.CloudModel == "" {
		a.bus.Warn("app", "GenerateCloud: model not set", nil)
		return types.GenerationResult{}, errors.New("Cloud model not set")
	}

	var result types.GenerationResult
	var err error

	switch s.PaymentMode {
	case "x402":
		w, lerr := wallet.LoadFromKeychain()
		if lerr != nil {
			a.bus.Warn("app", "GenerateCloud: x402 mode but no wallet configured", nil)
			return types.GenerationResult{}, errors.New("x402 mode selected but no wallet configured — open Settings to generate/import one")
		}
		result, err = a.cloud.GenerateX402(a.ctx, s.CloudModel, req, w)
	default:
		if s.APIKey == "" {
			a.bus.Warn("app", "GenerateCloud: API key not set", nil)
			return types.GenerationResult{}, errors.New("Cloud API key not set")
		}
		result, err = a.cloud.Generate(a.ctx, s.APIKey, s.CloudModel, req)
	}

	if err != nil {
		return result, err
	}
	a.autoSave(&result)
	return result, nil
}

// GenerateLocal dispatches to the running Python sidecar. The sidecar
// itself is single-threaded (the Engine is stateful) so concurrent calls
// queue up server-side; that's intentional for the POC.
func (a *App) GenerateLocal(req types.GenerationRequest) (types.GenerationResult, error) {
	result, err := a.sidecar.Generate(a.ctx, req)
	if err != nil {
		return result, err
	}
	a.autoSave(&result)
	return result, nil
}

// autoSave writes the generated image to disk and stamps result.SavedPath.
// A save failure is logged but never propagated — the user still gets the
// base64 in memory and can manually save from the renderer if needed.
func (a *App) autoSave(result *types.GenerationResult) {
	dir := a.settings.Get().OutputDir
	if dir == "" {
		dir = imagesink.DefaultDir()
	}
	path, err := imagesink.Save(result.ImageBase64, result.Source, result.Seed, dir)
	if err != nil {
		a.bus.Warn("app", "auto-save failed", map[string]any{
			"err": err.Error(),
			"dir": dir,
		})
		return
	}
	result.SavedPath = path
	a.bus.Info("app", "image saved", map[string]any{"path": path})
}

// ------------------------------------------------------------------------
// Log bus surface
// ------------------------------------------------------------------------

// GetLogs returns the current ring buffer snapshot so the renderer can
// seed its panel on mount. Subsequent entries arrive via the "log:entry"
// event.
func (a *App) GetLogs() []logbus.Entry {
	return a.bus.Snapshot()
}

func (a *App) ClearLogs() {
	a.bus.Clear()
	a.bus.Info("app", "logs cleared by user", nil)
}

// LogFromFrontend lets the renderer push captured console.* / window.error
// events into the same bus, so the LogPanel is a single source of truth.
// Level is one of "trace" | "info" | "warn" | "error"; unknown → "info".
func (a *App) LogFromFrontend(level, source, message string, data any) {
	lvl := logbus.LevelInfo
	switch logbus.Level(level) {
	case logbus.LevelTrace, logbus.LevelInfo, logbus.LevelWarn, logbus.LevelError:
		lvl = logbus.Level(level)
	}
	if source == "" {
		source = "front"
	}
	a.bus.Publish(lvl, source, message, data)
}

// ------------------------------------------------------------------------
// Installer surface — one-click bundled-engine setup
// ------------------------------------------------------------------------

// DetectPython runs the same probe the installer will use, but on demand —
// the SettingsDialog calls this to surface "Python X.Y.Z found at …" before
// the user even clicks Install.
func (a *App) DetectPython() (types.PythonInfo, error) {
	return installer.DetectPython(a.ctx)
}

// GetEngineInfo reports whether the bundled-engine venv exists and looks
// runnable. Cheap; safe to call every time the dialog opens.
func (a *App) GetEngineInfo() types.EngineInfo {
	dir, err := engineVenvDir()
	if err != nil {
		return types.EngineInfo{}
	}
	return installer.EngineInfoFor(a.ctx, dir)
}

// InstallEngine kicks off the full 5-phase install in a goroutine and returns
// immediately. Progress is streamed via the "install:progress" Wails event;
// the renderer listens for {phase:"done"} or {phase:"error"} to know it's
// finished. Only one install runs at a time — the Installer enforces this.
func (a *App) InstallEngine() error {
	venvDir, err := engineVenvDir()
	if err != nil {
		return err
	}
	reqs, err := resolveSidecarRequirements()
	if err != nil {
		return err
	}

	progress := make(chan types.InstallProgress, 16)

	// Goroutine #1: drive the install.
	go func() {
		// Stop the running sidecar before touching the venv. On Windows,
		// python.exe keeps torch's .pyd/.dll files mmap'd while it's alive,
		// so the wipe in installer.recreateVenv() fails with "file in use".
		// Idempotent: no-op when the sidecar isn't running.
		a.bus.Info("app", "stopping sidecar before install (to release venv file locks)", nil)
		a.sidecar.Stop()

		err := a.installer.Install(a.ctx, installer.Options{
			VenvDir:                 venvDir,
			SidecarRequirementsPath: reqs,
		}, progress)
		if err != nil {
			a.bus.Error("app", "InstallEngine failed", map[string]any{"err": err.Error()})
			return
		}

		// Persist the new pythonPath. Skip SaveSettings (which auto-restarts
		// only when the path actually changed) and write directly via the
		// store — we'll always restart explicitly below, since the install
		// flow stopped the sidecar at its start regardless of whether the
		// path changed (the venv may have been reused on a reinstall, in
		// which case path is unchanged but the sidecar is still stopped).
		s := a.settings.Get()
		s.PythonPath = installer.VenvPython(venvDir)
		if _, err := a.settings.Save(s); err != nil {
			a.bus.Error("app", "post-install settings save failed", map[string]any{"err": err.Error()})
		}

		// Always restart the sidecar after a successful install — the
		// pre-install Stop() left it in "stopped" state and nothing else
		// will revive it. Avoids the "local: stopped" pill that lingered
		// indefinitely on reinstall-with-same-pythonPath previously.
		a.bus.Info("app", "restarting sidecar after install", nil)
		if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath); rerr != nil {
			a.bus.Warn("app", "post-install sidecar restart failed", map[string]any{"err": rerr.Error()})
		}
	}()

	// Goroutine #2: forward progress events to the renderer.
	go func() {
		for p := range progress {
			runtime.EventsEmit(a.ctx, "install:progress", p)
		}
	}()

	return nil
}

// ------------------------------------------------------------------------
// Wallet surface — x402 burner-key management
// ------------------------------------------------------------------------

// GetWalletInfo reports the current wallet state to the renderer. Cheap
// when the keychain has no entry (just an ErrNoWallet round-trip). When
// configured, also fetches the USDC balance over the Base RPC — that's
// network I/O, so the call can block for a couple seconds.
func (a *App) GetWalletInfo() types.WalletInfo {
	info := types.WalletInfo{Network: "base-mainnet"}
	w, err := wallet.LoadFromKeychain()
	if err != nil {
		// ErrNoWallet is the common case; other errors mean the OS
		// keychain is unhappy and the user should see that.
		if err != wallet.ErrNoWallet {
			info.Error = err.Error()
			a.bus.Warn("app", "GetWalletInfo: keychain error", map[string]any{"err": err.Error()})
		}
		return info
	}
	info.Configured = true
	info.Address = w.Address().Hex()
	balance, berr := wallet.USDCBalance(a.ctx, w.Address(), false)
	if berr != nil {
		info.Error = berr.Error()
		a.bus.Warn("app", "GetWalletInfo: balance fetch failed", map[string]any{"err": berr.Error()})
	} else {
		info.BalanceUSDC = balance
	}
	return info
}

// RefreshWalletBalance bypasses the in-memory balance cache and re-queries
// the RPC. Bound separately because the renderer's refresh button must
// always read fresh state, not the 10s-cached one.
func (a *App) RefreshWalletBalance() (string, error) {
	w, err := wallet.LoadFromKeychain()
	if err != nil {
		return "", err
	}
	return wallet.USDCBalance(a.ctx, w.Address(), true)
}

// GenerateWallet creates a fresh keypair, stores it in the keychain
// (overwriting any existing entry), mirrors the public address into
// settings.json, and returns the new address.
//
// The renderer is responsible for confirming destruction of any
// existing wallet BEFORE calling this — the Go side just does what it's
// told to keep the UI flow clean.
func (a *App) GenerateWallet() (string, error) {
	w, err := wallet.Generate()
	if err != nil {
		a.bus.Error("app", "GenerateWallet failed", map[string]any{"err": err.Error()})
		return "", err
	}
	if err := wallet.SaveToKeychain(w); err != nil {
		a.bus.Error("app", "GenerateWallet save failed", map[string]any{"err": err.Error()})
		return "", err
	}
	addr := w.Address().Hex()
	s := a.settings.Get()
	s.WalletAddress = addr
	if _, err := a.SaveSettings(s); err != nil {
		a.bus.Warn("app", "GenerateWallet: failed to mirror address to settings", map[string]any{"err": err.Error()})
	}
	a.bus.Info("app", "wallet generated", map[string]any{"address": addr})
	return addr, nil
}

// ImportWallet parses a hex private key (0x-prefixed or not), stores it
// in the keychain, mirrors the address to settings, returns the address.
// Errors on malformed input — caller's textarea should display the message
// inline so the user knows what to fix.
func (a *App) ImportWallet(privateKeyHex string) (string, error) {
	w, err := wallet.Import(privateKeyHex)
	if err != nil {
		a.bus.Warn("app", "ImportWallet: invalid key", map[string]any{"err": err.Error()})
		return "", err
	}
	if err := wallet.SaveToKeychain(w); err != nil {
		a.bus.Error("app", "ImportWallet save failed", map[string]any{"err": err.Error()})
		return "", err
	}
	addr := w.Address().Hex()
	s := a.settings.Get()
	s.WalletAddress = addr
	if _, err := a.SaveSettings(s); err != nil {
		a.bus.Warn("app", "ImportWallet: failed to mirror address to settings", map[string]any{"err": err.Error()})
	}
	a.bus.Info("app", "wallet imported", map[string]any{"address": addr})
	return addr, nil
}

// ExportWalletPrivateKey returns the raw hex private key so the user
// can back it up. The renderer must gate this behind a confirmation
// modal — once this method returns, the secret is in the renderer's
// memory (and the user's clipboard if they copy it). NEVER LOGGED here.
func (a *App) ExportWalletPrivateKey() (string, error) {
	w, err := wallet.LoadFromKeychain()
	if err != nil {
		return "", err
	}
	a.bus.Info("app", "wallet private key exported to renderer", map[string]any{"address": w.Address().Hex()})
	return w.PrivateKeyHex(), nil
}

// resolveSidecarDir finds the sidecar/ folder relative to the running binary.
// `wails dev` runs from the project root so "sidecar/" is right there;
// `wails build` packs the binary into build/bin/ so we walk up. POC ships
// dev-mode only — the prod branch is here for completeness, not tested.
func resolveSidecarDir() (string, error) {
	candidates := []string{
		"sidecar",                            // wails dev
		filepath.Join("..", "..", "sidecar"), // wails build → build/bin/<exe>
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if _, err := os.Stat(filepath.Join(abs, "main.py")); err == nil {
			return abs, nil
		}
	}
	return "", fmt.Errorf("sidecar/ dir not found (tried %v)", candidates)
}

func resolveSidecarScript() (string, error) {
	dir, err := resolveSidecarDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "main.py"), nil
}

func resolveSidecarRequirements() (string, error) {
	dir, err := resolveSidecarDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "requirements.txt"), nil
}

// engineVenvDir is where the installer creates the bundled-engine venv.
// Lives under UserCacheDir (= %LOCALAPPDATA% on Windows) because it's
// regenerable cache, not roamable user config.
func engineVenvDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate UserCacheDir: %w", err)
	}
	return filepath.Join(cache, "imference-desktop-go", "engine-venv"), nil
}
