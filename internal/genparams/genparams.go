// Package genparams fills a local generation request from a model's catalog
// entry the way the app's composer does (frontend/src/app/model-params.ts):
// the format's real dimensions, the catalog's default steps / cfg, its quality
// tags, and caller values held inside the published bounds. It serves callers
// that don't go through the composer — the agents' local API (Imference MCP).
package genparams

import (
	"math"
	"strings"

	"imference-desktop-go/internal/types"
)

// Request is what an agent may set; zero values mean "the model's default".
type Request struct {
	Prompt         string
	NegativePrompt string
	FormatCode     string
	Width, Height  int
	Steps          int
	GuidanceScale  float64
	Seed           *int
	Scheduler      string
}

// fallbackFormats mirror FALLBACK_FORMATS / VIDEO_FALLBACK_FORMATS: used only
// when the catalog publishes no formats for the model.
var fallbackFormats = []types.FormatOption{
	{FormatCode: "square", Width: 1024, Height: 1024, IsDefault: true},
	{FormatCode: "portrait", Width: 832, Height: 1216},
	{FormatCode: "landscape", Width: 1216, Height: 832},
}

var videoFallbackFormats = []types.FormatOption{
	{FormatCode: "landscape", Width: 832, Height: 480, IsDefault: true},
	{FormatCode: "portrait", Width: 480, Height: 832},
}

// Formats are the model's formats, or the generic ones it falls back to.
func Formats(m *types.ModelInfo) []types.FormatOption {
	if m != nil && len(m.Formats) > 0 {
		return m.Formats
	}
	if m != nil && m.BackendType == "wan" {
		return videoFallbackFormats
	}
	return fallbackFormats
}

// FormatFor resolves a format code (unknown or empty: the model's default).
func FormatFor(m *types.ModelInfo, code string) types.FormatOption {
	opts := Formats(m)
	var def *types.FormatOption
	for i := range opts {
		if code != "" && strings.EqualFold(opts[i].FormatCode, code) {
			return opts[i]
		}
		if def == nil && opts[i].IsDefault {
			def = &opts[i]
		}
	}
	if def != nil {
		return *def
	}
	return opts[0]
}

// KnownFormat reports whether code is one of the model's formats.
func KnownFormat(m *types.ModelInfo, code string) bool {
	for _, f := range Formats(m) {
		if strings.EqualFold(f.FormatCode, code) {
			return true
		}
	}
	return false
}

// SnapDim holds a free dimension to a multiple of 8 within [256, 2048].
func SnapDim(n int) int {
	v := int(math.Round(float64(n)/8)) * 8
	if v < 256 {
		return 256
	}
	if v > 2048 {
		return 2048
	}
	return v
}

func knobInt(p *int) int {
	if p != nil && *p > 0 {
		return *p
	}
	return 0
}

func knobFloat(p *float64) float64 {
	if p != nil && *p > 0 {
		return *p
	}
	return 0
}

func clampInt(v int, lo, hi *int) int {
	if v <= 0 {
		return v
	}
	if l := knobInt(lo); l > 0 && v < l {
		return l
	}
	if h := knobInt(hi); h > 0 && v > h {
		return h
	}
	return v
}

func clampFloat(v float64, lo, hi *float64) float64 {
	if v <= 0 {
		return v
	}
	if l := knobFloat(lo); l > 0 && v < l {
		return l
	}
	if h := knobFloat(hi); h > 0 && v > h {
		return h
	}
	return v
}

// Build turns an agent request into the engine's request for model m:
//   - size: explicit width/height (snapped) win; else the format's dimensions;
//   - steps / cfg: the caller's value inside the catalog bounds, else the
//     catalog default (0 = the engine's own default);
//   - the model's quality tags (promptPre) are prepended, as the composer does.
//
// Negative prompt, scheduler and clip-skip defaults are filled later by the
// app (applyLocalModelConfig), like for runs from the composer.
func Build(m *types.ModelInfo, r Request) (types.GenerationRequest, types.FormatOption) {
	f := FormatFor(m, r.FormatCode)
	w, h := f.Width, f.Height
	if r.Width > 0 && r.Height > 0 {
		w, h = SnapDim(r.Width), SnapDim(r.Height)
		f = types.FormatOption{FormatCode: "custom", Width: w, Height: h}
	}
	steps := r.Steps
	cfg := r.GuidanceScale
	pre := ""
	if m != nil {
		if steps <= 0 {
			steps = knobInt(m.StepsDefault)
		}
		steps = clampInt(steps, m.StepsMin, m.StepsMax)
		if cfg <= 0 {
			cfg = knobFloat(m.CfgDefault)
		}
		cfg = clampFloat(cfg, m.CfgMin, m.CfgMax)
		pre = m.PromptPre
	}
	// Joined as the composer does (promptPre + prompt, the tags carry their own
	// separator), unless the agent already included them.
	prompt := strings.TrimSpace(r.Prompt)
	if t := strings.TrimSpace(pre); t != "" && !strings.HasPrefix(prompt, t) {
		prompt = pre + prompt
	}
	return types.GenerationRequest{
		Prompt:         prompt,
		NegativePrompt: r.NegativePrompt,
		Width:          w,
		Height:         h,
		NumSteps:       steps,
		GuidanceScale:  cfg,
		Seed:           r.Seed,
		Scheduler:      r.Scheduler,
		FormatCode:     f.FormatCode,
	}, f
}
