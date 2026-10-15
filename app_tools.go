package main

// Editing tools (imference_engine.tools) — the App surface:
//
//   - ListTools / ProbeTools: the catalog with this machine's badge and price;
//   - RunTool: route (auto | local | cloud), run, save the outputs to the
//     gallery (source "tool"), typed errors with a cloud offer — never a
//     silent fallback;
//   - CancelTool / ReleaseTools: stop a run, free the warm models;
//   - Get/SetToolsSettings, GetLocalAPIInfo: preferences + the agents' API.
//
// Image/video tools run in a dedicated tools sidecar (internal/tools), the
// generation tools (vary / inpaint / outpaint) in the generation sidecar on the
// loaded model, and both in the cloud through internal/cloud.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/gpu"
	"imference-desktop-go/internal/imagesink"
	"imference-desktop-go/internal/modelcache"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/tools"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
)

// creditUSD is the dollar value of one credit (1 credit = $0.001).
const creditUSD = 0.001

// noSaveDataURLMax caps the inline bytes of a transient output (a
// click-to-select mask is a few hundred KB).
const noSaveDataURLMax = 32 << 20

// ToolInfo is one catalog entry as the renderer sees it.
type ToolInfo struct {
	tools.Tool
	tools.Assessment
	// PriceCredits is the cloud price (credits); for generation tools it is the
	// selected cloud model's price (PriceIsModel).
	PriceCredits float64 `json:"priceCredits"`
	PriceUSD     float64 `json:"priceUsd"`
	PriceIsModel bool    `json:"priceIsModel,omitempty"`
}

// ToolRunRequest is one run from the renderer (or the local API).
type ToolRunRequest struct {
	JobID  string              `json:"jobId"`
	ToolID string              `json:"toolId"`
	Inputs map[string][]string `json:"inputs"` // gallery names, absolute paths or data: URIs
	Params map[string]any      `json:"params"`
	RunOn  string              `json:"runOn"`  // auto | local | cloud ("" = the Settings mode)
	NoSave bool                `json:"noSave"` // transient output (click-to-select): not saved, returned inline
	// SourceMeta is the source image's metadata when the gallery lives in the
	// browser (web, client gallery): the server cannot read the sidecar itself.
	SourceMeta *types.GenerationMeta `json:"sourceMeta,omitempty"`
}

// ToolRunOutput is one produced output.
type ToolRunOutput struct {
	Name      string `json:"name"`
	Type      string `json:"type"` // image | mask | video | text
	Format    string `json:"format"`
	SavedName string `json:"savedName,omitempty"` // gallery file name
	Path      string `json:"path,omitempty"`      // absolute path (gallery)
	Text      string `json:"text,omitempty"`
	DataURL   string `json:"dataUrl,omitempty"` // NoSave runs, and every output with a client gallery
	// Meta is the sidecar metadata for a client-gallery save (web).
	Meta   *types.GenerationMeta `json:"meta,omitempty"`
	Width  int                   `json:"width,omitempty"`
	Height int                   `json:"height,omitempty"`
	Seed   int                   `json:"seed,omitempty"`
}

// ToolRunResult is RunTool's answer. A failure is reported in Error (typed,
// with a cloud offer when the cloud can do it) rather than as a rejected
// promise, so the UI can propose the next step.
type ToolRunResult struct {
	JobID      string          `json:"jobId"`
	ToolID     string          `json:"toolId"`
	Outputs    []ToolRunOutput `json:"outputs"`
	RanOn      string          `json:"ranOn,omitempty"` // local | cloud
	Device     string          `json:"device,omitempty"`
	DurationMs int64           `json:"durationMs"`
	Credits    float64         `json:"credits,omitempty"`
	Error      *tools.Error    `json:"error,omitempty"`
}

// LocalAPIInfo describes the agents' HTTP API for the Settings screen.
type LocalAPIInfo struct {
	Enabled       bool   `json:"enabled"`
	Running       bool   `json:"running"`
	Port          int    `json:"port"`
	DiscoveryPath string `json:"discoveryPath"`
}

// ------------------------------------------------------------------------
// Wiring
// ------------------------------------------------------------------------

// initTools builds the tools manager (NewApp). The sidecar itself starts on
// the first local run.
func (a *App) initTools() {
	cat, err := tools.Builtin()
	if err != nil {
		a.bus.Error("tools", "embedded tools catalog unreadable — editing tools disabled", map[string]any{"err": err.Error()})
	}
	a.toolsCat = cat
	a.toolJobs = map[string]*toolJob{}
	a.tools = tools.NewManager(a.bus, a.toolsLaunchConfig, a.emitToolProgress)
	a.applyToolsSettings(a.settings.Get().Tools)
	a.sidecar.SetToolProgressListener(func(jobID, stage string, frac float64) {
		a.emitToolProgress(tools.Progress{JobID: jobID, Stage: stage, Fraction: frac})
	})
}

// startToolsAPI starts the agents' local API unless disabled (ServiceStartup).
func (a *App) startToolsAPI() {
	if a.toolsCat == nil || a.settings.Get().Tools.LocalAPIDisabled {
		return
	}
	a.toolsAPIMu.Lock()
	defer a.toolsAPIMu.Unlock()
	if a.toolsAPI != nil {
		return
	}
	disc, err := tools.DiscoveryPath()
	if err != nil {
		disc = ""
	}
	srv := &tools.APIServer{Catalog: a.toolsCat, Backend: toolsAPIBackend{a}, Bus: a.bus, Token: tools.NewToken()}
	if _, err := srv.Start(disc); err != nil {
		a.bus.Warn("tools", "local tools API not started", map[string]any{"err": err.Error()})
		return
	}
	a.toolsAPI = srv
}

func (a *App) stopToolsAPI() {
	a.toolsAPIMu.Lock()
	srv := a.toolsAPI
	a.toolsAPI = nil
	a.toolsAPIMu.Unlock()
	if srv != nil {
		srv.Stop()
	}
}

// shutdownTools stops the tools sidecar and the local API (ServiceShutdown).
func (a *App) shutdownTools() {
	a.stopToolsAPI()
	if a.tools != nil {
		a.tools.Stop()
	}
}

func (a *App) applyToolsSettings(ts types.ToolsSettings) {
	if a.tools == nil {
		return
	}
	idle := ts.IdleMinutes
	if idle <= 0 {
		idle = 10
	}
	a.tools.IdleTimeout = time.Duration(idle) * time.Minute
}

// toolsLaunchConfig resolves the interpreter, script and env of the tools
// sidecar at each start.
func (a *App) toolsLaunchConfig() (tools.LaunchConfig, error) {
	s := a.settings.Get()
	if s.PythonPath == "" {
		return tools.LaunchConfig{}, errors.New("the local engine is not installed — install it from Settings, or run the tool in the cloud")
	}
	if _, err := os.Stat(s.PythonPath); err != nil {
		return tools.LaunchConfig{}, fmt.Errorf("engine Python not found at %s — reinstall the engine", s.PythonPath)
	}
	script, err := resolveToolsScript()
	if err != nil {
		return tools.LaunchConfig{}, fmt.Errorf("tools sidecar script missing: %w", err)
	}
	return tools.LaunchConfig{Python: s.PythonPath, Script: script, Env: toolsEnv(s.Tools)}, nil
}

// toolsEnv is the tools sidecar's environment: the weights mirror is the
// image CDN's "/tools" folder (same mirror the engine already uses, see
// sidecar.ImageCDNBase), cached under the app's cache dir. A developer's
// TOOLS_MODEL_CDN / TOOLS_MODEL_CACHE in the launching shell win.
func toolsEnv(ts types.ToolsSettings) []string {
	env := append(os.Environ(), "PYTHONUNBUFFERED=1")
	dev := strings.TrimSpace(ts.Device)
	if dev == "" {
		dev = "auto"
	}
	env = append(env, "IMFERENCE_TOOLS_DEVICE="+dev)
	if _, ok := os.LookupEnv("TOOLS_MODEL_CDN"); !ok {
		if base := strings.TrimRight(sidecar.ImageCDNBase(), "/"); base != "" {
			env = append(env, "TOOLS_MODEL_CDN="+base+"/tools")
		}
	}
	if _, ok := os.LookupEnv("TOOLS_MODEL_CACHE"); !ok {
		if dir, err := toolsModelsDir(); err == nil {
			env = append(env, "TOOLS_MODEL_CACHE="+dir)
		}
	}
	return env
}

// toolsCacheDirInUse is where the tools sidecar keeps its weights: the
// TOOLS_MODEL_CACHE override when set, else toolsModelsDir ("" if unknown).
func toolsCacheDirInUse() string {
	if v := strings.TrimSpace(os.Getenv("TOOLS_MODEL_CACHE")); v != "" {
		return v
	}
	d, err := toolsModelsDir()
	if err != nil {
		return ""
	}
	return d
}

// toolsModelsDir caches the tools' small ONNX weights (2–500 MB each).
func toolsModelsDir() (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(cache, "imference-desktop-go", "tools-models"), nil
}

// toolsWorkDir holds a run's intermediate files (inputs written from data
// URIs, raw outputs before they move into the gallery). Removed after the run.
func toolsWorkDir(jobID string) (string, error) {
	cache, err := os.UserCacheDir()
	if err != nil {
		cache = os.TempDir()
	}
	dir := filepath.Join(cache, "imference-desktop-go", "tools-work", sanitizeJobID(jobID))
	return dir, os.MkdirAll(dir, 0o755)
}

func sanitizeJobID(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_' {
			b.WriteRune(r)
		}
	}
	if b.Len() == 0 {
		return newToolJobID()
	}
	return b.String()
}

func newToolJobID() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	return "tool_" + hex.EncodeToString(b[:])
}

func (a *App) emitToolProgress(p tools.Progress) {
	if p.ToolID == "" {
		a.toolMu.Lock()
		if j := a.toolJobs[p.JobID]; j != nil {
			p.ToolID = j.toolID
		}
		a.toolMu.Unlock()
	}
	if a.canEmit() {
		a.emit("tools:progress", p)
	}
}

// gpuInfo caches the GPU probe (it shells out to vendor tools).
func (a *App) gpuInfo() gpu.Info {
	a.gpuOnce.Do(func() { a.gpu = gpu.Detect(context.Background()) })
	return a.gpu
}

// toolsHost is the machine description the badges are computed from.
func (a *App) toolsHost() tools.Host {
	s := a.settings.Get()
	st := a.sidecar.Status()
	h := tools.Host{
		GOOS:             runtime.GOOS,
		GPU:              a.gpuInfo(),
		Probe:            a.tools.CachedProbe(),
		GenerationReady:  st.State == "ready",
		GenerationDevice: st.Device,
	}
	if s.PythonPath != "" {
		if _, err := os.Stat(s.PythonPath); err == nil {
			h.EngineInstalled = true
		}
	}
	if m := s.LocalModel; m != nil {
		h.GenerationImg2Img = cloud.IsImageBackend(m.BackendType) && cloud.SupportsRefImages(m.BackendType)
		h.GenerationBackend = m.BackendType
	}
	return h
}

// ------------------------------------------------------------------------
// Bound methods
// ------------------------------------------------------------------------

// ListTools returns the catalog with this machine's badge and cloud price.
func (a *App) ListTools() ([]ToolInfo, error) {
	if a.toolsCat == nil {
		return []ToolInfo{}, errors.New("tools catalog unavailable")
	}
	h := a.toolsHost()
	s := a.settings.Get()
	cacheDir := toolsCacheDirInUse()
	out := make([]ToolInfo, 0, len(a.toolsCat.Tools))
	for _, t := range a.toolsCat.Tools {
		// Which weights are already downloaded ("First run downloads ~N MB"
		// then only counts the chosen variant's missing files).
		if len(t.Weights) > 0 {
			ws := make([]tools.WeightFile, len(t.Weights))
			for i, w := range t.Weights {
				ws[i] = w
				if cacheDir != "" && w.Path != "" {
					if st, err := os.Stat(filepath.Join(cacheDir, filepath.FromSlash(w.Path))); err == nil && st.Size() > 0 {
						ws[i].Cached = true
					}
				}
			}
			t.Weights = ws
		}
		info := ToolInfo{Tool: t, Assessment: tools.Assess(t, h), PriceCredits: t.Credits}
		if t.IsGeneration() {
			info.PriceIsModel = true
			info.PriceCredits = 0
			if tools.NeedsEditModel(t) {
				// Priced on the edit model the cloud run would use (from the
				// cached catalog only: ListTools must stay instant offline).
				if m := a.cachedEditCloudModel(); m != nil {
					info.PriceCredits = float64(m.Cost)
				}
			} else if s.CloudModelInfo != nil {
				info.PriceCredits = float64(s.CloudModelInfo.Cost)
			}
		}
		info.PriceUSD = info.PriceCredits * creditUSD
		out = append(out, info)
	}
	return out, nil
}

// ProbeTools starts the tools sidecar (when the engine is installed) to learn
// the real runtime (onnxruntime providers, ffmpeg, RAM), then returns the
// refreshed list. Cheap after the first call: the probe is cached per start.
func (a *App) ProbeTools() ([]ToolInfo, error) {
	if a.tools.CachedProbe() == nil && a.toolsHost().EngineInstalled {
		ctx, cancel := context.WithTimeout(a.ctx, 3*time.Minute)
		if _, err := a.tools.ProbeNow(ctx); err != nil {
			a.bus.Warn("tools", "tools probe failed", map[string]any{"err": err.Error()})
		}
		cancel()
	}
	return a.ListTools()
}

// GetToolsSettings returns the editing-tools preferences.
func (a *App) GetToolsSettings() types.ToolsSettings {
	ts := a.settings.Get().Tools
	ts.Mode = tools.NormalizeMode(ts.Mode)
	return ts
}

// SetToolsSettings saves the preferences and applies them (idle timeout,
// local API on/off).
func (a *App) SetToolsSettings(ts types.ToolsSettings) (types.ToolsSettings, error) {
	ts.Mode = tools.NormalizeMode(ts.Mode)
	s := a.settings.Get()
	s.Tools = ts
	if _, err := a.settings.Save(s); err != nil {
		return ts, err
	}
	a.applyToolsSettings(ts)
	if ts.LocalAPIDisabled {
		a.stopToolsAPI()
	} else {
		a.startToolsAPI()
	}
	return ts, nil
}

// GetLocalAPIInfo reports the agents' API state.
func (a *App) GetLocalAPIInfo() LocalAPIInfo {
	info := LocalAPIInfo{Enabled: !a.settings.Get().Tools.LocalAPIDisabled}
	info.DiscoveryPath, _ = tools.DiscoveryPath()
	a.toolsAPIMu.Lock()
	if a.toolsAPI != nil {
		info.Running = true
		info.Port = a.toolsAPI.Port()
	}
	a.toolsAPIMu.Unlock()
	return info
}

// CancelTool stops a run: the cloud wait is abandoned (the server-side
// request may still finish and be charged), a local run is killed with its
// sidecar (the generation sidecar reloads its model).
func (a *App) CancelTool(jobID string) {
	a.toolMu.Lock()
	j := a.toolJobs[jobID]
	a.toolMu.Unlock()
	if j == nil {
		a.tools.Cancel(jobID) // a queued local run that hasn't registered yet
		return
	}
	a.bus.Info("tools", "cancel requested", map[string]any{"job": jobID, "tool": j.toolID})
	j.cancelled.Store(true)
	j.cancel()
	a.tools.Cancel(jobID)
	if j.onGeneration.Load() {
		_ = a.StopLocalGeneration()
	}
}

// ReleaseTools frees the tools' warm models (ONNX sessions, Florence-2): the
// editor/dialog calls it on close so they don't squat RAM next to a
// generation model. The process itself stops after the idle timeout.
func (a *App) ReleaseTools() error {
	ctx, cancel := context.WithTimeout(a.ctx, 15*time.Second)
	defer cancel()
	return a.tools.Release(ctx)
}

// RunTool runs one tool (see ToolRunRequest) and saves its outputs to the
// gallery. Tool failures come back in ToolRunResult.Error.
func (a *App) RunTool(req ToolRunRequest) (ToolRunResult, error) {
	if a.cloudOnly {
		// Web build: tools only run in the cloud, and inputs are gallery names
		// or data URIs — never a path on the server's disk.
		req.RunOn = tools.ModeCloud
		for name, vals := range req.Inputs {
			for _, v := range vals {
				v = strings.TrimSpace(v)
				if strings.HasPrefix(v, "data:") {
					continue
				}
				// Any separator, not just IsAbs: "/etc/passwd" is not absolute on Windows.
				if filepath.IsAbs(v) || filepath.VolumeName(v) != "" || strings.ContainsAny(v, `/\`) || strings.Contains(v, "..") {
					return ToolRunResult{JobID: req.JobID, ToolID: req.ToolID, Outputs: []ToolRunOutput{},
						Error: &tools.Error{Code: tools.CodeInvalidInput, Message: "input " + name + ": file paths are not accepted on the web", Field: name}}, nil
				}
			}
		}
	}
	return a.runTool(a.ctx, req), nil
}

// ------------------------------------------------------------------------
// The run
// ------------------------------------------------------------------------

// toolJob tracks a run for cancel + progress.
type toolJob struct {
	toolID       string
	cancel       context.CancelFunc
	cancelled    atomic.Bool
	onGeneration atomic.Bool
}

func (a *App) runTool(parent context.Context, req ToolRunRequest) (res ToolRunResult) {
	start := time.Now()
	if req.JobID == "" {
		req.JobID = newToolJobID()
	}
	res = ToolRunResult{JobID: req.JobID, ToolID: req.ToolID, Outputs: []ToolRunOutput{}}
	fail := func(e *tools.Error) ToolRunResult {
		res.Error = e
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}
	if a.toolsCat == nil {
		return fail(tools.NewError(tools.CodeInternal, "tools catalog unavailable"))
	}
	t, ok := a.toolsCat.Get(req.ToolID)
	if !ok {
		return fail(&tools.Error{Code: tools.CodeInvalidInput, Message: "unknown tool " + req.ToolID, Field: "tool_id"})
	}

	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	job := &toolJob{toolID: t.ID, cancel: cancel}
	a.toolMu.Lock()
	a.toolJobs[req.JobID] = job
	a.toolMu.Unlock()
	defer func() {
		a.toolMu.Lock()
		delete(a.toolJobs, req.JobID)
		a.toolMu.Unlock()
	}()

	work, err := toolsWorkDir(req.JobID)
	if err != nil {
		return fail(tools.NewError(tools.CodeInternal, err.Error()))
	}
	defer os.RemoveAll(work)

	inputs, sourceName, terr := a.resolveToolInputs(t, req.Inputs, work)
	if terr != nil {
		return fail(terr)
	}
	var sourceMeta *types.GenerationMeta
	if sourceName != "" {
		sourceMeta = readSidecar(filepath.Join(a.outputDir(), sourceName))
	}
	if sourceMeta == nil && a.clientGallery && req.SourceMeta != nil {
		sourceMeta = req.SourceMeta
	}

	s := a.settings.Get()
	mode := req.RunOn
	if mode == "" {
		mode = s.Tools.Mode
	}
	assess := tools.Assess(t, a.toolsHost())
	route, rerr := tools.Decide(mode, t, assess)
	if rerr != nil {
		if route == "" && tools.NormalizeMode(mode) == tools.ModeLocal && t.CloudAvailable {
			rerr.CloudRetry = a.cloudOffer(t, req.Params, sourceMeta)
		}
		return fail(rerr)
	}
	params := toolParams(t, req.Params, sourceMeta)
	if tools.NeedsEditModel(t) {
		if _, ok := params["instruction"]; !ok {
			return fail(&tools.Error{Code: tools.CodeInvalidInput, Message: "describe the change to make (instruction)", Field: "instruction"})
		}
	}
	outDir := filepath.Join(work, "out")
	a.bus.Info("tools", "run", map[string]any{"tool": t.ID, "job": req.JobID, "route": string(route), "badge": string(assess.Badge), "device": assess.Device})

	var outs []rawOutput
	var usedParams map[string]any
	if route == tools.RouteLocal {
		res.RanOn, res.Device = "local", assess.Device
		outs, usedParams, terr = a.runToolLocal(ctx, req.JobID, t, inputs, params, outDir, job)
		if terr != nil {
			if job.cancelled.Load() {
				terr = &tools.Error{Code: tools.CodeCancelled, Message: "cancelled"}
			} else if t.CloudAvailable && tools.CloudRetryable(terr) {
				terr.CloudRetry = a.cloudOffer(t, params, sourceMeta)
			}
			return fail(terr)
		}
	} else {
		res.RanOn = "cloud"
		cloudParams := cloudToolParams(t, params, sourceMeta, s, a.editDefaultModel(), a.cloudHasModel)
		outs, res.Credits, terr = a.runToolCloud(ctx, req.JobID, t, inputs, cloudParams, outDir)
		if terr != nil {
			if job.cancelled.Load() {
				terr = &tools.Error{Code: tools.CodeCancelled, Message: "cancelled"}
			}
			return fail(terr)
		}
		usedParams = cloudParams
	}

	meta := types.GenerationMeta{
		Source: "tool", Tool: t.ID, ToolParams: usedParams, SourceImage: sourceName, RanOn: res.RanOn,
	}
	if t.IsGeneration() {
		meta.Prompt, _ = params["prompt"].(string)
		if tools.NeedsEditModel(t) {
			// The instruction is the run's prompt: "Copy prompt" / "Reuse
			// settings" / the gallery search show what was asked.
			meta.Prompt, _ = params["instruction"].(string)
		}
		meta.NegativePrompt, _ = params["negative_prompt"].(string)
		if res.RanOn == "local" && s.LocalModel != nil {
			meta.ModelCode, meta.ModelName, meta.Engine = s.LocalModel.ModelCode, s.LocalModel.Name, s.LocalModel.BackendType
		} else if code, _ := usedParams["model"].(string); code != "" {
			meta.ModelCode = code
		}
		meta.Img2Img = true
	} else if sourceMeta != nil {
		// Keep the source's prompt so the result stays searchable and reusable.
		meta.Prompt = sourceMeta.Prompt
		meta.ModelCode, meta.ModelName, meta.Engine = sourceMeta.ModelCode, sourceMeta.ModelName, sourceMeta.Engine
	}
	saved := false
	for _, o := range outs {
		ro := ToolRunOutput{Name: o.name, Type: o.typ, Format: o.format, Text: o.text, Width: o.width, Height: o.height, Seed: o.seed}
		switch {
		case o.path == "":
		case o.typ == "text" || o.typ == "json":
			if ro.Text == "" {
				if b, rerr := os.ReadFile(o.path); rerr == nil {
					ro.Text = string(b)
				}
			}
		case a.clientGallery && !req.NoSave:
			// Web: hand the file + its sidecar metadata to the browser, which
			// saves them in the user's gallery folder.
			b, rerr := os.ReadFile(o.path)
			if rerr != nil {
				return fail(tools.NewError(tools.CodeInternal, "could not read the result: "+rerr.Error()))
			}
			mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(o.path)))
			if mt == "" {
				mt = "application/octet-stream"
			}
			ro.DataURL = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(b)
			m := meta
			m.Source, m.Seed = "tool", o.seed
			m.Width, m.Height = o.width, o.height
			m.CreatedAt = time.Now().Format(time.RFC3339)
			ro.Meta = &m
		case req.NoSave:
			if st, serr := os.Stat(o.path); serr == nil && st.Size() <= noSaveDataURLMax {
				if b, rerr := os.ReadFile(o.path); rerr == nil {
					mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(o.path)))
					if mt == "" {
						mt = "image/png"
					}
					ro.DataURL = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(b)
				}
			}
		default:
			m := meta
			m.Seed = o.seed
			m.Width, m.Height = o.width, o.height
			m.CreatedAt = time.Now().Format(time.RFC3339)
			p, metaErr, serr := imagesink.SaveFileWithMeta(o.path, "tool", o.seed, a.outputDir(), m)
			if serr != nil {
				a.bus.Warn("tools", "saving tool output failed", map[string]any{"err": serr.Error()})
				return fail(tools.NewError(tools.CodeInternal, "could not save the result: "+serr.Error()))
			}
			if metaErr != nil {
				a.bus.Warn("tools", "tool output metadata not written", map[string]any{"err": metaErr.Error()})
			}
			ro.Path, ro.SavedName = p, filepath.Base(p)
			saved = true
		}
		res.Outputs = append(res.Outputs, ro)
	}
	if saved {
		a.invalidateGalleryCache()
	}
	res.DurationMs = time.Since(start).Milliseconds()
	a.bus.Info("tools", "run done", map[string]any{"tool": t.ID, "job": req.JobID, "ranOn": res.RanOn, "ms": res.DurationMs})
	return res
}

// rawOutput is a produced output before it is saved.
type rawOutput struct {
	name, typ, format, path, text string
	width, height, seed           int
}

// resolveToolInputs maps the renderer's inputs to local paths: a gallery file
// name, an absolute path, or a data: URI (written into the work dir — the mask
// editor's PNG). Returns the first gallery name (the "source image").
func (a *App) resolveToolInputs(t tools.Tool, in map[string][]string, work string) (map[string]any, string, *tools.Error) {
	out := map[string]any{}
	source := ""
	for name := range in {
		if _, ok := t.Input(name); !ok {
			return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "unknown input " + name, Field: name}
		}
	}
	// Manifest order: the source image is the first image input ("image"),
	// never a reference image or the mask.
	for _, spec := range t.Inputs {
		name := spec.Name
		vals, ok := in[name]
		if !ok {
			continue
		}
		var paths []string
		for i, v := range vals {
			v = strings.TrimSpace(v)
			var p string
			switch {
			case v == "":
				continue
			case strings.HasPrefix(v, "data:"):
				comma := strings.IndexByte(v, ',')
				if comma < 0 || !strings.Contains(v[:comma], ";base64") {
					return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "input " + name + ": not a base64 data URI", Field: name}
				}
				data, err := base64.StdEncoding.DecodeString(v[comma+1:])
				if err != nil {
					return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "input " + name + ": " + err.Error(), Field: name}
				}
				ext := ".png"
				if exts, _ := mime.ExtensionsByType(strings.TrimSuffix(strings.TrimPrefix(v[:comma], "data:"), ";base64")); len(exts) > 0 {
					ext = exts[0]
				}
				p = filepath.Join(work, fmt.Sprintf("in-%s-%d%s", name, i, ext))
				if err := os.WriteFile(p, data, 0o600); err != nil {
					return nil, "", tools.NewError(tools.CodeInternal, err.Error())
				}
			case filepath.IsAbs(v):
				p = v
			default:
				if strings.ContainsAny(v, `/\`) || strings.Contains(v, "..") {
					return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "invalid gallery name " + v, Field: name}
				}
				p = filepath.Join(a.outputDir(), v)
				if source == "" && spec.Type != "mask" {
					source = v
				}
			}
			if st, err := os.Stat(p); err != nil || st.IsDir() {
				return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "input file not found: " + v, Field: name}
			}
			paths = append(paths, p)
		}
		if len(paths) == 0 {
			continue
		}
		if spec.MaxItems > 0 && len(paths) > spec.MaxItems {
			return nil, "", &tools.Error{Code: tools.CodeInvalidInput,
				Message: fmt.Sprintf("input %s: at most %d files", name, spec.MaxItems), Field: name}
		}
		if !spec.Multiple && len(paths) > 1 {
			return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "input " + name + " takes one file", Field: name}
		}
		if spec.Multiple {
			out[name] = paths
		} else {
			out[name] = paths[0]
		}
	}
	for _, spec := range t.Inputs {
		if _, ok := out[spec.Name]; spec.Required && !ok {
			return nil, "", &tools.Error{Code: tools.CodeInvalidInput, Message: "missing required input " + spec.Name, Field: spec.Name}
		}
	}
	return out, source, nil
}

// toolParams copies the request params and fills the generation defaults:
// the source image's prompt when none is given (the best default for vary).
func toolParams(t tools.Tool, in map[string]any, source *types.GenerationMeta) map[string]any {
	out := map[string]any{}
	for k, v := range in {
		if v == nil {
			continue
		}
		if s, ok := v.(string); ok && s == "" && k != "prompt" && k != "negative_prompt" {
			continue // an empty optional field = use the default
		}
		out[k] = v
	}
	if tools.NeedsEditModel(t) {
		// instruct-edit has no prompt: its prompt is the instruction (an agent
		// sending "prompt" means the instruction). The source's generation
		// prompt describes the old image, not the change — never a default.
		if p, _ := out["prompt"].(string); p != "" {
			if ins, _ := out["instruction"].(string); ins == "" {
				out["instruction"] = p
			}
		}
		delete(out, "prompt")
		if ins, ok := out["instruction"].(string); ok && strings.TrimSpace(ins) == "" {
			delete(out, "instruction")
		}
		if n, ok := out["negative_prompt"].(string); ok && n == "" {
			delete(out, "negative_prompt")
		}
		return out
	}
	if t.IsGeneration() && source != nil {
		if p, _ := out["prompt"].(string); p == "" && source.Prompt != "" {
			out["prompt"] = source.Prompt
		}
		if n, _ := out["negative_prompt"].(string); n == "" && source.NegativePrompt != "" {
			out["negative_prompt"] = source.NegativePrompt
		}
	}
	return out
}

// cloudToolParams fills the model of a cloud generation tool: an explicit
// choice wins; else the model the source image was made with, when the cloud
// runs it (made in the cloud, or a local model the cloud catalog also lists:
// cloudHas); else the selected cloud model; else the source's model.
// instruct-edit only takes an edit model: the selected cloud model when it is
// one, else editDefault (see editDefaultFrom).
func cloudToolParams(t tools.Tool, params map[string]any, source *types.GenerationMeta, s types.Settings, editDefault string, cloudHas func(string) bool) map[string]any {
	if !t.IsGeneration() {
		return params
	}
	out := map[string]any{}
	for k, v := range params {
		out[k] = v
	}
	if m, _ := out["model"].(string); m != "" && m != "local" {
		return out
	}
	if tools.NeedsEditModel(t) {
		switch {
		case s.CloudModel != "" && s.CloudModelInfo != nil && s.CloudModelInfo.ModelCode == s.CloudModel && cloud.IsEditModel(s.CloudModelInfo):
			out["model"] = s.CloudModel
		case editDefault != "":
			out["model"] = editDefault
		default:
			out["model"] = cloud.DefaultEditModel
		}
		return out
	}
	switch {
	case source != nil && source.Source == "cloud" && source.ModelCode != "":
		out["model"] = source.ModelCode
	case source != nil && source.ModelCode != "" && cloudHas != nil && cloudHas(source.ModelCode):
		out["model"] = source.ModelCode
	case s.CloudModel != "":
		out["model"] = s.CloudModel
	case source != nil && source.ModelCode != "":
		out["model"] = source.ModelCode
	default:
		delete(out, "model")
	}
	return out
}

// cloudHasModel: the cached cloud catalog runs this model code (no network).
func (a *App) cloudHasModel(code string) bool {
	for _, m := range a.cloud.CachedCloudModels() {
		if m.ModelCode == code {
			return true
		}
	}
	return false
}

// GenToolModels tells the Edit panel which model a generation tool (vary,
// inpaint, outpaint) would use, so it can say so and offer the fixes.
type GenToolModels struct {
	// SourceModel / SourceModelName: what the image was made with ("" unknown).
	SourceModel     string `json:"sourceModel"`
	SourceModelName string `json:"sourceModelName"`
	// Cloud is the model a cloud run uses by default (the source's when the
	// cloud runs it, else the selected cloud model).
	Cloud *types.ModelInfo `json:"cloud,omitempty"`
	// Local is the model loaded on this computer (nil: none / web).
	Local *types.ModelInfo `json:"local,omitempty"`
	// LocalIsSource: the loaded model is the one the image was made with.
	LocalIsSource bool `json:"localIsSource"`
	// SourceLocal: the source's model can be loaded on this computer (offer it).
	SourceLocal *types.ModelInfo `json:"sourceLocal,omitempty"`
	// Previous: an edit model is loaded; this is the model to switch back to.
	Previous *types.ModelInfo `json:"previous,omitempty"`
}

// ToolGenModels resolves GenToolModels for tool toolID on a gallery item
// (sourceName; meta for an unsaved / client-gallery source).
func (a *App) ToolGenModels(toolID, sourceName string, meta *types.GenerationMeta) GenToolModels {
	out := GenToolModels{}
	if sourceName != "" && !strings.ContainsAny(sourceName, `/\`) {
		if m := readSidecar(filepath.Join(a.outputDir(), sourceName)); m != nil {
			meta = m
		}
	}
	if meta != nil {
		out.SourceModel, out.SourceModelName = meta.ModelCode, meta.ModelName
	}
	s := a.settings.Get()
	if a.toolsCat != nil {
		if t, ok := a.toolsCat.Get(toolID); ok && t.IsGeneration() {
			cp := cloudToolParams(t, map[string]any{}, meta, s, a.editDefaultModel(), a.cloudHasModel)
			if code, _ := cp["model"].(string); code != "" {
				if m, err := a.cloudCatalogModel(code); err == nil {
					out.Cloud = m
				}
			}
		}
	}
	if a.cloudOnly {
		return out
	}
	if lm := s.LocalModel; lm != nil {
		l := *lm
		out.Local = &l
		out.LocalIsSource = out.SourceModel != "" && l.ModelCode == out.SourceModel
		if cloud.IsEditBackend(l.BackendType) && s.PreviousLocalModel != "" {
			if m, err := a.localCatalogModel(s.PreviousLocalModel); err == nil {
				out.Previous = m
			}
		}
	}
	if out.SourceModel != "" && !out.LocalIsSource {
		if m, err := a.localCatalogModel(out.SourceModel); err == nil {
			out.SourceLocal = m
		}
	}
	return out
}

// cloudOffer prices a cloud re-run for the "run in the cloud?" prompt.
func (a *App) cloudOffer(t tools.Tool, params map[string]any, source *types.GenerationMeta) *tools.CloudOffer {
	s := a.settings.Get()
	credits := t.Credits
	if t.IsGeneration() {
		credits = 0
		cp := cloudToolParams(t, params, source, s, a.editDefaultModel(), a.cloudHasModel)
		code, _ := cp["model"].(string)
		switch {
		case s.CloudModelInfo != nil && s.CloudModelInfo.ModelCode == code:
			credits = float64(s.CloudModelInfo.Cost)
		case code != "":
			if m, err := a.cloudCatalogModel(code); err == nil && m != nil {
				credits = float64(m.Cost)
			}
		}
	}
	return &tools.CloudOffer{Credits: credits, USD: credits * creditUSD, Rail: cloudRail(s.PaymentMode)}
}

// runToolLocal runs on this machine: generation tools in the generation
// sidecar, the rest in the tools sidecar.
func (a *App) runToolLocal(ctx context.Context, jobID string, t tools.Tool, inputs, params map[string]any, outDir string, job *toolJob) ([]rawOutput, map[string]any, *tools.Error) {
	var res *tools.EngineResult
	if t.IsGeneration() {
		job.onGeneration.Store(true)
		a.emitToolProgress(tools.Progress{JobID: jobID, ToolID: t.ID, Stage: "loading"})
		raw, err := a.sidecar.RunTool(ctx, map[string]any{
			"tool_id": t.ID, "job_id": jobID, "inputs": inputs, "params": params, "output_dir": outDir,
		})
		if err != nil {
			if job.cancelled.Load() || ctx.Err() != nil {
				return nil, nil, &tools.Error{Code: tools.CodeCancelled, Message: "cancelled"}
			}
			return nil, nil, tools.NewError(tools.CodeInternal, err.Error())
		}
		var terr *tools.Error
		if res, terr = tools.DecodeRunResult(raw); terr != nil {
			return nil, nil, terr
		}
	} else {
		var terr *tools.Error
		res, terr = a.tools.Run(ctx, tools.EngineRequest{
			JobID: jobID, ToolID: t.ID, Inputs: inputs, Params: params, OutputDir: outDir,
		})
		if terr != nil {
			return nil, nil, terr
		}
	}
	outs := make([]rawOutput, 0, len(res.Outputs))
	for _, o := range res.Outputs {
		outs = append(outs, rawOutput{name: o.Name, typ: o.Type, format: o.Format, path: o.Path, text: o.Text,
			width: o.Width, height: o.Height, seed: o.Seed()})
	}
	return outs, res.Params, nil
}

// runToolCloud uploads the inputs to imference and downloads the outputs.
func (a *App) runToolCloud(ctx context.Context, jobID string, t tools.Tool, inputs, params map[string]any, outDir string) ([]rawOutput, float64, *tools.Error) {
	s := a.settings.Get()
	rail := cloudRail(s.PaymentMode)
	var signer *wallet.Wallet
	if rail == "x402" {
		w, err := wallet.LoadFromKeychain()
		if err != nil {
			return nil, 0, tools.NewError(tools.CodeCloud, "x402 mode selected but no wallet configured — open Settings to generate/import one")
		}
		signer = w
	} else if s.APIKey == "" {
		return nil, 0, tools.NewError(tools.CodeCloud, "Cloud API key not set — add it in Settings")
	}
	files := map[string][]string{}
	for name, v := range inputs {
		switch x := v.(type) {
		case string:
			files[name] = []string{x}
		case []string:
			files[name] = x
		}
	}
	res, err := a.cloud.RunTool(ctx, rail, s.APIKey, signer, cloud.ToolRequest{ToolID: t.ID, Files: files, Params: params}, outDir,
		nil, func(stage string) { a.emitToolProgress(tools.Progress{JobID: jobID, ToolID: t.ID, Stage: stage}) })
	if err != nil {
		var ce *cloud.ToolError
		if errors.As(err, &ce) {
			return nil, 0, &tools.Error{Code: ce.Code, Message: ce.Message}
		}
		return nil, 0, tools.NewError(tools.CodeCloud, err.Error())
	}
	outs := make([]rawOutput, 0, len(res.Outputs))
	for _, o := range res.Outputs {
		seed := 0
		if f, ok := o.Seed.(float64); ok {
			seed = int(f)
		}
		format := o.Format
		if format == "" && o.LocalPath != "" {
			format = strings.TrimPrefix(strings.ToLower(filepath.Ext(o.LocalPath)), ".")
		}
		outs = append(outs, rawOutput{name: o.Name, typ: o.Type, format: format, path: o.LocalPath, text: o.Text,
			width: o.Width, height: o.Height, seed: seed})
	}
	return outs, res.Credits, nil
}

// ------------------------------------------------------------------------
// Instruction editing: edit models
// ------------------------------------------------------------------------

// EditModelsInfo is what the instruct-edit dialog's model selector shows.
type EditModelsInfo struct {
	// Cloud lists the catalog's instruction-edit models (cloud.EditModels:
	// im_engine qwenimage-edit, else a code/name containing "edit").
	Cloud []types.ModelInfo `json:"cloud"`
	// DefaultCloud is the model a cloud run uses when none is picked.
	DefaultCloud string `json:"defaultCloud"`
	// Local is the loaded local model when it is an edit model (nil otherwise).
	Local *types.ModelInfo `json:"local,omitempty"`
	// CloudError is set when the catalog could not be fetched (offline).
	CloudError string `json:"cloudError,omitempty"`
	// LocalCandidate is the edit model "Use on this computer" switches to:
	// the catalog's locally runnable edit model, else the built-in entry.
	LocalCandidate *types.ModelInfo `json:"localCandidate,omitempty"`
	// LocalCandidateCached: its weights are already downloaded (no 13 GB wait).
	LocalCandidateCached bool `json:"localCandidateCached"`
	// Previous is the model to switch back to after a SwitchToEditModel.
	Previous *types.ModelInfo `json:"previous,omitempty"`
	// Engine is the local model the engine holds now (what a swap replaces).
	Engine *types.ModelInfo `json:"engine,omitempty"`
}

// ListEditModels returns the instruction-edit models for the dialog.
func (a *App) ListEditModels() EditModelsInfo {
	info := EditModelsInfo{Cloud: []types.ModelInfo{}}
	s := a.settings.Get()
	if m := s.LocalModel; m != nil {
		lm := *m
		info.Engine = &lm
		if cloud.IsEditBackend(m.BackendType) {
			info.Local = &lm
		}
	}
	models, err := a.cloud.ListModels(a.ctx, false)
	if err != nil {
		info.CloudError = err.Error()
	} else {
		info.Cloud = cloud.EditModels(models)
	}
	info.DefaultCloud = editDefaultFrom(info.Cloud, s)
	info.LocalCandidate = a.localEditCandidate()
	if c := info.LocalCandidate; c != nil {
		if dir, derr := modelsDir(); derr == nil {
			if fi, serr := os.Stat(filepath.Join(dir, modelcache.FileName(c.ModelCode, c.ModelURL))); serr == nil {
				info.LocalCandidateCached = fi.Size() >= a.reuseFloor(modelcache.FileName(c.ModelCode, c.ModelURL))
			}
		}
	}
	if s.PreviousLocalModel != "" && info.Local != nil {
		if m, perr := a.localCatalogModel(s.PreviousLocalModel); perr == nil {
			info.Previous = m
		}
	}
	return info
}

// localEditCandidate is the edit model to run locally: the catalog's first
// locally runnable edit model, else the built-in GGUF entry.
func (a *App) localEditCandidate() *types.ModelInfo {
	if models, err := a.cloud.ListModels(a.ctx, true); err == nil {
		for _, m := range cloud.EditModels(models) {
			mm := m
			return &mm
		}
	}
	m := cloud.BuiltinEditModel()
	return &m
}

// SwitchToEditModel makes the edit model the local model (downloading it the
// first time, like SelectLocalModel — progress on "model:progress") and
// remembers the model it replaces, for SwitchBackFromEditModel.
func (a *App) SwitchToEditModel() error {
	c := a.localEditCandidate()
	s := a.settings.Get()
	if s.LocalModel != nil && !cloud.IsEditBackend(s.LocalModel.BackendType) && s.LocalModel.LocalPath == "" {
		s.PreviousLocalModel = s.LocalModel.ModelCode
		if _, err := a.settings.Save(s); err != nil {
			return err
		}
	}
	a.bus.Info("tools", "switch to edit model", map[string]any{"model": c.ModelCode, "previous": s.PreviousLocalModel})
	return a.SelectLocalModel(c.ModelCode)
}

// SwitchBackFromEditModel restores the model that was loaded before
// SwitchToEditModel (a restart from the cache: its weights were kept).
func (a *App) SwitchBackFromEditModel() error {
	s := a.settings.Get()
	prev := s.PreviousLocalModel
	if prev == "" {
		return fmt.Errorf("no previous model to switch back to")
	}
	s.PreviousLocalModel = ""
	if _, err := a.settings.Save(s); err != nil {
		return err
	}
	a.bus.Info("tools", "switch back from edit model", map[string]any{"model": prev})
	return a.SelectLocalModel(prev)
}

// editDefaultFrom picks the default cloud edit model: the selected cloud
// model when it is an edit model, else qwen-image-edit-2511 when the catalog
// lists it (or the catalog is unknown), else the catalog's first edit model.
func editDefaultFrom(editModels []types.ModelInfo, s types.Settings) string {
	if s.CloudModelInfo != nil && s.CloudModelInfo.ModelCode == s.CloudModel && cloud.IsEditModel(s.CloudModelInfo) {
		return s.CloudModel
	}
	if len(editModels) == 0 {
		return cloud.DefaultEditModel
	}
	for _, m := range editModels {
		if m.ModelCode == cloud.DefaultEditModel {
			return m.ModelCode
		}
	}
	return editModels[0].ModelCode
}

// editDefaultModel resolves the default edit model from the cached catalog
// (no network: called on the run path, where the catalog is usually warm).
func (a *App) editDefaultModel() string {
	return editDefaultFrom(cloud.EditModels(a.cloud.CachedCloudModels()), a.settings.Get())
}

// cachedEditCloudModel is the default edit model's catalog entry, from the
// cached catalog (nil when it was never fetched).
func (a *App) cachedEditCloudModel() *types.ModelInfo {
	s := a.settings.Get()
	code := a.editDefaultModel()
	if s.CloudModelInfo != nil && s.CloudModelInfo.ModelCode == code {
		return s.CloudModelInfo
	}
	for _, m := range a.cloud.CachedCloudModels() {
		if m.ModelCode == code {
			return &m
		}
	}
	return nil
}

// ------------------------------------------------------------------------
// Local API backend
// ------------------------------------------------------------------------

// toolsAPIBackend adapts the App to the agents' local API: local runs only,
// outputs saved to the gallery like any other run.
type toolsAPIBackend struct{ a *App }

func (b toolsAPIBackend) LocalAvailable(toolID string) bool {
	t, ok := b.a.toolsCat.Get(toolID)
	if !ok {
		return false
	}
	return tools.Assess(t, b.a.toolsHost()).Badge.IsLocal()
}

func (b toolsAPIBackend) RunLocal(ctx context.Context, toolID string, inputs map[string][]string, params map[string]any) (*tools.APIResult, *tools.Error) {
	res := b.a.runTool(ctx, ToolRunRequest{JobID: "api_" + newToolJobID(), ToolID: toolID, Inputs: inputs, Params: params, RunOn: tools.ModeLocal})
	if res.Error != nil {
		e := *res.Error
		e.CloudRetry = nil // agents choose run_on themselves
		return nil, &e
	}
	out := &tools.APIResult{ToolID: toolID, DurationMs: res.DurationMs, Outputs: []tools.APIOutput{}}
	for _, o := range res.Outputs {
		out.Outputs = append(out.Outputs, tools.APIOutput{Name: o.Name, Type: o.Type, Format: o.Format, Path: o.Path, Text: o.Text})
	}
	return out, nil
}
