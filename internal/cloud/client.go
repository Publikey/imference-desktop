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
	defaultBase   = "https://imference.com"
	postTimeout   = 30 * time.Second
	statusTimeout = 10 * time.Second
	pollInterval  = 1 * time.Second
	// Poll budget, one for the whole catalog. This cap is NOT a model of how long
	// a generation takes — /status returns 422 on a real failure, so polling
	// already stops early on anything that went wrong. It exists only so a job
	// the server never resolves can't be polled forever, which makes it a
	// property of our patience, not of the media kind.
	//
	// It used to be split (10 min image / 20 min video) off the kind the server
	// reported at enqueue, and that split was the bug: /generate classifies video
	// by engine, so a video model on an engine it didn't know came back tagged
	// "image" and died mid-queue on the short budget. Sizing every job for the
	// worst case a busy queue can produce removes the classification — and the
	// possibility of getting it wrong — from the picture entirely. An image
	// waiting at minute 11 is no more "failed" than a clip is.
	pollBudget = 45 * time.Minute
	// Polling starts fast (a server-cached image can come back in under a
	// second) then eases off: a job sitting in a queue for 45 minutes doesn't
	// need 2700 status requests to notice it moved.
	pollBackoffAfter    = 30 * time.Second
	pollIntervalBackoff = 5 * time.Second
	catalogTTL          = 5 * time.Minute // the model catalog is effectively static per session

	// Downloading the finished image is separate from the generation budget
	// above: on a slow/saturated uplink a single attempt can exceed its deadline
	// even though the blob exists, so the download gets its own retry budget.
	downloadBudget  = 180 * time.Second // whole download phase, including retries
	downloadAttempt = 60 * time.Second  // one attempt
	downloadTries   = 4                 // total attempts before giving up
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
		// Generous ceiling only: every request sets its own (shorter) context
		// deadline. Kept above downloadAttempt so it never preempts a single
		// download attempt, while still capping any request that forgets one.
		http: &http.Client{Timeout: 90 * time.Second},
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
	// DurationS is the clip length for video models that publish the knob. The
	// server clamps it to the catalog's bounds and drops it entirely for models
	// that don't take one.
	DurationS float64 `json:"duration_s,omitempty"`
	// FormatCode names the format the user picked. The server prices per format
	// (credit_multiplier), and would otherwise have to guess from width×height.
	FormatCode string `json:"format_code,omitempty"`
}

type postResponse struct {
	RequestID string `json:"request_id"`
	// Kind is "image" | "video", reported by the unified /generate endpoints —
	// drives the polling budget (videos take minutes).
	Kind string `json:"kind"`
}

// statusResponse mirrors GetMediaResponse in imference/app/models/image.go —
// the unified /status shape for images AND videos (Kind discriminates).
// Note the PascalCase JSON keys — the Go server uses default field names.
type statusResponse struct {
	Data struct {
		RequestID string `json:"RequestID"`
		Kind      string `json:"Kind"`
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
	// Steps / cfg / clip-skip bounds. Pointers because the catalog publishes
	// null for a knob a model doesn't expose (gpt-image-1 has no steps or cfg,
	// minimax-h3 no cfg), and a zero cannot say that — nor could it, since zero
	// is a legitimate clip-skip. The UI hides a control the catalog is silent on.
	StepsDefault      *int     `json:"steps_default"`
	StepsMin          *int     `json:"steps_min"`
	StepsMax          *int     `json:"steps_max"`
	CfgDefault        *float64 `json:"cfg_default"`
	CfgMin            *float64 `json:"cfg_min"`
	CfgMax            *float64 `json:"cfg_max"`
	SkipDefault       *int     `json:"skip_default"`
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
	// Source-image capability + audio track. AcceptsImageInput says the model
	// takes OPTIONAL reference images at all; ImageInputMax is how many (1 = an
	// img2img source, 2 = first + last frame for video interpolation).
	// HasAudio marks a video model whose output carries an audio track.
	//
	// All three are pointers: an absent field means "this server predates the
	// column", which refImageSlots must tell apart from an explicit false/0.
	AcceptsImageInput *bool `json:"accepts_image_input"`
	// ModelType is what the model produces, straight from the catalog view:
	// "image" or "video". "" for rows the view hasn't filled in yet.
	ModelType string `json:"model_type"`
	// Duration controls (seconds) for video models. A nil Default is the
	// catalog saying this model has NO duration knob — an image model, or a
	// video model with a fixed length.
	DurationSDefault *float64 `json:"duration_s_default"`
	DurationSMin     *float64 `json:"duration_s_min"`
	DurationSMax     *float64 `json:"duration_s_max"`
	ImageInputMax    *int     `json:"image_input_max"`
	HasAudio         *bool    `json:"has_audio"`
	// Catalog organization — order + family/group for sorting/grouping the list.
	ModelOrder      int    `json:"model_order"`
	ModelFamilyCode string `json:"model_family_code"`
	FamilyName      string `json:"family_name"`
	FamilyOrder     int    `json:"family_order"`
	ModelGroupCode  string `json:"model_group_code"`
}

// maxRefImageSlots caps what the catalog can ask the UI to render. Two is the
// most any model needs today (first + last frame); the clamp is here so a bad
// catalog value can't produce an absurd form.
const maxRefImageSlots = 2

// mediaKind is what a model produces, for the picker's Image / Video filter.
//
// The catalog's model_type answers when it has a value. The engine test below
// is a fallback for rows the view hasn't filled in: without it every model
// would answer "image" while the column is still NULL, and the Video filter
// would come up empty on a catalog that plainly has video in it. Unlike the
// server's copy of this question, nothing here bills or times out — the worst a
// wrong guess does is file a card under the wrong chip.
func mediaKind(m apiModel, backend string) string {
	switch strings.ToLower(strings.TrimSpace(m.ModelType)) {
	case "video":
		return "video"
	case "image":
		return "image"
	}
	if backend == "wan" || videoFallbackEngines[strings.ToLower(strings.TrimSpace(m.ImEngine))] {
		return "video"
	}
	if m.HasAudio != nil && *m.HasAudio {
		return "video" // an audio track is a video-only trait
	}
	return "image"
}

// videoFallbackEngines covers engines the desktop can't run locally (so
// normalizeEngine returns "") but that still produce clips. Delete once
// model_type is non-null across the catalog.
var videoFallbackEngines = map[string]bool{"wan22": true, "wan": true, "minimax": true}

// localBackend returns the backend the sidecar would load for this entry, or ""
// when it isn't being prepared for local use — the same "locally runnable" test
// ListModels applies: the im_local flag plus downloadable weights and a known
// engine.
func localBackend(m apiModel, backend string, forLocal bool) string {
	if forLocal && m.ImLocal && m.ModelURL != "" && backend != "" {
		return backend
	}
	return ""
}

// refImageSlots resolves how many reference-image slots a model offers, from
// the catalog's accepts_image_input (does it take any?) and image_input_max
// (how many?) — read against WHERE the model will run.
//
// localBackend is the normalized backend the sidecar would load, or "" when
// this entry is being prepared for the cloud. That distinction is the whole
// point: the catalog flag describes what the HOSTED endpoint is wired to
// accept, which is not the same question as what the local engine can do.
//
//   - Cloud: none at all, for now — reference images are local-only until the
//     cloud round trip is validated (see the TEMPORARY note in the body). The
//     rule this replaces was "honour the flag exactly", since offering a slot
//     the API drops would let someone spend credits on a run that quietly
//     ignored their image.
//   - Local image backends that do img2img: it's the sidecar's own capability,
//     available with any checkpoint it can load, so the slot is offered whatever
//     the catalog says about the hosted endpoint. The flag can only ADD slots.
//     A backend with no image input at all (Anima) gets none, catalog or not.
//   - Local video backends: only the catalog separates text-to-video from
//     image-to-video, so it is authoritative — a t2v model has nothing to do
//     with a source image. An absent column keeps the historical fallback of
//     one slot.
func refImageSlots(m apiModel, localBackend string) int {
	// What the catalog declares: -1 = the column is absent (server predates it).
	declared := -1
	if m.AcceptsImageInput != nil {
		declared = 0
		if *m.AcceptsImageInput {
			declared = 1
			if m.ImageInputMax != nil && *m.ImageInputMax > 1 {
				declared = min(*m.ImageInputMax, maxRefImageSlots)
			}
		}
	}
	if localBackend == "" {
		// TEMPORARY: reference images are a LOCAL-only feature for now. The cloud
		// request path can carry them (refImagesForCloud below still encodes
		// req.RefImages), but the round trip isn't validated end to end, so the
		// desktop must not offer a slot it can't honour — a user would spend
		// credits on a run that ignored their image.
		//
		// To lift this once the cloud path is proven: delete the next line and
		// the catalog's answer takes over again (`declared`, 0 when the column
		// is absent). Nothing else is gated on it.
		return 0
	}
	if declared < 0 {
		declared = 1 // pre-column server: every local model took an img2img source
	}
	if IsImageBackend(localBackend) {
		// An image backend that can't take a reference image has none, whatever
		// the catalog says about the hosted endpoint (which may well run a
		// different pipeline than the sidecar does).
		if !SupportsRefImages(localBackend) {
			return 0
		}
		if declared < 1 {
			return 1
		}
	}
	return declared
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
	// CreditMultiplier scales the model's price for this format (1 = SD, 2 = HD).
	// Absent means no surcharge — priced as 1.
	CreditMultiplier *float64 `json:"credit_multiplier"`
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
	case "krea2", "krea-2", "krea2-turbo":
		return "krea2"
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
	// krea2 loads locally like the others but its fp8-resident transformer
	// wants ~13 GB VRAM (no sub-module offload in the image engine) — small
	// cards OOM at load, so catalog rows should gate it via ImLocal.
	"krea2": true,
}

// IsImageBackend reports whether name is a normalized image backend the desktop
// can run locally (excludes "wan" video and "" / external).
func IsImageBackend(name string) bool {
	return imageBackends[name]
}

// refImageBackends is the subset of image backends whose LOCAL pipeline can
// actually start from a reference image. It's the img2img question, not the
// "can this backend run" question: Anima is a Modular Diffusers text-to-image
// pipeline with no image input at all, and Krea 2 has no diffusers img2img
// yet (upstream PR open) — offering the box on either promises something the
// engine cannot do.
var refImageBackends = map[string]bool{
	"sdxl": true, "sd15": true, "zimage": true,
	"flux": true, "chroma": true, "qwenimage": true,
}

// SupportsRefImages reports whether a normalized local backend accepts a
// reference image. Video backends answer "" here and are decided by the catalog
// instead (text-to-video vs image-to-video) — see refImageSlots.
func SupportsRefImages(backend string) bool {
	return refImageBackends[backend]
}

// singleFileBackends is the subset of image backends that load from a single
// .safetensors checkpoint (with a base repo for the transformer-only ones). This
// is what the "add custom model" flow supports. Anima is excluded: it's a
// Modular Diffusers pipeline that needs a full diffusers-format directory, not a
// single file (its load_pipeline treats the path as a repo id -> HF error).
var singleFileBackends = map[string]bool{
	"sdxl": true, "sd15": true, "zimage": true,
	"flux": true, "chroma": true, "qwenimage": true,
	// Anima: a single-file DiT (.safetensors) + a base modular repo (encoder /
	// VAE / config) — the engine's Anima backend injects the DiT into the base.
	"anima": true,
	// Krea 2: civitai/ComfyUI transformer-only single-files (native keys,
	// fp8_scaled/fp8/bf16 — the engine normalizes in memory) + the gated
	// krea/Krea-2-Turbo base repo.
	"krea2": true,
}

// IsSingleFileBackend reports whether a user-supplied single .safetensors can be
// loaded as this backend. Used to validate a custom checkpoint's backend.
func IsSingleFileBackend(name string) bool {
	return singleFileBackends[name]
}

// DefaultBaseModel returns the shared base-components repo a transformer-only
// checkpoint of the given backend needs (text encoder(s) + VAE + scheduler +,
// for Anima, the modular config), used only when the catalog carries no per-model
// base_model — a non-empty catalog base_model always wins. Self-contained
// backends (SDXL / SD 1.5 single-file) return "". Repos per the engine backend
// READMEs. NOTE: FLUX.1-dev is a GATED HF repo and the Anima base is large — rely
// on IMAGE_MODEL_CDN or a catalog base_model in practice.
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
	case "anima":
		return "circlestone-labs/Anima-Base-v1.0-Diffusers"
	case "krea2":
		return "krea/Krea-2-Turbo"
	default:
		return ""
	}
}

// toModelInfo maps a wire entry to the app's camelCase ModelInfo, normalizing
// im_engine to the internal backend name and defaulting the Z-Image base repo.
//
// forLocal says which list this entry is being built for. Only reference-image
// slots differ between the two (see refImageSlots) — the same catalog row can
// legitimately offer an img2img source locally and none in the cloud.
func toModelInfo(m apiModel, forLocal bool) types.ModelInfo {
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
		// Locally runnable = the same test ListModels applies for the local
		// catalog: the flag plus downloadable weights and a known backend.
		RefImages: refImageSlots(m, localBackend(m, backend, forLocal)),
		ModelType: mediaKind(m, backend),
		// Straight through: a nil Default is the catalog saying "no duration
		// control", which the composer reads as "offer nothing".
		DurationDefault: m.DurationSDefault,
		DurationMin:     m.DurationSMin,
		DurationMax:     m.DurationSMax,
		HasAudio:        m.HasAudio != nil && *m.HasAudio,
		Order:           m.ModelOrder,
		FamilyCode:      m.ModelFamilyCode,
		FamilyName:      m.FamilyName,
		FamilyOrder:     m.FamilyOrder,
		GroupCode:       m.ModelGroupCode,
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
				Ratio: f.Ratio, IsDefault: f.IsDefault, CreditMultiplier: f.CreditMultiplier,
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
		mi := toModelInfo(m, localOnly)
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
// onEnqueued, when non-nil, is called with the server's request_id + media kind
// the instant the POST succeeds — BEFORE polling. The caller persists it so an
// interrupted generation can be resumed later (see internal/cloudjobs).
func (c *Client) Generate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
	onEnqueued func(requestID, kind string),
) (types.GenerationResult, error) {
	if apiKey == "" {
		return types.GenerationResult{}, errors.New("cloud: API key not set")
	}
	if model == "" {
		return types.GenerationResult{}, errors.New("cloud: cloud model not set")
	}

	c.bus.Info("cloud", "Generate start", map[string]any{
		"model":  model,
		"prompt": truncate(req.Prompt, 80),
		"width":  req.Width,
		"height": req.Height,
		"steps":  req.NumSteps,
	})

	requestID, serverKind, err := c.postGenerate(ctx, apiKey, model, req)
	if err != nil {
		c.bus.Error("cloud", "postGenerate failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "postGenerate ok", map[string]any{"request_id": requestID, "kind": serverKind})
	if onEnqueued != nil {
		onEnqueued(requestID, serverKind)
	}

	return c.pollAndDownload(ctx, "credits", apiKey, requestID)
}

// pollAndDownload runs the shared tail of every cloud generation: poll /status
// (one budget for every model) then download the finished media. Rail "x402" polls the
// unauthenticated /ondemand/status; anything else uses the bearer /status.
// Reused by the live Generate path AND the resume-on-launch path.
func (c *Client) pollAndDownload(ctx context.Context, rail, apiKey, requestID string) (types.GenerationResult, error) {
	pollCtx, cancel := context.WithTimeout(ctx, pollBudget)
	defer cancel()

	var mediaURL string
	var seed int
	var err error
	if rail == "x402" {
		mediaURL, seed, err = c.pollStatusX402(pollCtx, requestID)
	} else {
		mediaURL, seed, err = c.pollStatus(pollCtx, apiKey, requestID)
	}
	if err != nil {
		c.bus.Error("cloud", "pollStatus failed", map[string]any{"err": err.Error(), "request_id": requestID})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "pollStatus ok", map[string]any{"url": mediaURL, "seed": seed})

	// Download on the caller's context (not the poll budget): generation is done,
	// and the download gets its own retry budget so a slow link doesn't lose an
	// already-generated result.
	b64, mime, err := c.downloadWithRetry(ctx, mediaURL)
	if err != nil {
		c.bus.Error("cloud", "download failed", map[string]any{"err": err.Error(), "url": mediaURL})
		return types.GenerationResult{}, fmt.Errorf("cloud: download media: %w", err)
	}
	c.bus.Info("cloud", "download ok", map[string]any{"bytes": len(b64) * 3 / 4, "mime": mime})

	return types.GenerationResult{
		ImageBase64: "data:" + mime + ";base64," + b64,
		Seed:        seed,
		Source:      "cloud",
	}, nil
}

// Resume re-polls and downloads a previously-enqueued generation by its
// request_id — used on launch/recheck to reclaim an interrupted job. apiKey is
// needed only for the credits rail (x402 status is public).
func (c *Client) Resume(ctx context.Context, rail, apiKey, requestID string) (types.GenerationResult, error) {
	c.bus.Info("cloud", "resume", map[string]any{"request_id": requestID, "rail": rail})
	return c.pollAndDownload(ctx, rail, apiKey, requestID)
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
	onEnqueued func(requestID, kind string),
) (types.GenerationResult, error) {
	if signer == nil {
		return types.GenerationResult{}, errors.New("cloud: x402 mode requires a configured wallet")
	}
	if model == "" {
		return types.GenerationResult{}, errors.New("cloud: cloud model not set")
	}

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

	requestID, serverKind, err := c.postGenerateX402(ctx, x402Client, model, req)
	if err != nil {
		c.bus.Error("cloud", "postGenerateX402 failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "postGenerateX402 ok", map[string]any{"request_id": requestID, "kind": serverKind})
	if onEnqueued != nil {
		onEnqueued(requestID, serverKind)
	}

	// Payment is settled; polling the result needs no auth/wallet.
	return c.pollAndDownload(ctx, "x402", "", requestID)
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

// easeOffPolling stretches a poll ticker from pollInterval to
// pollIntervalBackoff once the job has clearly gone into a queue. The fast first
// seconds keep a server-cached result feeling instant; after that, a job waiting
// tens of minutes doesn't need a request every second to notice it moved.
// Returns true the first time it fires so callers only re-arm once.
func easeOffPolling(t *time.Ticker, started time.Time, eased bool) bool {
	if eased || time.Since(started) < pollBackoffAfter {
		return eased
	}
	t.Reset(pollIntervalBackoff)
	return true
}

// terminalError marks a generation outcome that will never succeed by retrying
// (the server reported failure, or an auth error) — as opposed to a timeout or
// network blip, where the job may still be running server-side. The caller uses
// IsTerminal to decide whether to drop a persisted pending-job record (terminal)
// or keep it for a later resume (non-terminal).
type terminalError struct{ msg string }

func (e *terminalError) Error() string { return e.msg }

// IsTerminal reports whether err is a definitive generation failure (drop the
// pending record) rather than a recoverable timeout/network error (keep it).
func IsTerminal(err error) bool {
	var t *terminalError
	return errors.As(err, &t)
}

// transientStatus reports whether a /status HTTP code is a temporary blip worth
// polling through (gateway/throttle) rather than a terminal failure. The server
// signals a real, stop-now failure with 422; 4xx auth errors are terminal too.
func transientStatus(code int) bool {
	switch code {
	case http.StatusRequestTimeout, // 408
		http.StatusTooManyRequests,     // 429
		http.StatusInternalServerError, // 500
		http.StatusBadGateway,          // 502
		http.StatusServiceUnavailable,  // 503
		http.StatusGatewayTimeout:      // 504
		return true
	}
	return false
}

// pollTimedOut converts a fetch error into the friendly poll-timeout message
// when the cause is the exhausted poll budget (parent ctx), else returns the
// raw error. Used so an in-flight fetch cut short by the budget reports "timed
// out", not a cryptic "context deadline exceeded".
func pollTimedOut(ctx context.Context, fetchErr error, what string) error {
	if ctx.Err() != nil {
		return fmt.Errorf("cloud: %s status polling timed out — the job is still running server-side and stays pending; it's reclaimed on the next launch or with Recheck", what)
	}
	return fetchErr
}

func (c *Client) postGenerateX402(
	ctx context.Context,
	x402Client *x402.Client,
	model string,
	req types.GenerationRequest,
) (string, string, error) {
	// FormatCode is the supported way to name the output size — the server
	// resolves it to dimensions and prices it (credit_multiplier). Width/Height
	// ride along for API builds that predate format resolution; when both are
	// present the server gives the code priority.
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
		DurationS:      req.DurationS,
		FormatCode:     req.FormatCode,
	}

	postCtx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()

	// Unified endpoint: every model (image or video) posts here; the server
	// derives the media kind — and the x402 price — from the catalog model.
	resp, err := x402Client.DoJSON(postCtx, http.MethodPost, c.base+"/ondemand/generate", body, nil)
	if err != nil {
		// An empty wallet is a user problem with a clear remedy, not a transport
		// failure: surface it as written, with no "cloud: POST …" prefix in
		// front of the sentence the user actually needs to read.
		var funds *x402.InsufficientFundsError
		if errors.As(err, &funds) {
			return "", "", &terminalError{funds.Error()}
		}
		return "", "", fmt.Errorf("cloud: POST /ondemand/generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", "", fmt.Errorf("cloud: /ondemand/generate HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	var parsed postResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", "", fmt.Errorf("cloud: parse /ondemand/generate response: %w", err)
	}
	if parsed.RequestID == "" {
		return "", "", errors.New("cloud: /ondemand/generate returned empty request_id")
	}
	return parsed.RequestID, parsed.Kind, nil
}

// pollStatusX402 polls the x402 status endpoint. Same unified response shape
// as the credit-based /status (data.URL + data.Seed + data.Kind), but the
// route is different and there's no Bearer header.
func (c *Client) pollStatusX402(ctx context.Context, requestID string) (string, int, error) {
	statusURL := c.base + "/ondemand/status?request_id=" + url.QueryEscape(requestID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	if got, seed, done, err := c.fetchStatusX402(ctx, statusURL); err != nil {
		return "", 0, pollTimedOut(ctx, err, "x402")
	} else if done {
		return got, seed, nil
	}

	started, eased := time.Now(), false
	for {
		select {
		case <-ctx.Done():
			return "", 0, errors.New("cloud: x402 status polling timed out — the job is still running server-side and stays pending; it's reclaimed on the next launch or with Recheck")
		case <-ticker.C:
			eased = easeOffPolling(ticker, started, eased)
			got, seed, done, err := c.fetchStatusX402(ctx, statusURL)
			if err != nil {
				return "", 0, pollTimedOut(ctx, err, "x402")
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
		if ctx.Err() != nil {
			return "", 0, false, ctx.Err()
		}
		return "", 0, false, nil // transient blip — keep polling
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
		if transientStatus(resp.StatusCode) {
			_, _ = io.Copy(io.Discard, resp.Body)
			return "", 0, false, nil // gateway/throttle blip — keep polling
		}
		var errBody statusErrorBody
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "", 0, false, &terminalError{"cloud: /ondemand/status: " + msg}
	}
}

func (c *Client) postGenerate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
) (string, string, error) {
	// Same field set as postGenerateX402: FormatCode names the size (the server
	// resolves and prices it), Width/Height ride along for older API builds.
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
		DurationS:      req.DurationS,
		FormatCode:     req.FormatCode,
	}
	buf, _ := json.Marshal(body)

	postCtx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()

	// Unified endpoint: every model (image or video) posts here; the server
	// derives the media kind from the catalog model.
	r, _ := http.NewRequestWithContext(postCtx, http.MethodPost, c.base+"/generate", bytes.NewReader(buf))
	r.Header.Set("Authorization", "Bearer "+apiKey)
	r.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return "", "", fmt.Errorf("cloud: POST /generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Surface the raw body when possible — most failures here are
		// auth-related (401, 402, 403) and the server message is useful.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", "", fmt.Errorf("cloud: /generate HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed postResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", "", fmt.Errorf("cloud: parse /generate response: %w", err)
	}
	if parsed.RequestID == "" {
		return "", "", errors.New("cloud: /generate returned empty request_id")
	}
	return parsed.RequestID, parsed.Kind, nil
}

func (c *Client) pollStatus(ctx context.Context, apiKey, requestID string) (string, int, error) {
	statusURL := c.base + "/status?request_id=" + url.QueryEscape(requestID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Try once immediately, then on every tick. This makes the typical
	// "image was already cached server-side" path return in <1s instead of
	// waiting for the first tick.
	if got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey); err != nil {
		return "", 0, pollTimedOut(ctx, err, "")
	} else if done {
		return got, seed, nil
	}

	started, eased := time.Now(), false
	for {
		select {
		case <-ctx.Done():
			return "", 0, errors.New("cloud: status polling timed out — the job is still running server-side and stays pending; it's reclaimed on the next launch or with Recheck")
		case <-ticker.C:
			eased = easeOffPolling(ticker, started, eased)
			got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey)
			if err != nil {
				return "", 0, pollTimedOut(ctx, err, "")
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
		// Parent budget exhausted mid-fetch → let the loop's ctx.Done win.
		if ctx.Err() != nil {
			return "", 0, false, ctx.Err()
		}
		// A single network blip / slow fetch shouldn't kill a long run — keep polling.
		return "", 0, false, nil
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var parsed statusResponse
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return "", 0, false, fmt.Errorf("cloud: parse /status: %w", err)
		}
		return parsed.Data.URL, parsed.Data.Seed, true, nil
	case http.StatusNotFound:
		// Expected while job is pending — the server returns
		// {"error": "image not found or not ready yet"}.
		_, _ = io.Copy(io.Discard, resp.Body)
		return "", 0, false, nil
	default:
		if transientStatus(resp.StatusCode) {
			_, _ = io.Copy(io.Discard, resp.Body)
			return "", 0, false, nil // gateway/throttle blip — keep polling
		}
		var errBody statusErrorBody
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		// 422 (failed) / 4xx (auth) — a definitive outcome, don't keep polling
		// or keep the pending record.
		return "", 0, false, &terminalError{"cloud: /status: " + msg}
	}
}

// downloadAsBase64 fetches the Azure Blob URL and returns its base64
// payload + mime type. Keeps the frontend's data: URL pipeline identical
// between cloud and local modes.
// httpStatusError carries the blob server's status so the retry layer can tell
// a transient failure (5xx/429/408 — worth retrying) from a permanent one
// (404/403 — the blob is missing or forbidden, retrying is pointless).
type httpStatusError struct {
	status  int
	snippet string
}

func (e *httpStatusError) Error() string {
	return fmt.Sprintf("HTTP %d downloading image: %s", e.status, e.snippet)
}

// isRetryableDownloadErr reports whether a failed download attempt is worth
// retrying. Network-level errors (timeouts, resets, short reads) are transient;
// HTTP errors are retryable only for server-side/throttling statuses.
func isRetryableDownloadErr(err error) bool {
	var se *httpStatusError
	if errors.As(err, &se) {
		return se.status == http.StatusRequestTimeout ||
			se.status == http.StatusTooManyRequests ||
			se.status >= 500
	}
	return true
}

// downloadWithRetry fetches the finished image, retrying transient failures with
// exponential backoff within a dedicated budget. This is what makes a slow
// uplink (where a single attempt hits its deadline) still succeed — the blob
// exists, we just need another try.
func (c *Client) downloadWithRetry(ctx context.Context, src string) (string, string, error) {
	budgetCtx, cancel := context.WithTimeout(ctx, downloadBudget)
	defer cancel()

	var lastErr error
	backoff := 1 * time.Second
	for attempt := 1; attempt <= downloadTries; attempt++ {
		attemptCtx, aCancel := context.WithTimeout(budgetCtx, downloadAttempt)
		b64, mime, err := c.downloadAsBase64(attemptCtx, src)
		aCancel()
		if err == nil {
			if attempt > 1 {
				c.bus.Info("cloud", "download ok after retry", map[string]any{"attempt": attempt})
			}
			return b64, mime, nil
		}
		lastErr = err
		if !isRetryableDownloadErr(err) {
			return "", "", err // permanent (e.g. 404/403) — don't burn the budget
		}
		if budgetCtx.Err() != nil || attempt == downloadTries {
			break
		}
		c.bus.Warn("cloud", "download retry", map[string]any{
			"attempt": attempt, "err": err.Error(), "backoff_ms": backoff.Milliseconds(),
		})
		select {
		case <-time.After(backoff):
		case <-budgetCtx.Done():
			return "", "", budgetCtx.Err()
		}
		backoff *= 2
	}
	return "", "", lastErr
}

func (c *Client) downloadAsBase64(ctx context.Context, src string) (string, string, error) {
	c.bus.Trace("cloud", "GET "+src, nil)
	// The per-attempt timeout is set by the caller (downloadWithRetry); reuse the
	// shared client so we keep connection pooling / keep-alive.
	r, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
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
		return "", "", &httpStatusError{status: resp.StatusCode, snippet: string(snippet)}
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
