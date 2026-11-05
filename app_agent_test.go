package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/tools"
	"imference-desktop-go/internal/types"
)

// The agents' local generation, end to end against the fake engine: catalog
// defaults applied, the image saved to the gallery, the path returned.
func TestAgentGenerateLocal(t *testing.T) {
	a, _ := newToolsTestApp(t)
	steps := 28
	model := &types.ModelInfo{
		ModelCode: "anima", Name: "Anima", BackendType: "sdxl", PromptPre: "masterpiece, ", StepsDefault: &steps,
		Formats: []types.FormatOption{{FormatCode: "portrait", Width: 832, Height: 1216, IsDefault: true}},
	}
	logPath := startFakeGenSidecar(t, a, model)
	prev := engineInstalled
	engineInstalled = func(*App) bool { return true }
	t.Cleanup(func() { engineInstalled = prev })

	// The Activity rows the renderer gets ("agent:run").
	var runsMu sync.Mutex
	var runs []AgentRun
	a.emitter = func(name string, data ...any) {
		if r, ok := data[0].(AgentRun); ok && name == "agent:run" {
			runsMu.Lock()
			runs = append(runs, r)
			runsMu.Unlock()
		}
	}

	srv := &tools.APIServer{Catalog: a.toolsCat, Backend: toolsAPIBackend{a}, Bus: logbus.New(), Token: "tok"}
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	post := func(body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, hs.URL+"/v1/generate", bytes.NewReader(b))
		req.Header.Set("Authorization", "Bearer tok")
		req.Header.Set(tools.AgentHeader, "claude-ai")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]any
		_ = json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}

	code, m := post(map[string]any{"prompt": "a fox"})
	if code != http.StatusOK || m["model"] != "anima" || m["model_name"] != "Anima" || m["seed"] != float64(4242) {
		t.Fatalf("generate: %d %v", code, m)
	}
	out := m["outputs"].([]any)[0].(map[string]any)
	path, _ := out["path"].(string)
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("image not saved to the gallery: %v (%v)", err, out)
	}
	if out["width"] != float64(832) || out["height"] != float64(1216) {
		t.Fatalf("size = %v x %v", out["width"], out["height"])
	}
	runsMu.Lock()
	if len(runs) != 2 || runs[0].State != "running" || runs[1].State != "done" || runs[1].Image == nil ||
		runs[0].JobID != runs[1].JobID || runs[0].Agent != "claude-ai" || runs[0].Label != "a fox" || runs[0].Kind != "generate" ||
		runs[0].Model != "Anima" || runs[1].Model != "Anima" {
		t.Fatalf("agent:run events = %+v", runs)
	}
	runs = nil
	runsMu.Unlock()
	p := lastGenPayload(t, logPath)
	if p["prompt"] != "masterpiece, a fox" || p["num_steps"] != float64(28) || p["width"] != float64(832) {
		t.Fatalf("payload = %v", p)
	}

	// A model that isn't loaded and isn't downloaded: model_not_cached (or a
	// catalog error offline) — never a download.
	code, m = post(map[string]any{"prompt": "x", "model": "not-a-model"})
	if code == http.StatusOK {
		t.Fatalf("unknown model accepted: %v", m)
	}
	runsMu.Lock()
	defer runsMu.Unlock()
	if len(runs) != 2 || runs[1].State != "error" || runs[1].Error == "" {
		t.Fatalf("a failed run must settle its row: %+v", runs)
	}
}

// An agent's own cloud run (POST /v1/agent-runs): a row while it runs; on
// "done" Desktop fetches the result by request_id (public status endpoint)
// and saves it to the gallery with the prompt and model.
func TestAgentCloudReport(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	t.Setenv("APPDATA", home)
	t.Setenv("LOCALAPPDATA", home)
	store, err := settings.New()
	if err != nil {
		t.Fatal(err)
	}
	gallery := filepath.Join(home, "gallery")
	s := store.Get()
	s.OutputDir = gallery
	if _, err := store.Save(s); err != nil {
		t.Fatal(err)
	}
	png, _ := base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
	var apiURL string
	mux := http.NewServeMux()
	mux.HandleFunc("/ondemand/status", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("request_id") != "req-9" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte(`{"data":{"RequestID":"req-9","Kind":"image","URL":"` + apiURL + `/blob/c.png","Format":"png","Seed":77}}`))
	})
	mux.HandleFunc("/blob/c.png", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(png) })
	mux.HandleFunc("/api/models", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"models":[{"model_code":"flux","name":"Flux Dev","model_type":"image"}]}`))
	})
	api := httptest.NewServer(mux)
	defer api.Close()
	apiURL = api.URL

	bus := logbus.New()
	c := cloud.New(bus)
	c.SetBaseURL(api.URL)
	a := &App{settings: store, bus: bus, ctx: context.Background(), cloud: c}
	runs := make(chan AgentRun, 4)
	a.emitter = func(name string, data ...any) {
		if r, ok := data[0].(AgentRun); ok && name == "agent:run" {
			runs <- r
		}
	}
	be := toolsAPIBackend{a}
	if terr := be.ReportAgentRun(context.Background(), tools.AgentReport{ID: "req-9", State: "running", Label: "a cat", Model: "flux"}); terr != nil {
		t.Fatal(terr)
	}
	r := <-runs
	if r.State != "running" || r.Mode != "cloud" || r.JobID != "agentcloud_req-9" || r.Label != "a cat" {
		t.Fatalf("running = %+v", r)
	}
	if terr := be.ReportAgentRun(context.Background(), tools.AgentReport{ID: "req-9", State: "done", Label: "a cat", Model: "flux", RequestID: "req-9"}); terr != nil {
		t.Fatal(terr)
	}
	select {
	case r = <-runs:
	case <-time.After(20 * time.Second):
		t.Fatal("no done event")
	}
	if r.State != "done" || r.Image == nil || r.Image.SavedPath == "" || r.Image.Meta == nil || r.Image.Meta.Prompt != "a cat" || r.Image.Meta.Source != "cloud" {
		t.Fatalf("done = %+v (image %+v)", r, r.Image)
	}
	if _, err := os.Stat(r.Image.SavedPath); err != nil {
		t.Fatalf("not saved to the gallery: %v", err)
	}
	if r.JobID != "agentcloud_req-9" {
		t.Fatalf("job id = %s", r.JobID)
	}
}
