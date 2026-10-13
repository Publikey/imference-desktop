package cloud

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"imference-desktop-go/internal/logbus"
)

// A Bearer tool run: multipart upload (one part per input file + params JSON),
// 404 while pending, then data.Outputs downloaded into destDir.
func TestRunToolMultipartPollDownload(t *testing.T) {
	src := filepath.Join(t.TempDir(), "in.png")
	if err := os.WriteFile(src, []byte("PNGDATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	var polls atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/tools/upscale":
			if got := r.Header.Get("Authorization"); got != "Bearer key-1" {
				t.Errorf("auth header = %q", got)
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Errorf("multipart: %v", err)
			}
			fh := r.MultipartForm.File["image"]
			if len(fh) != 1 || fh[0].Filename != "in.png" {
				t.Errorf("image part = %+v", fh)
			} else {
				f, _ := fh[0].Open()
				b, _ := io.ReadAll(f)
				if string(b) != "PNGDATA" {
					t.Errorf("image bytes = %q", b)
				}
				if ct := fh[0].Header.Get("Content-Type"); ct != "image/png" {
					t.Errorf("image content-type = %q", ct)
				}
			}
			var params map[string]any
			if err := json.Unmarshal([]byte(r.FormValue("params")), &params); err != nil || params["scale"] != float64(2) {
				t.Errorf("params = %q (%v)", r.FormValue("params"), err)
			}
			_, _ = w.Write([]byte(`{"request_id":"req-9","kind":"tool","tool_id":"upscale","credits":4}`))
		case r.URL.Path == "/status":
			if r.URL.Query().Get("request_id") != "req-9" {
				t.Errorf("status request_id = %s", r.URL.RawQuery)
			}
			if polls.Add(1) < 2 {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(`{"error":"not ready"}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"RequestID":"req-9","Kind":"tool","URL":"` + srv.URL + `/blob/a.png",
				"Outputs":[{"url":"` + srv.URL + `/blob/a.png","name":"image","type":"image","format":"png","width":8,"height":8}]}}`))
		case r.URL.Path == "/blob/a.png":
			_, _ = w.Write([]byte("RESULT"))
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusTeapot)
		}
	}))
	defer srv.Close()

	c := New(logbus.New())
	c.base = srv.URL
	var stages []string
	var enq string
	dest := t.TempDir()
	res, err := c.RunTool(t.Context(), "credits", "key-1", nil, ToolRequest{
		ToolID: "upscale", Files: map[string][]string{"image": {src}}, Params: map[string]any{"scale": 2},
	}, dest, func(id string, _ float64) { enq = id }, func(s string) { stages = append(stages, s) })
	if err != nil {
		t.Fatal(err)
	}
	if enq != "req-9" || res.RequestID != "req-9" || res.Credits != 4 {
		t.Errorf("request id / credits: %q %+v", enq, res)
	}
	if len(res.Outputs) != 1 || res.Outputs[0].LocalPath == "" {
		t.Fatalf("outputs %+v", res.Outputs)
	}
	b, _ := os.ReadFile(res.Outputs[0].LocalPath)
	if string(b) != "RESULT" || filepath.Ext(res.Outputs[0].LocalPath) != ".png" {
		t.Errorf("downloaded %q to %s", b, res.Outputs[0].LocalPath)
	}
	if strings.Join(stages, ",") != "uploading,queued,downloading" {
		t.Errorf("stages = %v", stages)
	}
}

func TestRunToolTextAndFailure(t *testing.T) {
	src := filepath.Join(t.TempDir(), "in.jpg")
	_ = os.WriteFile(src, []byte("x"), 0o644)
	fail := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/tools/describe":
			_, _ = w.Write([]byte(`{"request_id":"r1","kind":"tool","credits":2}`))
		case "/status":
			if fail {
				w.WriteHeader(http.StatusUnprocessableEntity)
				_, _ = w.Write([]byte(`{"error":"out of memory","code":"oom"}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":{"Text":"a red square","Outputs":[{"url":"","name":"text","type":"text","format":"txt","text":"a red square"}]}}`))
		case "/tools/bad":
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"error":"unknown param 'zoom'","code":"invalid_input"}`))
		}
	}))
	defer srv.Close()
	c := New(logbus.New())
	c.base = srv.URL
	files := map[string][]string{"image": {src}}

	res, err := c.RunTool(t.Context(), "credits", "k", nil, ToolRequest{ToolID: "describe", Files: files}, t.TempDir(), nil, nil)
	if err != nil || res.Outputs[0].Text != "a red square" {
		t.Fatalf("describe: %+v %v", res, err)
	}

	fail = true
	_, err = c.RunTool(t.Context(), "credits", "k", nil, ToolRequest{ToolID: "describe", Files: files}, t.TempDir(), nil, nil)
	te, ok := err.(*ToolError)
	if !ok || te.Code != "oom" || !te.Terminal {
		t.Fatalf("422 oom: %#v", err)
	}

	_, err = c.RunTool(t.Context(), "credits", "k", nil, ToolRequest{ToolID: "bad", Files: files}, t.TempDir(), nil, nil)
	te, ok = err.(*ToolError)
	if !ok || te.Code != "invalid_input" || te.HTTP != 400 {
		t.Fatalf("400: %#v", err)
	}

	_, err = c.RunTool(t.Context(), "credits", "", nil, ToolRequest{ToolID: "describe", Files: files}, t.TempDir(), nil, nil)
	if te, ok = err.(*ToolError); !ok || !te.Terminal {
		t.Fatalf("no key: %#v", err)
	}
}

func TestBuildToolMultipartMultipleInputs(t *testing.T) {
	dir := t.TempDir()
	a, b := filepath.Join(dir, "a.mp4"), filepath.Join(dir, "b.mp4")
	_ = os.WriteFile(a, []byte("A"), 0o644)
	_ = os.WriteFile(b, []byte("B"), 0o644)
	body, ctype, err := buildToolMultipart(map[string][]string{"videos": {a, b}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(string(body)))
	r.Header.Set("Content-Type", ctype)
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		t.Fatal(err)
	}
	if n := len(r.MultipartForm.File["videos"]); n != 2 {
		t.Fatalf("videos parts = %d", n)
	}
	if r.FormValue("params") != "{}" {
		t.Fatalf("params = %q", r.FormValue("params"))
	}
}
