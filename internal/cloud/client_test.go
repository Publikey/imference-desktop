package cloud

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"imference-desktop-go/internal/logbus"
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
