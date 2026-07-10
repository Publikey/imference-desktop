package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register decoders for image.DecodeConfig (dimensions)
	_ "image/jpeg" //
	_ "image/png"  //
	"mime"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/imagesink"
	"imference-desktop-go/internal/installer"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelfetch"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/update"
	"imference-desktop-go/internal/version"
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
	// app is the running Wails v3 application handle, captured in ServiceStartup.
	// Used to emit events to the renderer (a.app.Event.Emit). nil until startup.
	app *application.App

	bus       *logbus.Bus
	settings  *settings.Store
	sidecar   *sidecar.Manager
	cloud     *cloud.Client
	installer *installer.Installer

	// gallery metadata cache (name → sidecar meta) for cheap filtering/facets.
	// The sidecars remain the source of truth; this is a derived, invalidated
	// cache — rebuilt on demand, dropped whenever a save/delete changes the set.
	galleryMu    sync.Mutex
	galleryCache map[string]*types.GenerationMeta
	galleryValid bool
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

	// The sidecar Python script is optional and NOT embedded: a packaged/portable
	// build has no sidecar/ folder beside it, so this resolves only in a dev
	// checkout. Missing → the local engine is unavailable (cloud still works);
	// don't crash the whole app. The empty path makes sidecar.Start() no-op/fail
	// gracefully instead of paniquing at construction.
	scriptPath, err := resolveSidecarScript()
	if err != nil {
		bus.Warn("app", "sidecar script not found — local engine unavailable (cloud only)", map[string]any{"err": err.Error()})
		scriptPath = ""
	}

	a := &App{
		bus:       bus,
		settings:  store,
		cloud:     cloud.New(bus),
		installer: installer.New(bus),
	}
	a.sidecar = sidecar.New(scriptPath, logDir, a.broadcastSidecarStatus, bus)
	a.sidecar.SetProgressListener(a.broadcastGenerateProgress)
	return a
}

// ServiceStartup is the Wails v3 service lifecycle hook, called during app
// startup. We capture the app context (reused by downstream network/RPC calls)
// and the application handle (for emitting events), wire the log-bus emitter,
// then kick off cleanup. If settings are empty the local engine stays stopped
// and the UI shows "local: error" on first paint, prompting the user toward ⚙.
func (a *App) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	a.ctx = ctx
	a.app = application.Get()
	// Wire the bus emitter now that we have the app handle — every Publish()
	// from this point streams to the renderer's <LogPanel/>. The emitter shape
	// (name, ...data) maps directly onto v3's variadic Event.Emit.
	a.bus.SetEmitter(func(eventName string, data ...any) {
		if a.app == nil {
			return
		}
		a.app.Event.Emit(eventName, data...)
	})
	a.bus.Info("app", "startup", nil)
	go func() {
		// Clean up a stale model selection, but DON'T auto-start the local engine
		// — it's spawned on demand from the home-screen engine control. Cloud-only
		// users no longer pay for a local engine (GPU/RAM) they won't use.
		_ = a.clearStaleLocalModel()
		a.bus.Info("app", "sidecar left stopped at startup — start it from the engine control", nil)
	}()
	return nil
}

// clearStaleLocalModel drops a persisted model selection whose weights file no
// longer exists (e.g. the cache dir was wiped or the file deleted) — the
// settings.json lives under UserConfigDir and survives a UserCacheDir wipe, so a
// clean reinstall can inherit a dangling SDXLPath. Returns the current settings,
// with SDXLPath + LocalModel cleared and saved when they were stale, so the app
// never tries to load a missing checkpoint (which surfaced as "Local error").
func (a *App) clearStaleLocalModel() types.Settings {
	s := a.settings.Get()
	if s.SDXLPath == "" {
		return s
	}
	if _, err := os.Stat(s.SDXLPath); err == nil {
		return s // weights present — selection is valid
	}
	a.bus.Warn("app", "selected model weights missing; clearing stale selection", map[string]any{"path": s.SDXLPath})
	s.SDXLPath = ""
	s.LocalModel = nil
	if _, err := a.settings.Save(s); err != nil {
		a.bus.Error("app", "clear stale model save failed", map[string]any{"err": err.Error()})
	}
	return s
}

// ServiceShutdown is the Wails v3 service lifecycle hook, called when the app
// is terminating (default v3 behaviour quits the app once the last window is
// closed). We SIGTERM the sidecar gracefully — the manager's Stop() has its own
// 3 s SIGKILL deadline so this is bounded — and the shutdown blocks until we
// return.
func (a *App) ServiceShutdown() error {
	a.bus.Info("app", "ServiceShutdown — stopping sidecar", nil)
	a.sidecar.Stop()
	return nil
}

func (a *App) broadcastSidecarStatus(s types.SidecarStatus) {
	if a.app == nil {
		return // Wails hasn't called ServiceStartup yet — nothing to emit to.
	}
	a.app.Event.Emit("sidecar:status", s)
}

func (a *App) broadcastGenerateProgress(p types.GenerateProgress) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit("generate:progress", p)
}

// ------------------------------------------------------------------------
// Bound methods (visible to the renderer as window.go.main.App.<Method>)
// ------------------------------------------------------------------------

func (a *App) GetSettings() types.Settings {
	return a.settings.Get()
}

// GetVersion returns the app's own version: "dev" for local builds, "X.X.X"
// for release binaries (embedded by CI, see internal/version).
func (a *App) GetVersion() string {
	return version.Version
}

// CheckForUpdate asks GitHub for the latest release and compares it to this
// build. Local "dev" builds return UpdateAvailable=false without any network
// call. The frontend treats an error as "no banner" — never blocking startup.
func (a *App) CheckForUpdate() (types.UpdateInfo, error) {
	info, err := update.Check(a.ctx, version.Version)
	if err != nil {
		a.bus.Warn("app", "CheckForUpdate failed", map[string]any{"err": err.Error()})
		return info, err
	}
	if info.UpdateAvailable {
		a.bus.Info("app", "update available", map[string]any{
			"current": info.CurrentVersion, "latest": info.LatestVersion,
		})
	}
	return info, nil
}

// SaveSettings overwrites settings on disk and restarts the sidecar in the
// background if a sidecar-affecting field changed — but ONLY when the engine is
// currently running. When it's stopped (the default now — the engine starts on
// demand), we just persist; the new config applies at the next manual Start.
// This keeps settings edits (incl. auto-save) from spinning the engine up.
func (a *App) SaveSettings(next types.Settings) (types.Settings, error) {
	prev := a.settings.Get()
	saved, err := a.settings.Save(next)
	if err != nil {
		a.bus.Error("app", "SaveSettings failed", map[string]any{"err": err.Error()})
		return types.Settings{}, err
	}
	restart := settings.SidecarConfigChanged(prev, saved) && a.sidecar.Status().State == "ready"
	a.bus.Info("app", "SaveSettings ok", map[string]any{"sidecarRestart": restart})
	if restart {
		go func() {
			_ = a.sidecar.Restart(a.ctx, saved.PythonPath, saved.SDXLPath, saved.LocalModel, saved.EngineRuntime)
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
	return a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime)
}

// StartSidecar boots the local engine on demand (home-screen engine control),
// loading the currently-selected model. No-op if already starting/ready; errors
// if the engine isn't installed or no model has been downloaded yet.
func (a *App) StartSidecar() error {
	s := a.settings.Get()
	a.bus.Info("app", "StartSidecar requested", nil)
	return a.sidecar.Start(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime)
}

// StopSidecar shuts the local engine down to free GPU/RAM.
func (a *App) StopSidecar() error {
	a.bus.Info("app", "StopSidecar requested", nil)
	return a.sidecar.Stop()
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
	a.autoSave(&result, cloudMeta(req, s.CloudModelInfo))
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
	a.autoSave(&result, genMeta(req, a.settings.Get().LocalModel))
	return result, nil
}

// genMeta / cloudMeta build the generation metadata from a request + the model
// that produced it (shared shape; the source/seed/createdAt are filled by
// autoSave). model may be nil (no catalog entry).
func genMeta(req types.GenerationRequest, model *types.ModelInfo) types.GenerationMeta {
	m := types.GenerationMeta{
		Prompt:         req.Prompt,
		NegativePrompt: req.NegativePrompt,
		Width:          req.Width,
		Height:         req.Height,
		NumSteps:       req.NumSteps,
		GuidanceScale:  req.GuidanceScale,
		Scheduler:      req.Scheduler,
		ClipSkip:       req.ClipSkip,
		Img2Img:        req.SourceImage != "",
		Strength:       req.Strength,
	}
	if model != nil {
		m.ModelCode = model.ModelCode
		m.ModelName = model.Name
		m.Engine = model.BackendType
		m.FormatCode = model.FormatCode
	}
	return m
}

func cloudMeta(req types.GenerationRequest, model *types.ModelInfo) types.GenerationMeta {
	// Cloud img2img isn't wired, so drop the img2img fields; otherwise identical.
	m := genMeta(req, model)
	m.Img2Img = false
	m.Strength = 0
	return m
}

// applyLocalModelConfig fills the selected model's default negative prompt /
// scheduler / clip-skip when the caller left them unset. The quality-tag prefix
// (prompt_pre) and numeric params (steps, cfg) come through the request already,
// composed/seeded by the renderer. No-op when no model is selected.
func (a *App) applyLocalModelConfig(req *types.GenerationRequest) {
	m := a.settings.Get().LocalModel
	if m == nil {
		return
	}
	// NOTE: the quality-tag prefix (prompt_pre) is composed client-side now (the
	// renderer's editable "Quality tags" field), so we do NOT prepend it here —
	// doing so would double it. Same client-side composition as the cloud path.
	if req.NegativePrompt == "" {
		req.NegativePrompt = m.PromptNegative
	}
	// Z-Image has no CLIP tokenizer and a fixed flow-matching scheduler, so the
	// engine ignores scheduler/clip-skip for it — don't inject them. SDXL keeps
	// the model's catalog defaults when the caller left them unset.
	if m.BackendType != "zimage" {
		if req.Scheduler == "" {
			req.Scheduler = m.SchedulerDefault
		}
		if req.ClipSkip == nil && m.SkipDefault > 0 {
			skip := m.SkipDefault
			req.ClipSkip = &skip
		}
	}
	a.bus.Info("app", "applied local model config", map[string]any{
		"model":     m.ModelCode,
		"backend":   m.BackendType,
		"scheduler": req.Scheduler,
		"clipSkip":  req.ClipSkip,
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
		if a.app != nil {
			a.app.Event.Emit("model:progress", p)
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
		if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime); rerr != nil {
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
func (a *App) autoSave(result *types.GenerationResult, meta types.GenerationMeta) {
	dir := a.outputDir()
	meta.Source = result.Source
	meta.Seed = result.Seed
	meta.CreatedAt = time.Now().Format(time.RFC3339)
	path, metaErr, err := imagesink.SaveWithMeta(result.ImageBase64, result.Source, result.Seed, dir, meta)
	if err != nil {
		a.bus.Warn("app", "auto-save failed", map[string]any{"err": err.Error(), "dir": dir})
		return
	}
	if metaErr != nil {
		a.bus.Warn("app", "metadata sidecar not written", map[string]any{"err": metaErr.Error()})
	}
	result.SavedPath = path
	result.Meta = &meta
	a.invalidateGalleryCache()
	a.bus.Info("app", "image saved", map[string]any{"path": path})
}

// invalidateGalleryCache drops the derived meta cache so the next gallery scan
// rebuilds it. Called after any save/delete.
func (a *App) invalidateGalleryCache() {
	a.galleryMu.Lock()
	a.galleryValid = false
	a.galleryCache = nil
	a.galleryMu.Unlock()
}

// outputDir is where generated images are saved and where the gallery reads
// from — the user's OutputDir setting, or the default Pictures/Imference.
func (a *App) outputDir() string {
	if d := a.settings.Get().OutputDir; d != "" {
		return d
	}
	return imagesink.DefaultDir()
}

var galleryExts = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true, ".gif": true}

// ListSavedImages returns one page of previously-generated images from the
// output folder, newest first (by file mtime), optionally narrowed by filter.
// Paginated for infinite scroll: pass the running offset and a page size.
func (a *App) ListSavedImages(offset, limit int, filter types.GalleryFilter) ([]types.SavedImage, error) {
	dir := a.outputDir()
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return []types.SavedImage{}, nil // no folder yet → empty gallery
		}
		return nil, err
	}
	type fmeta struct {
		name string
		mod  time.Time
	}
	files := make([]fmeta, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !galleryExts[strings.ToLower(filepath.Ext(e.Name()))] {
			continue
		}
		mt := time.Time{}
		if info, ierr := e.Info(); ierr == nil {
			mt = info.ModTime()
		}
		files = append(files, fmeta{e.Name(), mt})
	}
	// Newest first, by actual file date.
	sort.Slice(files, func(i, j int) bool { return files[i].mod.After(files[j].mod) })

	// Filtering needs metadata for the whole set → use the cache.
	active := filter.Engine != "" || filter.ModelCode != "" || filter.Source != ""
	var cache map[string]*types.GenerationMeta
	if active {
		cache = a.galleryMeta(dir)
		kept := files[:0]
		for _, f := range files {
			if matchFilter(cache[f.name], filter) {
				kept = append(kept, f)
			}
		}
		files = kept
	}

	if offset < 0 {
		offset = 0
	}
	if offset >= len(files) {
		return []types.SavedImage{}, nil
	}
	end := offset + limit
	if limit <= 0 || end > len(files) {
		end = len(files)
	}
	out := make([]types.SavedImage, 0, end-offset)
	for _, fm := range files[offset:end] {
		p := filepath.Join(dir, fm.name)
		source, seed := parseSavedName(fm.name)
		w, h := imageDims(p)
		var mptr *types.GenerationMeta
		if cache != nil {
			mptr = cache[fm.name]
		} else {
			mptr = readSidecar(p)
		}
		out = append(out, types.SavedImage{
			Name: fm.name, Source: source, Seed: seed, SavedPath: p, Width: w, Height: h, Meta: mptr,
		})
	}
	return out, nil
}

// readSidecar loads "<imgPath>.json" if present. nil when absent/unparseable.
func readSidecar(imgPath string) *types.GenerationMeta {
	raw, err := os.ReadFile(imgPath + ".json")
	if err != nil {
		return nil
	}
	var m types.GenerationMeta
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil
	}
	return &m
}

func matchFilter(m *types.GenerationMeta, f types.GalleryFilter) bool {
	if f.Engine == "" && f.ModelCode == "" && f.Source == "" {
		return true
	}
	if m == nil {
		return false // an active filter excludes images without metadata
	}
	if f.Engine != "" && m.Engine != f.Engine {
		return false
	}
	if f.ModelCode != "" && m.ModelCode != f.ModelCode {
		return false
	}
	if f.Source != "" && m.Source != f.Source {
		return false
	}
	return true
}

// galleryMeta returns the derived name→meta cache, (re)building it by reading
// every sidecar when invalid. The sidecars stay the source of truth.
func (a *App) galleryMeta(dir string) map[string]*types.GenerationMeta {
	a.galleryMu.Lock()
	if a.galleryValid && a.galleryCache != nil {
		c := a.galleryCache
		a.galleryMu.Unlock()
		return c
	}
	a.galleryMu.Unlock()

	cache := map[string]*types.GenerationMeta{}
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			if e.IsDir() || !galleryExts[strings.ToLower(filepath.Ext(e.Name()))] {
				continue
			}
			if m := readSidecar(filepath.Join(dir, e.Name())); m != nil {
				cache[e.Name()] = m
			}
		}
	}
	a.galleryMu.Lock()
	a.galleryCache = cache
	a.galleryValid = true
	a.galleryMu.Unlock()
	return cache
}

// GalleryFacets returns the distinct filterable values across the whole gallery
// (with counts), for building the filter UI.
func (a *App) GalleryFacets() (types.GalleryFacets, error) {
	cache := a.galleryMeta(a.outputDir())
	models := map[string]*types.Facet{}
	engines := map[string]int{}
	sources := map[string]int{}
	for _, m := range cache {
		if m == nil {
			continue
		}
		if m.ModelCode != "" {
			f := models[m.ModelCode]
			if f == nil {
				f = &types.Facet{Value: m.ModelCode, Label: m.ModelName}
				models[m.ModelCode] = f
			}
			if f.Label == "" {
				f.Label = m.ModelName
			}
			f.Count++
		}
		if m.Engine != "" {
			engines[m.Engine]++
		}
		if m.Source != "" {
			sources[m.Source]++
		}
	}
	// Non-nil slices → JSON [] (not null), so the renderer can read .length safely.
	out := types.GalleryFacets{
		Models:  []types.Facet{},
		Engines: []types.Facet{},
		Sources: []types.Facet{},
	}
	for _, f := range models {
		if f.Label == "" {
			f.Label = f.Value
		}
		out.Models = append(out.Models, *f)
	}
	for k, c := range engines {
		out.Engines = append(out.Engines, types.Facet{Value: k, Label: k, Count: c})
	}
	for k, c := range sources {
		out.Sources = append(out.Sources, types.Facet{Value: k, Label: k, Count: c})
	}
	byCountDesc := func(s []types.Facet) {
		sort.Slice(s, func(i, j int) bool {
			if s[i].Count != s[j].Count {
				return s[i].Count > s[j].Count
			}
			return s[i].Label < s[j].Label
		})
	}
	byCountDesc(out.Models)
	byCountDesc(out.Engines)
	byCountDesc(out.Sources)
	return out, nil
}

// imageDims reads only the image header to get pixel dimensions (cheap; no full
// decode). Returns 0,0 for formats without a registered decoder (e.g. webp).
func imageDims(path string) (int, int) {
	f, err := os.Open(path)
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return 0, 0
	}
	return cfg.Width, cfg.Height
}

// DeleteSavedImage removes one file from the output folder. Destructive — the
// renderer confirms first.
func (a *App) DeleteSavedImage(name string) error {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return errors.New("invalid image name")
	}
	p := filepath.Join(a.outputDir(), name)
	if err := os.Remove(p); err != nil {
		return err
	}
	_ = os.Remove(p + ".json") // best-effort: drop the metadata sidecar too
	a.invalidateGalleryCache()
	a.bus.Info("app", "deleted saved image", map[string]any{"name": name})
	return nil
}

// parseSavedName pulls source + seed out of "<ts>_<source>_<seed>.<ext>".
// Best-effort: returns ("", 0) for names that don't match.
func parseSavedName(name string) (source string, seed int) {
	base := strings.TrimSuffix(name, filepath.Ext(name))
	parts := strings.Split(base, "_")
	if len(parts) < 3 {
		return "", 0
	}
	seed, _ = strconv.Atoi(parts[len(parts)-1])
	source = strings.Join(parts[1:len(parts)-1], "_")
	return source, seed
}

// GetSavedImage reads one gallery file and returns it as a base64 data URL. Goes
// through the Wails bridge (not an HTTP route) so it works identically in
// `wails dev`, the packaged build, and on Windows. The renderer calls it lazily
// per tile (only when scrolled into view), so a large history stays cheap.
func (a *App) GetSavedImage(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", errors.New("invalid image name")
	}
	raw, err := os.ReadFile(filepath.Join(a.outputDir(), name))
	if err != nil {
		return "", err
	}
	mimeType := mime.TypeByExtension(filepath.Ext(name))
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}
	return "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(raw), nil
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

		// No ModelPath: the engine install no longer bundles a default checkpoint.
		// Model weights are downloaded on demand when the user picks one from the
		// catalog (SelectLocalModel), keyed by its im_engine backend.
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
		// A reinstall keeps a valid prior model, but a from-scratch install (cache
		// dir wiped) can inherit a dangling SDXLPath from the surviving
		// settings.json — drop it so we don't try to load missing weights.
		if s.SDXLPath != "" {
			if _, err := os.Stat(s.SDXLPath); err != nil {
				a.bus.Warn("app", "post-install: selected model weights missing; clearing", map[string]any{"path": s.SDXLPath})
				s.SDXLPath = ""
				s.LocalModel = nil
			}
		}
		if _, err := a.settings.Save(s); err != nil {
			a.bus.Error("app", "post-install settings save failed", map[string]any{"err": err.Error()})
		}

		// Restart the sidecar after install only when a valid model is already
		// configured — the pre-install Stop() left it "stopped". With no model
		// yet, starting would just fail "settings incomplete"; the upcoming model
		// selection (SelectLocalModel) restarts it once weights are on disk.
		if s.SDXLPath == "" {
			a.bus.Info("app", "install complete; awaiting model selection before sidecar start", nil)
		} else {
			a.bus.Info("app", "restarting sidecar after install", nil)
			if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime); rerr != nil {
				a.bus.Warn("app", "post-install sidecar restart failed", map[string]any{"err": rerr.Error()})
			}
		}
	}()

	// Goroutine #2: forward progress events to the renderer.
	go func() {
		for p := range progress {
			if a.app != nil {
				a.app.Event.Emit("install:progress", p)
			}
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

// resolveSidecarDir returns the directory holding the sidecar Python wrapper.
// In a dev checkout the on-disk "sidecar/" is preferred so edits are live under
// `wails dev`; a packaged binary has no such folder, so we extract the embedded
// copy (bundled via //go:embed in main.go) to a stable, writable location.
func resolveSidecarDir() (string, error) {
	// Dev: an on-disk sidecar/ next to the working dir (or up from build/bin).
	for _, c := range []string{"sidecar", filepath.Join("..", "..", "sidecar")} {
		if abs, err := filepath.Abs(c); err == nil {
			if _, err := os.Stat(filepath.Join(abs, "main.py")); err == nil {
				return abs, nil
			}
		}
	}
	// Packaged: materialize the embedded wrapper.
	return extractEmbeddedSidecar()
}

// extractEmbeddedSidecar writes the embedded sidecar files to
// "<UserCacheDir>/imference-desktop-go/sidecar" (i.e. %LOCALAPPDATA%\… on
// Windows), rewriting only when missing or changed so the extracted copy tracks
// the running app version. Returns the directory.
func extractEmbeddedSidecar() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "imference-desktop-go", "sidecar")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	for _, name := range []string{"main.py", "requirements.txt"} {
		data, err := sidecarFiles.ReadFile("sidecar/" + name)
		if err != nil {
			return "", fmt.Errorf("read embedded sidecar/%s: %w", name, err)
		}
		dst := filepath.Join(dir, name)
		if cur, err := os.ReadFile(dst); err == nil && bytes.Equal(cur, data) {
			continue // up to date
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return "", fmt.Errorf("write %s: %w", dst, err)
		}
	}
	return dir, nil
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
