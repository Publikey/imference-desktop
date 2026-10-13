//go:build web

package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"imference-desktop-go/internal/types"
)

// mockAPI is a minimal imference.com: generate -> status -> blob.
func mockAPI(t *testing.T) (*httptest.Server, *atomic.Value) {
	t.Helper()
	var lastGen atomic.Value
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/generate":
			b, _ := io.ReadAll(r.Body)
			lastGen.Store(r.Header.Get("Authorization") + " " + string(b))
			_, _ = w.Write([]byte(`{"request_id":"req-1","kind":"image"}`))
		case r.URL.Path == "/status":
			_, _ = w.Write([]byte(`{"data":{"RequestID":"req-1","Kind":"image","URL":"` + srv.URL + `/blob/req-1.png","Format":"png","Seed":42}}`))
		case strings.HasPrefix(r.URL.Path, "/blob/"):
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(tinyPNG())
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &lastGen
}

func tinyPNG() []byte {
	// 1x1 transparent PNG
	b, _ := hexDecode("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
		"1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082")
	return b
}

func hexDecode(s string) ([]byte, error) {
	out := make([]byte, len(s)/2)
	for i := range out {
		var v byte
		for j := 0; j < 2; j++ {
			c := s[2*i+j]
			switch {
			case c >= '0' && c <= '9':
				v = v<<4 | (c - '0')
			case c >= 'a' && c <= 'f':
				v = v<<4 | (c - 'a' + 10)
			}
		}
		out[i] = v
	}
	return out, nil
}

type client struct {
	t    *testing.T
	base string
	hc   *http.Client
}

func newClient(t *testing.T, base string) *client {
	jar, _ := cookiejar.New(nil)
	return &client{t: t, base: base, hc: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}}
}

func (c *client) post(path string, body any, csrf bool) (int, map[string]any) {
	c.t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, c.base+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if csrf {
		req.Header.Set(csrfHeader, "1")
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		c.t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	return resp.StatusCode, m
}

func (c *client) call(name string, args ...any) (int, map[string]any) {
	c.t.Helper()
	if args == nil {
		args = []any{}
	}
	return c.post("/web/call", map[string]any{"methodName": "main.App." + name, "args": args}, true)
}

// startServer keeps the gallery on the server (the original prototype mode);
// startClientGallery runs the default web mode (gallery on the user's disk).
func startServer(t *testing.T, apiBase string) (*webServer, *httptest.Server) {
	return startServerWith(t, apiBase, "", true)
}

func startServerAt(t *testing.T, apiBase, basePath string) (*webServer, *httptest.Server) {
	return startServerWith(t, apiBase, basePath, true)
}

func startClientGallery(t *testing.T, apiBase string) (*webServer, *httptest.Server) {
	return startServerWith(t, apiBase, "", false)
}

func startServerWith(t *testing.T, apiBase, basePath string, serverGallery bool) (*webServer, *httptest.Server) {
	t.Helper()
	assets := fstest.MapFS{"index.html": {Data: []byte("<!doctype html><title>app</title>")}}
	srv := newWebServer(webConfig{
		basePath: basePath, dataDir: t.TempDir(), apiBase: apiBase, idleAfter: time.Minute, serverGallery: serverGallery,
		checkKey: func(_ context.Context, key string) error {
			if strings.HasPrefix(key, "good") {
				return nil
			}
			return errors.New("unknown API key")
		},
	}, assets)
	hs := httptest.NewServer(srv.routes())
	t.Cleanup(hs.Close)
	return srv, hs
}

// The web runtime sends Wails' numeric binding IDs: they must map to the same
// methods the generated bindings name.
func TestBindingIDsMatchGeneratedBindings(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("frontend", "bindings", "imference-desktop-go", "app.ts"))
	if err != nil {
		t.Skip("generated bindings not present")
	}
	re := regexp.MustCompile(`export function (\w+)\([^)]*\)[^{]*\{\s*return \$Call\.ByID\((\d+)`)
	tbl := newRPCTable()
	n := 0
	for _, m := range re.FindAllStringSubmatch(string(src), -1) {
		var id uint32
		for _, c := range m[2] {
			id = id*10 + uint32(c-'0')
		}
		got, ok := tbl.byID[id]
		if !ok || got.name != m[1] {
			t.Fatalf("binding %s id %d resolves to %v", m[1], id, got)
		}
		n++
	}
	if n < 40 {
		t.Fatalf("only %d bindings parsed", n)
	}
	for _, set := range []map[string]bool{webAllow, webStub} {
		for name := range set {
			if _, ok := tbl.byName["main.App."+name]; !ok {
				t.Errorf("policy lists unknown method %s", name)
			}
		}
	}
	for name := range webCustom {
		if _, ok := tbl.byName["main.App."+name]; !ok {
			t.Errorf("custom handler for unknown method %s", name)
		}
	}
}

func TestLoginCSRFAndShell(t *testing.T) {
	_, hs := startServer(t, "")
	c := newClient(t, hs.URL)
	// App shell requires a session.
	resp, _ := c.hc.Get(hs.URL + "/")
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/login" {
		t.Fatalf("shell without session: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if code, _ := c.post("/web/login", map[string]string{"apiKey": "good-1"}, false); code != http.StatusForbidden {
		t.Fatalf("login without CSRF header: %d", code)
	}
	if code, _ := c.post("/web/login", map[string]string{"apiKey": "bad"}, true); code != http.StatusUnauthorized {
		t.Fatalf("bad key: %d", code)
	}
	if code, _ := c.call("GetSettings"); code != http.StatusUnauthorized {
		t.Fatalf("call before login: %d", code)
	}
	if code, _ := c.post("/web/login", map[string]string{"apiKey": "good-1"}, true); code != http.StatusOK {
		t.Fatalf("login: %d", code)
	}
	resp, _ = c.hc.Get(hs.URL + "/")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("shell with session: %d", resp.StatusCode)
	}
	if code, _ := c.post("/web/call", map[string]any{"methodName": "main.App.GetVersion", "args": []any{}}, false); code != http.StatusForbidden {
		t.Fatalf("call without CSRF header: %d", code)
	}
	if code, _ := c.post("/web/logout", nil, true); code != http.StatusOK {
		t.Fatal("logout")
	}
	if code, _ := c.call("GetSettings"); code != http.StatusUnauthorized {
		t.Fatalf("call after logout: %d", code)
	}
}

func TestPolicyAndSettingsSanitizing(t *testing.T) {
	_, hs := startServer(t, "")
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)

	code, m := c.call("GetSettings")
	s := m["result"].(map[string]any)
	if code != 200 || s["apiKey"] != "good-1" || s["paymentMode"] != "credits" || s["outputDir"] != "" {
		t.Fatalf("GetSettings: %d %v", code, s)
	}
	// Local engine and wallet methods are refused; status reads are stubbed.
	for _, name := range []string{"InstallEngine", "StartSidecar", "GenerateLocal", "PickModelFile", "ExportWalletPrivateKey",
		"GenerateWallet", "RevealInFolder", "OpenCacheFolder", "AddLora", "UseCustomModel"} {
		if code, m := c.call(name); code != http.StatusNotImplemented {
			t.Errorf("%s: %d %v", name, code, m)
		}
	}
	if code, m := c.call("GetEngineInfo"); code != 200 || m["result"] == nil {
		t.Fatalf("GetEngineInfo stub: %d %v", code, m)
	}
	if code, m := c.call("ListLocalModels"); code != 200 || m["result"] == nil {
		t.Fatalf("ListLocalModels stub must be [] not null: %d %v", code, m)
	}
	// Only cloud choices are writable.
	code, m = c.call("SaveSettings", map[string]any{"apiKey": "other", "pythonPath": "/usr/bin/python3",
		"outputDir": "/etc", "paymentMode": "x402", "cloudModel": "flux-dev"})
	s = m["result"].(map[string]any)
	if code != 200 || s["cloudModel"] != "flux-dev" || s["apiKey"] != "good-1" || s["pythonPath"] != "" ||
		s["outputDir"] != "" || s["paymentMode"] != "credits" {
		t.Fatalf("SaveSettings: %d %v", code, s)
	}
	// Tools never run locally and never take server paths.
	code, m = c.call("RunTool", map[string]any{"toolId": "resize", "inputs": map[string]any{"image": []string{"/etc/passwd"}},
		"params": map[string]any{"width": 10}})
	res := m["result"].(map[string]any)
	if code != 200 || res["error"] == nil || !strings.Contains(res["error"].(map[string]any)["message"].(string), "file paths") {
		t.Fatalf("RunTool with a path: %d %v", code, m)
	}
	if code, _ := c.post("/web/call", map[string]any{"methodName": "main.App.NoSuch", "args": []any{}}, true); code != http.StatusNotFound {
		t.Fatalf("unknown method: %d", code)
	}
}

func TestUsersAreIsolated(t *testing.T) {
	srv, hs := startServer(t, "")
	a, b := newClient(t, hs.URL), newClient(t, hs.URL)
	a.post("/web/login", map[string]string{"apiKey": "good-A"}, true)
	b.post("/web/login", map[string]string{"apiKey": "good-B"}, true)
	ua, _ := srv.ensureUser("good-A")
	ub, _ := srv.ensureUser("good-B")
	if ua == ub || ua.app.outputDir() == ub.app.outputDir() {
		t.Fatal("users share an App or a gallery")
	}
	// A file in A's gallery is invisible to B.
	if err := os.WriteFile(filepath.Join(ua.app.outputDir(), "20260101-000000_cloud_1.png"), tinyPNG(), 0o600); err != nil {
		t.Fatal(err)
	}
	_, ma := a.call("ListSavedImages", 0, 50, map[string]any{})
	_, mb := b.call("ListSavedImages", 0, 50, map[string]any{})
	if len(ma["result"].([]any)) != 1 || len(mb["result"].([]any)) != 0 {
		t.Fatalf("galleries: A=%v B=%v", ma["result"], mb["result"])
	}
	// Two tabs of the same user share one App.
	a2 := newClient(t, hs.URL)
	a2.post("/web/login", map[string]string{"apiKey": "good-A"}, true)
	if len(srv.users) != 2 {
		t.Fatalf("users = %d", len(srv.users))
	}
}

func TestEventsStream(t *testing.T) {
	srv, hs := startServer(t, "")
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	req, _ := http.NewRequest(http.MethodGet, hs.URL+"/web/events", nil)
	resp, err := c.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rd := bufio.NewReader(resp.Body)
	_, _ = rd.ReadString('\n') // ": connected"
	u, _ := srv.ensureUser("good-1")
	deadline := time.Now().Add(2 * time.Second)
	for {
		u.mu.Lock()
		n := len(u.subs)
		u.mu.Unlock()
		if n > 0 || time.Now().After(deadline) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	u.app.emit("generate:progress", map[string]any{"step": 3, "total": 8})
	for {
		line, err := rd.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasPrefix(line, "data: ") {
			var ev map[string]any
			_ = json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev)
			if ev["name"] != "generate:progress" || ev["data"].(map[string]any)["step"] != float64(3) {
				t.Fatalf("event: %v", ev)
			}
			return
		}
	}
}

// End to end: the browser's GenerateCloud call runs the real Go cloud client
// against the (mock) imference API and lands in the user's gallery.
func TestGenerateCloudEndToEnd(t *testing.T) {
	api, lastGen := mockAPI(t)
	_, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "a red fox", "width": 512, "height": 512})
	if code != 200 {
		t.Fatalf("GenerateCloud: %d %v", code, m)
	}
	if g, _ := lastGen.Load().(string); !strings.HasPrefix(g, "Bearer good-1 ") || !strings.Contains(g, "a red fox") {
		t.Fatalf("API did not get the session key / prompt: %q", g)
	}
	_, list := c.call("ListSavedImages", 0, 50, map[string]any{})
	if items, _ := list["result"].([]any); len(items) != 1 {
		t.Fatalf("gallery after generate: %v (generate result %v)", list["result"], m["result"])
	}
}

func TestEvictIdle(t *testing.T) {
	srv, hs := startServer(t, "")
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	srv.evictIdle(time.Now().Add(2 * time.Minute))
	if len(srv.users) != 0 || len(srv.sessions) != 0 {
		t.Fatal("idle user not evicted")
	}
	if code, _ := c.call("GetSettings"); code != http.StatusUnauthorized {
		t.Fatalf("evicted session still valid: %d", code)
	}
}


// Behind the API's /app proxy: everything lives under the prefix, and the
// session cookie is scoped to it.
func TestBasePath(t *testing.T) {
	_, hs := startServerAt(t, "", "/app")
	c := newClient(t, hs.URL+"/app")
	resp, _ := c.hc.Get(hs.URL + "/app")
	if resp.StatusCode != http.StatusMovedPermanently || resp.Header.Get("Location") != "/app/" {
		t.Fatalf("/app: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	resp, _ = c.hc.Get(hs.URL + "/app/")
	if resp.StatusCode != http.StatusFound || resp.Header.Get("Location") != "/app/login" {
		t.Fatalf("/app/ without session: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}
	if resp, _ := c.hc.Get(hs.URL + "/app/login"); resp.StatusCode != http.StatusOK {
		t.Fatalf("/app/login: %d", resp.StatusCode)
	}
	req, _ := http.NewRequest(http.MethodPost, hs.URL+"/app/web/login", strings.NewReader(`{"apiKey":"good-1"}`))
	req.Header.Set(csrfHeader, "1")
	resp, err := c.hc.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("login under /app: %v %v", err, resp)
	}
	if ck := resp.Cookies(); len(ck) != 1 || ck[0].Path != "/app/" {
		t.Fatalf("cookie path: %+v", ck)
	}
	if code, m := c.call("GetVersion"); code != http.StatusOK {
		t.Fatalf("call under /app: %d %v", code, m)
	}
	if resp, _ := c.hc.Get(hs.URL + "/web/call"); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("routes leak outside the prefix: %d", resp.StatusCode)
	}
}


// Client gallery (default web mode): the server returns the image and its
// metadata, writes nothing, and tells the browser which mode it runs.
func TestClientGalleryGenerateReturnsImageAndWritesNothing(t *testing.T) {
	api, _ := mockAPI(t)
	srv, hs := startClientGallery(t, api.URL)
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	if _, m := c.post("/web/call", map[string]any{"methodName": "web.GetConfig", "args": []any{}}, true); m["result"].(map[string]any)["gallery"] != "client" {
		t.Fatalf("GetConfig: %v", m)
	}
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "a red fox", "width": 512, "height": 512})
	res := m["result"].(map[string]any)
	if code != 200 || !strings.HasPrefix(res["imageBase64"].(string), "data:image/png;base64,") || res["savedPath"] != "" {
		t.Fatalf("GenerateCloud: %d %v", code, res)
	}
	meta := res["meta"].(map[string]any)
	if meta["prompt"] != "a red fox" || meta["source"] != "cloud" || meta["createdAt"] == "" {
		t.Fatalf("meta: %v", meta)
	}
	u, _ := srv.ensureUser("good-1")
	if entries, _ := os.ReadDir(u.app.outputDir()); len(entries) != 0 {
		t.Fatalf("server wrote %d gallery files", len(entries))
	}
}

func TestClientGalleryOutbox(t *testing.T) {
	srv, hs := startClientGallery(t, "")
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	u, _ := srv.ensureUser("good-1")
	u.app.outboxAdd("job-1", types.GenerationResult{ImageBase64: "data:image/png;base64,AAAA", Seed: 7, Source: "cloud",
		Meta: &types.GenerationMeta{Prompt: "p"}})
	u.app.outboxAdd("job-2", types.GenerationResult{ImageBase64: "data:image/png;base64,BBBB", Seed: 8, Source: "cloud"})
	_, m := c.call("TakeClientGalleryOutbox")
	items := m["result"].([]any)
	if len(items) != 2 || items[0].(map[string]any)["jobId"] != "job-1" {
		t.Fatalf("outbox: %v", m)
	}
	if _, m = c.call("TakeClientGalleryOutbox"); len(m["result"].([]any)) != 0 {
		t.Fatalf("outbox not cleared: %v", m)
	}
	// Survives a restart of the App (persisted next to the user's settings).
	u.app.outboxAdd("job-3", types.GenerationResult{ImageBase64: "data:image/png;base64,CCCC"})
	again := newApp(appOptions{configDir: filepath.Dir(u.app.outboxPath), cloudOnly: true, clientGallery: true})
	if got := again.TakeClientGalleryOutbox(); len(got) != 1 || got[0].JobID != "job-3" {
		t.Fatalf("persisted outbox: %v", got)
	}
}

// A cloud tool run in client-gallery mode hands the output back (data URL +
// metadata, with the source image's metadata sent by the browser) and saves
// nothing on the server.
func TestClientGalleryToolOutputsReturned(t *testing.T) {
	var srvURL string
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tools/upscale":
			_, _ = w.Write([]byte(`{"request_id":"t1","kind":"tool","credits":4}`))
		case "/status":
			_, _ = w.Write([]byte(`{"data":{"Outputs":[{"url":"` + srvURL + `/blob/o.png","name":"image","type":"image","format":"png","seed":0,"width":2,"height":2}]}}`))
		case "/blob/o.png":
			_, _ = w.Write(tinyPNG())
		default:
			http.NotFound(w, r)
		}
	}))
	defer api.Close()
	srvURL = api.URL
	srv, hs := startClientGallery(t, api.URL)
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	src := "data:image/png;base64," + base64.StdEncoding.EncodeToString(tinyPNG())
	code, m := c.call("RunTool", map[string]any{"toolId": "upscale", "inputs": map[string]any{"image": []string{src}},
		"params": map[string]any{"scale": 2}, "sourceMeta": map[string]any{"prompt": "original prompt", "modelCode": "flux-dev"}})
	res := m["result"].(map[string]any)
	if code != 200 || res["error"] != nil {
		t.Fatalf("RunTool: %d %v", code, m)
	}
	out := res["outputs"].([]any)[0].(map[string]any)
	if !strings.HasPrefix(out["dataUrl"].(string), "data:image/png;base64,") || out["savedName"] != nil {
		t.Fatalf("output: %v", out)
	}
	meta := out["meta"].(map[string]any)
	if meta["tool"] != "upscale" || meta["source"] != "tool" || meta["prompt"] != "original prompt" {
		t.Fatalf("output meta: %v", meta)
	}
	u, _ := srv.ensureUser("good-1")
	if entries, _ := os.ReadDir(u.app.outputDir()); len(entries) != 0 {
		t.Fatalf("server wrote %d gallery files", len(entries))
	}
}
