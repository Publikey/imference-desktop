package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // register decoders for image.DecodeConfig (dimensions)
	_ "image/jpeg" //
	_ "image/png"  //
	"io/fs"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/cloudjobs"
	"imference-desktop-go/internal/components"
	"imference-desktop-go/internal/diskspace"
	"imference-desktop-go/internal/imagesink"
	"imference-desktop-go/internal/installer"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelcache"
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

	// cloudJobs persists in-flight cloud generations so an app close / timeout
	// doesn't orphan a paid-for result — resumed on launch. cloudBusy tracks
	// job ids currently owned by a live call OR an active resume, so Recheck
	// never double-polls the same request. Both nil-safe / mutex-guarded.
	cloudJobs *cloudjobs.Store
	cloudMu   sync.Mutex
	cloudBusy map[string]bool

	// modelCache indexes the downloaded weights so several models can live on
	// disk at once (switching back is then instant) under a size quota. nil when
	// the index couldn't be opened — every use must be nil-safe. cacheMu
	// serialises plan-then-delete against a manual deletion from the UI.
	modelCache *modelcache.Store
	cacheMu    sync.Mutex

	// gallery metadata cache (name → sidecar meta) for cheap filtering/facets.
	// The sidecars remain the source of truth; this is a derived, invalidated
	// cache — rebuilt on demand, dropped whenever a save/delete changes the set.
	galleryMu    sync.Mutex
	galleryCache map[string]*types.GenerationMeta
	galleryValid bool

	// components pre-downloads a model's shared base components (text encoder /
	// VAE / tokenizer) from the CDN mirror so the first generation never hides
	// a multi-GB pull behind "generating". compMu/compBusy serialize: one
	// download at a time, UI-triggered.
	components *components.Manager
	compMu     sync.Mutex
	compBusy   bool

	// dlCancel aborts an in-flight local model download (SelectLocalModel). Set
	// while a download runs, nil otherwise; guarded by dlMu.
	dlMu     sync.Mutex
	dlCancel context.CancelFunc
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

	// Pending-cloud store is best-effort: a failure here (rare — same UserConfigDir
	// as settings) just disables resume, it must not stop the app booting.
	cloudStore, cjErr := cloudjobs.New()
	if cjErr != nil {
		bus.Warn("app", "pending-cloud store unavailable — interrupted cloud jobs won't resume", map[string]any{"err": cjErr.Error()})
	}

	// Weights-cache index, same best-effort policy: without it the app still
	// downloads and runs models, it just can't enforce a quota or list what's
	// cached. Never a reason to fail startup.
	var cacheStore *modelcache.Store
	if dir, mdErr := modelsDir(); mdErr == nil {
		if mc, mcErr := modelcache.New(dir); mcErr == nil {
			cacheStore = mc
		} else {
			bus.Warn("app", "model cache index unavailable — quota disabled", map[string]any{"err": mcErr.Error()})
		}
	}

	a := &App{
		bus:        bus,
		settings:   store,
		cloud:      cloud.New(bus),
		installer:  installer.New(bus),
		cloudJobs:  cloudStore,
		cloudBusy:  map[string]bool{},
		modelCache: cacheStore,
		components: components.New(bus),
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
		// Custom checkpoints answer their own capability questions from the
		// backend that loads them — no catalog, no network, so do it up front.
		a.backfillCustomRefImages()
		// Align the weights index with the disk BEFORE anything can act on it:
		// picks up files left by older builds, drops ones deleted by hand, and
		// sweeps stray .part files. Cheap (ReadDir + stat), so it stays inline.
		a.reconcileModelCache()
		// Attaching catalog identity needs the network, so it runs on its own and
		// simply retries next launch when offline. Re-resolving the persisted
		// model snapshots needs the same (now warm) catalog, so it rides along.
		go func() {
			a.relabelModelCache()
			a.refreshCatalogSnapshots()
		}()
		a.bus.Info("app", "sidecar left stopped at startup — start it from the engine control", nil)
		// Force the venv engine to the pinned version if it drifted (e.g. an
		// older install whose diffusers doesn't actually offload). No-op when
		// the versions match, the venv is absent, or a dev source override is set.
		a.ensureEngineUpToDate()
	}()

	// Resume any cloud generations interrupted by the last close. A short delay
	// lets the renderer mount + subscribe to "cloud:resolved" first, so a job
	// that finishes instantly still updates the Activity list.
	go func() {
		time.Sleep(2 * time.Second)
		if n := len(a.ListPendingCloudJobs()); n > 0 {
			a.bus.Info("app", "resuming interrupted cloud generations", map[string]any{"count": n})
		}
		a.resumePendingCloud()
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
	dirty := false

	// Purge custom-registry entries whose file has moved/been deleted.
	if len(s.CustomModels) > 0 {
		kept := s.CustomModels[:0]
		for _, m := range s.CustomModels {
			if _, err := os.Stat(m.LocalPath); err == nil {
				kept = append(kept, m)
			} else {
				a.bus.Warn("app", "custom model file missing; dropping from registry", map[string]any{"path": m.LocalPath})
				dirty = true
			}
		}
		s.CustomModels = kept
	}

	if s.SDXLPath != "" {
		if _, err := os.Stat(s.SDXLPath); err != nil {
			a.bus.Warn("app", "selected model weights missing; clearing stale selection", map[string]any{"path": s.SDXLPath})
			s.SDXLPath = ""
			s.LocalModel = nil
			dirty = true
		}
	}

	if dirty {
		if _, err := a.settings.Save(s); err != nil {
			a.bus.Error("app", "clear stale model save failed", map[string]any{"err": err.Error()})
		}
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
	// Lowering the quota must have a visible effect right away, but the settings
	// dialog auto-saves — so sweep in the background and let the call return.
	if saved.ModelCacheQuotaBytes != prev.ModelCacheQuotaBytes && a.cacheQuota() < a.modelCacheTotal() {
		go a.sweepQuota("")
	}

	restart := settings.SidecarConfigChanged(prev, saved) && a.sidecar.Status().State == "ready"
	a.bus.Info("app", "SaveSettings ok", map[string]any{"sidecarRestart": restart})
	if restart {
		go func() {
			// Defer the restart to the current generation so an engine-affecting
			// settings change mid-run doesn't kill the in-flight image.
			a.sidecar.WaitForIdle()
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

// StopLocalGeneration aborts the in-flight local generation. runqy_python's task
// loop is single-threaded — while a denoise runs it isn't reading stdin, so the
// running image can't be cancelled cooperatively. We hard-kill the sidecar
// (which aborts the current generate) and reload the model so the engine is
// ready for the next queued job. Returns immediately; the restart runs in the
// background and the killed request's Generate call fails, which the renderer
// maps to a "stopped" job. No-op when nothing is generating.
func (a *App) StopLocalGeneration() error {
	if !a.sidecar.IsGenerating() {
		return nil
	}
	a.bus.Info("app", "StopLocalGeneration requested", nil)
	s := a.settings.Get()
	go func() {
		if err := a.sidecar.Interrupt(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime); err != nil {
			a.bus.Warn("app", "StopLocalGeneration restart failed", map[string]any{"err": err.Error()})
		}
	}()
	return nil
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

	normalizeRefImages(&req)
	meta := cloudMeta(req, s.CloudModelInfo)
	rail := cloudRail(s.PaymentMode)
	jobID := newCloudJobID()

	// Persist the job the moment the server accepts it, so an app close / crash /
	// timeout mid-flight can resume it (the result lives server-side forever).
	// Mark it busy so a concurrent Recheck doesn't double-poll the same request.
	onEnqueued := func(requestID, kind string) {
		a.setCloudBusy(jobID, true)
		if a.cloudJobs != nil {
			m := meta
			if err := a.cloudJobs.Add(types.PendingCloudJob{
				JobID: jobID, RequestID: requestID, Kind: kind, Rail: rail,
				Prompt: req.Prompt, Meta: &m, CreatedAt: time.Now().Format(time.RFC3339),
			}); err != nil {
				a.bus.Warn("app", "persist pending cloud job failed", map[string]any{"err": err.Error()})
			}
		}
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
		result, err = a.cloud.GenerateX402(a.ctx, s.CloudModel, req, w, onEnqueued)
	default:
		if s.APIKey == "" {
			a.bus.Warn("app", "GenerateCloud: API key not set", nil)
			return types.GenerationResult{}, errors.New("Cloud API key not set")
		}
		result, err = a.cloud.Generate(a.ctx, s.APIKey, s.CloudModel, req, onEnqueued)
	}

	// Clear the record only on a DEFINITIVE outcome: success, or a terminal
	// failure (server said 422 / auth). A timeout / network error leaves the
	// record in place so the next launch (or Recheck) reclaims the result.
	a.setCloudBusy(jobID, false)
	if err == nil || cloud.IsTerminal(err) {
		a.dropPendingCloud(jobID)
	} else {
		a.bus.Info("app", "cloud job left pending for resume", map[string]any{"job": jobID, "err": err.Error()})
	}

	if err != nil {
		return result, err
	}
	a.autoSave(&result, meta)
	return result, nil
}

// cloudRail maps the settings payment mode to a pending-record rail tag.
func cloudRail(paymentMode string) string {
	if paymentMode == "x402" {
		return "x402"
	}
	return "credits"
}

// newCloudJobID returns a short random id correlating a persisted cloud job with
// its resumed Activity row + completion event.
func newCloudJobID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "cloud_" + hex.EncodeToString(b[:])
}

func (a *App) setCloudBusy(jobID string, busy bool) {
	a.cloudMu.Lock()
	defer a.cloudMu.Unlock()
	if busy {
		a.cloudBusy[jobID] = true
	} else {
		delete(a.cloudBusy, jobID)
	}
}

func (a *App) isCloudBusy(jobID string) bool {
	a.cloudMu.Lock()
	defer a.cloudMu.Unlock()
	return a.cloudBusy[jobID]
}

func (a *App) dropPendingCloud(jobID string) {
	if a.cloudJobs == nil {
		return
	}
	if err := a.cloudJobs.Remove(jobID); err != nil {
		a.bus.Warn("app", "remove pending cloud job failed", map[string]any{"err": err.Error()})
	}
}

// ListPendingCloudJobs returns the cloud generations persisted as in-flight, so
// the renderer can rehydrate the Activity list on launch. Excludes any currently
// owned by a live call/resume (those settle through their own path).
func (a *App) ListPendingCloudJobs() []types.PendingCloudJob {
	if a.cloudJobs == nil {
		return []types.PendingCloudJob{}
	}
	out := []types.PendingCloudJob{}
	for _, j := range a.cloudJobs.List() {
		if !a.isCloudBusy(j.JobID) {
			out = append(out, j)
		}
	}
	return out
}

// RecheckPendingCloud re-polls every persisted pending job that isn't already
// being handled. Fired by the Activity "Recheck" action; also runs once at
// startup. Each resumed job settles via the "cloud:resolved" event.
func (a *App) RecheckPendingCloud() {
	a.resumePendingCloud()
}

// DropPendingCloudJob forgets a persisted cloud job on the user's request — the
// manual escape hatch for a row wedged on "Running in the cloud…" (a request_id
// the server will never resolve). It does NOT cancel anything server-side; the
// result, if one ever lands, stays retrievable by request_id. Any resume already
// in flight is left to finish harmlessly: it will simply find no record to drop.
func (a *App) DropPendingCloudJob(jobID string) {
	a.bus.Info("app", "pending cloud job dismissed by user", map[string]any{"job": jobID})
	a.dropPendingCloud(jobID)
}

// resumePendingCloud spawns a background resume for each pending record not
// already in flight. On completion it emits "cloud:resolved" ({jobId, result}
// or {jobId, error}) and drops the record.
func (a *App) resumePendingCloud() {
	if a.cloudJobs == nil {
		return
	}
	for _, job := range a.cloudJobs.List() {
		if a.isCloudBusy(job.JobID) {
			continue // a live call or another resume already owns it
		}
		a.setCloudBusy(job.JobID, true)
		go a.resumeOne(job)
	}
}

// pendingCloudMaxAge bounds how long a pending record may survive unresolved.
// Each resume attempt is capped (cloud.pollBudget), but nothing capped the job's
// TOTAL life: a request_id the server answers 404 for forever
// (a run dropped from the queue) reads as "not ready yet", so the record was
// retried on every launch and its Activity row stayed "Running in the cloud…"
// indefinitely. 6 h is far beyond any real queue wait, and short enough that a
// dead run doesn't outlive the session that started it by more than an evening.
const pendingCloudMaxAge = 6 * time.Hour

// pendingCloudExpired reports whether a record is past pendingCloudMaxAge. An
// unparseable/empty CreatedAt counts as expired: without a timestamp the job's
// age can never be bounded, which is exactly the state we're trying to end.
func pendingCloudExpired(job types.PendingCloudJob, now time.Time) bool {
	created, err := time.Parse(time.RFC3339, job.CreatedAt)
	if err != nil {
		return true
	}
	return now.Sub(created) > pendingCloudMaxAge
}

// resumeOne re-polls + downloads one persisted job and reports the outcome to
// the renderer. Keeps the record on a recoverable error (try again next time);
// drops it on success, terminal failure, or old age.
func (a *App) resumeOne(job types.PendingCloudJob) {
	defer a.setCloudBusy(job.JobID, false)

	// Give up before spending another poll budget on a job that has outlived
	// any plausible queue wait. Reported as an error so the row settles into
	// something the user can see and dismiss, instead of vanishing silently.
	if pendingCloudExpired(job, time.Now()) {
		a.bus.Warn("app", "abandoning stale cloud job", map[string]any{
			"job": job.JobID, "request_id": job.RequestID, "created": job.CreatedAt,
		})
		a.dropPendingCloud(job.JobID)
		a.emitCloudResolved(job.JobID, nil, "cloud: generation abandoned — still not ready after 6h; the run never completed server-side")
		return
	}

	apiKey := ""
	if job.Rail != "x402" {
		apiKey = a.settings.Get().APIKey
	}
	result, err := a.cloud.Resume(a.ctx, job.Rail, apiKey, job.RequestID)
	if err != nil {
		if cloud.IsTerminal(err) {
			a.dropPendingCloud(job.JobID)
			a.emitCloudResolved(job.JobID, nil, err.Error())
		}
		// Non-terminal (timeout/network): keep the record, stay silent — the next
		// launch or Recheck retries it.
		return
	}

	meta := types.GenerationMeta{}
	if job.Meta != nil {
		meta = *job.Meta
	}
	a.autoSave(&result, meta)
	a.dropPendingCloud(job.JobID)
	a.emitCloudResolved(job.JobID, &result, "")
	a.bus.Info("app", "resumed cloud job", map[string]any{"job": job.JobID, "request_id": job.RequestID})
}

// emitCloudResolved notifies the renderer that a resumed job finished (or
// failed). The frontend settles the matching Activity row.
func (a *App) emitCloudResolved(jobID string, result *types.GenerationResult, errMsg string) {
	if a.app == nil {
		return
	}
	a.app.Event.Emit("cloud:resolved", map[string]any{
		"jobId":  jobID,
		"result": result,
		"error":  errMsg,
	})
}

// GenerateLocal dispatches to the running Python sidecar. The sidecar
// itself is single-threaded (the Engine is stateful) so concurrent calls
// queue up server-side; that's intentional for the POC.
func (a *App) GenerateLocal(req types.GenerationRequest) (types.GenerationResult, error) {
	normalizeRefImages(&req)
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

// normalizeRefImages keeps RefImages[0] and SourceImage in sync, so callers may
// fill either one and everything downstream sees both.
//
// Slot 0 IS the img2img source: the sidecar and the engine have always spoken
// "source_image", and reference images are additive on top of that contract
// rather than a replacement for it. Empty slots are trimmed so a request never
// carries "" placeholders.
func normalizeRefImages(req *types.GenerationRequest) {
	kept := req.RefImages[:0]
	for _, s := range req.RefImages {
		if strings.TrimSpace(s) != "" {
			kept = append(kept, s)
		}
	}
	req.RefImages = kept

	switch {
	case len(req.RefImages) > 0 && req.SourceImage == "":
		req.SourceImage = req.RefImages[0]
	case len(req.RefImages) == 0 && req.SourceImage != "":
		req.RefImages = []string{req.SourceImage}
	}
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
	// Scheduler + clip-skip are CLIP/sampler-scheduler concepts — only SDXL and
	// SD 1.5 use them. The flow-matching backends (Z-Image, FLUX, Chroma,
	// Qwen-Image, Anima) fix their scheduler at load and have no CLIP-skip, so the
	// engine ignores both; don't inject them. SDXL/SD1.5 keep the model's catalog
	// defaults when the caller left them unset.
	if m.BackendType == "sdxl" || m.BackendType == "sd15" {
		if req.Scheduler == "" {
			req.Scheduler = m.SchedulerDefault
		}
		if req.ClipSkip == nil && m.SkipDefault != nil && *m.SkipDefault > 0 {
			skip := *m.SkipDefault
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

// SelectLocalModel makes the chosen model active, downloading its weights only
// when they aren't already cached, then restarts the sidecar so they load.
// Returns immediately; progress streams on the "model:progress" event
// ({phase:"done"|"error"} terminates).
//
// Previously downloaded models are KEPT (up to the cache quota), so coming back
// to one is a restart rather than a multi-GB re-download. Making room, when
// needed, evicts least-recently-used models — never the active one.
func (a *App) SelectLocalModel(modelCode string) error {
	chosen, err := a.localCatalogModel(modelCode)
	if err != nil {
		return err
	}

	dir, err := modelsDir()
	if err != nil {
		return err
	}
	cacheKey := modelcache.FileName(chosen.ModelCode, chosen.ModelURL)
	newPath := filepath.Join(dir, cacheKey)

	emit := func(p types.InstallProgress) {
		if a.app != nil {
			a.app.Event.Emit("model:progress", p)
		}
	}

	// Per-download cancelable context so CancelModelDownload can abort just this
	// fetch (not the whole app). Registered now, cleared when the goroutine ends.
	dlCtx, cancelDL := context.WithCancel(a.ctx)
	a.dlMu.Lock()
	if a.dlCancel != nil {
		a.dlCancel() // shouldn't happen (button is disabled), but never leak
	}
	a.dlCancel = cancelDL
	a.dlMu.Unlock()

	go func() {
		defer func() {
			cancelDL()
			a.dlMu.Lock()
			a.dlCancel = nil
			a.dlMu.Unlock()
		}()

		emit(types.InstallProgress{
			Phase: "model", Message: "Preparing " + chosen.Name,
			MessageKey: "progress.preparing", MessageArgs: map[string]string{"name": chosen.Name},
		})
		a.bus.Info("app", "SelectLocalModel start", map[string]any{"model": chosen.ModelCode, "url": chosen.ModelURL})

		// Never interrupt an in-flight generation: wait for the current image to
		// finish before tearing the engine down. The renderer's queue also defers
		// the switch until its local queue drains, so this is normally instant;
		// it's the guard for the single request already handed to the sidecar.
		if a.sidecar.IsGenerating() {
			emit(types.InstallProgress{
				Phase: "model", Message: "Waiting for the current generation to finish…",
				MessageKey: "progress.waitingGeneration",
			})
			a.sidecar.WaitForIdle()
		}

		// Stop the sidecar before downloading/evicting: the active .safetensors is
		// mmap'd by the running engine, so we must release it first (and on
		// Windows an open file can't be deleted at all).
		a.sidecar.Stop()

		// Migrate a file downloaded by an older build to the canonical name, so
		// upgrading never re-downloads weights already on disk. relabelModelCache
		// does the same thing earlier when the catalog is reachable; both are
		// idempotent and either one is enough.
		a.migrateLegacyWeights(chosen, newPath, cacheKey)

		// Cache hit: the weights are already here. No probe, no eviction, no
		// download — just load them.
		reuseFloor := a.reuseFloor(cacheKey)
		if fi, serr := os.Stat(newPath); serr == nil && fi.Size() >= reuseFloor {
			a.bus.Info("app", "using cached weights", map[string]any{"model": chosen.ModelCode, "bytes": fi.Size()})
			emit(types.InstallProgress{
				Phase: "model", Message: "Using cached " + chosen.Name,
				MessageKey: "progress.usingCached", MessageArgs: map[string]string{"name": chosen.Name},
			})
		} else {
			if !a.prepareCacheSpace(dlCtx, chosen, cacheKey, emit) {
				return // reported already (out of disk, or cancelled)
			}
			_, derr := modelfetch.New(a.bus).Fetch(dlCtx, chosen.ModelURL, newPath, reuseFloor,
				func(p modelfetch.Progress) {
					emit(types.InstallProgress{
						Phase:      "model",
						Message:    fmt.Sprintf("Downloading %s — %s / %s", chosen.Name, humanBytes(p.Downloaded), humanBytes(p.Total)),
						MessageKey: "progress.downloading",
						MessageArgs: map[string]string{
							"name": chosen.Name, "done": humanBytes(p.Downloaded), "total": humanBytes(p.Total),
						},
						PercentEstimate: p.Percent,
					})
				},
			)
			if derr != nil {
				// User aborted: no error state — restore the previous engine so local
				// mode stays usable, then report a clean "cancelled".
				if errors.Is(derr, context.Canceled) {
					a.bus.Info("app", "SelectLocalModel cancelled", map[string]any{"model": chosen.ModelCode})
					if s := a.settings.Get(); s.SDXLPath != "" && s.LocalModel != nil {
						_ = a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime)
					}
					emit(types.InstallProgress{
						Phase: "cancelled", Message: "Download cancelled",
						MessageKey: "progress.downloadCancelled", Done: true,
					})
					return
				}
				a.bus.Error("app", "SelectLocalModel download failed", map[string]any{"err": derr.Error()})
				emit(types.InstallProgress{Phase: "error", Error: derr.Error(), Done: true})
				return
			}
		}

		// Index the weights and reclaim anything the new arrival superseded. The
		// old model is NOT deleted here — that's the whole point of the cache.
		a.indexCachedModel(chosen, cacheKey, newPath)

		s := a.settings.Get()
		s.SDXLPath = newPath
		s.LocalModel = chosen
		if _, serr := a.settings.Save(s); serr != nil {
			a.bus.Error("app", "SelectLocalModel settings save failed", map[string]any{"err": serr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: serr.Error(), Done: true})
			return
		}

		emit(types.InstallProgress{
			Phase: "model", Message: "Loading " + chosen.Name + " into the engine…",
			MessageKey: "progress.loadingEngine", MessageArgs: map[string]string{"name": chosen.Name},
			PercentEstimate: 100,
		})
		if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime); rerr != nil {
			a.bus.Warn("app", "SelectLocalModel sidecar restart failed", map[string]any{"err": rerr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: rerr.Error(), Done: true})
			return
		}
		a.bus.Info("app", "SelectLocalModel done", map[string]any{"model": chosen.ModelCode})
		emit(types.InstallProgress{
			Phase: "done", Message: chosen.Name + " ready",
			MessageKey: "progress.modelReady", MessageArgs: map[string]string{"name": chosen.Name},
			PercentEstimate: 100, Done: true,
		})
	}()

	return nil
}

// refreshCatalogSnapshots re-resolves the persisted model selections against the
// live catalog. settings.json stores whole ModelInfo snapshots so the UI has
// costs, formats and defaults before (or without) a network round-trip — which
// means they go stale the moment the catalog changes, and nobody re-picks a
// model they are already using just to refresh it. A model gaining a
// reference-image slot, a corrected step default or a new format would
// otherwise only reach the user on their next deliberate pick.
//
// Best-effort and quiet: no catalog, no change. Custom checkpoints are skipped
// entirely — they have no catalog row, and their snapshot IS the source of
// truth.
func (a *App) refreshCatalogSnapshots() {
	s := a.settings.Get()
	dirty := false

	if s.LocalModel != nil && s.LocalModel.LocalPath == "" {
		if m, err := a.localCatalogModel(s.LocalModel.ModelCode); err == nil && !reflect.DeepEqual(*m, *s.LocalModel) {
			s.LocalModel = m
			dirty = true
		}
	}
	if s.CloudModelInfo != nil {
		if m, err := a.cloudCatalogModel(s.CloudModelInfo.ModelCode); err == nil && !reflect.DeepEqual(*m, *s.CloudModelInfo) {
			s.CloudModelInfo = m
			dirty = true
		}
	}
	if !dirty {
		return
	}
	if _, err := a.settings.Save(s); err != nil {
		a.bus.Warn("app", "refreshing model snapshots failed", map[string]any{"err": err.Error()})
		return
	}
	a.bus.Info("app", "model snapshots refreshed from the catalog", nil)
	// The renderer read settings at mount, before this could finish — tell it.
	if a.app != nil {
		a.app.Event.Emit("settings:changed", s)
	}
}

// cloudCatalogModel resolves a model code against the cloud-runnable catalog.
func (a *App) cloudCatalogModel(modelCode string) (*types.ModelInfo, error) {
	models, err := a.cloud.ListModels(a.ctx, false)
	if err != nil {
		return nil, err
	}
	for i := range models {
		if models[i].ModelCode == modelCode {
			return &models[i], nil
		}
	}
	return nil, fmt.Errorf("model %q not found in the cloud catalog", modelCode)
}

// customRefImages is how many reference-image slots a user checkpoint offers:
// one for the backends whose local pipeline does img2img, none for the ones with
// no image input (Anima). Custom checkpoints never carry more — the multi-slot
// case (first + last frame) belongs to catalog video models.
func customRefImages(backendType string) int {
	if cloud.SupportsRefImages(backendType) {
		return 1
	}
	return 0
}

// Per-backend sampling recipes for user checkpoints. The catalog publishes
// these per model; a custom file has no row to ask, so we state the ENGINE
// FAMILY's recipe here (mirroring the engine's own per-backend defaults)
// rather than one generic guess — a Krea 2 Turbo checkpoint wants 8 steps and
// guidance OFF (cfg 0, Krea convention), not SDXL's 28/6. They must stay set:
// a nil default means "this model has no such knob", which would take the
// sliders away from a checkpoint that very much needs them.
type samplingBounds struct {
	steps, stepsMin, stepsMax int
	cfg, cfgMin, cfgMax       float64
}

var customSamplingByBackend = map[string]samplingBounds{
	"sdxl":   {28, 1, 50, 6.0, 1, 20},
	"sd15":   {25, 1, 50, 7.0, 1, 20},
	"zimage": {8, 1, 50, 1.0, 1, 10}, // turbo-family norm; a base finetune can slide up
	"flux":   {28, 1, 50, 3.5, 0, 10},
	"chroma": {28, 1, 50, 2.0, 0, 10},
	"qwenimage": {40, 1, 50, 4.0, 0, 10},
	"anima":     {28, 1, 50, 6.0, 1, 20},
	// Krea 2 Turbo: TDM-distilled — 8 steps, guidance OFF (cfg 0 in the Krea
	// convention; >0 re-enables CFG and doubles the transformer passes).
	"krea2": {8, 1, 16, 0.0, 0, 10},
}

var genericSampling = samplingBounds{28, 1, 50, 6.0, 1, 20}

func samplingFor(backend string) samplingBounds {
	if b, ok := customSamplingByBackend[backend]; ok {
		return b
	}
	return genericSampling
}

// withCustomSamplingDefaults stamps the backend's recipe onto a user checkpoint.
func withCustomSamplingDefaults(m *types.ModelInfo) {
	b := samplingFor(m.BackendType)
	steps, stepsMin, stepsMax := b.steps, b.stepsMin, b.stepsMax
	cfg, cfgMin, cfgMax := b.cfg, b.cfgMin, b.cfgMax
	m.StepsDefault, m.StepsMin, m.StepsMax = &steps, &stepsMin, &stepsMax
	m.CfgDefault, m.CfgMin, m.CfgMax = &cfg, &cfgMin, &cfgMax
}

// hasLegacyGenericStamp reports whether a checkpoint still carries the
// pre-per-backend GENERIC bounds (everything 28/1/50 + 6/1/20) although its
// backend now publishes a different recipe — e.g. a krea2 file registered
// before the split. Used by the startup backfill to migrate it.
func hasLegacyGenericStamp(m *types.ModelInfo) bool {
	g := genericSampling
	if samplingFor(m.BackendType) == g {
		return false // its recipe IS the generic one — nothing to migrate
	}
	return m.StepsDefault != nil && *m.StepsDefault == g.steps &&
		m.StepsMin != nil && *m.StepsMin == g.stepsMin &&
		m.StepsMax != nil && *m.StepsMax == g.stepsMax &&
		m.CfgDefault != nil && *m.CfgDefault == g.cfg &&
		m.CfgMin != nil && *m.CfgMin == g.cfgMin &&
		m.CfgMax != nil && *m.CfgMax == g.cfgMax
}

// backfillCustomRefImages fills RefImages on checkpoints registered before the
// field existed (it defaults to 0, which would wrongly hide the reference-image
// box on an SDXL checkpoint). Local, cheap, and idempotent — unlike the catalog
// snapshots, this needs no network, so it runs on the startup path.
func (a *App) backfillCustomRefImages() {
	s := a.settings.Get()
	dirty := false
	fix := func(m *types.ModelInfo) {
		if m == nil || m.LocalPath == "" {
			return
		}
		if want := customRefImages(m.BackendType); m.RefImages != want {
			m.RefImages = want
			dirty = true
		}
		// Entries saved before the sampling bounds became nullable carry a
		// literal 0 for EVERYTHING, which read as "unset". Zero STEPS is never
		// legitimate, so it stays the legacy detector — but cfg 0 now is (Krea 2
		// Turbo publishes cfgDefault 0 = guidance off), so only a NEGATIVE cfg
		// counts as garbage.
		if m.StepsDefault == nil || *m.StepsDefault <= 0 || m.CfgDefault == nil || *m.CfgDefault < 0 {
			withCustomSamplingDefaults(m)
			dirty = true
		}
		// Migrate entries stamped with the old one-size-fits-all bounds to
		// their backend's recipe (e.g. a krea2 checkpoint registered before the
		// per-backend split: 28 steps / cfg 6 → 8 steps / cfg 0).
		if hasLegacyGenericStamp(m) {
			withCustomSamplingDefaults(m)
			dirty = true
		}
	}
	for i := range s.CustomModels {
		fix(&s.CustomModels[i])
	}
	fix(s.LocalModel)
	if !dirty {
		return
	}
	if _, err := a.settings.Save(s); err != nil {
		a.bus.Warn("app", "backfilling custom model capabilities failed", map[string]any{"err": err.Error()})
		return
	}
	a.bus.Info("app", "custom model capabilities backfilled", nil)
	if a.app != nil {
		a.app.Event.Emit("settings:changed", s)
	}
}

// localCatalogModel resolves a model code against the local-runnable catalog.
func (a *App) localCatalogModel(modelCode string) (*types.ModelInfo, error) {
	models, err := a.cloud.ListModels(a.ctx, true)
	if err != nil {
		return nil, err
	}
	for i := range models {
		if models[i].ModelCode == modelCode {
			return &models[i], nil
		}
	}
	return nil, fmt.Errorf("model %q not found in catalog (or it's cloud-only)", modelCode)
}

// EnsureLocalModel activates a model whose weights are ALREADY on disk, and
// reports false without touching anything when they aren't.
//
// This is what the generate path calls: picking a cached model and hitting
// Generate should just work (the engine restart is the app's problem, not the
// user's), while starting a multi-GB download stays a deliberate, explicitly
// clicked act. A miss here means the file was evicted, deleted by hand, or the
// catalog re-pointed the model at new weights — all cases where the caller must
// fall back to SelectLocalModel, which downloads.
func (a *App) EnsureLocalModel(modelCode string) (bool, error) {
	chosen, err := a.localCatalogModel(modelCode)
	if err != nil {
		return false, err
	}
	dir, err := modelsDir()
	if err != nil {
		return false, err
	}
	cacheKey := modelcache.FileName(chosen.ModelCode, chosen.ModelURL)
	if !isCompleteWeightsFile(filepath.Join(dir, cacheKey), a.reuseFloor(cacheKey)) &&
		// A file left under the pre-cache naming scheme counts too: SelectLocalModel
		// renames it into place instead of downloading.
		!isCompleteWeightsFile(filepath.Join(dir, modelcache.LegacyFileName(chosen.ModelURL)), modelReuseMinBytes) {
		a.bus.Info("app", "EnsureLocalModel: weights not on disk", map[string]any{"model": modelCode})
		return false, nil
	}
	return true, a.SelectLocalModel(modelCode)
}

// isCompleteWeightsFile reports whether path holds a whole checkpoint (not a
// truncated leftover): present and at least floor bytes.
func isCompleteWeightsFile(path string, floor int64) bool {
	fi, err := os.Stat(path)
	return err == nil && fi.Size() >= floor
}

// CancelModelDownload aborts an in-flight local model download (if any). The
// download goroutine sees context.Canceled, cleans up the partial file, and
// emits a "cancelled" progress event; a no-op when nothing is downloading.
func (a *App) CancelModelDownload() {
	a.dlMu.Lock()
	cancel := a.dlCancel
	a.dlMu.Unlock()
	if cancel != nil {
		a.bus.Info("app", "CancelModelDownload requested", nil)
		cancel()
	}
}

// deleteManagedModel removes a downloaded model file, but ONLY when it lives
// inside our managed models directory — a guard so a user-supplied SDXLPath
// pointing at their own checkpoint elsewhere is never deleted.
//
// Reports whether the file is actually gone. Callers MUST check it before
// dropping the matching index entry: on Windows, deleting a file the engine has
// mmap'd fails with a sharing violation, and an index that forgot it would
// understate the cache and hand out space that was never freed. An
// already-missing file counts as success.
func (a *App) deleteManagedModel(p string) error {
	dir, err := modelsDir()
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(dir, p)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || strings.Contains(rel, string(filepath.Separator)+"..") {
		a.bus.Warn("app", "refusing to delete model outside managed dir", map[string]any{"path": p})
		return errors.New("path outside the managed models directory")
	}
	if err := os.Remove(p); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		a.bus.Warn("app", "delete model failed", map[string]any{"path": p, "err": err.Error()})
		return err
	}
	a.bus.Info("app", "deleted cached model", map[string]any{"path": p})
	return nil
}

// --- Weights cache -------------------------------------------------------

// protectedModelPaths lists the absolute paths the cache must never index or
// evict: every user-supplied checkpoint. They're referenced in place and could
// legitimately sit inside the managed dir (the user can point the file picker
// anywhere), so keeping them OUT of the index is stronger than flagging them —
// the eviction planner can't choose what it can't see.
func (a *App) protectedModelPaths() map[string]bool {
	out := map[string]bool{}
	s := a.settings.Get()
	add := func(p string) {
		if p == "" {
			return
		}
		if abs, err := filepath.Abs(p); err == nil {
			out[abs] = true
		}
	}
	for _, m := range s.CustomModels {
		add(m.LocalPath)
	}
	if s.LocalModel != nil && s.LocalModel.LocalPath != "" {
		add(s.LocalModel.LocalPath)
	}
	return out
}

// activeCacheKey is the cache key of the currently selected model, or "" when
// none is selected or it lives outside the managed dir (a custom checkpoint).
func (a *App) activeCacheKey() string {
	p := a.settings.Get().SDXLPath
	if p == "" || a.modelCache == nil {
		return ""
	}
	rel, err := filepath.Rel(a.modelCache.Dir(), p)
	if err != nil || rel != filepath.Base(p) {
		return "" // not directly inside the managed dir
	}
	return rel
}

// reconcileModelCache rebuilds the index from what's on disk. Runs at startup,
// before anything can consult the index.
func (a *App) reconcileModelCache() {
	if a.modelCache == nil {
		return
	}
	rep, err := a.modelCache.Reconcile(a.protectedModelPaths())
	if err != nil {
		a.bus.Warn("app", "model cache reconcile failed", map[string]any{"err": err.Error()})
		return
	}
	a.bus.Info("app", "model cache reconciled", map[string]any{
		"indexed": rep.Indexed, "dropped": rep.Dropped, "parts": rep.PartsRemoved,
		"orphans": rep.Orphans, "bytes": rep.TotalBytes,
	})
	a.emitCacheChanged()
}

// relabelModelCache attaches catalog identity to indexed files and migrates
// legacy filenames to the canonical scheme. Best-effort: needs the catalog.
func (a *App) relabelModelCache() {
	if a.modelCache == nil {
		return
	}
	models, err := a.cloud.ListModels(a.ctx, true)
	if err != nil {
		a.bus.Info("app", "model cache relabel skipped — catalog unavailable", map[string]any{"err": err.Error()})
		return
	}
	refs := make([]modelcache.CatalogRef, 0, len(models))
	for _, m := range models {
		refs = append(refs, modelcache.CatalogRef{ModelCode: m.ModelCode, ModelName: m.Name, ModelURL: m.ModelURL})
	}
	renamed, rerr := a.modelCache.Relabel(refs)
	if rerr != nil {
		a.bus.Warn("app", "model cache relabel failed", map[string]any{"err": rerr.Error()})
		return
	}
	// Rename first, THEN persist the new path. Crashing in between leaves a
	// selection pointing at a gone file, which clearStaleLocalModel clears on the
	// next launch — annoying, never destructive. The reverse order would point
	// settings at a file that doesn't exist yet.
	if len(renamed) > 0 {
		if s := a.settings.Get(); s.SDXLPath != "" {
			if to, ok := renamed[filepath.Base(s.SDXLPath)]; ok {
				s.SDXLPath = a.modelCache.Path(to)
				if _, serr := a.settings.Save(s); serr != nil {
					a.bus.Warn("app", "re-pointing SDXLPath after rename failed", map[string]any{"err": serr.Error()})
				}
			}
		}
		a.bus.Info("app", "model cache relabeled", map[string]any{"renamed": len(renamed)})
	}
	a.sweepQuota("")
	a.emitCacheChanged()
}

// cacheQuota / cacheMinFree resolve the effective limits (0 = default).
func (a *App) cacheQuota() int64 {
	if q := a.settings.Get().ModelCacheQuotaBytes; q > 0 {
		return q
	}
	return modelcache.DefaultQuotaBytes
}

// modelCacheTotal is the indexed cache size, 0 when there's no index.
func (a *App) modelCacheTotal() int64 {
	if a.modelCache == nil {
		return 0
	}
	return a.modelCache.TotalBytes()
}

func (a *App) cacheMinFree() int64 {
	if m := a.settings.Get().ModelCacheMinFreeBytes; m > 0 {
		return m
	}
	return defaultMinFreeBytes
}

// evictPlan builds the eviction plan for an incoming download of incomingBytes
// (0 when nothing is coming in — a plain sweep). Never plans the active model
// or targetKey.
func (a *App) evictPlan(targetKey string, incomingBytes int64) modelcache.Plan {
	if a.modelCache == nil {
		return modelcache.Plan{}
	}
	cands := modelcache.BuildCandidates(a.modelCache.List(), a.activeCacheKey(), targetKey)
	return modelcache.PlanEviction(cands, a.modelCache.TotalBytes(), incomingBytes, a.cacheQuota())
}

// applyEviction deletes the planned files and forgets only the ones that really
// went away. Returns the bytes actually reclaimed.
func (a *App) applyEviction(plan modelcache.Plan) int64 {
	if a.modelCache == nil || len(plan.Evict) == 0 {
		return 0
	}
	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()

	// Re-check protection at delete time, not just at plan time. Reconcile keeps
	// user checkpoints out of the index, but a file indexed as an orphan first
	// and registered as a custom model afterwards would still be in there.
	protected := a.protectedModelPaths()

	var freed int64
	for _, key := range plan.Evict {
		e, ok := a.modelCache.Get(key)
		if !ok {
			continue
		}
		if abs, aerr := filepath.Abs(a.modelCache.Path(key)); aerr == nil && protected[abs] {
			a.bus.Info("app", "skipping eviction of a registered custom model", map[string]any{"key": key})
			_ = a.modelCache.Delete(key) // stop tracking it: it's the user's file now
			continue
		}
		if err := a.deleteManagedModel(a.modelCache.Path(key)); err != nil {
			continue // file still there: keep the entry, the space isn't back
		}
		if derr := a.modelCache.Delete(key); derr != nil {
			a.bus.Warn("app", "cache index update failed after eviction", map[string]any{"err": derr.Error()})
		}
		freed += e.Bytes
	}
	if freed > 0 {
		a.bus.Info("app", "evicted cached models", map[string]any{"count": len(plan.Evict), "freed": freed})
		a.emitCacheChanged()
	}
	return freed
}

// sweepQuota brings the cache back under quota with nothing new coming in.
// A no-op when already under. protectKey is spared on top of the active model.
func (a *App) sweepQuota(protectKey string) {
	a.applyEviction(a.evictPlan(protectKey, 0))
}

// emitCacheChanged tells the renderer the cache contents moved, so the picker
// badges and the storage screen refresh.
func (a *App) emitCacheChanged() {
	if a.app != nil {
		a.app.Event.Emit("model:cache", nil)
	}
}

// reuseFloor is the size at which an existing file counts as a complete
// download. When the index knows the exact size we demand exactly that, which
// catches a file truncated by a hard kill; otherwise we fall back to the loose
// "plausibly a multi-GB checkpoint" bound.
func (a *App) reuseFloor(key string) int64 {
	if a.modelCache != nil {
		if e, ok := a.modelCache.Get(key); ok && e.Bytes > 0 {
			return e.Bytes
		}
	}
	return modelReuseMinBytes
}

// migrateLegacyWeights renames a file downloaded under the old URL-basename
// scheme to its canonical cache name, so an upgrading user never re-downloads
// what they already have. Silent no-op when there's nothing to migrate.
func (a *App) migrateLegacyWeights(chosen *types.ModelInfo, newPath, cacheKey string) {
	if a.modelCache == nil || chosen.ModelURL == "" {
		return
	}
	if _, err := os.Stat(newPath); err == nil || !errors.Is(err, fs.ErrNotExist) {
		return // already canonical (or an unreadable path — let Fetch report it)
	}
	legacyKey := modelcache.LegacyFileName(chosen.ModelURL)
	if legacyKey == cacheKey {
		return
	}
	legacyPath := a.modelCache.Path(legacyKey)
	fi, serr := os.Stat(legacyPath)
	if serr != nil || fi.Size() < modelReuseMinBytes {
		return
	}
	if rerr := os.Rename(legacyPath, newPath); rerr != nil {
		// Not fatal: the download below simply proceeds under the canonical name.
		a.bus.Warn("app", "legacy weights rename failed", map[string]any{"from": legacyPath, "err": rerr.Error()})
		return
	}
	if e, ok := a.modelCache.Get(legacyKey); ok {
		_ = a.modelCache.Delete(legacyKey)
		e.Key = cacheKey
		_ = a.modelCache.Put(e)
	}
	a.bus.Info("app", "migrated legacy weights filename", map[string]any{"from": legacyKey, "to": cacheKey})
}

// prepareCacheSpace makes room for an incoming download and enforces the
// free-space wall. Reports false when the caller must abort (already emitted).
//
// Order matters: the plan is computed and checked against free space BEFORE any
// file is deleted, so we never evict models and then fail anyway — the worst of
// both worlds.
func (a *App) prepareCacheSpace(ctx context.Context, chosen *types.ModelInfo, cacheKey string, emit func(types.InstallProgress)) bool {
	if a.modelCache == nil {
		return true // no index: no quota to enforce, download as before
	}

	incoming, perr := modelfetch.New(a.bus).Probe(ctx, chosen.ModelURL)
	if errors.Is(perr, context.Canceled) {
		emit(types.InstallProgress{
			Phase: "cancelled", Message: "Download cancelled",
			MessageKey: "progress.downloadCancelled", Done: true,
		})
		return false
	}
	if incoming <= 0 {
		incoming = defaultModelSizeEstimate
		a.bus.Info("app", "model size unknown — using estimate", map[string]any{"model": chosen.ModelCode})
	}

	plan := a.evictPlan(cacheKey, incoming)
	if plan.Shortfall > 0 {
		// The quota is a housekeeping target, not a wall: refusing here would
		// wedge the app whenever the active model alone eats the budget.
		a.bus.Warn("app", "cache quota can't fit this model — proceeding anyway", map[string]any{
			"model": chosen.ModelCode, "shortfall": plan.Shortfall,
		})
	}

	if free, ferr := diskspace.FreeBytes(a.modelCache.Dir()); ferr == nil {
		minFree := a.cacheMinFree()
		if free+plan.Freed < incoming+minFree {
			msg := fmt.Sprintf(
				"Not enough disk space for %s: needs %s plus a %s reserve, only %s free (%s would be reclaimed from cached models).",
				chosen.Name, humanBytes(incoming), humanBytes(minFree), humanBytes(free), humanBytes(plan.Freed),
			)
			a.bus.Error("app", "insufficient disk space for model download", map[string]any{
				"model": chosen.ModelCode, "need": incoming, "free": free, "reclaimable": plan.Freed,
			})
			emit(types.InstallProgress{
				Phase: "error", Error: msg, Done: true,
				MessageKey: "progress.noDiskSpace",
				MessageArgs: map[string]string{
					"name": chosen.Name, "need": humanBytes(incoming), "reserve": humanBytes(minFree),
					"free": humanBytes(free), "reclaimable": humanBytes(plan.Freed),
				},
			})
			return false // nothing downloaded, nothing deleted
		}
	}

	if len(plan.Evict) > 0 {
		emit(types.InstallProgress{
			Phase: "model", Message: "Freeing space — " + humanBytes(plan.Freed) + "…",
			MessageKey: "progress.freeingSpace", MessageArgs: map[string]string{"size": humanBytes(plan.Freed)},
		})
		a.applyEviction(plan)
	}
	return true
}

// indexCachedModel records freshly landed weights, drops any earlier file for
// the same model (the catalog re-pointed it, so the old one is dead weight),
// and re-checks the quota against the real size.
func (a *App) indexCachedModel(chosen *types.ModelInfo, cacheKey, path string) {
	if a.modelCache == nil {
		return
	}
	fi, err := os.Stat(path)
	if err != nil {
		a.bus.Warn("app", "cannot stat downloaded weights", map[string]any{"path": path, "err": err.Error()})
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	if perr := a.modelCache.Put(modelcache.Entry{
		Key:        cacheKey,
		ModelCode:  chosen.ModelCode,
		ModelName:  chosen.Name,
		URLHash:    modelcache.URLHash(chosen.ModelURL),
		Bytes:      fi.Size(),
		AddedAt:    now,
		LastUsedAt: now,
	}); perr != nil {
		a.bus.Warn("app", "cache index update failed", map[string]any{"err": perr.Error()})
	}

	// Supersession: same model, different file → the old one can never be
	// selected again, so reclaim it now instead of waiting for the LRU.
	for _, e := range a.modelCache.List() {
		if e.ModelCode != chosen.ModelCode || e.Key == cacheKey {
			continue
		}
		if a.deleteManagedModel(a.modelCache.Path(e.Key)) == nil {
			_ = a.modelCache.Delete(e.Key)
			a.bus.Info("app", "dropped superseded weights", map[string]any{"key": e.Key, "model": e.ModelCode})
		}
	}

	// The probe was an estimate; correct against reality.
	a.sweepQuota(cacheKey)
	a.emitCacheChanged()
}

// ListCachedModels returns the downloaded checkpoints, most recently used
// first. Served straight from the index — no disk walk, safe to call on every
// picker open.
func (a *App) ListCachedModels() []types.CachedModel {
	out := []types.CachedModel{}
	if a.modelCache == nil {
		return out
	}
	active := a.activeCacheKey()
	for _, e := range a.modelCache.List() {
		out = append(out, types.CachedModel{
			Key: e.Key, ModelCode: e.ModelCode, ModelName: e.ModelName,
			Bytes: e.Bytes, LastUsedAt: e.LastUsedAt,
			Active: e.Key == active, Orphan: e.ModelCode == "",
		})
	}
	return out
}

// GetStorageInfo is the cheap storage readout: index totals plus one syscall.
func (a *App) GetStorageInfo() types.StorageInfo {
	info := types.StorageInfo{QuotaBytes: a.cacheQuota(), MinFreeBytes: a.cacheMinFree()}
	if dir, err := modelsDir(); err == nil {
		info.ModelsDir = dir
		if free, ferr := diskspace.FreeBytes(dir); ferr == nil {
			info.FreeBytes = free
		}
	}
	if dir, err := sidecar.ModelCacheDir(); err == nil {
		info.BaseCacheDir = dir
	}
	if dir, err := engineVenvDir(); err == nil {
		info.EngineDir = dir
	}
	if a.modelCache != nil {
		info.UsedBytes = a.modelCache.TotalBytes()
	}
	return info
}

// GetFolderSizes walks the three cache trees. SLOW — the engine venv alone is
// tens of thousands of files — so it's deliberately separate from
// GetStorageInfo and the UI resolves it after painting.
func (a *App) GetFolderSizes() types.FolderSizes {
	var out types.FolderSizes
	if dir, err := modelsDir(); err == nil {
		out.ModelsBytes, _ = diskspace.DirSize(dir)
	}
	if dir, err := sidecar.ModelCacheDir(); err == nil {
		out.BaseCacheBytes, _ = diskspace.DirSize(dir)
	}
	if dir, err := engineVenvDir(); err == nil {
		out.EngineBytes, _ = diskspace.DirSize(dir)
	}
	return out
}

// DeleteCachedModel removes one downloaded checkpoint on the user's request.
// Refuses the active model — the engine has it mmap'd, so the delete would fail
// on Windows anyway, and a clear message beats a sharing violation.
//
// key is the only untrusted input reaching the filesystem here: it's validated,
// then joined, then confined by deleteManagedModel's guard.
func (a *App) DeleteCachedModel(key string) error {
	if a.modelCache == nil {
		return errors.New("model cache index unavailable")
	}
	if !modelcache.IsSafeKey(key) {
		a.bus.Warn("app", "rejected unsafe cache key", map[string]any{"key": key})
		return errors.New("invalid cache key")
	}
	if key == a.activeCacheKey() {
		return errors.New("this model is loaded in the engine — switch to another model first")
	}
	if _, ok := a.modelCache.Get(key); !ok {
		return errors.New("not a cached model")
	}

	a.cacheMu.Lock()
	defer a.cacheMu.Unlock()
	if err := a.deleteManagedModel(a.modelCache.Path(key)); err != nil {
		return err
	}
	if err := a.modelCache.Delete(key); err != nil {
		return err
	}
	a.emitCacheChanged()
	return nil
}

// PurgeBaseComponentsCache empties model-cache/, the shared text-encoder/VAE
// tree the Python engine fills from the CDN. Outside the LRU quota on purpose:
// those files are shared by every checkpoint of a family, so evicting them
// automatically would re-download 8–10 GB the next time any of them loads.
//
// The engine is stopped first: on Windows RemoveAll over open files fails
// halfway and leaves a half-destroyed tree, which is worse than refusing.
func (a *App) PurgeBaseComponentsCache() error {
	dir, err := sidecar.ModelCacheDir()
	if err != nil {
		return err
	}
	// Confinement: the path is computed, never supplied — assert it anyway
	// before handing it to RemoveAll.
	if filepath.Base(dir) != "model-cache" || !strings.Contains(filepath.ToSlash(dir), "imference-desktop-go") {
		return errors.New("refusing to purge an unexpected directory")
	}

	if a.sidecar.IsGenerating() {
		a.sidecar.WaitForIdle()
	}
	a.sidecar.Stop()

	if rerr := os.RemoveAll(dir); rerr != nil {
		a.bus.Error("app", "purge base components failed", map[string]any{"err": rerr.Error()})
		return rerr
	}
	if merr := os.MkdirAll(dir, 0o755); merr != nil {
		return merr
	}
	a.bus.Info("app", "purged base component cache", map[string]any{"dir": dir})
	a.emitCacheChanged()
	return nil
}

// OpenCacheFolder reveals one of the three known cache directories in the OS
// file manager. kind is an allow-list, never a path — the frontend can't ask
// for an arbitrary location.
func (a *App) OpenCacheFolder(kind string) error {
	var (
		dir string
		err error
	)
	switch kind {
	case "models":
		dir, err = modelsDir()
	case "base":
		dir, err = sidecar.ModelCacheDir()
	case "engine":
		dir, err = engineVenvDir()
	default:
		return fmt.Errorf("unknown folder %q", kind)
	}
	if err != nil {
		return err
	}
	if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
		return mkErr
	}
	return a.openFolder(dir)
}

// openFolder opens a directory in the OS file manager. Unlike RevealInFolder
// (which highlights one file under the output dir), callers here pass a path we
// computed ourselves, so there's nothing to confine.
func (a *App) openFolder(dir string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dir)
	case "windows":
		// explorer exits non-zero even on success; don't treat that as failure.
		_ = exec.Command("explorer", dir).Start()
		a.bus.Info("app", "opened folder", map[string]any{"dir": dir})
		return nil
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		a.bus.Warn("app", "open folder failed", map[string]any{"dir": dir, "err": err.Error()})
		return err
	}
	a.bus.Info("app", "opened folder", map[string]any{"dir": dir})
	return nil
}

// PickModelFile opens the native file picker filtered to .safetensors and
// returns the chosen absolute path, or "" when the user cancels.
func (a *App) PickModelFile() (string, error) {
	if a.app == nil {
		return "", errors.New("app not ready")
	}
	path, err := a.app.Dialog.OpenFile().
		SetTitle("Choose a .safetensors checkpoint").
		AddFilter("Safetensors checkpoint", "*.safetensors").
		PromptForSingleSelection()
	if err != nil {
		// Treat a dialog cancel surfaced as an error like a plain cancel.
		a.bus.Info("app", "PickModelFile cancelled/failed", map[string]any{"err": err.Error()})
		return "", nil
	}
	return path, nil
}

// customModelMinBytes is the floor below which a .safetensors file cannot be a
// full checkpoint — LoRA/embedding files are typically 10–500 MB and the
// engine only loads full checkpoints, so failing early beats a cryptic
// engine-load error later.
const customModelMinBytes = 1 << 30 // 1 GB

// UseCustomModel registers a user-supplied checkpoint (referenced in place —
// never copied, never deleted) and makes it the active local model. The
// previously downloaded catalog file, if any, is kept on disk so switching
// back is instant (modelfetch's size-based reuse skips the re-download).
func (a *App) UseCustomModel(path, backendType, baseModel string) (types.Settings, error) {
	if !cloud.IsSingleFileBackend(backendType) {
		// Anima (Modular Diffusers) needs a diffusers-format directory, not a
		// single .safetensors, so it can't come through the custom-file flow.
		return types.Settings{}, fmt.Errorf("backend %q can't be loaded from a single .safetensors file", backendType)
	}
	// Transformer-only backends (Z-Image, FLUX, Chroma, Qwen-Image) need shared
	// base-components; default the repo when the user didn't supply one, matching
	// the catalog path. Self-contained backends (SDXL, SD 1.5, Anima) get "".
	baseModel = strings.TrimSpace(baseModel)
	if baseModel == "" {
		baseModel = cloud.DefaultBaseModel(backendType)
	}
	if !strings.EqualFold(filepath.Ext(path), ".safetensors") {
		return types.Settings{}, errors.New("not a .safetensors file")
	}
	fi, err := os.Stat(path)
	if err != nil {
		return types.Settings{}, fmt.Errorf("file not found: %s", path)
	}
	if fi.Size() < customModelMinBytes {
		return types.Settings{}, errors.New("this file is too small to be a full checkpoint — LoRA/embedding files are not supported, only complete model checkpoints")
	}

	base := filepath.Base(path)
	info := types.ModelInfo{
		ModelCode:   "custom:" + base,
		Name:        strings.TrimSuffix(base, filepath.Ext(base)),
		BackendType: backendType,
		BaseModel:   strings.TrimSpace(baseModel),
		LocalPath:   path,
		CanLocal:    true,
		// No catalog row to ask, so the backend decides: whether a checkpoint can
		// start from a reference image is a property of the pipeline that loads
		// it, not of the file.
		RefImages: customRefImages(backendType),
	}
	withCustomSamplingDefaults(&info)

	s := a.settings.Get()
	s.SDXLPath = path
	s.LocalModel = &info
	// Upsert into the custom registry (dedup by path, newest first).
	kept := []types.ModelInfo{info}
	for _, m := range s.CustomModels {
		if m.LocalPath != path {
			kept = append(kept, m)
		}
	}
	s.CustomModels = kept
	saved, err := a.settings.Save(s)
	if err != nil {
		a.bus.Error("app", "UseCustomModel settings save failed", map[string]any{"err": err.Error()})
		return types.Settings{}, err
	}
	a.bus.Info("app", "custom model registered", map[string]any{"path": path, "backend": backendType})

	// Reload the engine only if it's currently running; otherwise the model
	// loads at the next on-demand start (same policy as SaveSettings). WaitForIdle
	// keeps a switch requested mid-generation from killing the running image.
	if a.sidecar.Status().State == "ready" {
		go func() {
			a.sidecar.WaitForIdle()
			_ = a.sidecar.Restart(a.ctx, saved.PythonPath, saved.SDXLPath, saved.LocalModel, saved.EngineRuntime)
		}()
	}
	return saved, nil
}

// CheckModelReadiness reports whether a model's shared base components (text
// encoder / VAE / tokenizer / scheduler — the multi-GB repo a transformer-only
// checkpoint needs) are already in the offline tree. STATELESS on purpose: the
// renderer passes the base repo of the model it is DISPLAYING (which may be a
// pending pick, not yet the saved LocalModel — reading saved settings here
// once showed krea2's missing components under a freshly selected SDXL). The
// UI gates the Generate button on Ready and offers DownloadModelComponents
// when files are missing — so a cold first generation never hides a multi-GB
// download behind "generating". Never gates on uncertainty: an empty repo
// (self-contained model), a disabled CDN, or an unmirrored base all report
// Ready=true (HasManifest=false) and fall back to the engine's lazy download.
func (a *App) CheckModelReadiness(baseRepo string) components.Readiness {
	repo := strings.TrimSpace(baseRepo)
	cacheDir, err := sidecar.ImageCacheDir()
	if err != nil {
		return components.Readiness{BaseRepo: repo, Ready: true}
	}
	return a.components.Check(a.ctx, sidecar.ImageCDNBase(), cacheDir, repo)
}

// DownloadModelComponents pre-downloads a model's base components from the CDN
// mirror into the engine's offline tree, asynchronously. Stateless like
// CheckModelReadiness — the renderer passes the displayed model's base repo.
// Progress streams via "components:progress" events; a final "components:done"
// or "components:error" settles the UI. Idempotent and resumable (present
// files are skipped; a cancelled run resumes on the next call). On completion
// the engine's own completion marker is written, so its cold load is a cache
// hit.
func (a *App) DownloadModelComponents(baseRepo string) error {
	repo := strings.TrimSpace(baseRepo)
	if repo == "" {
		return errors.New("model has no shared base components to download")
	}
	cacheDir, err := sidecar.ImageCacheDir()
	if err != nil {
		return fmt.Errorf("model cache dir unavailable: %w", err)
	}
	a.compMu.Lock()
	if a.compBusy {
		a.compMu.Unlock()
		return errors.New("a components download is already running")
	}
	a.compBusy = true
	a.compMu.Unlock()

	a.bus.Info("app", "components download started", map[string]any{"repo": repo})
	go func() {
		defer func() {
			a.compMu.Lock()
			a.compBusy = false
			a.compMu.Unlock()
		}()
		err := a.components.Download(a.ctx, sidecar.ImageCDNBase(), cacheDir, repo,
			func(p components.Progress) {
				if a.app != nil {
					a.app.Event.Emit("components:progress", p)
				}
			})
		if err != nil {
			a.bus.Error("app", "components download failed", map[string]any{
				"repo": repo, "err": err.Error()})
			if a.app != nil {
				a.app.Event.Emit("components:error", map[string]any{
					"baseRepo": repo, "error": err.Error()})
			}
			return
		}
		if a.app != nil {
			a.app.Event.Emit("components:done", map[string]any{"baseRepo": repo})
		}
	}()
	return nil
}

// RemoveCustomModel drops a custom checkpoint from the registry (the file on
// disk is never touched). If it was the active model, the selection is cleared
// and the engine stopped.
func (a *App) RemoveCustomModel(path string) (types.Settings, error) {
	s := a.settings.Get()
	kept := s.CustomModels[:0]
	for _, m := range s.CustomModels {
		if m.LocalPath != path {
			kept = append(kept, m)
		}
	}
	s.CustomModels = kept
	wasActive := s.SDXLPath == path
	if wasActive {
		s.SDXLPath = ""
		s.LocalModel = nil
	}
	saved, err := a.settings.Save(s)
	if err != nil {
		return types.Settings{}, err
	}
	if wasActive {
		// Stop off the RPC goroutine and only once idle, so removing the active
		// model mid-generation doesn't kill the in-flight image (or hang this call).
		go func() {
			a.sidecar.WaitForIdle()
			a.sidecar.Stop()
		}()
	}
	a.bus.Info("app", "custom model removed", map[string]any{"path": path, "wasActive": wasActive})
	return saved, nil
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

// galleryExts maps a listable file extension to its media kind. Videos (WAN
// cloud results) live in the same output folder and gallery as images; the
// kind drives <img> vs <video> rendering in the renderer.
var galleryExts = map[string]string{
	".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
	".mp4": "video", ".webm": "video",
}

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
		if e.IsDir() || galleryExts[strings.ToLower(filepath.Ext(e.Name()))] == "" {
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
	active := filter.Engine != "" || filter.ModelCode != "" || filter.Source != "" || filter.Text != ""
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
		kind := galleryExts[strings.ToLower(filepath.Ext(fm.name))]
		w, h := imageDims(p)
		var mptr *types.GenerationMeta
		if cache != nil {
			mptr = cache[fm.name]
		} else {
			mptr = readSidecar(p)
		}
		// Videos have no decodable image header — fall back to the sidecar's
		// requested dimensions so the masonry still reserves the right aspect box.
		if w == 0 && mptr != nil && mptr.Width > 0 && mptr.Height > 0 {
			w, h = mptr.Width, mptr.Height
		}
		out = append(out, types.SavedImage{
			Name: fm.name, Kind: kind, Source: source, Seed: seed, SavedPath: p, Width: w, Height: h, Meta: mptr,
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
	if f.Engine == "" && f.ModelCode == "" && f.Source == "" && f.Text == "" {
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
	if f.Text != "" && !strings.Contains(strings.ToLower(m.Prompt), strings.ToLower(f.Text)) {
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
			if e.IsDir() || galleryExts[strings.ToLower(filepath.Ext(e.Name()))] == "" {
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

// RevealInFolder opens the OS file manager with the given file highlighted
// (Finder / Explorer / the default Linux file manager). The path is confined to
// the output directory so the renderer can't ask us to reveal arbitrary files.
func (a *App) RevealInFolder(imgPath string) error {
	if imgPath == "" {
		return errors.New("empty path")
	}
	abs, err := filepath.Abs(imgPath)
	if err != nil {
		return err
	}
	// Confinement: only files under the output dir may be revealed.
	dir, err := filepath.Abs(a.outputDir())
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(dir, abs)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("path is outside the output folder")
	}

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", abs)
	case "windows":
		// explorer returns a non-zero exit code even on success; ignore its error.
		_ = exec.Command("explorer", "/select,"+abs).Start()
		a.bus.Info("app", "revealed in folder", map[string]any{"path": abs})
		return nil
	default: // linux, *bsd — no universal "select" flag; open the parent dir.
		cmd = exec.Command("xdg-open", filepath.Dir(abs))
	}
	if err := cmd.Start(); err != nil {
		a.bus.Warn("app", "reveal in folder failed", map[string]any{"err": err.Error()})
		return err
	}
	a.bus.Info("app", "revealed in folder", map[string]any{"path": abs})
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
	// Deterministic types for the formats we write ourselves — the renderer keys
	// <img> vs <video> off the data-URL prefix, and mime.TypeByExtension consults
	// the OS (Windows registry) where video mappings aren't guaranteed.
	var mimeType string
	switch strings.ToLower(filepath.Ext(name)) {
	case ".mp4":
		mimeType = "video/mp4"
	case ".webm":
		mimeType = "video/webm"
	default:
		mimeType = mime.TypeByExtension(filepath.Ext(name))
	}
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

// ensureEngineUpToDate brings the venv's engine in line with the version the
// desktop pins (EngineTarball), force-reinstalling it (uninstall + install,
// skipping the torch phase) in two cases:
//
//   - the installed version differs from the pinned one — e.g. upgrading a stale
//     engine whose diffusers can't actually cut VRAM via CPU offload;
//   - the venv works but carries NO engine at all. That's the hole a previous
//     upgrade leaves if it's interrupted between the uninstall and the install
//     (app closed, network dropped): every local run then dies on "No module
//     named 'imference_engine'" and nothing repairs it, because a missing
//     package reports no version to be "outdated" against. Repairing here costs
//     one pip install (torch and the rest are already in place) and turns a
//     dead venv into a self-healing one.
//
// Runs in the background and streams the same "install:progress" events as
// InstallEngine so the UI shows the work; a no-op when the versions match, the
// venv is missing, or a dev source override is active (PinnedEngineVersion ==
// ""), which also covers an editable checkout reporting no version.
func (a *App) ensureEngineUpToDate() {
	venvDir, err := engineVenvDir()
	if err != nil {
		return
	}
	info := installer.EngineInfoFor(a.ctx, venvDir)
	if !info.Installed {
		return // no venv yet — installing one is the user's call, not ours
	}
	missing := info.EngineVersion == "" && !info.Dev && info.PinnedVersion != ""
	if !info.Outdated && !missing {
		return
	}
	reqs, err := resolveSidecarRequirements()
	if err != nil {
		return
	}
	if missing {
		a.bus.Warn("app", "engine package missing from the venv — reinstalling the pinned engine", map[string]any{
			"pinned": info.PinnedVersion, "venv": venvDir,
		})
	} else {
		a.bus.Warn("app", "engine version mismatch — force-reinstalling pinned engine", map[string]any{
			"installed": info.EngineVersion, "pinned": info.PinnedVersion,
		})
	}

	progress := make(chan types.InstallProgress, 16)
	go func() {
		// Release venv file locks (Windows keeps torch .pyd/.dll mmap'd).
		a.sidecar.Stop()
		if err := a.installer.Install(a.ctx, installer.Options{
			VenvDir:                 venvDir,
			SidecarRequirementsPath: reqs,
			EngineOnly:              true,
		}, progress); err != nil {
			a.bus.Error("app", "engine auto-reinstall failed", map[string]any{"err": err.Error()})
			return
		}
		// pythonPath is unchanged (same venv) — just restart the sidecar with the
		// current model so the freshly upgraded engine is live. No model yet →
		// leave stopped; selection restarts it later.
		s := a.settings.Get()
		if s.SDXLPath == "" {
			a.bus.Info("app", "engine updated; awaiting model selection before sidecar start", nil)
			return
		}
		a.bus.Info("app", "restarting sidecar after engine update", nil)
		if rerr := a.sidecar.Restart(a.ctx, s.PythonPath, s.SDXLPath, s.LocalModel, s.EngineRuntime); rerr != nil {
			a.bus.Warn("app", "post-update sidecar restart failed", map[string]any{"err": rerr.Error()})
		}
	}()
	go func() {
		for p := range progress {
			if a.app != nil {
				a.app.Event.Emit("install:progress", p)
			}
		}
	}()
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

const (
	// defaultMinFreeBytes is the free-space cushion kept on the cache volume.
	// Unlike the quota, this is a hard wall: a download that would eat into it
	// fails before any network call rather than filling the user's disk.
	defaultMinFreeBytes int64 = 10 << 30 // 10 GiB
	// minAllowedQuotaBytes floors what the settings UI may set — below this
	// nothing useful fits and every switch would thrash the cache.
	minAllowedQuotaBytes int64 = 8 << 30 // 8 GiB
	// defaultModelSizeEstimate stands in when a HEAD gives no Content-Length.
	// Deliberately above the largest catalog checkpoint (~7.1 GB) so the
	// "will it fit" arithmetic errs toward freeing space rather than overfilling.
	defaultModelSizeEstimate int64 = 8 << 30 // 8 GiB
)

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
