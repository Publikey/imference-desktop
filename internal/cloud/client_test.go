package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

// A transient failure (503) on the first attempts should be retried until the
// blob download succeeds — the slow-uplink case that dropped a valid image.
func TestDownloadWithRetry_RetriesTransientThenSucceeds(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&calls, 1) < 3 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("slow down"))
			return
		}
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write([]byte("PNGDATA"))
	}))
	defer srv.Close()

	c := New(logbus.New())
	b64, mime, err := c.downloadWithRetry(context.Background(), srv.URL)
	if err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 attempts, got %d", got)
	}
	if mime != "image/png" || b64 == "" {
		t.Fatalf("bad result: mime=%q b64len=%d", mime, len(b64))
	}
}

// The cloud POST body must carry the format the user picked — format_code is
// what the server resolves to dimensions and prices (credit_multiplier), and
// duration_s is the billed clip length. Width/Height ride along for API builds
// that predate format resolution. These fields existed on postBody but were
// silently dropped here: the user paid for the format and got the default one.
func TestPostGenerate_SendsFormatCodeAndDuration(t *testing.T) {
	var got postBody
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/generate" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Errorf("bad body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"request_id":"r1","kind":"image"}`))
	}))
	defer srv.Close()

	c := New(logbus.New())
	c.base = srv.URL
	req := types.GenerationRequest{
		Prompt:     "a lighthouse",
		Width:      1344,
		Height:     768,
		FormatCode: "landscape-wide",
		DurationS:  10,
	}
	requestID, kind, err := c.postGenerate(context.Background(), "key", "z-image-turbo", req)
	if err != nil {
		t.Fatalf("postGenerate: %v", err)
	}
	if requestID != "r1" || kind != "image" {
		t.Fatalf("bad response: id=%q kind=%q", requestID, kind)
	}
	if got.FormatCode != "landscape-wide" {
		t.Errorf("format_code = %q, want landscape-wide", got.FormatCode)
	}
	if got.DurationS != 10 {
		t.Errorf("duration_s = %v, want 10", got.DurationS)
	}
	if got.Width != 1344 || got.Height != 768 {
		t.Errorf("dims = %dx%d, want 1344x768", got.Width, got.Height)
	}
}

// A permanent failure (404 — blob missing) must fail fast without burning the
// retry budget.
func TestDownloadWithRetry_PermanentFailsFast(t *testing.T) {
	var calls int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("BlobNotFound"))
	}))
	defer srv.Close()

	c := New(logbus.New())
	if _, _, err := c.downloadWithRetry(context.Background(), srv.URL); err == nil {
		t.Fatal("expected error for 404")
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Fatalf("404 must not retry; got %d attempts", got)
	}
}
