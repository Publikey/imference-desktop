package components

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"imference-desktop-go/internal/logbus"
)

func testManager() *Manager { return New(logbus.New()) }

// blob returns deterministic bytes so reassembly errors show up as mismatches.
func blob(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 31)
	}
	return b
}

// rangeServer serves files with full Range support (http.ServeContent).
func rangeServer(t *testing.T, files map[string][]byte) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ok := files[strings.TrimPrefix(r.URL.Path, "/")]
		if !ok {
			http.NotFound(w, r)
			return
		}
		http.ServeContent(w, r, "", time.Unix(0, 0), bytes.NewReader(data))
	}))
}

func TestFetchRangedAssemblesTheFile(t *testing.T) {
	data := blob(1 << 20) // 1 MB across 6 streams
	srv := rangeServer(t, map[string][]byte{"f.bin": data})
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "f.bin")
	var last int64
	err := testManager().fetchRanged(context.Background(), srv.URL+"/f.bin", dest,
		int64(len(data)), func(n int64) { last = n })
	if err != nil {
		t.Fatalf("fetchRanged: %v", err)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatal("reassembled bytes differ from source")
	}
	if last != int64(len(data)) {
		t.Fatalf("progress ended at %d, want %d", last, len(data))
	}
	if _, err := os.Stat(dest + ".part"); !os.IsNotExist(err) {
		t.Fatal(".part file left behind")
	}
}

func TestFetchRangedRejectsServersWithoutRanges(t *testing.T) {
	// Plain handler: ignores Range, always 200 with the full body.
	data := blob(4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(data)
	}))
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := testManager().fetchRanged(context.Background(), srv.URL+"/f.bin", dest,
		int64(len(data)), nil)
	if err == nil || !strings.Contains(err.Error(), "206") {
		t.Fatalf("want a no-206 error, got %v", err)
	}
	if _, statErr := os.Stat(dest); !os.IsNotExist(statErr) {
		t.Fatal("dest must not exist after a failed ranged fetch")
	}
}

func TestDownloadThenCheckRoundTrip(t *testing.T) {
	big := blob(200_000)
	files := map[string][]byte{
		"repo/x/.manifest.json": mustJSON(t, []string{"model_index.json", "sub/weights.bin"}),
		"repo/x/model_index.json": []byte(`{"ok":true}`),
		"repo/x/sub/weights.bin":  big,
	}
	srv := rangeServer(t, files)
	defer srv.Close()

	cache := t.TempDir()
	m := testManager()

	// Before: not ready, 2 files missing, sizes summed from HEAD.
	r := m.Check(context.Background(), srv.URL, cache, "repo/x")
	if !r.HasManifest || r.Ready || r.MissingFiles != 2 {
		t.Fatalf("pre-download readiness wrong: %+v", r)
	}
	if r.MissingBytes != int64(len(big)+len(files["repo/x/model_index.json"])) {
		t.Fatalf("missing bytes %d", r.MissingBytes)
	}

	var final Progress
	if err := m.Download(context.Background(), srv.URL, cache, "repo/x",
		func(p Progress) { final = p }); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if !final.Done || final.Percent != 100 {
		t.Fatalf("final progress: %+v", final)
	}
	// Files land at the engine's flat-tree layout + the marker is written.
	got, err := os.ReadFile(filepath.Join(cache, "repo", "x", "sub", "weights.bin"))
	if err != nil || !bytes.Equal(got, big) {
		t.Fatalf("weights content wrong (err=%v)", err)
	}
	if _, err := os.Stat(filepath.Join(cache, "repo", "x", markerName)); err != nil {
		t.Fatal("marker .cdn_complete not written")
	}

	// After: ready via the marker fast path (no network needed — dead server URL).
	r = m.Check(context.Background(), "http://127.0.0.1:1", cache, "repo/x")
	if !r.Ready {
		t.Fatalf("post-download readiness wrong: %+v", r)
	}
}

func TestCheckDoesNotGateWithoutManifest(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	r := testManager().Check(context.Background(), srv.URL, t.TempDir(), "repo/x")
	if r.HasManifest || !r.Ready {
		t.Fatalf("404 manifest must not gate: %+v", r)
	}
	// Empty repo (self-contained model) short-circuits to ready.
	r = testManager().Check(context.Background(), srv.URL, t.TempDir(), "")
	if !r.Ready {
		t.Fatalf("empty repo must be ready: %+v", r)
	}
}

func TestManifestPathEscapesAreDropped(t *testing.T) {
	srv := rangeServer(t, map[string][]byte{
		"repo/x/.manifest.json": mustJSON(t, []string{"../evil.bin", "/abs.bin", "ok.bin"}),
		"repo/x/ok.bin":         []byte("fine"),
	})
	defer srv.Close()
	cache := t.TempDir()
	if err := testManager().Download(context.Background(), srv.URL, cache, "repo/x", nil); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if _, err := os.Stat(filepath.Join(cache, "evil.bin")); !os.IsNotExist(err) {
		t.Fatal("path traversal escaped the repo dir")
	}
	if _, err := os.Stat(filepath.Join(cache, "repo", "x", "ok.bin")); err != nil {
		t.Fatal("legit file missing")
	}
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
