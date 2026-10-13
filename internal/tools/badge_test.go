package tools

import (
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
		{"no engine, local-only tool -> unavailable", "restore-faces", Host{GOOS: "linux"}, BadgeUnavailable, "", "engine_not_installed"},
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
		{"inpaint: on rocm -> local", "inpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationDevice: "cuda:0(rocm)"}, BadgeLocal, "rocm", ""},
		{"outpaint: on cpu -> cloud", "outpaint", Host{GenerationReady: true, GenerationImg2Img: true, GenerationDevice: "cpu"}, BadgeCloud, "", "generation_on_cpu"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := Assess(tool(t, c.tool), c.host)
			if a.Badge != c.badge || a.Device != c.device || a.Reason != c.reason {
				t.Fatalf("Assess(%s) = %+v, want badge=%s device=%s reason=%s", c.tool, a, c.badge, c.device, c.reason)
			}
		})
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
	rf := tool(t, "restore-faces") // no cloud runtime (license not verified)
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
