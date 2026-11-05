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
)

// Local generation for agents (the local API's /v1/generation and
// /v1/generate, used by the Imference MCP server with run_on: local).

// agentEngineWait bounds how long an agent's request waits for the engine to
// load a model (a cold start or a model switch).
const agentEngineWait = 10 * time.Minute

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

func (b toolsAPIBackend) Generate(ctx context.Context, body tools.GenerateBody, sourcePath string) (*tools.GenerateResult, *tools.Error) {
	a := b.a
	start := time.Now()
	if !engineInstalled(a) {
		return nil, &tools.Error{Code: tools.CodeEngineNotReady,
			Message: "the local engine isn't installed: install it in Imference Desktop (Settings > Local engine), or use run_on: cloud"}
	}
	s := a.settings.Get()
	want := strings.TrimSpace(body.Model)
	if want == "" && s.LocalModel == nil {
		return nil, &tools.Error{Code: tools.CodeEngineNotReady, Field: "model",
			Message: "no local model is selected in Imference Desktop: pass model, or pick one in the app"}
	}
	// Another model asked for: load it if its weights are on this computer.
	if want != "" && (s.LocalModel == nil || s.LocalModel.ModelCode != want) {
		ok, err := a.EnsureLocalModel(want)
		if err != nil {
			return nil, &tools.Error{Code: tools.CodeInvalidInput, Field: "model", Message: err.Error()}
		}
		if !ok {
			return nil, &tools.Error{Code: tools.CodeModelNotCached, Field: "model",
				Message: "model " + want + " isn't downloaded on this computer: download it in Imference Desktop first, or use run_on: cloud"}
		}
		if terr := a.waitForModel(ctx, want); terr != nil {
			return nil, terr
		}
		s = a.settings.Get()
	}
	model := s.LocalModel
	if err := editModelGenerateGuard(model); err != nil {
		return nil, &tools.Error{Code: tools.CodeUnsupportedRuntime, Reason: "edit_model_loaded", Message: err.Error()}
	}
	// The engine starts on demand (first run of the session, or stopped by the user).
	if st := a.sidecar.Status().State; st != "ready" {
		if st != "starting" {
			if err := a.StartSidecar(); err != nil {
				return nil, &tools.Error{Code: tools.CodeEngineNotReady, Message: "the local engine couldn't start: " + err.Error()}
			}
		}
		if terr := a.waitForModel(ctx, model.ModelCode); terr != nil {
			return nil, terr
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
			return nil, &tools.Error{Code: tools.CodeInvalidInput, Field: "source_image", Message: err.Error()}
		}
		mt := mime.TypeByExtension(filepath.Ext(sourcePath))
		if mt == "" {
			mt = "image/png"
		}
		req.SourceImage = "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(data)
		req.Strength = body.Strength
	}

	res, err := a.GenerateLocal(req)
	if err != nil {
		code := tools.CodeInternal
		if msg := strings.ToLower(err.Error()); strings.Contains(msg, "out of memory") || strings.Contains(msg, "oom") {
			code = tools.CodeOOM
		}
		return nil, &tools.Error{Code: code, Message: err.Error()}
	}
	out := &tools.GenerateResult{Model: model.ModelCode, Seed: res.Seed, DurationMs: time.Since(start).Milliseconds(), Outputs: []tools.APIOutput{}}
	if res.SavedPath != "" {
		kind := "image"
		if model.BackendType == "wan" {
			kind = "video"
		}
		out.Outputs = append(out.Outputs, tools.APIOutput{Name: "image", Type: kind,
			Format: strings.TrimPrefix(filepath.Ext(res.SavedPath), "."), Path: res.SavedPath, Width: req.Width, Height: req.Height})
	}
	return out, nil
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

var _ tools.GenerateBackend = toolsAPIBackend{}
