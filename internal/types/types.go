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
	// CloudModelInfo is the full catalog entry for the selected cloud model
	// (CloudModel holds just its code, the value actually sent to the server).
	// Stored so the form selector can show the model's details and seed cloud
	// generation params (steps/cfg/resolution) the same way LocalModel does.
	// Nil until the user picks a cloud model from the form.
	CloudModelInfo *ModelInfo `json:"cloudModelInfo,omitempty"`
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
