package tools

import (
	"context"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"imference-desktop-go/internal/logbus"
)

type fakeGenBackend struct {
	fakeBackend
	gotBody   GenerateBody
	gotSource []byte
	err       *Error
}

func (f *fakeGenBackend) GenerationInfo(context.Context) GenerationInfo {
	return GenerationInfo{Ready: true, EngineState: "ready",
		Model:  &GenModel{Code: "anima", Name: "Anima", Cached: true, Active: true},
		Models: []GenModel{{Code: "anima", Cached: true, Active: true}, {Code: "flux", Cached: false}}}
}

func (f *fakeGenBackend) Generate(_ context.Context, body GenerateBody, source string) (*GenerateResult, *Error) {
	f.gotBody = body
	if source != "" {
		f.gotSource, _ = os.ReadFile(source)
	}
	if f.err != nil {
		return nil, f.err
	}
	return &GenerateResult{Model: "anima", Seed: 42, DurationMs: 900,
		Outputs: []APIOutput{{Name: "image", Type: "image", Format: "png", Path: "/gallery/a.png", Width: 1024, Height: 1024}}}, nil
}

func newGenAPI(t *testing.T, be APIBackend) *httptest.Server {
	t.Helper()
	cat, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	s := &APIServer{Catalog: cat, Backend: be, Bus: logbus.New(), Token: "secret", AllowHTTP: true}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return srv
}

func TestLocalAPIGenerationInfo(t *testing.T) {
	srv := newGenAPI(t, &fakeGenBackend{})
	if code, _ := call(t, srv, "GET", "/v1/generation", "", nil); code != http.StatusUnauthorized {
		t.Fatalf("no token: %d", code)
	}
	code, m := call(t, srv, "GET", "/v1/generation", "secret", nil)
	if code != 200 || m["ready"] != true || m["model"].(map[string]any)["code"] != "anima" {
		t.Fatalf("info = %d %v", code, m)
	}
	if n := len(m["models"].([]any)); n != 2 {
		t.Fatalf("models = %d", n)
	}
}

func TestLocalAPIGenerate(t *testing.T) {
	be := &fakeGenBackend{}
	srv := newGenAPI(t, be)
	src := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("PNGDATA"))
	code, m := call(t, srv, "POST", "/v1/generate", "secret", map[string]any{
		"model": "anima", "prompt": "a fox", "format_code": "portrait", "steps": 20, "seed": 7,
		"source_image": src, "strength": 0.6,
	})
	if code != 200 || m["seed"] != float64(42) {
		t.Fatalf("generate = %d %v", code, m)
	}
	out := m["outputs"].([]any)[0].(map[string]any)
	if out["path"] != "/gallery/a.png" || out["width"] != float64(1024) {
		t.Fatalf("output = %v", out)
	}
	b := be.gotBody
	if b.Model != "anima" || b.Prompt != "a fox" || b.FormatCode != "portrait" || b.Steps != 20 || b.Seed == nil || *b.Seed != 7 || b.Strength != 0.6 {
		t.Fatalf("body = %+v", b)
	}
	if string(be.gotSource) != "PNGDATA" {
		t.Fatalf("source = %q", be.gotSource)
	}
}

func TestLocalAPIGenerateErrors(t *testing.T) {
	be := &fakeGenBackend{}
	srv := newGenAPI(t, be)
	if code, m := call(t, srv, "POST", "/v1/generate", "secret", map[string]any{"prompt": "  "}); code != 400 || errCode(m) != CodeInvalidInput {
		t.Fatalf("empty prompt: %d %v", code, m)
	}
	be.err = &Error{Code: CodeModelNotCached, Field: "model", Message: "not downloaded"}
	if code, m := call(t, srv, "POST", "/v1/generate", "secret", map[string]any{"prompt": "x", "model": "flux"}); code != 400 || errCode(m) != CodeModelNotCached {
		t.Fatalf("not cached: %d %v", code, m)
	}
	be.err = &Error{Code: CodeEngineNotReady, Message: "not installed"}
	if code, m := call(t, srv, "POST", "/v1/generate", "secret", map[string]any{"prompt": "x"}); code != 503 || errCode(m) != CodeEngineNotReady {
		t.Fatalf("engine: %d %v", code, m)
	}
	// A backend without generation (older builds of the interface): 404.
	plain := newGenAPI(t, &fakeBackend{})
	if code, _ := call(t, plain, "POST", "/v1/generate", "secret", map[string]any{"prompt": "x"}); code != 404 {
		t.Fatalf("no generation backend: %d", code)
	}
}
