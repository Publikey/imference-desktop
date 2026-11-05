package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"imference-desktop-go/internal/logbus"
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

	srv := &tools.APIServer{Catalog: a.toolsCat, Backend: toolsAPIBackend{a}, Bus: logbus.New(), Token: "tok"}
	hs := httptest.NewServer(srv.Handler())
	defer hs.Close()
	post := func(body map[string]any) (int, map[string]any) {
		b, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, hs.URL+"/v1/generate", bytes.NewReader(b))
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

	code, m := post(map[string]any{"prompt": "a fox"})
	if code != http.StatusOK || m["model"] != "anima" || m["seed"] != float64(4242) {
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
}
