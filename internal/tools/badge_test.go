package tools

import (
	"strings"
	"testing"

	"imference-desktop-go/internal/gpu"
)

func tool(t *testing.T, id string) Tool {
	t.Helper()
	c, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	tl, ok := c.Get(id)
	if !ok {
		t.Fatalf("no tool %s", id)
	}
	return tl
}

// localOnly is a shipped tool with its cloud runtime taken away: every tool
// in the catalog has one today, but a tool without (e.g. an unverified
// license) must still route correctly.
func localOnly(t *testing.T, id string) Tool {
	tl := tool(t, id)
	tl.CloudAvailable = false
	return tl
}

func TestAssessTable(t *testing.T) {
	nvidia := gpu.Info{Vendor: gpu.VendorNVIDIA, Name: "RTX", VRAMGiB: 12}
	cpuProbe := &Probe{Providers: []string{"CPUExecutionProvider"}, FFmpeg: true, RAMGB: 16}
	cudaProbe := &Probe{Providers: []string{"CUDAExecutionProvider", "CPUExecutionProvider"}, FFmpeg: true, RAMGB: 32, TorchDevice: "cuda"}
	dmlProbe := &Probe{Providers: []string{"DmlExecutionProvider", "CPUExecutionProvider"}, FFmpeg: true, RAMGB: 16, TorchDevice: "cpu"}

	cases := []struct {
		name   string
		tool   string
		host   Host
		badge  Badge
		device string
		reason string
	}{
		{"no engine -> cloud", "upscale", Host{GOOS: "linux"}, BadgeCloud, "", "engine_not_installed"},
		{"no engine, local-only tool -> unavailable", "restore-faces/local-only", Host{GOOS: "linux"}, BadgeUnavailable, "", "engine_not_installed"},
		{"guess: nvidia -> cuda", "upscale", Host{GOOS: "windows", GPU: nvidia, EngineInstalled: true}, BadgeLocal, "cuda", ""},
		{"guess: windows amd -> directml", "upscale", Host{GOOS: "windows", GPU: gpu.Info{Vendor: gpu.VendorAMD}, EngineInstalled: true}, BadgeLocal, "directml", ""},
		{"guess: mac -> cpu slow for upscale", "upscale", Host{GOOS: "darwin", GPU: gpu.Info{Vendor: gpu.VendorApple}, EngineInstalled: true}, BadgeLocalSlow, "cpu", ""},
		{"guess: mac describe -> mps (torch)", "describe", Host{GOOS: "darwin", GPU: gpu.Info{Vendor: gpu.VendorApple}, EngineInstalled: true}, BadgeLocal, "mps", ""},
		{"cpu probe: upscale slow", "upscale", Host{GOOS: "linux", EngineInstalled: true, Probe: cpuProbe}, BadgeLocalSlow, "cpu", ""},
		{"cpu probe: remove-bg fine on cpu", "remove-background", Host{GOOS: "linux", EngineInstalled: true, Probe: cpuProbe}, BadgeLocal, "cpu", ""},
		{"cuda probe: upscale on cuda", "upscale", Host{GOOS: "linux", GPU: nvidia, EngineInstalled: true, Probe: cudaProbe}, BadgeLocal, "cuda", ""},
		{"dml probe: describe on cpu torch -> slow", "describe", Host{GOOS: "windows", EngineInstalled: true, Probe: dmlProbe}, BadgeLocalSlow, "cpu", ""},
		{"dml probe: segment on directml", "segment", Host{GOOS: "windows", EngineInstalled: true, Probe: dmlProbe}, BadgeLocal, "directml", ""},
		{"no onnxruntime -> cloud", "upscale", Host{GOOS: "linux", EngineInstalled: true, Probe: &Probe{FFmpeg: true}}, BadgeCloud, "", "no_onnxruntime"},
		{"no onnxruntime: utilities still local", "resize", Host{GOOS: "linux", EngineInstalled: true, Probe: &Probe{FFmpeg: true}}, BadgeLocal, "cpu", ""},
		{"no ffmpeg -> video cloud", "video-trim", Host{GOOS: "linux", EngineInstalled: true, Probe: &Probe{Providers: []string{"CPUExecutionProvider"}}}, BadgeCloud, "", "no_ffmpeg"},
		{"low ram -> cloud", "upscale", Host{GOOS: "linux", EngineInstalled: true, Probe: &Probe{Providers: []string{"CPUExecutionProvider"}, RAMGB: 2}}, BadgeCloud, "", "low_ram"},
		{"video-trim cpu only", "video-trim", Host{GOOS: "linux", GPU: nvidia, EngineInstalled: true, Probe: cudaProbe}, BadgeLocal, "cpu", ""},

		{"vary: generation stopped -> cloud", "vary", Host{GOOS: "linux", EngineInstalled: true}, BadgeCloud, "", "generation_not_ready"},
		{"vary: no img2img -> cloud", "vary", Host{GenerationReady: true, GenerationDevice: "cuda:0"}, BadgeCloud, "", "no_img2img"},
		{"vary: on cuda -> local", "vary", Host{GenerationReady: true, GenerationImg2Img: true, GenerationDevice: "cuda:0"}, BadgeLocal, "cuda", ""},
		{"outpaint: on rocm -> local", "outpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationDevice: "cuda:0(rocm)"}, BadgeLocal, "rocm", ""},
		{"outpaint: on cpu -> cloud", "outpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationDevice: "cpu"}, BadgeCloud, "", "generation_on_cpu"},

		// Instruction editing needs an edit model loaded; the img2img tools refuse one.
		{"instruct-edit: edit model on cuda -> local", "instruct-edit", Host{GenerationReady: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0"}, BadgeLocal, "cuda", ""},
		{"instruct-edit: edit model on rocm -> local", "instruct-edit", Host{GenerationReady: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0(rocm)"}, BadgeLocal, "rocm", ""},
		{"instruct-edit: edit model on mps -> cloud", "instruct-edit", Host{GenerationReady: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "mps"}, BadgeCloud, "", "generation_on_cpu"},
		{"instruct-edit: sdxl loaded -> cloud", "instruct-edit", Host{GenerationReady: true, GenerationImg2Img: true, GenerationBackend: "sdxl", GenerationDevice: "cuda:0"}, BadgeCloud, "", "no_edit_model"},
		{"instruct-edit: edit model not ready -> cloud", "instruct-edit", Host{GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0"}, BadgeCloud, "", "generation_not_ready"},
		{"vary: edit model loaded -> cloud", "vary", Host{GenerationReady: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0"}, BadgeCloud, "", "edit_model_loaded"},
		{"outpaint: edit model loaded -> cloud", "outpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0"}, BadgeCloud, "", "edit_model_loaded"},
		{"outpaint: qwenimage loaded -> local", "outpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationBackend: "qwenimage", GenerationDevice: "cuda:0"}, BadgeLocal, "cuda", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			tl := tool
			if id, ok := strings.CutSuffix(c.tool, "/local-only"); ok {
				c.tool, tl = id, localOnly
			}
			a := Assess(tl(t, c.tool), c.host)
			if a.Badge != c.badge || a.Device != c.device || a.Reason != c.reason {
				t.Fatalf("Assess(%s) = %+v, want badge=%s device=%s reason=%s", c.tool, a, c.badge, c.device, c.reason)
			}
		})
	}
}

func TestInstructEditRouting(t *testing.T) {
	ie := tool(t, "instruct-edit")
	if !ie.IsGeneration() || !NeedsEditModel(ie) || NeedsEditModel(tool(t, "vary")) {
		t.Fatalf("instruct-edit: generation=%v needsEdit=%v", ie.IsGeneration(), NeedsEditModel(ie))
	}
	editHost := Host{GenerationReady: true, GenerationBackend: "qwenimage-edit", GenerationDevice: "cuda:0"}
	sdxlHost := Host{GenerationReady: true, GenerationImg2Img: true, GenerationBackend: "sdxl", GenerationDevice: "cuda:0"}
	if r, err := Decide("auto", ie, Assess(ie, editHost)); err != nil || r != RouteLocal {
		t.Errorf("auto on an edit model = %q %v, want local", r, err)
	}
	if r, err := Decide("auto", ie, Assess(ie, sdxlHost)); err != nil || r != RouteCloud {
		t.Errorf("auto on sdxl = %q %v, want cloud", r, err)
	}
	if _, err := Decide("local", ie, Assess(ie, sdxlHost)); err == nil || err.Code != CodeUnsupportedRuntime {
		t.Errorf("forced local on sdxl: %v", err)
	}
	vary := tool(t, "vary")
	if r, err := Decide("auto", vary, Assess(vary, editHost)); err != nil || r != RouteCloud {
		t.Errorf("vary on an edit model = %q %v, want cloud", r, err)
	}
}

func TestAssessMinVRAMFallsBackToCPU(t *testing.T) {
	tl := tool(t, "upscale")
	tl.Runtimes.MinVRAMGB = 8
	h := Host{GOOS: "linux", GPU: gpu.Info{Vendor: gpu.VendorNVIDIA, VRAMGiB: 4}, EngineInstalled: true,
		Probe: &Probe{Providers: []string{"CUDAExecutionProvider", "CPUExecutionProvider"}}}
	if a := Assess(tl, h); a.Badge != BadgeLocalSlow || a.Device != "cpu" {
		t.Fatalf("got %+v", a)
	}
}

func TestDecideRouting(t *testing.T) {
	up := tool(t, "upscale")
	rf := localOnly(t, "restore-faces")
	local := Assessment{Badge: BadgeLocal, Device: "cuda"}
	slow := Assessment{Badge: BadgeLocalSlow, Device: "cpu"}
	cloud := Assessment{Badge: BadgeCloud, Reason: "engine_not_installed"}
	unavail := Assessment{Badge: BadgeUnavailable, Reason: "engine_not_installed"}

	cases := []struct {
		mode  string
		tool  Tool
		a     Assessment
		route Route
		err   string
	}{
		{"auto", up, local, RouteLocal, ""},
		{"auto", up, slow, RouteLocal, ""},
		{"auto", up, cloud, RouteCloud, ""},
		{"auto", rf, unavail, "", CodeUnsupportedRuntime},
		{"", up, local, RouteLocal, ""}, // unknown mode = auto
		{"local", up, local, RouteLocal, ""},
		{"local", up, slow, RouteLocal, ""},
		{"local", up, cloud, "", CodeUnsupportedRuntime},
		{"cloud", up, local, RouteCloud, ""},
		{"cloud", rf, local, "", CodeUnsupportedRuntime},
	}
	for _, c := range cases {
		r, err := Decide(c.mode, c.tool, c.a)
		code := ""
		if err != nil {
			code = err.Code
		}
		if r != c.route || code != c.err {
			t.Errorf("Decide(%q, %s, %s) = %q, %v; want %q, %q", c.mode, c.tool.ID, c.a.Badge, r, err, c.route, c.err)
		}
	}
}

func TestCloudRetryable(t *testing.T) {
	cases := map[*Error]bool{
		{Code: CodeOOM}:                true,
		{Code: CodeUnsupportedRuntime}: true,
		{Code: CodeWeightsMissing, Message: "could not download https://x"}: true,
		{Code: CodeWeightsMissing, Message: "checksum mismatch for a.onnx"}: false,
		{Code: CodeInvalidInput}: false,
		{Code: CodeTooLarge}:     false,
		{Code: CodeInternal}:     false,
		{Code: CodeCancelled}:    false,
	}
	for e, want := range cases {
		if got := CloudRetryable(e); got != want {
			t.Errorf("CloudRetryable(%+v) = %v, want %v", e, got, want)
		}
	}
	if CloudRetryable(nil) {
		t.Error("nil is not retryable")
	}
}

func TestDecodeRunResult(t *testing.T) {
	res, err := DecodeRunResult([]byte(`{"ok":true,"result":{"tool_id":"resize","outputs":[{"name":"image","type":"image","format":"png","path":"/x.png"}]}}`))
	if err != nil || res.ToolID != "resize" || res.Outputs[0].Path != "/x.png" {
		t.Fatalf("ok result: %+v %v", res, err)
	}
	_, err = DecodeRunResult([]byte(`{"ok":false,"error":{"code":"oom","message":"out of memory"}}`))
	if err == nil || err.Code != CodeOOM {
		t.Fatalf("error result: %v", err)
	}
	res, err = DecodeRunResult([]byte(`{"tool":{"tool_id":"vary","outputs":[{"name":"image","type":"image","path":"/v.png","data":{"seed":42}}]}}`))
	if err != nil || res.Outputs[0].Seed() != 42 {
		t.Fatalf("generation result: %+v %v", res, err)
	}
	_, err = DecodeRunResult([]byte(`{"tool_error":{"code":"unsupported_runtime","message":"old engine"}}`))
	if err == nil || err.Code != CodeUnsupportedRuntime {
		t.Fatalf("generation error: %v", err)
	}
	if _, err = DecodeRunResult([]byte(`garbage`)); err == nil || err.Code != CodeInternal {
		t.Fatalf("garbage: %v", err)
	}
}
