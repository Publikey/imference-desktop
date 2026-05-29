// Package modelfetch streams large model weight files (SDXL .safetensors,
// ~6.9 GB) from a URL to disk, with progress reporting and reuse detection.
// Kept separate from internal/installer (which is all pip/venv) because this
// is a plain large HTTP GET with different failure modes and no Python.
//
// The download is atomic: bytes land in a sibling ".part" file and are
// renamed onto destPath only after a complete, error-free transfer — a
// half-finished download (app quit, network drop) never masquerades as a
// valid model on the next launch.
package modelfetch

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"imference-desktop-go/internal/logbus"
)

// Progress is reported during a transfer. Total is -1 when the server didn't
// send a Content-Length (Percent stays 0 → the UI shows an indeterminate bar).
type Progress struct {
	Downloaded int64
	Total      int64
	Percent    int
}

type Fetcher struct {
	bus  *logbus.Bus
	http *http.Client
}

// New builds a Fetcher with a client that has NO overall timeout — a 7 GB
// download on a slow link can take many minutes, so cancellation is driven
// purely by the caller's context.
func New(bus *logbus.Bus) *Fetcher {
	return &Fetcher{bus: bus, http: &http.Client{}}
}

// Fetch downloads url to destPath. If destPath already exists with a size
// >= minBytes it's considered complete and reused (returns reused=true with
// no download) — this makes a Reinstall a fast no-op instead of re-pulling
// gigabytes. onProgress may be nil; when set it's called throttled (only on
// whole-percent changes, plus once at the end).
func (f *Fetcher) Fetch(
	ctx context.Context,
	url, destPath string,
	minBytes int64,
	onProgress func(Progress),
) (reused bool, err error) {
	if fi, statErr := os.Stat(destPath); statErr == nil && fi.Size() >= minBytes {
		f.bus.Info("modelfetch", "reusing existing model file", map[string]any{
			"path":  destPath,
			"bytes": fi.Size(),
		})
		return true, nil
	}

	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return false, fmt.Errorf("modelfetch: mkdir %s: %w", filepath.Dir(destPath), err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return false, fmt.Errorf("modelfetch: build request: %w", err)
	}
	req.Header.Set("User-Agent", "imference-desktop-go/0.0.1")

	f.bus.Info("modelfetch", "GET "+url, nil)
	resp, err := f.http.Do(req)
	if err != nil {
		return false, fmt.Errorf("modelfetch: GET %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, fmt.Errorf("modelfetch: HTTP %d fetching model: %s", resp.StatusCode, string(snippet))
	}

	// Guard against a 200 that's actually an HTML error/login page rather than a
	// model. Real .safetensors come back as octet-stream (or no content-type);
	// a text/* body means we'd otherwise save a few KB of HTML over the model.
	if ct := resp.Header.Get("Content-Type"); strings.HasPrefix(ct, "text/") {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return false, fmt.Errorf("modelfetch: expected a model file but server returned Content-Type %q (not a .safetensors). Body: %s", ct, string(snippet))
	}

	partPath := destPath + ".part"
	out, err := os.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return false, fmt.Errorf("modelfetch: create %s: %w", partPath, err)
	}

	pw := &progressWriter{total: resp.ContentLength, onProgress: onProgress, lastPct: -1}
	_, copyErr := io.Copy(io.MultiWriter(out, pw), resp.Body)
	closeErr := out.Close()

	if copyErr != nil {
		_ = os.Remove(partPath) // don't leave a partial file behind
		// A cancelled context surfaces here as context.Canceled — propagate it
		// cleanly so the caller can distinguish "user aborted" from "failed".
		return false, fmt.Errorf("modelfetch: download: %w", copyErr)
	}
	if closeErr != nil {
		_ = os.Remove(partPath)
		return false, fmt.Errorf("modelfetch: close %s: %w", partPath, closeErr)
	}

	// Completeness: if the server advertised a length, the body must match it.
	// io.Copy returns nil on a clean EOF even if the peer closed early, so this
	// is what actually catches a truncated-but-graceful transfer. ContentLength
	// is -1 for chunked/unknown — skip the check then.
	if resp.ContentLength > 0 && pw.downloaded != resp.ContentLength {
		_ = os.Remove(partPath)
		return false, fmt.Errorf("modelfetch: incomplete download — got %d of %d bytes", pw.downloaded, resp.ContentLength)
	}

	if err := os.Rename(partPath, destPath); err != nil {
		_ = os.Remove(partPath)
		return false, fmt.Errorf("modelfetch: finalize %s: %w", destPath, err)
	}

	f.bus.Info("modelfetch", "model downloaded", map[string]any{
		"path":  destPath,
		"bytes": pw.downloaded,
	})
	return false, nil
}

// progressWriter counts bytes flowing through io.Copy and fires onProgress on
// each whole-percent increment, keeping event volume sane on a multi-GB pull.
type progressWriter struct {
	total      int64
	downloaded int64
	lastPct    int
	onProgress func(Progress)
}

func (w *progressWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.downloaded += int64(n)
	if w.onProgress == nil {
		return n, nil
	}
	pct := 0
	if w.total > 0 {
		pct = min(int((w.downloaded*100)/w.total), 100)
	}
	if pct != w.lastPct {
		w.lastPct = pct
		w.onProgress(Progress{Downloaded: w.downloaded, Total: w.total, Percent: pct})
	}
	return n, nil
}
