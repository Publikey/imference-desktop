package main

import (
	"context"
	"encoding/base64"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"time"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/genparams"
	"imference-desktop-go/internal/tools"
	"imference-desktop-go/internal/types"
)

// Local generation for agents (the local API's /v1/generation and
// /v1/generate, used by the Imference MCP server with run_on: local).

// agentEngineWait bounds how long an agent's request waits for the engine to
// load a model (a cold start or a model switch).
const agentEngineWait = 10 * time.Minute

// agentDefaultStrength is the img2img strength when the agent doesn't give
// one (the composer's default).
const agentDefaultStrength = 0.6

// AgentRun is the "agent:run" event: a run an AI agent started through the
// local API, shown as an Activity row ("via Claude") and, once done, in the
// gallery — the user sees what the agent does on their machine.
type AgentRun struct {
	JobID string `json:"jobId"`
	// Kind: generate or tool.
	Kind   string `json:"kind"`
	ToolID string `json:"toolId,omitempty"`
	// Label: the prompt (generate) or the tool's name.
	Label string `json:"label"`
	// Agent: the client behind the MCP server (claude-ai, claude-code…), "" = unknown.
	Agent string `json:"agent,omitempty"`
	// Model: the model's name (generate), as the app shows it.
	Model string `json:"model,omitempty"`
	// Mode: where it runs — local (this computer) or cloud (the agent's own
	// cloud call, reported through POST /v1/agent-runs).
	Mode string `json:"mode"`
	// State: running, done, error.
	State string                  `json:"state"`
	Image *types.GenerationResult `json:"image,omitempty"`
	Tool  *ToolRunResult          `json:"tool,omitempty"`
	Error string                  `json:"error,omitempty"`
}

func (a *App) emitAgentRun(r AgentRun) {
	if r.State == "running" {
		agent := r.Agent
		if agent == "" {
			agent = "(not sent)"
		}
		a.bus.Info("agent", "run started by an AI agent", map[string]any{"agent": agent, "kind": r.Kind, "model": r.Model, "tool": r.ToolID})
	}
	if a.canEmit() {
		a.emit("agent:run", r)
	}
}

// agentModelName is the name the app shows for the model a run will use
// (code "" = the loaded one).
func (a *App) agentModelName(ctx context.Context, code string) string {
	m := a.settings.Get().LocalModel
	code = strings.TrimSpace(code)
	if code == "" || (m != nil && m.ModelCode == code) {
		if m != nil {
			return m.Name
		}
		return ""
	}
	if models, err := a.cloud.ListModels(ctx, true); err == nil {
		for _, x := range models {
			if x.ModelCode == code {
				return x.Name
			}
		}
	}
	return code
}

func newAgentJobID() string { return "agent_" + strings.TrimPrefix(newToolJobID(), "tool_") }

// engineInstalled reports whether the local engine is installed (tests stub it).
var engineInstalled = func(a *App) bool { return a.GetEngineInfo().Installed }

func (b toolsAPIBackend) GenerationInfo(ctx context.Context) tools.GenerationInfo {
	a := b.a
	s := a.settings.Get()
	info := tools.GenerationInfo{EngineState: a.sidecar.Status().State, Models: []tools.GenModel{}}
	cached := map[string]bool{}
	if a.modelCache != nil {
		for _, e := range a.modelCache.List() {
			if e.ModelCode != "" {
				cached[e.ModelCode] = true
			}
		}
	}
	active := ""
	if s.LocalModel != nil {
		active = s.LocalModel.ModelCode
		info.Model = &tools.GenModel{Code: active, Name: s.LocalModel.Name, Backend: s.LocalModel.BackendType,
			Cached: true, Active: true, Video: s.LocalModel.BackendType == "wan"}
	}
	if models, err := a.cloud.ListModels(ctx, true); err == nil {
		for _, m := range models {
			if cloud.IsEditBackend(m.BackendType) {
				continue // edit models don't generate from a prompt
			}
			info.Models = append(info.Models, tools.GenModel{Code: m.ModelCode, Name: m.Name, Backend: m.BackendType,
				Cached: cached[m.ModelCode] || m.ModelCode == active, Active: m.ModelCode == active, Video: m.BackendType == "wan"})
		}
	}
	switch {
	case !engineInstalled(a):
		info.Reason = "engine_not_installed"
	case s.LocalModel == nil:
		info.Reason = "no_model"
	case cloud.IsEditBackend(s.LocalModel.BackendType):
		info.Reason = "edit_model_loaded"
	default:
		info.Ready = true
	}
	return info
}

func (b toolsAPIBackend) Generate(ctx context.Context, body tools.GenerateBody, sourcePath string) (res *tools.GenerateResult, terr *tools.Error) {
	a := b.a
	// The Activity row: running now (a model switch or a cold start can take
	// a while — the user sees why the GPU is busy), then done or failed.
	run := AgentRun{JobID: newAgentJobID(), Kind: "generate", Label: strings.TrimSpace(body.Prompt), Agent: tools.AgentFrom(ctx), State: "running",
		Model: a.agentModelName(ctx, body.Model), Mode: "local"}
	a.emitAgentRun(run)
	var image *types.GenerationResult
	defer func() {
		if terr != nil {
			run.State, run.Error = "error", terr.Message
		} else {
			run.State, run.Image = "done", image
			if res != nil && res.ModelName != "" {
				run.Model = res.ModelName
			}
		}
		a.emitAgentRun(run)
	}()
	res, image, terr = b.generate(ctx, body, sourcePath)
	return res, terr
}

func (b toolsAPIBackend) generate(ctx context.Context, body tools.GenerateBody, sourcePath string) (*tools.GenerateResult, *types.GenerationResult, *tools.Error) {
	a := b.a
	start := time.Now()
	if !engineInstalled(a) {
		return nil, nil, &tools.Error{Code: tools.CodeEngineNotReady,
			Message: "the local engine isn't installed: install it in Imference Desktop (Settings > Local engine), or use run_on: cloud"}
	}
	s := a.settings.Get()
	want := strings.TrimSpace(body.Model)
	if want == "" && s.LocalModel == nil {
		return nil, nil, &tools.Error{Code: tools.CodeEngineNotReady, Field: "model",
			Message: "no local model is selected in Imference Desktop: pass model, or pick one in the app"}
	}
	// Another model asked for: load it if its weights are on this computer.
	if want != "" && (s.LocalModel == nil || s.LocalModel.ModelCode != want) {
		ok, err := a.EnsureLocalModel(want)
		if err != nil {
			return nil, nil, &tools.Error{Code: tools.CodeInvalidInput, Field: "model", Message: err.Error()}
		}
		if !ok {
			return nil, nil, &tools.Error{Code: tools.CodeModelNotCached, Field: "model",
				Message: "model " + want + " isn't downloaded on this computer: download it in Imference Desktop first, or use run_on: cloud"}
		}
		if terr := a.waitForModel(ctx, want); terr != nil {
			return nil, nil, terr
		}
		s = a.settings.Get()
	}
	model := s.LocalModel
	if err := editModelGenerateGuard(model); err != nil {
		return nil, nil, &tools.Error{Code: tools.CodeUnsupportedRuntime, Reason: "edit_model_loaded", Message: err.Error()}
	}
	// The engine starts on demand (first run of the session, or stopped by the user).
	if st := a.sidecar.Status().State; st != "ready" {
		if st != "starting" {
			if err := a.StartSidecar(); err != nil {
				return nil, nil, &tools.Error{Code: tools.CodeEngineNotReady, Message: "the local engine couldn't start: " + err.Error()}
			}
		}
		if terr := a.waitForModel(ctx, model.ModelCode); terr != nil {
			return nil, nil, terr
		}
	}

	req, _ := genparams.Build(model, genparams.Request{
		Prompt: body.Prompt, NegativePrompt: body.NegativePrompt, FormatCode: body.FormatCode,
		Width: body.Width, Height: body.Height, Steps: body.Steps, GuidanceScale: body.GuidanceScale,
		Seed: body.Seed, Scheduler: body.Scheduler,
	})
	if sourcePath != "" {
		data, err := os.ReadFile(sourcePath)
		if err != nil {
			return nil, nil, &tools.Error{Code: tools.CodeInvalidInput, Field: "source_image", Message: err.Error()}
		}
		mt := mime.TypeByExtension(filepath.Ext(sourcePath))
		if mt == "" {
			mt = "image/png"
		}
		req.SourceImage = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(data)
		req.Strength = body.Strength
		if req.Strength <= 0 || req.Strength > 1 {
			req.Strength = agentDefaultStrength
		}
	}

	res, err := a.GenerateLocal(req)
	if err != nil {
		code := tools.CodeInternal
		if msg := strings.ToLower(err.Error()); strings.Contains(msg, "out of memory") || strings.Contains(msg, "oom") {
			code = tools.CodeOOM
		}
		return nil, nil, &tools.Error{Code: code, Message: err.Error()}
	}
	out := &tools.GenerateResult{Model: model.ModelCode, ModelName: model.Name, Seed: res.Seed, DurationMs: time.Since(start).Milliseconds(), Outputs: []tools.APIOutput{}}
	if res.SavedPath != "" {
		kind := "image"
		if model.BackendType == "wan" {
			kind = "video"
		}
		out.Outputs = append(out.Outputs, tools.APIOutput{Name: "image", Type: kind,
			Format: strings.TrimPrefix(filepath.Ext(res.SavedPath), "."), Path: res.SavedPath, Width: req.Width, Height: req.Height})
	}
	return out, &res, nil
}

// waitForModel waits until the engine is ready with model code loaded.
func (a *App) waitForModel(ctx context.Context, code string) *tools.Error {
	deadline := time.Now().Add(agentEngineWait)
	for {
		st := a.sidecar.Status()
		m := a.settings.Get().LocalModel
		if st.State == "ready" && m != nil && m.ModelCode == code {
			return nil
		}
		if st.State == "error" {
			return &tools.Error{Code: tools.CodeEngineNotReady, Message: "the local engine failed to load the model: " + st.Message}
		}
		if time.Now().After(deadline) {
			return &tools.Error{Code: tools.CodeTimeout, Message: "the local engine took too long to load " + code}
		}
		select {
		case <-ctx.Done():
			return &tools.Error{Code: tools.CodeCancelled, Message: "request cancelled"}
		case <-time.After(500 * time.Millisecond):
		}
	}
}

// agentCloudFetch bounds how long Desktop polls for an agent's cloud result.
var agentCloudFetch = 15 * time.Minute

// ReportAgentRun shows an agent's own cloud run (the MCP server's generate in
// the cloud): an Activity row "via Claude" while it runs; once done, Desktop
// fetches the result from its request_id (the public status endpoint, any
// rail) and saves it to the gallery like any cloud run.
func (b toolsAPIBackend) ReportAgentRun(ctx context.Context, r tools.AgentReport) *tools.Error {
	a := b.a
	run := AgentRun{JobID: "agentcloud_" + safeJobPart(r.ID), Kind: "generate", Label: strings.TrimSpace(r.Label),
		Agent: tools.AgentFrom(ctx), Model: a.cloudModelName(ctx, r.Model), Mode: "cloud", State: r.State, Error: r.Error}
	if r.State != "done" || strings.TrimSpace(r.RequestID) == "" {
		a.emitAgentRun(run)
		return nil
	}
	go func() {
		fctx, cancel := context.WithTimeout(context.Background(), agentCloudFetch)
		defer cancel()
		res, err := a.cloud.Resume(fctx, "x402", "", r.RequestID)
		if err != nil {
			a.bus.Warn("agent", "couldn't fetch an agent's cloud result", map[string]any{"request_id": r.RequestID, "err": err.Error()})
			run.State, run.Error = "error", "the result couldn't be downloaded: "+err.Error()
			a.emitAgentRun(run)
			return
		}
		res.Source = "cloud"
		a.autoSave(&res, types.GenerationMeta{Prompt: run.Label, ModelCode: r.Model, ModelName: run.Model})
		run.Image = &res
		a.emitAgentRun(run)
	}()
	return nil
}

// cloudModelName is the catalog name of a cloud model (its code when unknown).
func (a *App) cloudModelName(ctx context.Context, code string) string {
	code = strings.TrimSpace(code)
	if code == "" {
		return ""
	}
	if models, err := a.cloud.ListModels(ctx, false); err == nil {
		for _, m := range models {
			if m.ModelCode == code {
				return m.Name
			}
		}
	}
	return code
}

// safeJobPart keeps an id usable as part of a job id.
func safeJobPart(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == '_' || (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// CloudCredentials: the account's key for the agents' cloud runs, when the
// user allows it (Settings › AI agents).
func (b toolsAPIBackend) CloudCredentials() (string, bool) {
	s := b.a.settings.Get()
	return strings.TrimSpace(s.APIKey), s.Tools.AgentsCanSpend
}

var (
	_ tools.GenerateBackend    = toolsAPIBackend{}
	_ tools.CredentialsBackend = toolsAPIBackend{}
	_ tools.AgentReportBackend = toolsAPIBackend{}
)
