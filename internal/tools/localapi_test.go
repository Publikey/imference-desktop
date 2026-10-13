package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"imference-desktop-go/internal/logbus"
)

type fakeBackend struct {
	local   map[string]bool
	gotTool string
	gotIn   map[string][]string
	gotPar  map[string]any
	inBytes map[string]string
	err     *Error
}

func (f *fakeBackend) LocalAvailable(id string) bool { return f.local[id] }

func (f *fakeBackend) RunLocal(_ context.Context, id string, in map[string][]string, params map[string]any) (*APIResult, *Error) {
	f.gotTool, f.gotIn, f.gotPar = id, in, params
	f.inBytes = map[string]string{}
	for k, ps := range in {
		for _, p := range ps {
			b, _ := os.ReadFile(p)
			f.inBytes[k] += string(b)
		}
	}
	if f.err != nil {
		return nil, f.err
	}
	return &APIResult{ToolID: id, DurationMs: 12, Outputs: []APIOutput{{Name: "image", Type: "image", Format: "png", Path: "/gallery/x.png"}}}, nil
}

func newTestAPI(t *testing.T, be *fakeBackend) (*APIServer, *httptest.Server) {
	t.Helper()
	cat, err := Builtin()
	if err != nil {
		t.Fatal(err)
	}
	s := &APIServer{Catalog: cat, Backend: be, Bus: logbus.New(), Token: "secret", AllowHTTP: true}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return s, srv
}

func call(t *testing.T, srv *httptest.Server, method, path, token string, body any) (int, map[string]any) {
	t.Helper()
	var rd *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, _ := http.NewRequest(method, srv.URL+path, rd)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func errCode(m map[string]any) string {
	e, _ := m["error"].(map[string]any)
	s, _ := e["code"].(string)
	return s
}

func TestLocalAPIAuth(t *testing.T) {
	_, srv := newTestAPI(t, &fakeBackend{})
	if code, _ := call(t, srv, "GET", "/v1/tools", "", nil); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	if code, _ := call(t, srv, "GET", "/v1/tools", "wrong", nil); code != 401 {
		t.Fatalf("wrong token: %d", code)
	}
	req, _ := http.NewRequest("GET", srv.URL+"/v1/tools", nil)
	req.Header.Set("Authorization", "Bearer secret")
	req.Header.Set("Origin", "https://evil.example")
	resp, _ := http.DefaultClient.Do(req)
	resp.Body.Close()
	if resp.StatusCode != 403 {
		t.Fatalf("browser origin: %d", resp.StatusCode)
	}
}

func TestLocalAPIListTools(t *testing.T) {
	_, srv := newTestAPI(t, &fakeBackend{local: map[string]bool{"resize": true}})
	code, m := call(t, srv, "GET", "/v1/tools", "secret", nil)
	if code != 200 {
		t.Fatalf("status %d", code)
	}
	list, _ := m["tools"].([]any)
	if len(list) < 10 {
		t.Fatalf("tools = %d", len(list))
	}
	seen := 0
	for _, it := range list {
		e := it.(map[string]any)
		switch e["id"] {
		case "resize":
			seen++
			if e["local_available"] != true || e["mcp_name"] == nil {
				t.Errorf("resize entry %v", e)
			}
		case "upscale":
			seen++
			if e["local_available"] != false {
				t.Errorf("upscale entry %v", e)
			}
		}
	}
	if seen != 2 {
		t.Fatal("resize/upscale missing")
	}
}

func TestLocalAPIRunWithPathURLAndDataURI(t *testing.T) {
	be := &fakeBackend{local: map[string]bool{"resize": true, "video-concat": true}}
	_, srv := newTestAPI(t, be)
	src := filepath.Join(t.TempDir(), "in.png")
	_ = os.WriteFile(src, []byte("FROMPATH"), 0o644)

	code, m := call(t, srv, "POST", "/v1/tools/resize", "secret", map[string]any{
		"inputs": map[string]any{"image": src}, "params": map[string]any{"width": 64},
	})
	if code != 200 || m["tool_id"] != "resize" {
		t.Fatalf("path run: %d %v", code, m)
	}
	if be.inBytes["image"] != "FROMPATH" || be.gotPar["width"] != float64(64) {
		t.Fatalf("backend got %v %v", be.inBytes, be.gotPar)
	}
	outs := m["outputs"].([]any)
	if outs[0].(map[string]any)["path"] != "/gallery/x.png" {
		t.Fatalf("outputs %v", outs)
	}

	data := "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("FROMDATA"))
	if code, m = call(t, srv, "POST", "/v1/tools/resize", "secret", map[string]any{"inputs": map[string]any{"image": data}}); code != 200 {
		t.Fatalf("data run: %d %v", code, m)
	}
	if be.inBytes["image"] != "FROMDATA" || !strings.HasSuffix(be.gotIn["image"][0], ".png") {
		t.Fatalf("data input: %v %v", be.inBytes, be.gotIn)
	}

	blob := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write([]byte("CLIP" + r.URL.Path))
	}))
	defer blob.Close()
	if code, m = call(t, srv, "POST", "/v1/tools/video-concat", "secret", map[string]any{
		"inputs": map[string]any{"videos": []string{blob.URL + "/a", blob.URL + "/b"}},
	}); code != 200 {
		t.Fatalf("url run: %d %v", code, m)
	}
	if be.inBytes["videos"] != "CLIP/aCLIP/b" || len(be.gotIn["videos"]) != 2 {
		t.Fatalf("url inputs: %v", be.inBytes)
	}
	// The temp copies are removed after the run.
	if _, err := os.Stat(be.gotIn["videos"][0]); !os.IsNotExist(err) {
		t.Errorf("temp input not cleaned up: %v", err)
	}
}

func TestLocalAPIErrors(t *testing.T) {
	be := &fakeBackend{local: map[string]bool{"resize": true, "upscale": true}}
	_, srv := newTestAPI(t, be)
	src := filepath.Join(t.TempDir(), "in.png")
	_ = os.WriteFile(src, []byte("x"), 0o644)

	cases := []struct {
		name   string
		path   string
		body   any
		status int
		code   string
	}{
		{"unknown tool", "/v1/tools/nope", map[string]any{}, 404, CodeInvalidInput},
		{"not local", "/v1/tools/describe", map[string]any{"inputs": map[string]any{"image": src}}, 503, CodeUnsupportedRuntime},
		{"unknown input", "/v1/tools/resize", map[string]any{"inputs": map[string]any{"zzz": src}}, 400, CodeInvalidInput},
		{"relative path", "/v1/tools/resize", map[string]any{"inputs": map[string]any{"image": "in.png"}}, 400, CodeInvalidInput},
		{"missing file", "/v1/tools/resize", map[string]any{"inputs": map[string]any{"image": filepath.Join(t.TempDir(), "nope.png")}}, 400, CodeInvalidInput},
		{"bad data uri", "/v1/tools/resize", map[string]any{"inputs": map[string]any{"image": "data:image/png,abc"}}, 400, CodeInvalidInput},
		{"bad json", "/v1/tools/resize", "not an object", 400, CodeInvalidInput},
	}
	for _, c := range cases {
		code, m := call(t, srv, "POST", c.path, "secret", c.body)
		if code != c.status || errCode(m) != c.code {
			t.Errorf("%s: %d %v, want %d %s", c.name, code, m, c.status, c.code)
		}
	}

	// Engine errors map to the documented statuses.
	for code, status := range map[string]int{CodeOOM: 503, CodeWeightsMissing: 503, CodeTooLarge: 400, CodeInternal: 500} {
		be.err = &Error{Code: code, Message: "x"}
		got, m := call(t, srv, "POST", "/v1/tools/upscale", "secret", map[string]any{"inputs": map[string]any{"image": src}})
		if got != status || errCode(m) != code {
			t.Errorf("engine %s: %d %v", code, got, m)
		}
	}
}

func TestLocalAPITooLarge(t *testing.T) {
	be := &fakeBackend{local: map[string]bool{"resize": true}}
	s, srv := newTestAPI(t, be)
	// Shrink resize's cap to 1 KB for the test.
	cat := *s.Catalog
	cat.Tools = append([]Tool(nil), s.Catalog.Tools...)
	i := cat.byID["resize"]
	cat.Tools[i].Inputs = []InputSpec{{Name: "image", Type: "image", Required: true, MaxMB: 1.0 / 1024}}
	s.Catalog = &cat
	big := "data:image/png;base64," + base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), 4096))
	code, m := call(t, srv, "POST", "/v1/tools/resize", "secret", map[string]any{"inputs": map[string]any{"image": big}})
	if code != 400 || errCode(m) != CodeTooLarge {
		t.Fatalf("got %d %v", code, m)
	}
}

func TestDiscoveryFileLifecycle(t *testing.T) {
	disc := filepath.Join(t.TempDir(), "imference-desktop-go", "local-api.json")
	cat, _ := Builtin()
	s := &APIServer{Catalog: cat, Backend: &fakeBackend{}, Bus: logbus.New()}
	port, err := s.Start(disc)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Stop()
	raw, err := os.ReadFile(disc)
	if err != nil {
		t.Fatal(err)
	}
	var d Discovery
	if err := json.Unmarshal(raw, &d); err != nil {
		t.Fatal(err)
	}
	if d.Port != port || d.PID != os.Getpid() || len(d.Token) != 64 || d.Token != s.Token {
		t.Fatalf("discovery = %+v (port %d)", d, port)
	}
	if runtime.GOOS != "windows" {
		st, _ := os.Stat(disc)
		if st.Mode().Perm() != 0o600 {
			t.Errorf("discovery mode = %v", st.Mode().Perm())
		}
	}
	// The server answers on that port with that token.
	req, _ := http.NewRequest("GET", "http://127.0.0.1:"+itoa(port)+"/v1/health", nil)
	req.Header.Set("Authorization", "Bearer "+d.Token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("health: %v %v", resp, err)
	}
	resp.Body.Close()

	s.Stop()
	if _, err := os.Stat(disc); !os.IsNotExist(err) {
		t.Fatalf("discovery file not removed: %v", err)
	}
}

func TestRemoveDiscoveryKeepsOtherInstance(t *testing.T) {
	disc := filepath.Join(t.TempDir(), "local-api.json")
	_ = WriteDiscovery(disc, Discovery{Port: 1, Token: "t", PID: os.Getpid() + 1})
	RemoveDiscovery(disc)
	if _, err := os.Stat(disc); err != nil {
		t.Fatal("another instance's file must be kept")
	}
}

func itoa(n int) string { return strconv.Itoa(n) }
