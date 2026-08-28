package modelfetch

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"imference-desktop-go/internal/logbus"
)

func blob(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(i * 31)
	}
	return b
}

func rangeServer(data []byte) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// application/octet-stream so the text/* guard in Probe/Fetch passes.
		w.Header().Set("Content-Type", "application/octet-stream")
		http.ServeContent(w, r, "", time.Unix(0, 0), bytes.NewReader(data))
	}))
}

func TestFetchRangedAssemblesTheFile(t *testing.T) {
	data := blob(1 << 20)
	srv := rangeServer(data)
	defer srv.Close()

	part := filepath.Join(t.TempDir(), "m.safetensors.part")
	var lastPct int
	err := New(logbus.New()).fetchRanged(context.Background(), srv.URL, part,
		int64(len(data)), func(p Progress) { lastPct = p.Percent })
	if err != nil {
		t.Fatalf("fetchRanged: %v", err)
	}
	got, err := os.ReadFile(part)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("reassembled bytes differ (err=%v)", err)
	}
	if lastPct != 100 {
		t.Fatalf("progress ended at %d%%", lastPct)
	}
}

func TestFetchRangedRejectsServersWithoutRanges(t *testing.T) {
	data := blob(4096)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(data)
	}))
	defer srv.Close()

	part := filepath.Join(t.TempDir(), "m.part")
	err := New(logbus.New()).fetchRanged(context.Background(), srv.URL, part, int64(len(data)), nil)
	if err == nil || !strings.Contains(err.Error(), "206") {
		t.Fatalf("want a no-206 error, got %v", err)
	}
	if _, statErr := os.Stat(part); !os.IsNotExist(statErr) {
		t.Fatal(".part must be removed after a failed ranged fetch")
	}
}

func TestFetchTakesTheRangedPathForBigFiles(t *testing.T) {
	// Exactly the threshold so the ranged branch triggers through the public
	// Fetch API (probe → ranged → rename).
	data := blob(rangedThreshold)
	srv := rangeServer(data)
	defer srv.Close()

	dest := filepath.Join(t.TempDir(), "model.safetensors")
	reused, err := New(logbus.New()).Fetch(context.Background(), srv.URL, dest, 1, nil)
	if err != nil || reused {
		t.Fatalf("Fetch: reused=%v err=%v", reused, err)
	}
	fi, err := os.Stat(dest)
	if err != nil || fi.Size() != int64(len(data)) {
		t.Fatalf("dest wrong (err=%v)", err)
	}
}
