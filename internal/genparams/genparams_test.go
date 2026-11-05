package genparams

import (
	"testing"

	"imference-desktop-go/internal/types"
)

func ip(v int) *int         { return &v }
func fp(v float64) *float64 { return &v }

func model() *types.ModelInfo {
	return &types.ModelInfo{
		ModelCode:    "anima",
		BackendType:  "sdxl",
		PromptPre:    "masterpiece, ",
		StepsDefault: ip(28), StepsMin: ip(10), StepsMax: ip(40),
		CfgDefault: fp(5), CfgMin: fp(1), CfgMax: fp(10),
		Formats: []types.FormatOption{
			{FormatCode: "square", Width: 1024, Height: 1024, IsDefault: true},
			{FormatCode: "portrait", Width: 832, Height: 1216},
		},
	}
}

func TestBuildDefaults(t *testing.T) {
	req, f := Build(model(), Request{Prompt: "a fox"})
	if f.FormatCode != "square" || req.Width != 1024 || req.Height != 1024 {
		t.Fatalf("format = %+v, req %dx%d", f, req.Width, req.Height)
	}
	if req.NumSteps != 28 || req.GuidanceScale != 5 {
		t.Fatalf("steps/cfg = %d/%v", req.NumSteps, req.GuidanceScale)
	}
	if req.Prompt != "masterpiece, a fox" {
		t.Fatalf("prompt = %q", req.Prompt)
	}
}

func TestBuildFormatClampAndTags(t *testing.T) {
	req, f := Build(model(), Request{Prompt: "masterpiece, a fox", FormatCode: "PORTRAIT", Steps: 99, GuidanceScale: 0.2})
	if f.FormatCode != "portrait" || req.Width != 832 || req.Height != 1216 {
		t.Fatalf("format = %+v", f)
	}
	if req.NumSteps != 40 || req.GuidanceScale != 1 {
		t.Fatalf("clamped steps/cfg = %d/%v", req.NumSteps, req.GuidanceScale)
	}
	if req.Prompt != "masterpiece, a fox" {
		t.Fatalf("tags added twice: %q", req.Prompt)
	}
}

func TestBuildFreeSizeAndFallbacks(t *testing.T) {
	req, f := Build(model(), Request{Prompt: "x", Width: 1001, Height: 100})
	if f.FormatCode != "custom" || req.Width != 1000 || req.Height != 256 {
		t.Fatalf("free size = %+v %dx%d", f, req.Width, req.Height)
	}
	// No catalog formats: generic ones; video models get 480p ones.
	req, _ = Build(&types.ModelInfo{BackendType: "sdxl"}, Request{Prompt: "x"})
	if req.Width != 1024 || req.NumSteps != 0 {
		t.Fatalf("fallback = %dx%d steps %d", req.Width, req.Height, req.NumSteps)
	}
	req, _ = Build(&types.ModelInfo{BackendType: "wan"}, Request{Prompt: "x"})
	if req.Width != 832 || req.Height != 480 {
		t.Fatalf("video fallback = %dx%d", req.Width, req.Height)
	}
	if !KnownFormat(model(), "Square") || KnownFormat(model(), "wide") {
		t.Fatal("KnownFormat")
	}
}
