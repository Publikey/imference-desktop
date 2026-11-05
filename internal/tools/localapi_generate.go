package tools

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Local generation for agents (the MCP server's generate with run_on: local):
//
//	GET  /v1/generation -> GenerationInfo: the loaded model, the local models
//	                       and which are on disk, the engine state
//	POST /v1/generate   GenerateBody -> GenerateResult (synchronous; the image
//	                       is also saved to the gallery)
//
// A model on disk but not loaded is loaded first (never downloaded: an agent
// can't start a multi-GB download).

const (
	// CodeModelNotCached: the requested model isn't downloaded on this computer.
	CodeModelNotCached = "model_not_cached"
	// CodeEngineNotReady: the local engine isn't installed or can't start.
	CodeEngineNotReady = "engine_not_ready"
)

// GenModel is one local model as agents see it.
type GenModel struct {
	Code    string `json:"code"`
	Name    string `json:"name"`
	Backend string `json:"backend,omitempty"`
	// Cached: the weights are on this computer (it can be loaded without a download).
	Cached bool `json:"cached"`
	Active bool `json:"active"`
	Video  bool `json:"video,omitempty"`
}

// GenerationInfo is GET /v1/generation.
type GenerationInfo struct {
	// Ready: the engine is installed and a model is selected (it starts on demand).
	Ready bool `json:"ready"`
	// EngineState is the sidecar state: idle (not started yet), starting, ready, stopped, error.
	EngineState string     `json:"engine_state"`
	Model       *GenModel  `json:"model"`
	Models      []GenModel `json:"models"`
	// Reason says why Ready is false (engine_not_installed, no_model, edit_model_loaded…).
	Reason string `json:"reason,omitempty"`
}

// GenerateBody is POST /v1/generate. Zero values mean "the model's default".
type GenerateBody struct {
	Model          string  `json:"model"`
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negative_prompt"`
	FormatCode     string  `json:"format_code"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	Steps          int     `json:"steps"`
	GuidanceScale  float64 `json:"guidance_scale"`
	Seed           *int    `json:"seed"`
	Scheduler      string  `json:"scheduler"`
	// SourceImage (img2img): a path, https URL or data URI, like tool inputs.
	SourceImage string  `json:"source_image"`
	Strength    float64 `json:"strength"`
}

// GenerateResult is a finished local generation.
type GenerateResult struct {
	Model      string      `json:"model"`
	Seed       int         `json:"seed"`
	Outputs    []APIOutput `json:"outputs"`
	DurationMs int64       `json:"duration_ms"`
}

// GenerateBackend is what the server needs from the app to generate. Optional:
// a backend without it answers 404 on the generation routes.
type GenerateBackend interface {
	GenerationInfo(ctx context.Context) GenerationInfo
	// Generate runs body locally; sourcePath is the materialized source image ("" = none).
	Generate(ctx context.Context, body GenerateBody, sourcePath string) (*GenerateResult, *Error)
}

func (s *APIServer) genBackend(w http.ResponseWriter) (GenerateBackend, bool) {
	g, ok := s.Backend.(GenerateBackend)
	if !ok {
		writeErr(w, http.StatusNotFound, &Error{Code: CodeInvalidInput, Message: "local generation is not available in this build"})
	}
	return g, ok
}

func (s *APIServer) handleGenerationInfo(w http.ResponseWriter, r *http.Request) {
	g, ok := s.genBackend(w)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, g.GenerationInfo(r.Context()))
}

func (s *APIServer) handleGenerate(w http.ResponseWriter, r *http.Request) {
	g, ok := s.genBackend(w)
	if !ok {
		return
	}
	var body GenerateBody
	if err := json.NewDecoder(io.LimitReader(r.Body, apiBodyMaxBytes)).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: "invalid JSON body: " + err.Error()})
		return
	}
	if strings.TrimSpace(body.Prompt) == "" {
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: "prompt is required", Field: "prompt"})
		return
	}
	source := ""
	if strings.TrimSpace(body.SourceImage) != "" {
		work, err := os.MkdirTemp("", "imference-api-")
		if err != nil {
			writeErr(w, http.StatusInternalServerError, &Error{Code: CodeInternal, Message: err.Error()})
			return
		}
		defer os.RemoveAll(work)
		p, terr := s.materialize(r.Context(), body.SourceImage, InputSpec{}, filepath.Join(work, "source"))
		if terr != nil {
			terr.Field = "source_image"
			writeErr(w, statusFor(terr.Code), terr)
			return
		}
		source = p
	}
	res, terr := g.Generate(r.Context(), body, source)
	if terr != nil {
		writeErr(w, statusFor(terr.Code), terr)
		return
	}
	writeJSON(w, http.StatusOK, res)
}
