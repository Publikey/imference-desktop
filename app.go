package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/imagesink"
	"imference-desktop-go/internal/installer"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelfetch"
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

// GetCreditBalance reports the cloud account's remaining credits for the
// "API key (credit)" payment mode — the same balance the imference web app
// shows. The renderer passes the key it currently has in the dialog (which may
// be an unsaved draft); when empty we fall back to the saved key. Returns
// Configured=false with no error when neither yields a key, so the UI can
// prompt for one instead of flashing an error.
func (a *App) GetCreditBalance(apiKey string) types.CreditInfo {
	if apiKey == "" {
		apiKey = a.settings.Get().APIKey
	}
	if apiKey == "" {
		return types.CreditInfo{Configured: false}
	}
	credits, err := a.cloud.GetCredits(a.ctx, apiKey)
	if err != nil {
		a.bus.Warn("app", "GetCreditBalance failed", map[string]any{"err": err.Error()})
		return types.CreditInfo{Configured: true, Error: err.Error()}
	}
	return types.CreditInfo{Configured: true, Credits: credits}
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
	a.applyLocalModelConfig(&req)
	result, err := a.sidecar.Generate(a.ctx, req)
	if err != nil {
		return result, err
	}
	a.autoSave(&result)
	return result, nil
}

// applyLocalModelConfig folds the selected model's catalog config into a local
// generation request: prepends the model's quality-tag prefix, supplies its
// default negative prompt / scheduler / clip-skip when the caller left them
// unset. Numeric params (steps, cfg) come through the request from the UI,
// which seeds them from the model's defaults. No-op when no model is selected.
func (a *App) applyLocalModelConfig(req *types.GenerationRequest) {
	m := a.settings.Get().LocalModel
	if m == nil {
		return
	}
	if m.PromptPre != "" {
		req.Prompt = m.PromptPre + req.Prompt
	}
	if req.NegativePrompt == "" {
		req.NegativePrompt = m.PromptNegative
	}
	if req.Scheduler == "" {
		req.Scheduler = m.SchedulerDefault
	}
	if req.ClipSkip == nil && m.SkipDefault > 0 {
		skip := m.SkipDefault
		req.ClipSkip = &skip
	}
	a.bus.Info("app", "applied local model config", map[string]any{
		"model":     m.ModelCode,
		"scheduler": req.Scheduler,
		"clipSkip":  m.SkipDefault,
	})
}

// ------------------------------------------------------------------------
// Model catalog + local model selection
// ------------------------------------------------------------------------

// ListLocalModels returns the imference catalog filtered to locally-runnable
// models (those with downloadable weights). Public endpoint — works without an
// API key, so the picker is usable on first run.
func (a *App) ListLocalModels() ([]types.ModelInfo, error) {
	return a.cloud.ListModels(a.ctx, true)
}

// ListCloudModels returns the full imference catalog (cloud can run any model
// code, including the proprietary cloud-only ones the local picker hides).
// Public endpoint — works without an API key.
func (a *App) ListCloudModels() ([]types.ModelInfo, error) {
	return a.cloud.ListModels(a.ctx, false)
}

// SelectCloudModel records which catalog model cloud generation should use.
// Unlike SelectLocalModel this is instant — no weights to download, no sidecar
// to restart: it just persists the model code (sent to the server) plus the
// full catalog entry (so the form can show details and seed generation params).
func (a *App) SelectCloudModel(modelCode string) error {
	models, err := a.cloud.ListModels(a.ctx, false)
	if err != nil {
		return err
	}
	var chosen *types.ModelInfo
	for i := range models {
		if models[i].ModelCode == modelCode {
			chosen = &models[i]
			break
		}
	}
	if chosen == nil {
		return fmt.Errorf("model %q not found in catalog", modelCode)
	}

	s := a.settings.Get()
	s.CloudModel = chosen.ModelCode
	s.CloudModelInfo = chosen
	if _, serr := a.settings.Save(s); serr != nil {
		return serr
	}
	a.bus.Info("app", "SelectCloudModel", map[string]any{"model": chosen.ModelCode})
	return nil
}

// SelectLocalModel downloads the chosen model's weights, deletes the previously
// downloaded model (only after the new one lands), persists the selection, and
// restarts the sidecar so the new weights load. Returns immediately; progress
// streams on the "model:progress" event ({phase:"done"|"error"} terminates).
func (a *App) SelectLocalModel(modelCode string) error {
	models, err := a.cloud.ListModels(a.ctx, true)
	if err != nil {
		return err
	}
	var chosen *types.ModelInfo
	for i := range models {
		if models[i].ModelCode == modelCode {
			chosen = &models[i]
			break
		}
	}
	if chosen == nil {
		return fmt.Errorf("model %q not found in catalog (or it's cloud-only)", modelCode)
	}

	newPath, err := sdxlModelPath(chosen.ModelURL)
	if err != nil {
		return err
	}
	oldPath := a.settings.Get().SDXLPath

	emit := func(p types.InstallProgress) {
		if a.ctx != nil {
			runtime.EventsEmit(a.ctx, "model:progress", p)
		}
	}

	go func() {
		emit(types.InstallProgress{Phase: "model", Message: "Preparing " + chosen.Name})
		a.bus.Info("app", "SelectLocalModel start", map[string]any{"model": chosen.ModelCode, "url": chosen.ModelURL})

		// Stop the sidecar before downloading/deleting: the old .safetensors is
		// mmap'd by the running engine, so we must release it first (and on
		// Windows the file can't be deleted while open).
		a.sidecar.Stop()

		_, derr := modelfetch.New(a.bus).Fetch(a.ctx, chosen.ModelURL, newPath, modelReuseMinBytes,
			func(p modelfetch.Progress) {
				emit(types.InstallProgress{
					Phase:           "model",
					Message:         fmt.Sprintf("Downloading %s — %s / %s", chosen.Name, humanBytes(p.Downloaded), humanBytes(p.Total)),
					PercentEstimate: p.Percent,
				})
			},
		)
		if derr != nil {
			a.bus.Error("app", "SelectLocalModel download failed", map[string]any{"err": derr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: derr.Error(), Done: true})
			return
		}

		// New weights are safely on disk — now reclaim the old model's space.
		if oldPath != "" && oldPath != newPath {
			a.deleteManagedModel(oldPath)
		}

		s := a.settings.Get()
		s.SDXLPath = newPath
		s.LocalModel = chosen
		if _, serr := a.settings.Save(s); serr != nil {
			a.bus.Error("app", "SelectLocalModel settings save failed", map[string]any{"err": serr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: serr.Error(), Done: true})
			return
		}

		emit(types.InstallProgress{Phase: "model", Message: "Loading " + chosen.Name + " into the engine…", PercentEstimate: 100})
		if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath); rerr != nil {
			a.bus.Warn("app", "SelectLocalModel sidecar restart failed", map[string]any{"err": rerr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: rerr.Error(), Done: true})
			return
		}
		a.bus.Info("app", "SelectLocalModel done", map[string]any{"model": chosen.ModelCode})
		emit(types.InstallProgress{Phase: "done", Message: chosen.Name + " ready", PercentEstimate: 100, Done: true})
	}()

	return nil
}

// deleteManagedModel removes a previously downloaded model file, but ONLY when
// it lives inside our managed models directory — a guard so a user-supplied
// SDXLPath pointing at their own checkpoint elsewhere is never deleted.
func (a *App) deleteManagedModel(p string) {
	dir, err := modelsDir()
	if err != nil {
		return
	}
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)+"..") {
		a.bus.Warn("app", "refusing to delete model outside managed dir", map[string]any{"path": p})
		return
	}
	if err := os.Remove(p); err != nil {
		a.bus.Warn("app", "delete old model failed", map[string]any{"path": p, "err": err.Error()})
		return
	}
	a.bus.Info("app", "deleted old local model", map[string]any{"path": p})
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
	modelPath, err := sdxlModelPath(installer.SDXLModelURL)
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
			ModelPath:               modelPath, // triggers the SDXL download phase
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
			// The install flow downloaded (or reused) the SDXL weights at
			// modelPath, so wire them in too — this is what lets the post-install
			// sidecar restart succeed instead of failing "settings incomplete".
			s.SDXLPath = modelPath
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

// modelReuseMinBytes is the cross-launch reuse floor for downloaded weights —
// an existing model file larger than this is treated as a complete prior
// download. Loose "this is plausibly a real multi-GB checkpoint, not a stub"
// bound; true completeness of a fresh download is enforced by modelfetch.
const modelReuseMinBytes = 1_000_000_000

// modelsDir is where the app caches downloaded model weights. Under
// UserCacheDir (alongside the engine venv) because they're large, regenerable
// assets — re-downloadable, not roamable user config.
func modelsDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", fmt.Errorf("locate UserCacheDir: %w", err)
	}
	return filepath.Join(cache, "imference-desktop-go", "models"), nil
}

// sdxlModelPath is the local cache path for a model given its download URL.
// The filename is derived from the URL's basename so that each distinct model
// gets its own cache file. This matters: the reuse check is by path+size, so a
// fixed filename would make swapping models silently re-serve a previously
// downloaded model that happens to sit at the same path.
func sdxlModelPath(modelURL string) (string, error) {
	dir, err := modelsDir()
	if err != nil {
		return "", err
	}
	name := "model.safetensors" // fallback when the URL has no usable basename
	if u, perr := url.Parse(modelURL); perr == nil {
		if base := path.Base(u.Path); base != "" && base != "." && base != "/" && strings.HasSuffix(base, ".safetensors") {
			name = base
		}
	}
	return filepath.Join(dir, name), nil
}

// humanBytes renders a byte count as a short string ("6.9 GB"); "?" for a
// negative total (server sent no Content-Length).
func humanBytes(n int64) string {
	if n < 0 {
		return "?"
	}
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
