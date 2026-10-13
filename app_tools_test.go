package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/tools"
	"imference-desktop-go/internal/types"
)

// newToolsTestApp builds an App whose tools sidecar is the fake one from
// internal/tools/testdata, with a temp settings dir and gallery.
func newToolsTestApp(t *testing.T) (*App, string) {
	t.Helper()
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not available")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, ".cache"))
	t.Setenv("APPDATA", home)
	t.Setenv("LOCALAPPDATA", home)
	store, err := settings.New()
	if err != nil {
		t.Fatal(err)
	}
	gallery := filepath.Join(home, "gallery")
	s := store.Get()
	s.PythonPath = py
	s.OutputDir = gallery
	if _, err := store.Save(s); err != nil {
		t.Fatal(err)
	}
	bus := logbus.New()
	a := &App{settings: store, bus: bus, ctx: context.Background(), cloud: cloud.New(bus)}
	a.sidecar = sidecar.New("", "", nil, bus)
	a.initTools()
	script, _ := filepath.Abs(filepath.Join("internal", "tools", "testdata", "fake_tools_sidecar.py"))
	a.tools = tools.NewManager(bus, func() (tools.LaunchConfig, error) {
		return tools.LaunchConfig{Python: py, Script: script, Env: os.Environ()}, nil
	}, a.emitToolProgress)
	t.Cleanup(a.tools.Stop)
	if err := os.MkdirAll(gallery, 0o755); err != nil {
		t.Fatal(err)
	}
	return a, gallery
}

func writeGalleryImage(t *testing.T, gallery, name, prompt string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(gallery, name), []byte("PNG"), 0o644); err != nil {
		t.Fatal(err)
	}
	meta := `{"prompt":"` + prompt + `","source":"local","modelCode":"cyber","seed":7,"createdAt":"2026-10-13T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(gallery, name+".json"), []byte(meta), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRunToolLocalSavesToGallery(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "20261013-101010_local_7.png", "a red fox")

	res := a.runTool(context.Background(), ToolRunRequest{
		JobID: "job-a", ToolID: "resize", RunOn: "local",
		Inputs: map[string][]string{"image": {"20261013-101010_local_7.png"}},
		Params: map[string]any{"width": 32, "format": ""},
	})
	if res.Error != nil {
		t.Fatalf("run failed: %+v", res.Error)
	}
	if res.RanOn != "local" || len(res.Outputs) != 1 {
		t.Fatalf("result %+v", res)
	}
	o := res.Outputs[0]
	if o.SavedName == "" || filepath.Dir(o.Path) != gallery || !strings.Contains(o.SavedName, "_tool_") {
		t.Fatalf("output not in the gallery: %+v", o)
	}
	meta := readSidecar(o.Path)
	if meta == nil || meta.Tool != "resize" || meta.Source != "tool" || meta.SourceImage != "20261013-101010_local_7.png" ||
		meta.RanOn != "local" || meta.Prompt != "a red fox" {
		t.Fatalf("meta = %+v", meta)
	}
	// The empty optional "format" was dropped (engine default applies).
	if _, ok := meta.ToolParams["format"]; ok {
		t.Errorf("empty param forwarded: %v", meta.ToolParams)
	}
	// The gallery lists it under source "tool".
	imgs, err := a.ListSavedImages(0, 10, types.GalleryFilter{Source: "tool"})
	if err != nil || len(imgs) != 1 || imgs[0].Source != "tool" {
		t.Fatalf("gallery: %+v %v", imgs, err)
	}
	// The work dir is gone.
	if wd, _ := toolsWorkDir("job-a"); wd != "" {
		entries, _ := os.ReadDir(wd)
		if len(entries) != 0 {
			t.Errorf("work dir not cleaned: %v", entries)
		}
		os.RemoveAll(wd)
	}
}

func TestRunToolNoSaveReturnsDataURL(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "x")
	res := a.runTool(context.Background(), ToolRunRequest{
		ToolID: "segment", RunOn: "local", NoSave: true,
		Inputs: map[string][]string{"image": {"src.png"}},
		Params: map[string]any{"points": []any{map[string]any{"x": 1, "y": 1, "label": 1}}},
	})
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	if o := res.Outputs[0]; o.SavedName != "" || !strings.HasPrefix(o.DataURL, "data:image/png;base64,") {
		t.Fatalf("output %+v", o)
	}
	entries, _ := os.ReadDir(gallery)
	if len(entries) != 2 { // src.png + src.png.json only
		t.Fatalf("gallery changed: %v", entries)
	}
}

func TestRunToolDataURIMaskInput(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "x")
	res := a.runTool(context.Background(), ToolRunRequest{
		ToolID: "erase-object", RunOn: "local",
		Inputs: map[string][]string{"image": {"src.png"}, "mask": {"data:image/png;base64,UE5H"}},
	})
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	// The source image is the image input, never the mask.
	if m := readSidecar(res.Outputs[0].Path); m == nil || m.SourceImage != "src.png" {
		t.Fatalf("meta %+v", m)
	}
}

func TestRunToolErrorsAndCloudOffer(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "x")
	in := map[string][]string{"image": {"src.png"}}

	// Local OOM on a tool the cloud can run: typed error + priced offer.
	res := a.runTool(context.Background(), ToolRunRequest{ToolID: "upscale", RunOn: "local", Inputs: in, Params: map[string]any{"fail": "oom"}})
	if res.Error == nil || res.Error.Code != tools.CodeOOM || res.Error.CloudRetry == nil || res.Error.CloudRetry.Credits != 4 {
		t.Fatalf("oom: %+v", res.Error)
	}
	if res.Error.CloudRetry.Rail != "credits" || res.Error.CloudRetry.USD != 0.004 {
		t.Errorf("offer %+v", res.Error.CloudRetry)
	}

	// Invalid inputs never reach a runtime.
	for _, req := range []ToolRunRequest{
		{ToolID: "nope", Inputs: in},
		{ToolID: "resize", Inputs: map[string][]string{}},
		{ToolID: "resize", Inputs: map[string][]string{"image": {"../etc/passwd"}}},
		{ToolID: "resize", Inputs: map[string][]string{"image": {"missing.png"}}},
		{ToolID: "resize", Inputs: map[string][]string{"bogus": {"src.png"}}},
	} {
		if r := a.runTool(context.Background(), req); r.Error == nil || r.Error.Code != tools.CodeInvalidInput {
			t.Errorf("%+v: %+v", req, r.Error)
		}
	}

	// Forced local without an engine: unsupported_runtime + cloud offer.
	s := a.settings.Get()
	s.PythonPath = ""
	_, _ = a.settings.Save(s)
	res = a.runTool(context.Background(), ToolRunRequest{ToolID: "upscale", RunOn: "local", Inputs: in})
	if res.Error == nil || res.Error.Code != tools.CodeUnsupportedRuntime || res.Error.CloudRetry == nil {
		t.Fatalf("no engine, local: %+v", res.Error)
	}
	// A local-only tool gets no offer.
	res = a.runTool(context.Background(), ToolRunRequest{ToolID: "restore-faces", RunOn: "local", Inputs: in})
	if res.Error == nil || res.Error.CloudRetry != nil {
		t.Fatalf("restore-faces: %+v", res.Error)
	}
	// Auto without an engine goes to the cloud (no API key -> a cloud error).
	res = a.runTool(context.Background(), ToolRunRequest{ToolID: "upscale", RunOn: "auto", Inputs: in})
	if res.RanOn != "cloud" || res.Error == nil || res.Error.Code != tools.CodeCloud {
		t.Fatalf("auto -> cloud: %+v", res)
	}
}

func TestRunToolCloudRoute(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "a red fox")
	var gotParams string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tools/vary":
			_ = r.ParseMultipartForm(1 << 20)
			gotParams = r.FormValue("params")
			_, _ = w.Write([]byte(`{"request_id":"r1","kind":"tool","credits":12}`))
		case "/status":
			_, _ = w.Write([]byte(`{"data":{"Outputs":[{"url":"` + srv.URL + `/blob.png","name":"image","type":"image","format":"png","seed":99}]}}`))
		case "/blob.png":
			_, _ = w.Write([]byte("VARIED"))
		}
	}))
	defer srv.Close()
	a.cloud.SetBaseURL(srv.URL)
	s := a.settings.Get()
	s.APIKey = "k"
	s.CloudModel = "flux-dev"
	_, _ = a.settings.Save(s)

	res := a.runTool(context.Background(), ToolRunRequest{ToolID: "vary", RunOn: "cloud",
		Inputs: map[string][]string{"image": {"src.png"}}, Params: map[string]any{"strength": "strong"}})
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	if res.RanOn != "cloud" || res.Credits != 12 || res.Outputs[0].Seed != 99 {
		t.Fatalf("result %+v", res)
	}
	// Vary defaults: the source's prompt, the selected cloud model (the source
	// was made locally).
	if !strings.Contains(gotParams, `"prompt":"a red fox"`) || !strings.Contains(gotParams, `"model":"flux-dev"`) {
		t.Fatalf("params sent = %s", gotParams)
	}
	b, _ := os.ReadFile(res.Outputs[0].Path)
	if string(b) != "VARIED" {
		t.Fatalf("saved %q", b)
	}
	if m := readSidecar(res.Outputs[0].Path); m == nil || m.RanOn != "cloud" || m.ModelCode != "flux-dev" || m.Seed != 99 {
		t.Fatalf("meta %+v", m)
	}
}

func TestCloudToolParamsModelChoice(t *testing.T) {
	cat, _ := tools.Builtin()
	vary, _ := cat.Get("vary")
	up, _ := cat.Get("upscale")
	s := types.Settings{CloudModel: "selected"}
	cloudSrc := &types.GenerationMeta{Source: "cloud", ModelCode: "from-image"}
	localSrc := &types.GenerationMeta{Source: "local", ModelCode: "local-model"}
	cases := []struct {
		params map[string]any
		src    *types.GenerationMeta
		s      types.Settings
		want   any
	}{
		{map[string]any{"model": "explicit"}, cloudSrc, s, "explicit"},
		{map[string]any{}, cloudSrc, s, "from-image"},
		{map[string]any{}, localSrc, s, "selected"},
		{map[string]any{"model": "local"}, nil, s, "selected"},
		{map[string]any{}, localSrc, types.Settings{}, "local-model"},
		{map[string]any{}, nil, types.Settings{}, nil},
	}
	for i, c := range cases {
		got := cloudToolParams(vary, c.params, c.src, c.s, "")["model"]
		if got != c.want {
			t.Errorf("case %d: model = %v, want %v", i, got, c.want)
		}
	}
	if p := cloudToolParams(up, map[string]any{"scale": 2}, cloudSrc, s, ""); p["model"] != nil {
		t.Errorf("non-generation tool got a model: %v", p)
	}
}

func TestToolParamsPromptDefault(t *testing.T) {
	cat, _ := tools.Builtin()
	vary, _ := cat.Get("vary")
	src := &types.GenerationMeta{Prompt: "a cat", NegativePrompt: "blurry"}
	p := toolParams(vary, map[string]any{"prompt": "", "seed": nil}, src)
	if p["prompt"] != "a cat" || p["negative_prompt"] != "blurry" {
		t.Fatalf("got %v", p)
	}
	if _, ok := p["seed"]; ok {
		t.Error("nil params must be dropped")
	}
	p = toolParams(vary, map[string]any{"prompt": "a dog"}, src)
	if p["prompt"] != "a dog" {
		t.Fatalf("explicit prompt overridden: %v", p)
	}
}

func TestToolsEnvDefaultsTheMirror(t *testing.T) {
	t.Setenv("IMAGE_MODEL_CDN", "https://cdn.example/image")
	os.Unsetenv("TOOLS_MODEL_CDN")
	env := strings.Join(toolsEnv(types.ToolsSettings{Device: "cpu"}), "\n")
	if !strings.Contains(env, "TOOLS_MODEL_CDN=https://cdn.example/image/tools") || !strings.Contains(env, "IMFERENCE_TOOLS_DEVICE=cpu") {
		t.Fatalf("env:\n%s", env)
	}
	t.Setenv("TOOLS_MODEL_CDN", "https://mine")
	env = strings.Join(toolsEnv(types.ToolsSettings{}), "\n")
	if strings.Contains(env, "/image/tools") || !strings.Contains(env, "IMFERENCE_TOOLS_DEVICE=auto") {
		t.Fatalf("override not respected:\n%s", env)
	}
}
