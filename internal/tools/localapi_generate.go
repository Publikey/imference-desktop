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
	Model string `json:"model"`
	// ModelName is the name Desktop shows (Model is its code).
	ModelName  string      `json:"model_name,omitempty"`
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

// CredentialsBackend hands the account's API key to agents when the user
// allows it (Settings › AI agents), so the MCP server's cloud runs use the
// key Desktop already has — never copied into the agent's config.
type CredentialsBackend interface {
	// CloudCredentials returns the key ("" = none saved) and whether agents may use it.
	CloudCredentials() (apiKey string, allowed bool)
}

// CodeNotAllowed: the user hasn't allowed agents to spend their credits.
const CodeNotAllowed = "not_allowed"

// CodeNoAPIKey: no API key is saved in Desktop.
const CodeNoAPIKey = "no_api_key"

// handleCloudCredentials is GET /v1/cloud-credentials → {"api_key"}.
func (s *APIServer) handleCloudCredentials(w http.ResponseWriter, r *http.Request) {
	c, ok := s.Backend.(CredentialsBackend)
	if !ok {
		writeErr(w, http.StatusNotFound, &Error{Code: CodeInvalidInput, Message: "not available in this build"})
		return
	}
	key, allowed := c.CloudCredentials()
	switch {
	case !allowed:
		writeErr(w, http.StatusForbidden, &Error{Code: CodeNotAllowed,
			Message: "Imference Desktop doesn't let AI agents spend its credits: turn on Settings › AI agents › Let AI agents spend my credits"})
	case key == "":
		writeErr(w, http.StatusNotFound, &Error{Code: CodeNoAPIKey,
			Message: "no Imference account in Imference Desktop yet: buy credits or add an API key in Settings › Credits & account"})
	default:
		if s.Bus != nil {
			s.Bus.Info("tools", "AI agent got the account's API key for cloud runs", map[string]any{"agent": AgentFrom(r.Context())})
		}
		writeJSON(w, http.StatusOK, map[string]any{"api_key": key})
	}
}

// AgentReport is POST /v1/agent-runs: an agent tells Desktop about a cloud
// run it started itself (the MCP server's generate with run_on: cloud), so
// it shows in Activity and, once done, in the gallery like a local run.
// Desktop fetches the result itself from the request_id (never a URL from
// the caller).
type AgentReport struct {
	// ID identifies the run across reports (the cloud request_id).
	ID string `json:"id"`
	// State: running, done, error.
	State string `json:"state"`
	// Kind: generate (the only one today).
	Kind      string  `json:"kind"`
	Label     string  `json:"label"`
	Model     string  `json:"model"`
	RequestID string  `json:"request_id"`
	Credits   float64 `json:"credits"`
	Error     string  `json:"error"`
}

// AgentReportBackend receives the agents' cloud runs. Optional (404 without).
type AgentReportBackend interface {
	ReportAgentRun(ctx context.Context, r AgentReport) *Error
}

func (s *APIServer) handleAgentRun(w http.ResponseWriter, r *http.Request) {
	b, ok := s.Backend.(AgentReportBackend)
	if !ok {
		writeErr(w, http.StatusNotFound, &Error{Code: CodeInvalidInput, Message: "not available in this build"})
		return
	}
	var rep AgentReport
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&rep); err != nil {
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: "invalid JSON body: " + err.Error()})
		return
	}
	switch {
	case strings.TrimSpace(rep.ID) == "" || len(rep.ID) > 128:
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Field: "id", Message: "id is required"})
		return
	case rep.State != "running" && rep.State != "done" && rep.State != "error":
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Field: "state", Message: "state must be running, done or error"})
		return
	}
	if terr := b.ReportAgentRun(r.Context(), rep); terr != nil {
		writeErr(w, statusFor(terr.Code), terr)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true})
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
