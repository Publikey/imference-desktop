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
}

// GenerationResult is the unified Go → frontend response. Same shape for
// cloud and local: image always arrives as base64 PNG/WebP so the React
// side just sets `<img src="data:image/png;base64,..."/>` regardless of source.
type GenerationResult struct {
	ImageBase64 string `json:"imageBase64"`
	Seed        int    `json:"seed"`
	Source      string `json:"source"` // "cloud" | "local"
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
