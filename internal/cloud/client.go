// Package cloud is the HTTP client for the imference.com credit-based image
// generation endpoint. Mirrors the contract from
// imference-desktop/src/renderer/src/lib/cloud.ts and the Go server-side
// definitions in C:\git windows\imference\app\models\image.go.
package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
	"imference-desktop-go/internal/x402"
)

const (
	defaultBase    = "https://imference.com"
	postTimeout    = 30 * time.Second
	statusTimeout  = 10 * time.Second
	pollInterval   = 1 * time.Second
	overallTimeout = 120 * time.Second
	catalogTTL     = 5 * time.Minute // the model catalog is effectively static per session
)

type Client struct {
	base string
	http *http.Client
	bus  *logbus.Bus

	// catalog caches the full (unfiltered) /api/models response. The catalog
	// rarely changes during a session, yet it's hit on every list AND every
	// model-select (which looks one entry up by code). One fetch serves them
	// all until the TTL lapses. Guarded by catalogMu.
	catalogMu      sync.Mutex
	catalog        []apiModel
	catalogFetched time.Time

	// formats caches the /api/formats response (per-model resolutions/ratios),
	// same TTL semantics as the catalog. Guarded by formatsMu.
	formatsMu      sync.Mutex
	formats        []apiFormat
	formatsFetched time.Time
}

func New(bus *logbus.Bus) *Client {
	return &Client{
		base: defaultBase,
		http: &http.Client{Timeout: 60 * time.Second}, // per-request timeouts override
		bus:  bus,
	}
}

// postBody mirrors PostImagePayload in imference/app/models/image.go.
// snake_case JSON tags match the Go server's expectations.
type postBody struct {
	Model          string  `json:"model"`
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negative_prompt,omitempty"`
	Width          int     `json:"width,omitempty"`
	Height         int     `json:"height,omitempty"`
	NumSteps       int     `json:"steps,omitempty"`
	GuidanceScale  float64 `json:"guidance_scale,omitempty"`
	Seed           *int    `json:"seed,omitempty"`
	BatchNbr       int     `json:"batch_nbr,omitempty"`
}

type postResponse struct {
	RequestID string `json:"request_id"`
}

// statusResponse mirrors GetImageResponse in imference/app/models/image.go.
// Note the PascalCase JSON keys — the Go server uses default field names.
type statusResponse struct {
	Data struct {
		RequestID string `json:"RequestID"`
		URL       string `json:"URL"`
		Format    string `json:"Format"`
		Seed      int    `json:"Seed"`
		Timestamp string `json:"Timestamp"`
	} `json:"data"`
}

type statusErrorBody struct {
	Error string `json:"error"`
}

// apiModel mirrors one entry of GET /api/models on the wire (snake_case). We
// map it to types.ModelInfo (camelCase) so the frontend gets native-feeling
// keys and the rest of the app doesn't depend on the server's casing.
type apiModel struct {
	ModelCode         string  `json:"model_code"`
	Name              string  `json:"name"`
	ShortDescription  string  `json:"short_description"`
	MediumDescription string  `json:"medium_description"`
	Image             string  `json:"image"`
	ModelURL          string  `json:"model_url"`
	PromptPre         string  `json:"prompt_pre"`
	PromptNegative    string  `json:"prompt_negative"`
	StepsDefault      int     `json:"steps_default"`
	StepsMin          int     `json:"steps_min"`
	StepsMax          int     `json:"steps_max"`
	CfgDefault        float64 `json:"cfg_default"`
	CfgMin            float64 `json:"cfg_min"`
	CfgMax            float64 `json:"cfg_max"`
	SkipDefault       int     `json:"skip_default"`
	SchedulerDefault  string  `json:"scheduler_default"`
	FormatCode        string  `json:"format_code"`
	// ImEngine is the catalog's engine discriminator: an image backend (sdxl,
	// sd15, zimage, flux, chroma, qwenimage, anima), "wan22", "external", or null. Mapped to the internal backend name; the
	// local picker skips the ones that aren't locally runnable (external / null).
	ImEngine     string  `json:"im_engine"`
	BaseModel    string  `json:"base_model"`
	ShiftDefault float64 `json:"shift_default"`
	// ImCost is the cloud run cost in credits (1 credit = $0.001). ImLocal/ImCloud
	// declare where the model may run (drives which catalog it appears in).
	ImCost  int  `json:"im_cost"`
	ImLocal bool `json:"im_local"`
	ImCloud bool `json:"im_cloud"`
	// Catalog organization — order + family/group for sorting/grouping the list.
	ModelOrder      int    `json:"model_order"`
	ModelFamilyCode string `json:"model_family_code"`
	FamilyName      string `json:"family_name"`
	ModelGroupCode  string `json:"model_group_code"`
}

// apiFormat mirrors one im_format row (GET /api/formats).
type apiFormat struct {
	ModelCode  string `json:"model_code"`
	FormatCode string `json:"format_code"`
	Name       string `json:"name"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Ratio      string `json:"ratio"`
	IsDefault  bool   `json:"is_default"`
}

// normalizeEngine maps the catalog's im_engine value to the internal backend
// name the sidecar understands. Returns "" for values the desktop can't run
// locally — null/empty, or "external" (a remote-API model handled elsewhere).
// All seven image backends the engine exposes (imference-engine 0.3.x) plus WAN
// video are recognized; only one image backend loads per sidecar, chosen from
// the selected model's backend.
func normalizeEngine(imEngine string) string {
	switch strings.ToLower(strings.TrimSpace(imEngine)) {
	case "sdxl":
		return "sdxl"
	case "sd15", "sd1.5", "sd-1.5":
		return "sd15"
	case "zimage", "z-image":
		return "zimage"
	case "flux":
		return "flux"
	case "chroma":
		return "chroma"
	case "qwenimage", "qwen-image", "qwen_image":
		return "qwenimage"
	case "anima":
		return "anima"
	case "wan22", "wan":
		return "wan"
	default:
		return "" // "external" (later) and null/empty
	}
}

// imageBackends is the set of normalized image-backend names the sidecar can
// load (one per sidecar). Kept in sync with the engine's registered backends
// (imference-engine 0.3.x) and normalizeEngine above.
var imageBackends = map[string]bool{
	"sdxl": true, "sd15": true, "zimage": true, "flux": true,
	"chroma": true, "qwenimage": true, "anima": true,
}

// IsImageBackend reports whether name is a normalized image backend the desktop
// can run locally (excludes "wan" video and "" / external).
func IsImageBackend(name string) bool {
	return imageBackends[name]
}

// singleFileBackends is the subset of image backends that load from a single
// .safetensors checkpoint (with a base repo for the transformer-only ones). This
// is what the "add custom model" flow supports. Anima is excluded: it's a
// Modular Diffusers pipeline that needs a full diffusers-format directory, not a
// single file (its load_pipeline treats the path as a repo id -> HF error).
var singleFileBackends = map[string]bool{
	"sdxl": true, "sd15": true, "zimage": true,
	"flux": true, "chroma": true, "qwenimage": true,
}

// IsSingleFileBackend reports whether a user-supplied single .safetensors can be
// loaded as this backend. Used to validate a custom checkpoint's backend.
func IsSingleFileBackend(name string) bool {
	return singleFileBackends[name]
}

// DefaultBaseModel returns the shared base-components repo a transformer-only
// checkpoint of the given backend needs (text encoder(s) + VAE + scheduler),
// used only when the catalog carries no per-model base_model — a non-empty
// catalog base_model always wins. Backends whose checkpoints are self-contained
// (SDXL / SD 1.5 single-file; Anima has no transformer/base split) return "".
// Repos per the engine backend READMEs. NOTE: FLUX.1-dev is a GATED HF repo and
// its base components are large — rely on IMAGE_MODEL_CDN or a catalog base_model
// in practice.
func DefaultBaseModel(backend string) string {
	switch backend {
	case "zimage":
		return "Tongyi-MAI/Z-Image-Turbo"
	case "flux":
		return "black-forest-labs/FLUX.1-dev"
	case "chroma":
		return "lodestones/Chroma1-HD"
	case "qwenimage":
		return "Qwen/Qwen-Image"
	default:
		return ""
	}
}

// toModelInfo maps a wire entry to the app's camelCase ModelInfo, normalizing
// im_engine to the internal backend name and defaulting the Z-Image base repo.
func toModelInfo(m apiModel) types.ModelInfo {
	backend := normalizeEngine(m.ImEngine)
	baseModel := m.BaseModel
	if baseModel == "" {
		baseModel = DefaultBaseModel(backend)
	}
	return types.ModelInfo{
		ModelCode:         m.ModelCode,
		Name:              m.Name,
		ShortDescription:  m.ShortDescription,
		MediumDescription: m.MediumDescription,
		Image:             m.Image,
		ModelURL:          m.ModelURL,
		PromptPre:         m.PromptPre,
		PromptNegative:    m.PromptNegative,
		StepsDefault:      m.StepsDefault,
		StepsMin:          m.StepsMin,
		StepsMax:          m.StepsMax,
		CfgDefault:        m.CfgDefault,
		CfgMin:            m.CfgMin,
		CfgMax:            m.CfgMax,
		SkipDefault:       m.SkipDefault,
		SchedulerDefault:  m.SchedulerDefault,
		FormatCode:        m.FormatCode,
		BackendType:       backend,
		BaseModel:         baseModel,
		ShiftDefault:      m.ShiftDefault,
		Cost:              m.ImCost,
		CanLocal:          m.ImLocal,
		CanCloud:          m.ImCloud,
		Order:             m.ModelOrder,
		FamilyCode:        m.ModelFamilyCode,
		FamilyName:        m.FamilyName,
		GroupCode:         m.ModelGroupCode,
	}
}

// ListModels fetches the imference model catalog, filtered by the catalog's
// im_local / im_cloud flags. When localOnly is true it returns models the local
// engine can run (im_local, plus the technical prerequisites: a downloadable
// model_url and a known engine); otherwise it returns the cloud-runnable models
// (im_cloud). The endpoint is public (no auth), so this works before the user
// configures an API key.
func (c *Client) ListModels(ctx context.Context, localOnly bool) ([]types.ModelInfo, error) {
	models, err := c.fetchCatalog(ctx)
	if err != nil {
		return nil, err
	}

	// Per-model formats (resolutions/ratios). Non-fatal if it fails — models
	// still list, the UI falls back to generic square/portrait/landscape.
	formatsByModel := map[string][]types.FormatOption{}
	if fs, ferr := c.fetchFormats(ctx); ferr != nil {
		c.bus.Warn("cloud", "fetchFormats failed", map[string]any{"err": ferr.Error()})
	} else {
		for _, f := range fs {
			formatsByModel[f.ModelCode] = append(formatsByModel[f.ModelCode], types.FormatOption{
				FormatCode: f.FormatCode, Name: f.Name, Width: f.Width, Height: f.Height,
				Ratio: f.Ratio, IsDefault: f.IsDefault,
			})
		}
	}

	out := make([]types.ModelInfo, 0, len(models))
	for _, m := range models {
		if localOnly {
			// im_local is authoritative, but the sidecar still needs weights to
			// download and a backend to route to.
			if !m.ImLocal || m.ModelURL == "" || normalizeEngine(m.ImEngine) == "" {
				continue
			}
		} else if !m.ImCloud {
			continue // not cloud-runnable
		}
		mi := toModelInfo(m)
		mi.Formats = formatsByModel[m.ModelCode]
		out = append(out, mi)
	}
	// Catalog display order (model_order), then name as a stable tiebreaker.
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	c.bus.Info("cloud", "ListModels ok", map[string]any{"total": len(models), "returned": len(out), "localOnly": localOnly})
	return out, nil
}

// fetchFormats returns the full /api/formats response, cached per formatsTTL
// (same as the catalog). Public endpoint — no auth needed.
func (c *Client) fetchFormats(ctx context.Context) ([]apiFormat, error) {
	c.formatsMu.Lock()
	defer c.formatsMu.Unlock()

	if c.formats != nil && time.Since(c.formatsFetched) < catalogTTL {
		return c.formats, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, c.base+"/api/formats", nil)
	r.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("cloud: GET /api/formats: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("cloud: /api/formats HTTP %d: %s", resp.StatusCode, string(body))
	}

	var parsed struct {
		Formats []apiFormat `json:"formats"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("cloud: parse /api/formats: %w", err)
	}

	c.formats = parsed.Formats
	c.formatsFetched = time.Now()
	return parsed.Formats, nil
}

// fetchCatalog returns the full (unfiltered) /api/models response, served from
// an in-memory cache when a prior fetch is still within catalogTTL. A single
// fetch therefore backs every list and model-select within a session. The
// catalog is public (no auth), so this works before the user configures a key.
func (c *Client) fetchCatalog(ctx context.Context) ([]apiModel, error) {
	c.catalogMu.Lock()
	defer c.catalogMu.Unlock()

	if c.catalog != nil && time.Since(c.catalogFetched) < catalogTTL {
		return c.catalog, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, c.base+"/api/models", nil)
	r.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("cloud: GET /api/models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("cloud: /api/models HTTP %d: %s", resp.StatusCode, string(body))
	}

	var parsed struct {
		Models []apiModel `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("cloud: parse /api/models: %w", err)
	}

	c.catalog = parsed.Models
	c.catalogFetched = time.Now()
	return parsed.Models, nil
}

// creditsPath is the account credit-balance endpoint — the same one the
// imference web app calls (GET /credits/balance, Bearer auth, → {"credits": N}).
const creditsPath = "/credits/balance"

// creditsResponse is the wire shape of creditsPath: a flat {"credits": 100}.
type creditsResponse struct {
	Credits float64 `json:"credits"`
}

// GetCredits fetches the remaining credit balance for a Bearer API key. The
// caller passes the key explicitly (the Settings UI checks the key the user
// just typed, before it's necessarily saved). A non-200 surfaces the server's
// body so an invalid/expired key shows a useful message.
func (c *Client) GetCredits(ctx context.Context, apiKey string) (float64, error) {
	if apiKey == "" {
		return 0, errors.New("cloud: API key not set")
	}

	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, c.base+creditsPath, nil)
	r.Header.Set("Authorization", "Bearer "+apiKey)
	r.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return 0, fmt.Errorf("cloud: GET %s: %w", creditsPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return 0, fmt.Errorf("cloud: %s HTTP %d: %s", creditsPath, resp.StatusCode, string(body))
	}

	var parsed creditsResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return 0, fmt.Errorf("cloud: parse %s: %w", creditsPath, err)
	}
	c.bus.Info("cloud", "GetCredits ok", map[string]any{"credits": parsed.Credits})
	return parsed.Credits, nil
}

// Generate runs the full POST → poll → download → base64 dance and returns
// a unified GenerationResult ready for the frontend.
func (c *Client) Generate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
) (types.GenerationResult, error) {
	if apiKey == "" {
		return types.GenerationResult{}, errors.New("cloud: API key not set")
	}
	if model == "" {
		return types.GenerationResult{}, errors.New("cloud: cloud model not set")
	}

	overallCtx, cancel := context.WithTimeout(ctx, overallTimeout)
	defer cancel()

	c.bus.Info("cloud", "Generate start", map[string]any{
		"model":  model,
		"prompt": truncate(req.Prompt, 80),
		"width":  req.Width,
		"height": req.Height,
		"steps":  req.NumSteps,
	})

	requestID, err := c.postGenerate(overallCtx, apiKey, model, req)
	if err != nil {
		c.bus.Error("cloud", "postGenerate failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "postGenerate ok", map[string]any{"request_id": requestID})

	imageURL, seed, err := c.pollStatus(overallCtx, apiKey, requestID)
	if err != nil {
		c.bus.Error("cloud", "pollStatus failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "pollStatus ok", map[string]any{"url": imageURL, "seed": seed})

	b64, mime, err := c.downloadAsBase64(overallCtx, imageURL)
	if err != nil {
		c.bus.Error("cloud", "download failed", map[string]any{"err": err.Error(), "url": imageURL})
		return types.GenerationResult{}, fmt.Errorf("cloud: download image: %w", err)
	}
	c.bus.Info("cloud", "download ok", map[string]any{"bytes": len(b64) * 3 / 4, "mime": mime})

	return types.GenerationResult{
		ImageBase64: "data:" + mime + ";base64," + b64,
		Seed:        seed,
		Source:      "cloud",
	}, nil
}

// GenerateX402 is the x402 / pay-per-call USDC variant of Generate.
// Same flow shape (POST → poll → download → base64) but hits the
// /ondemand/* endpoints, has no Bearer auth, and lets the x402.Client
// transparently handle the 402-sign-retry dance using the wallet signer.
//
// The wallet signs an EIP-3009 transferWithAuthorization for the USDC
// amount the server requires (currently 0.05 USDC per image on Base).
// Polling does NOT need auth/payment — it's just a status read.
func (c *Client) GenerateX402(
	ctx context.Context,
	model string,
	req types.GenerationRequest,
	signer *wallet.Wallet,
) (types.GenerationResult, error) {
	if signer == nil {
		return types.GenerationResult{}, errors.New("cloud: x402 mode requires a configured wallet")
	}
	if model == "" {
		return types.GenerationResult{}, errors.New("cloud: cloud model not set")
	}

	overallCtx, cancel := context.WithTimeout(ctx, overallTimeout)
	defer cancel()

	c.bus.Info("cloud", "GenerateX402 start", map[string]any{
		"model":   model,
		"prompt":  truncate(req.Prompt, 80),
		"width":   req.Width,
		"height":  req.Height,
		"steps":   req.NumSteps,
		"address": signer.Address().Hex(),
	})

	x402Client := x402.New(signer)
	x402Client.HTTP = c.http
	x402Client.Logger = busAsLogger{bus: c.bus}

	requestID, err := c.postGenerateX402(overallCtx, x402Client, model, req)
	if err != nil {
		c.bus.Error("cloud", "postGenerateX402 failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "postGenerateX402 ok", map[string]any{"request_id": requestID})

	imageURL, seed, err := c.pollStatusX402(overallCtx, requestID)
	if err != nil {
		c.bus.Error("cloud", "pollStatusX402 failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "pollStatusX402 ok", map[string]any{"url": imageURL, "seed": seed})

	b64, mime, err := c.downloadAsBase64(overallCtx, imageURL)
	if err != nil {
		c.bus.Error("cloud", "download failed", map[string]any{"err": err.Error(), "url": imageURL})
		return types.GenerationResult{}, fmt.Errorf("cloud: download image: %w", err)
	}
	c.bus.Info("cloud", "download ok", map[string]any{"bytes": len(b64) * 3 / 4, "mime": mime})

	return types.GenerationResult{
		ImageBase64: "data:" + mime + ";base64," + b64,
		Seed:        seed,
		Source:      "cloud",
	}, nil
}

// busAsLogger adapts *logbus.Bus to the x402.Logger interface so the
// in-app LogPanel sees every x402 phase tagged with source="x402".
type busAsLogger struct{ bus *logbus.Bus }

func (b busAsLogger) Info(_, message string, data ...any) {
	b.bus.Info("x402", message, data...)
}
func (b busAsLogger) Warn(_, message string, data ...any) {
	b.bus.Warn("x402", message, data...)
}
func (b busAsLogger) Error(_, message string, data ...any) {
	b.bus.Error("x402", message, data...)
}

func (c *Client) postGenerateX402(
	ctx context.Context,
	x402Client *x402.Client,
	model string,
	req types.GenerationRequest,
) (string, error) {
	body := postBody{
		Model:          model,
		Prompt:         req.Prompt,
		NegativePrompt: req.NegativePrompt,
		Width:          req.Width,
		Height:         req.Height,
		NumSteps:       req.NumSteps,
		GuidanceScale:  req.GuidanceScale,
		Seed:           req.Seed,
		BatchNbr:       1,
	}

	postCtx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()

	resp, err := x402Client.DoJSON(postCtx, http.MethodPost, c.base+"/ondemand/image/generate", body, nil)
	if err != nil {
		return "", fmt.Errorf("cloud: POST /ondemand/image/generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("cloud: /ondemand/image/generate HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	var parsed postResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("cloud: parse /ondemand/image/generate response: %w", err)
	}
	if parsed.RequestID == "" {
		return "", errors.New("cloud: /ondemand/image/generate returned empty request_id")
	}
	return parsed.RequestID, nil
}

// pollStatusX402 polls the x402 status endpoint. Same response shape as
// the credit-based /image/status (data.URL + data.Seed), but the route
// is different and there's no Bearer header. The handler also wraps
// the response in {"type":"image"|"video"} but we ignore that field —
// this POC only does image, and `data.URL` is what we need.
func (c *Client) pollStatusX402(ctx context.Context, requestID string) (string, int, error) {
	statusURL := c.base + "/ondemand/status?request_id=" + url.QueryEscape(requestID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	if got, seed, done, err := c.fetchStatusX402(ctx, statusURL); err != nil {
		return "", 0, err
	} else if done {
		return got, seed, nil
	}

	for {
		select {
		case <-ctx.Done():
			return "", 0, fmt.Errorf("cloud: x402 status polling timed out after %s", overallTimeout)
		case <-ticker.C:
			got, seed, done, err := c.fetchStatusX402(ctx, statusURL)
			if err != nil {
				return "", 0, err
			}
			if done {
				return got, seed, nil
			}
		}
	}
}

func (c *Client) fetchStatusX402(ctx context.Context, statusURL string) (string, int, bool, error) {
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, statusURL, nil)
	resp, err := c.http.Do(r)
	if err != nil {
		return "", 0, false, fmt.Errorf("cloud: GET /ondemand/status: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var parsed statusResponse
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return "", 0, false, fmt.Errorf("cloud: parse /ondemand/status: %w", err)
		}
		return parsed.Data.URL, parsed.Data.Seed, true, nil
	case http.StatusNotFound:
		_, _ = io.Copy(io.Discard, resp.Body)
		return "", 0, false, nil
	default:
		var errBody statusErrorBody
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "", 0, false, fmt.Errorf("cloud: /ondemand/status: %s", msg)
	}
}

func (c *Client) postGenerate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
) (string, error) {
	body := postBody{
		Model:          model,
		Prompt:         req.Prompt,
		NegativePrompt: req.NegativePrompt,
		Width:          req.Width,
		Height:         req.Height,
		NumSteps:       req.NumSteps,
		GuidanceScale:  req.GuidanceScale,
		Seed:           req.Seed,
		BatchNbr:       1,
	}
	buf, _ := json.Marshal(body)

	postCtx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(postCtx, http.MethodPost, c.base+"/image/generate", bytes.NewReader(buf))
	r.Header.Set("Authorization", "Bearer "+apiKey)
	r.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return "", fmt.Errorf("cloud: POST /image/generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Surface the raw body when possible — most failures here are
		// auth-related (401, 402, 403) and the server message is useful.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("cloud: /image/generate HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed postResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("cloud: parse /image/generate response: %w", err)
	}
	if parsed.RequestID == "" {
		return "", errors.New("cloud: /image/generate returned empty request_id")
	}
	return parsed.RequestID, nil
}

func (c *Client) pollStatus(ctx context.Context, apiKey, requestID string) (string, int, error) {
	statusURL := c.base + "/image/status?request_id=" + url.QueryEscape(requestID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Try once immediately, then on every tick. This makes the typical
	// "image was already cached server-side" path return in <1s instead of
	// waiting for the first tick.
	if got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey); err != nil {
		return "", 0, err
	} else if done {
		return got, seed, nil
	}

	for {
		select {
		case <-ctx.Done():
			return "", 0, fmt.Errorf("cloud: status polling timed out after %s", overallTimeout)
		case <-ticker.C:
			got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey)
			if err != nil {
				return "", 0, err
			}
			if done {
				return got, seed, nil
			}
		}
	}
}

// fetchStatus returns (url, seed, done, err). done=false with err=nil means
// "not ready yet, keep polling" — matches the 404 the server returns while
// the job is still in the queue.
func (c *Client) fetchStatus(ctx context.Context, statusURL, apiKey string) (string, int, bool, error) {
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, statusURL, nil)
	r.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := c.http.Do(r)
	if err != nil {
		return "", 0, false, fmt.Errorf("cloud: GET /image/status: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var parsed statusResponse
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return "", 0, false, fmt.Errorf("cloud: parse /image/status: %w", err)
		}
		return parsed.Data.URL, parsed.Data.Seed, true, nil
	case http.StatusNotFound:
		// Expected while job is pending — the server returns
		// {"error": "image not found or not ready yet"}.
		_, _ = io.Copy(io.Discard, resp.Body)
		return "", 0, false, nil
	default:
		var errBody statusErrorBody
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "", 0, false, fmt.Errorf("cloud: /image/status: %s", msg)
	}
}

// downloadAsBase64 fetches the Azure Blob URL and returns its base64
// payload + mime type. Keeps the frontend's data: URL pipeline identical
// between cloud and local modes.
func (c *Client) downloadAsBase64(ctx context.Context, src string) (string, string, error) {
	c.bus.Trace("cloud", "GET "+src, nil)
	// Bound the download to 30s via context, but reuse the shared client so we
	// keep connection pooling / keep-alive instead of allocating a fresh one.
	dlCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	r, _ := http.NewRequestWithContext(dlCtx, http.MethodGet, src, nil)
	r.Header.Set("User-Agent", "imference-desktop-go/0.0.1")
	resp, err := c.http.Do(r)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Surface a snippet of the body — Azure Blob returns useful XML
		// (AuthenticationFailed, BlobNotFound, etc.) that beats a bare 404.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		c.bus.Warn("cloud", "blob non-200", map[string]any{
			"status":  resp.StatusCode,
			"snippet": string(snippet),
			"url":     src,
		})
		return "", "", fmt.Errorf("HTTP %d downloading image: %s", resp.StatusCode, string(snippet))
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = "image/webp"
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(raw), mime, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
