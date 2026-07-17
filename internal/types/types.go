// Package types holds structs shared between the Wails-bound App and the
// internal sub-packages. They double as the JSON contract exposed to the
// React frontend via Wails' auto-generated TS bindings, so JSON tags are
// camelCase to feel native to JS.
package types

// Settings persisted via internal/settings.Store. Empty strings are the
// signal for "not configured" — the frontend offers the SettingsDialog when
// any required field is empty.
type Settings struct {
	APIKey     string `json:"apiKey"`
	PythonPath string `json:"pythonPath"`
	SDXLPath   string `json:"sdxlPath"`
	CloudModel string `json:"cloudModel"`
	// OutputDir overrides where generated images are auto-saved. When empty,
	// defaults to imagesink.DefaultDir() (typically <home>/Pictures/Imference).
	OutputDir string `json:"outputDir"`
	// PaymentMode picks the cloud auth scheme: "bearer" (default; uses APIKey)
	// or "x402" (pays per request from the local wallet on Base mainnet).
	PaymentMode string `json:"paymentMode"`
	// WalletAddress is the public EVM address of the configured wallet,
	// mirrored here for display in the UI when the renderer hasn't unlocked
	// the keychain yet. The private key itself NEVER lives in this file —
	// it's in the OS keychain (Windows Credential Manager).
	WalletAddress string `json:"walletAddress"`
	// LocalModel is the currently-selected local model (chosen from the
	// imference catalog and downloaded to SDXLPath). Nil until the user picks
	// one. Its config drives local generation defaults — see App.GenerateLocal.
	LocalModel *ModelInfo `json:"localModel,omitempty"`
	// EngineRuntime holds host-machine tuning for the engine (device, VAE mode,
	// offload, model-residency caps, WAN quantization). Applied as env vars when
	// the sidecar starts. NOT generation params — those live in the generation UI.
	EngineRuntime EngineRuntimeSettings `json:"engineRuntime"`
	// CloudModelInfo is the full catalog entry for the selected cloud model
	// (CloudModel holds just its code, the value actually sent to the server).
	// Stored so the form selector can show the model's details and seed cloud
	// generation params (steps/cfg/resolution) the same way LocalModel does.
	// Nil until the user picks a cloud model from the form.
	CloudModelInfo *ModelInfo `json:"cloudModelInfo,omitempty"`
	// CustomModels are user-supplied checkpoints (LocalPath set) registered via
	// UseCustomModel, kept so they stay selectable in the model dropdown. The
	// files themselves are referenced in place — never copied, never deleted.
	// UI-only: not a sidecar-affecting field (the active model is LocalModel).
	CustomModels []ModelInfo `json:"customModels,omitempty"`
}

// UpdateInfo is the result of App.CheckForUpdate: the app's own version vs the
// latest GitHub release. URL is the release page to open in the browser —
// there is no in-app download (the app isn't code-signed yet).
type UpdateInfo struct {
	CurrentVersion  string `json:"currentVersion"`            // "dev" or "X.X.X"
	LatestVersion   string `json:"latestVersion,omitempty"`   // "X.X.X" (tag without v)
	URL             string `json:"url,omitempty"`             // release page html_url
	UpdateAvailable bool   `json:"updateAvailable"`
}

// EngineRuntimeSettings holds host-tuning for the engine. All seven image
// backends (SDXL, SD 1.5, Z-Image, FLUX, Chroma, Qwen-Image, Anima) share the
// engine's single IMAGE_* env contract and only one loads per sidecar, so they
// share ONE Image block rather than a block each. WAN video has its own WAN_*
// contract. (Pre-unification builds stored separate `sdxl`/`zimage` blocks;
// settings.reload() migrates the old `sdxl` block into `image`.)
type EngineRuntimeSettings struct {
	Image ImageRuntimeSettings `json:"image"`
	Wan   WanRuntimeSettings   `json:"wan"`
}

// ImageRuntimeSettings tunes the active image backend (shared IMAGE_* env
// contract). UseTinyVAE only affects SDXL / SD 1.5; the engine ignores it for
// Z-Image / FLUX / Chroma / Qwen-Image / Anima.
type ImageRuntimeSettings struct {
	// Device: "" / "auto" | cuda | cuda:N | mps | cpu. "cuda" covers BOTH
	// NVIDIA and AMD GPUs — torch's ROCm build presents the AMD GPU under the
	// cuda device string, so there is no separate "rocm" value.
	Device     string `json:"device,omitempty"`
	UseTinyVAE bool   `json:"useTinyVae,omitempty"` // SDXL/SD1.5 TAESD — ~10× faster VAE decode
	// EnableCPUOffload is tri-state: nil = Auto (the desktop enables offload on
	// NVIDIA/AMD cards below autoOffloadVRAMThresholdGiB — see resolveCPUOffload
	// — so a small-VRAM GPU doesn't oversubscribe VRAM and crawl via WDDM
	// shared-memory spill), *true = force on, *false = force off. On a card the
	// full pipe fits on, Auto leaves it off (full residency is fastest).
	EnableCPUOffload *bool  `json:"enableCpuOffload,omitempty"`
	MaxGPUModels     string `json:"maxGpuModels,omitempty"` // "" / "auto" / int
	MaxCPUModels     string `json:"maxCpuModels,omitempty"` // "" / "auto" / int
}

// WanRuntimeSettings tunes the WAN video backend (WAN_* env contract). Applies
// once the video backend is enabled; ignored by the image backends. The two
// bool knobs are pointers because the engine defaults them to true — nil means
// "leave at engine default", *false means the user explicitly disabled it.
type WanRuntimeSettings struct {
	Device           string `json:"device,omitempty"`
	MemoryProfile    string `json:"memoryProfile,omitempty"`    // "" / "auto" | gguf_q8 | gguf_q6 | gguf_q5 | gguf_q4
	TextEncoderQuant string `json:"textEncoderQuant,omitempty"` // "" / int8 | none
	VAETiling        *bool  `json:"vaeTiling,omitempty"`        // engine default true
	EnableOffload    *bool  `json:"enableOffload,omitempty"`    // engine default true
	MaxResident      string `json:"maxResident,omitempty"`      // "" / int
}

// ModelInfo is one entry from imference.com/api/models, trimmed to the fields
// the desktop app uses. Doubles as the JSON contract for the frontend model
// picker. Only models with a non-empty ModelURL can run locally — the rest are
// cloud-only / proprietary (Flux, GPT-Image, Veo, Wan video, …).
type ModelInfo struct {
	ModelCode         string  `json:"modelCode"`
	Name              string  `json:"name"`
	ShortDescription  string  `json:"shortDescription"`
	MediumDescription string  `json:"mediumDescription"`
	Image             string  `json:"image"`    // thumbnail URL
	ModelURL          string  `json:"modelUrl"` // downloadable .safetensors ("" = cloud-only)
	// LocalPath is the absolute path of a user-supplied checkpoint (custom
	// model added via UseCustomModel). Non-empty = custom: no catalog entry,
	// no download — the sidecar loads this file directly.
	LocalPath string `json:"localPath,omitempty"`
	PromptPre         string  `json:"promptPre"`
	PromptNegative    string  `json:"promptNegative"`
	StepsDefault      int     `json:"stepsDefault"`
	StepsMin          int     `json:"stepsMin"`
	StepsMax          int     `json:"stepsMax"`
	CfgDefault        float64 `json:"cfgDefault"`
	CfgMin            float64 `json:"cfgMin"`
	CfgMax            float64 `json:"cfgMax"`
	SkipDefault       int     `json:"skipDefault"` // clip-skip
	SchedulerDefault  string  `json:"schedulerDefault"`
	FormatCode        string  `json:"formatCode"`
	// BackendType is the internal engine backend, normalized from the catalog's
	// im_engine field, one of the image backends (sdxl, sd15, zimage, flux,
	// chroma, qwenimage, anima) or "wan". (im_engine "external" and null
	// are filtered out upstream in cloud.ListModels — not locally runnable.)
	BackendType string `json:"backendType,omitempty"`
	// BaseModel is the HF repo id of the shared base-components a backend needs
	// (Z-Image finetunes, e.g. "Tongyi-MAI/Z-Image-Turbo"). Empty for
	// self-contained SDXL single-file checkpoints. Resolved offline via the CDN.
	BaseModel string `json:"baseModel,omitempty"`
	// ShiftDefault is the Z-Image flow-matching shift (3.0≈480p, 5.0≈720p),
	// passed as backend_options={"shift": …}. Ignored by SDXL. 0 → engine default.
	ShiftDefault float64 `json:"shiftDefault,omitempty"`
	// Cost is the cloud run cost in credits (1 credit = $0.001). Local runs are
	// free. CanLocal/CanCloud declare where the model may run.
	Cost     int  `json:"cost"`
	CanLocal bool `json:"canLocal"`
	CanCloud bool `json:"canCloud"`
	// Formats are the model's supported resolutions/ratios (im_format). Empty
	// when the catalog has none — the UI then falls back to generic formats.
	Formats []FormatOption `json:"formats,omitempty"`
	// Catalog organization (im_model family/group) for sorting/grouping the list.
	Order      int    `json:"order,omitempty"`
	FamilyCode string `json:"familyCode,omitempty"`
	FamilyName string `json:"familyName,omitempty"`
	GroupCode  string `json:"groupCode,omitempty"`
}

// FormatOption is one supported resolution/ratio for a model (from im_format).
type FormatOption struct {
	FormatCode string `json:"formatCode"`
	Name       string `json:"name,omitempty"`
	Width      int    `json:"width"`
	Height     int    `json:"height"`
	Ratio      string `json:"ratio,omitempty"`
	IsDefault  bool   `json:"isDefault"`
}

// WalletInfo is what the renderer sees when it asks about the wallet
// status. The private key is never exposed through this struct.
type WalletInfo struct {
	Configured  bool   `json:"configured"`  // true if a key exists in the keychain
	Address     string `json:"address"`     // checksummed hex (0x…) or ""
	BalanceUSDC string `json:"balanceUSDC"` // human string ("1.234"), atomic / 10^6
	Network     string `json:"network"`     // always "base-mainnet" in this POC
	Error       string `json:"error,omitempty"`
}

// CreditInfo is the renderer's view of the cloud account's remaining credits,
// fetched with the Bearer API key (the "API key (credit)" payment mode). Mirrors
// the balance readout the imference web app shows. Configured is false when no
// key is set, so the Settings UI can prompt for a key instead of showing an error.
type CreditInfo struct {
	Configured bool    `json:"configured"`      // true when an API key was available to query
	Credits    float64 `json:"credits"`         // remaining credit balance
	Error      string  `json:"error,omitempty"` // populated on a failed lookup (bad key, network)
}

// GenerationRequest is the unified frontend → Go payload for both modes.
// Mirrors imference-desktop/src/renderer/src/lib/types.ts GenerationParams.
type GenerationRequest struct {
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negativePrompt,omitempty"`
	Width          int     `json:"width"`
	Height         int     `json:"height"`
	NumSteps       int     `json:"numSteps"`
	GuidanceScale  float64 `json:"guidanceScale"`
	// Seed is a pointer so the JSON can carry null (= random) vs 0 (= explicit zero).
	Seed *int `json:"seed,omitempty"`
	// Scheduler and ClipSkip are usually injected server-side from the selected
	// LocalModel's config (App.GenerateLocal) rather than set by the renderer,
	// but the fields exist so a caller can override. Empty/nil → engine default.
	Scheduler string `json:"scheduler,omitempty"`
	ClipSkip  *int   `json:"clipSkip,omitempty"`
	// SourceImage enables img2img: a base64 source the engine denoises from
	// instead of pure noise. May be a data-URL ("data:image/png;base64,…") or
	// raw base64 — the sidecar client strips any data-URL prefix. Empty = text2img.
	SourceImage string `json:"sourceImage,omitempty"`
	// Strength is the img2img denoising strength (0 = keep source, 1 = ignore it).
	// Only meaningful with SourceImage set. 0/unset → engine default (0.75). In
	// img2img the output size is derived from the source image (Width/Height ignored).
	Strength float64 `json:"strength,omitempty"`
}

// SavedImage is one previously-generated image found on disk in the output
// folder. The renderer fetches its bytes lazily via GetSavedImage(name) (base64
// over the Wails bridge). Basic fields are parsed from the filename
// "<YYYYMMDD-HHMMSS>_<source>_<seed>.<ext>"; Meta comes from the "<name>.json"
// sidecar when present.
type SavedImage struct {
	Name      string `json:"name"`      // file name (key for GetSavedImage / DeleteSavedImage)
	Source    string `json:"source"`    // "local" | "cloud" | …
	Seed      int    `json:"seed"`      // 0 when unparseable
	SavedPath string `json:"savedPath"` // absolute path on disk
	// Width/Height let the renderer reserve the right aspect box before the bytes
	// load (masonry with any format). 0 when the header couldn't be read.
	Width  int `json:"width"`
	Height int `json:"height"`
	// Meta is the generation metadata from the sidecar JSON. Nil for images saved
	// before this feature (or hand-added files).
	Meta *GenerationMeta `json:"meta,omitempty"`
}

// GenerationMeta captures how an image was produced. Written verbatim to a
// "<image>.json" sidecar at save time, and read back to drive the gallery's
// detail view and filters. Format-agnostic — reused as-is for future video.
type GenerationMeta struct {
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negativePrompt,omitempty"`
	Source         string  `json:"source"`              // "local" | "cloud"
	ModelCode      string  `json:"modelCode,omitempty"` // catalog code
	ModelName      string  `json:"modelName,omitempty"` // display name
	Engine         string  `json:"engine,omitempty"`    // e.g. "sdxl" | "flux" | "zimage" | "wan"
	Width          int     `json:"width,omitempty"`
	Height         int     `json:"height,omitempty"`
	FormatCode     string  `json:"formatCode,omitempty"` // "square" | "portrait" | "landscape"
	NumSteps       int     `json:"numSteps,omitempty"`
	GuidanceScale  float64 `json:"guidanceScale,omitempty"`
	Scheduler      string  `json:"scheduler,omitempty"`
	ClipSkip       *int    `json:"clipSkip,omitempty"`
	Seed           int     `json:"seed"`
	Img2Img        bool    `json:"img2img,omitempty"`
	Strength       float64 `json:"strength,omitempty"`
	CreatedAt      string  `json:"createdAt"` // RFC3339
}

// GalleryFilter narrows ListSavedImages. Empty fields mean "no constraint".
type GalleryFilter struct {
	Engine    string `json:"engine"`    // e.g. "sdxl" | "flux" | "zimage" | "wan"
	ModelCode string `json:"modelCode"` // exact catalog code
	Source    string `json:"source"`    // "local" | "cloud"
	Text      string `json:"text"`      // free-text, matched against the prompt (case-insensitive)
}

// Facet is one filterable value with how many saved images carry it.
type Facet struct {
	Value string `json:"value"`
	Label string `json:"label"`
	Count int    `json:"count"`
}

// GalleryFacets are the distinct filterable values across the whole gallery,
// used to build the filter UI.
type GalleryFacets struct {
	Models  []Facet `json:"models"`
	Engines []Facet `json:"engines"`
	Sources []Facet `json:"sources"`
}

// GenerationResult is the unified Go → frontend response. Same shape for
// cloud and local: image always arrives as base64 PNG/WebP so the React
// side just sets `<img src="data:image/png;base64,..."/>` regardless of source.
type GenerationResult struct {
	ImageBase64 string `json:"imageBase64"`
	Seed        int    `json:"seed"`
	Source      string `json:"source"` // "cloud" | "local"
	// SavedPath is the absolute path to the auto-saved copy on disk. Empty
	// string when save failed (the failure is logged but doesn't fail the
	// generation — the in-memory base64 result is still usable).
	SavedPath string `json:"savedPath"`
	// Meta is the generation metadata (same as the sidecar), so the freshly
	// generated image shows the same details in the UI as gallery images.
	Meta *GenerationMeta `json:"meta,omitempty"`
}

// GenerateProgress is broadcast on the "generate:progress" event channel during
// a local generation — one per denoise step, parsed from the engine's stderr
// progress bar. Lets the UI show a real progress bar instead of an opaque
// "Generating…". Cloud generation doesn't emit these (no per-step feedback).
type GenerateProgress struct {
	Step    int `json:"step"`
	Total   int `json:"total"`
	Percent int `json:"percent"`
}

// SidecarStatus is broadcast via Wails events on the "sidecar:status" channel
// every time the sidecar manager transitions states. The frontend uses the
// `state` discriminator to render the header pill and to enable/disable the
// Run Local button.
type SidecarStatus struct {
	State   string `json:"state"` // idle | starting | ready | error | stopped
	Port    int    `json:"port,omitempty"`
	Device  string `json:"device,omitempty"`
	Message string `json:"message,omitempty"`
}

// PythonInfo is the result of DetectPython: which interpreter we picked, and
// its self-reported version. Used by the frontend's installer panel.
type PythonInfo struct {
	Path    string `json:"path"`
	Version string `json:"version"`
}

// EngineInfo reflects whether the bundled-engine venv exists and looks valid.
// Computed on demand by GetEngineInfo — cheap, fast, can be called every time
// the SettingsDialog opens.
type EngineInfo struct {
	Installed  bool   `json:"installed"`
	VenvDir    string `json:"venvDir"`
	PythonPath string `json:"pythonPath"`
	// EngineVersion is the imference-engine version currently installed in the
	// venv (via importlib.metadata), "" when unknown / not installed.
	EngineVersion string `json:"engineVersion"`
	// PinnedVersion is the version the desktop ships with (parsed from
	// EngineTarball), "" under a dev source override where no version is enforced.
	PinnedVersion string `json:"pinnedVersion"`
	// Outdated is true when both versions are known and differ — the startup
	// check force-reinstalls the pinned engine in that case.
	Outdated bool `json:"outdated"`
}

// InstallProgress is emitted on the "install:progress" event channel during
// InstallEngine. The frontend renders a phase label + percent bar from this,
// and the final entry (Done=true or Error!="") lets it re-enable the button.
type InstallProgress struct {
	Phase string `json:"phase"` // detect | venv | torch | sidecar-deps | engine | done | error
	// Message is a short human-readable string for the UI ("Downloading torch
	// (~3 GB)…"). For verbose pip lines, callers should publish to logbus
	// directly — those flow into the LogPanel and don't bloat this event.
	Message string `json:"message"`
	// PercentEstimate is 0–100, monotone within each long-running phase. Zero
	// during indeterminate phases (detect, venv create) so the UI shows a
	// barber-pole instead of a fake percent.
	PercentEstimate int    `json:"percentEstimate"`
	Done            bool   `json:"done"`
	Error           string `json:"error,omitempty"`
}
