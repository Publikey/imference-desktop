package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/tools"
	"imference-desktop-go/internal/types"
)

func editModel() *types.ModelInfo {
	return &types.ModelInfo{ModelCode: "qwen-image-edit-2511", Name: "Qwen-Image-Edit 2511", BackendType: "qwenimage-edit"}
}

func TestGenerateRefusesEditModels(t *testing.T) {
	a, _ := newToolsTestApp(t)
	s := a.settings.Get()
	s.LocalModel = editModel()
	s.CloudModel = "qwen-image-edit-2511"
	s.CloudModelInfo = editModel()
	_, _ = a.settings.Save(s)
	if _, err := a.GenerateLocal(types.GenerationRequest{Prompt: "a fox"}); !errors.Is(err, ErrEditModelGenerate) {
		t.Fatalf("GenerateLocal on an edit model: %v", err)
	}
	if _, err := a.GenerateCloud(types.GenerationRequest{Prompt: "a fox"}); !errors.Is(err, ErrEditModelGenerate) {
		t.Fatalf("GenerateCloud on an edit model: %v", err)
	}
	if !strings.Contains(ErrEditModelGenerate.Error(), "Edit with instructions") {
		t.Errorf("message must point at the tool: %v", ErrEditModelGenerate)
	}
	// A text-to-image model is not refused by the guard.
	if err := editModelGenerateGuard(&types.ModelInfo{BackendType: "qwenimage"}); err != nil {
		t.Errorf("qwenimage refused: %v", err)
	}
	// Name heuristics never block generation: only the backend does.
	if err := editModelGenerateGuard(&types.ModelInfo{ModelCode: "some-edit-model"}); err != nil {
		t.Errorf("name-only edit model refused: %v", err)
	}
}

func TestToolParamsInstructEdit(t *testing.T) {
	cat, _ := tools.Builtin()
	ie, _ := cat.Get("instruct-edit")
	src := &types.GenerationMeta{Prompt: "a cat on a sofa", NegativePrompt: "blurry"}
	p := toolParams(ie, map[string]any{"instruction": "make it night", "negative_prompt": "", "prompt": ""}, src)
	if p["instruction"] != "make it night" {
		t.Fatalf("instruction: %v", p)
	}
	for _, k := range []string{"prompt", "negative_prompt"} {
		if _, ok := p[k]; ok {
			t.Errorf("%s must not be filled from the source: %v", k, p)
		}
	}
	// An agent's "prompt" is the instruction.
	p = toolParams(ie, map[string]any{"prompt": "remove the man"}, nil)
	if p["instruction"] != "remove the man" || p["prompt"] != nil {
		t.Errorf("prompt -> instruction: %v", p)
	}
	// A blank instruction is absent (runTool then refuses it).
	if p = toolParams(ie, map[string]any{"instruction": "  "}, src); p["instruction"] != nil {
		t.Errorf("blank instruction kept: %v", p)
	}
}

func TestCloudToolParamsInstructEdit(t *testing.T) {
	cat, _ := tools.Builtin()
	ie, _ := cat.Get("instruct-edit")
	cloudSrc := &types.GenerationMeta{Source: "cloud", ModelCode: "flux-dev"}
	plain := types.Settings{CloudModel: "flux-dev", CloudModelInfo: &types.ModelInfo{ModelCode: "flux-dev", BackendType: "flux"}}
	selEdit := types.Settings{CloudModel: "qwen-image-edit-2509", CloudModelInfo: &types.ModelInfo{ModelCode: "qwen-image-edit-2509", BackendType: "qwenimage-edit"}}
	cases := []struct {
		params      map[string]any
		s           types.Settings
		editDefault string
		want        string
	}{
		{map[string]any{"model": "explicit-edit"}, plain, "", "explicit-edit"},
		{map[string]any{}, plain, "", cloud.DefaultEditModel}, // never the flux source / selection
		{map[string]any{"model": "local"}, plain, "other-edit", "other-edit"},
		{map[string]any{}, selEdit, "other-edit", "qwen-image-edit-2509"},
	}
	for i, c := range cases {
		if got := cloudToolParams(ie, c.params, cloudSrc, c.s, c.editDefault)["model"]; got != c.want {
			t.Errorf("case %d: model = %v, want %s", i, got, c.want)
		}
	}
	// The default: the selected edit model, else 2511 when listed (or nothing
	// is known), else the first edit model.
	if got := editDefaultFrom(nil, plain); got != cloud.DefaultEditModel {
		t.Errorf("empty catalog: %s", got)
	}
	list := []types.ModelInfo{{ModelCode: "qwen-image-edit-2509"}, {ModelCode: cloud.DefaultEditModel}}
	if got := editDefaultFrom(list, plain); got != cloud.DefaultEditModel {
		t.Errorf("2511 listed: %s", got)
	}
	if got := editDefaultFrom(list[:1], plain); got != "qwen-image-edit-2509" {
		t.Errorf("first: %s", got)
	}
	if got := editDefaultFrom(list, selEdit); got != "qwen-image-edit-2509" {
		t.Errorf("selected edit model: %s", got)
	}
}

// startFakeGenSidecar runs internal/tools/testdata/fake_gen_sidecar.py as the
// generation sidecar with the given model "loaded".
func startFakeGenSidecar(t *testing.T, a *App, model *types.ModelInfo) string {
	t.Helper()
	logPath := filepath.Join(t.TempDir(), "gen.log")
	t.Setenv("FAKE_GEN_LOG", logPath)
	script, _ := filepath.Abs(filepath.Join("internal", "tools", "testdata", "fake_gen_sidecar.py"))
	weights := filepath.Join(t.TempDir(), "model.safetensors")
	_ = os.WriteFile(weights, []byte("x"), 0o644)
	a.sidecar = sidecar.New(script, "", nil, a.bus)
	s := a.settings.Get()
	s.LocalModel = model
	_, _ = a.settings.Save(s)
	cpu := "cpu"
	rt := types.EngineRuntimeSettings{}
	rt.Image.Device = cpu
	if err := a.sidecar.Start(context.Background(), s.PythonPath, weights, model, rt); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = a.sidecar.Stop() })
	deadline := time.Now().Add(5 * time.Second)
	for d := a.sidecar.Status().Device; (d == "" || d == "unknown") && time.Now().Before(deadline); d = a.sidecar.Status().Device {
		time.Sleep(20 * time.Millisecond)
	}
	return logPath
}

func lastGenPayload(t *testing.T, logPath string) map[string]any {
	t.Helper()
	b, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	var p map[string]any
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestInstructEditLocalRunAndAPI(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "a cat on a sofa")
	writeGalleryImage(t, gallery, "ref1.png", "a hat")
	logPath := startFakeGenSidecar(t, a, editModel())

	if b := tools.Assess(mustTool(t, a, "instruct-edit"), a.toolsHost()); b.Badge != tools.BadgeLocal || b.Device != "cuda" {
		t.Fatalf("instruct-edit badge with an edit model loaded: %+v", b)
	}
	if b := tools.Assess(mustTool(t, a, "vary"), a.toolsHost()); b.Badge.IsLocal() || b.Reason != "edit_model_loaded" {
		t.Fatalf("vary badge with an edit model loaded: %+v", b)
	}

	res := a.runTool(context.Background(), ToolRunRequest{
		ToolID: "instruct-edit", RunOn: "local",
		Inputs: map[string][]string{"image": {"src.png"}, "references": {"ref1.png", "data:image/png;base64,UE5H"}},
		Params: map[string]any{"instruction": "give the cat the hat from image 2", "model": "qwen-image-edit-2511", "keep_size": true},
	})
	if res.Error != nil {
		t.Fatalf("run: %+v", res.Error)
	}
	if res.RanOn != "local" || len(res.Outputs) != 1 || res.Outputs[0].Seed != 1234 {
		t.Fatalf("result %+v", res)
	}
	p := lastGenPayload(t, logPath)
	in := p["inputs"].(map[string]any)
	refs, _ := in["references"].([]any)
	if filepath.Base(in["image"].(string)) != "src.png" || len(refs) != 2 || filepath.Base(refs[0].(string)) != "ref1.png" {
		t.Fatalf("inputs sent = %v", in)
	}
	params := p["params"].(map[string]any)
	if params["instruction"] != "give the cat the hat from image 2" || params["prompt"] != nil {
		t.Fatalf("params sent = %v", params)
	}
	meta := readSidecar(res.Outputs[0].Path)
	if meta == nil || meta.Tool != "instruct-edit" || meta.Prompt != "give the cat the hat from image 2" ||
		meta.SourceImage != "src.png" || meta.Engine != "qwenimage-edit" || meta.ModelCode != "qwen-image-edit-2511" {
		t.Fatalf("meta = %+v", meta)
	}

	// Missing instruction / too many references never reach the engine.
	for _, req := range []ToolRunRequest{
		{ToolID: "instruct-edit", RunOn: "local", Inputs: map[string][]string{"image": {"src.png"}}, Params: map[string]any{"instruction": ""}},
		{ToolID: "instruct-edit", RunOn: "local", Inputs: map[string][]string{"image": {"src.png"}, "references": {"ref1.png", "ref1.png", "src.png"}},
			Params: map[string]any{"instruction": "x"}},
	} {
		if r := a.runTool(context.Background(), req); r.Error == nil || r.Error.Code != tools.CodeInvalidInput {
			t.Errorf("%+v: %+v", req.Params, r.Error)
		}
	}

	// The agents' local API: references as a list.
	srv := &tools.APIServer{Catalog: a.toolsCat, Backend: toolsAPIBackend{a}, Bus: logbus.New(), Token: "tok", AllowHTTP: true}
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	post := func() (int, map[string]any) {
		body, _ := json.Marshal(map[string]any{
			"inputs": map[string]any{"image": filepath.Join(gallery, "src.png"), "references": []string{filepath.Join(gallery, "ref1.png")}},
			"params": map[string]any{"instruction": "make it snow"},
		})
		req, _ := http.NewRequest(http.MethodPost, hs.URL+"/v1/tools/instruct-edit", bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer tok")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	code, body := post()
	if code != http.StatusOK || body["tool_id"] != "instruct-edit" {
		t.Fatalf("API run: %d %v", code, body)
	}
	p = lastGenPayload(t, logPath)
	if refs, _ := p["inputs"].(map[string]any)["references"].([]any); len(refs) != 1 {
		t.Fatalf("API references = %v", p["inputs"])
	}

	// A text-to-image model loaded: instruct-edit is not local.
	s := a.settings.Get()
	s.LocalModel = &types.ModelInfo{ModelCode: "sdxl-x", BackendType: "sdxl"}
	_, _ = a.settings.Save(s)
	if code, body = post(); code != http.StatusServiceUnavailable {
		t.Fatalf("API with sdxl loaded: %d %v", code, body)
	}
}

func mustTool(t *testing.T, a *App, id string) tools.Tool {
	t.Helper()
	tl, ok := a.toolsCat.Get(id)
	if !ok {
		t.Fatalf("no tool %s", id)
	}
	return tl
}

func TestInstructEditCloudRoute(t *testing.T) {
	a, gallery := newToolsTestApp(t)
	writeGalleryImage(t, gallery, "src.png", "a cat")
	writeGalleryImage(t, gallery, "ref1.png", "a hat")
	var gotParams string
	var gotFiles = map[string]int{}
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tools/instruct-edit":
			mr, _ := r.MultipartReader()
			for mr != nil {
				part, err := mr.NextPart()
				if err != nil {
					break
				}
				if part.FileName() != "" {
					gotFiles[part.FormName()]++
				} else if part.FormName() == "params" {
					var b bytes.Buffer
					_, _ = b.ReadFrom(part)
					gotParams = b.String()
				}
			}
			_, _ = w.Write([]byte(`{"request_id":"r1","kind":"tool","credits":30}`))
		case "/status":
			_, _ = w.Write([]byte(`{"data":{"Outputs":[{"url":"` + srv.URL + `/blob.png","name":"image","type":"image","format":"png","seed":7}]}}`))
		case "/blob.png":
			_, _ = w.Write([]byte("EDITED"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	a.cloud.SetBaseURL(srv.URL)
	s := a.settings.Get()
	s.APIKey = "k"
	s.CloudModel = "flux-dev" // a text-to-image selection must not be used
	_, _ = a.settings.Save(s)

	res := a.runTool(context.Background(), ToolRunRequest{ToolID: "instruct-edit", RunOn: "cloud",
		Inputs: map[string][]string{"image": {"src.png"}, "references": {"ref1.png"}},
		Params: map[string]any{"instruction": "add a hat"}})
	if res.Error != nil {
		t.Fatal(res.Error)
	}
	if !strings.Contains(gotParams, `"model":"qwen-image-edit-2511"`) || !strings.Contains(gotParams, `"instruction":"add a hat"`) {
		t.Fatalf("params sent = %s", gotParams)
	}
	if gotFiles["image"] != 1 || gotFiles["references"] != 1 {
		t.Fatalf("files sent = %v", gotFiles)
	}
	if m := readSidecar(res.Outputs[0].Path); m == nil || m.Prompt != "add a hat" || m.ModelCode != "qwen-image-edit-2511" || m.RanOn != "cloud" {
		t.Fatalf("meta %+v", m)
	}
}
