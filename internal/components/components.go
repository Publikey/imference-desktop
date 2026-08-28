// Package components checks and downloads a model's SHARED BASE COMPONENTS
// (text encoder(s), VAE, tokenizer, scheduler configs) from the R2/CDN mirror
// into the engine's flat offline tree — BEFORE a generation ever starts.
//
// Why: transformer-only checkpoints (Z-Image, FLUX, Chroma, Qwen-Image,
// Krea 2) need a multi-GB base repo the engine pulls lazily on the FIRST
// generation. Without this package that download hides behind a "generating"
// status for minutes. The UI uses Check to gate the Generate button and
// Download (with per-file progress) behind an explicit
// "download components" button.
//
// Contract mirrored from the engine (imference_engine/runtime/offline.py —
// keep in sync):
//
//   - manifest:  <cdnBase>/<repo>/.manifest.json — a JSON list of
//     repo-relative forward-slash file paths (no sizes; sizes come from HEAD).
//   - files:     <cdnBase>/<repo>/<rel>  →  <cacheDir>/<repo>/<rel>
//   - marker:    <cacheDir>/<repo>/.cdn_complete — empty file written ONLY
//     after every manifest file landed. It is the engine's own skip condition,
//     so writing it here makes the engine's cold load a pure cache hit.
//
// The engine keeps its own lazy download path as a safety net: a wrong verdict
// here degrades to the old behavior, never to a broken load.
package components

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
)

const (
	manifestName = ".manifest.json"
	markerName   = ".cdn_complete"
	userAgent    = "imference-desktop-go"
	probeTimeout = 15 * time.Second

	// Files at/above this size download as PARALLEL RANGE REQUESTS (the same
	// idea as the engine's download_parallel "[N streams]") — a single HTTP
	// connection to the CDN often caps well below link speed. Below it (configs,
	// tokenizers) the setup overhead isn't worth it.
	multipartThreshold = 64 << 20 // 64 MB
	multipartStreams   = 6
)

// Readiness is the answer to "can this model generate right now without a
// hidden multi-GB download?".
type Readiness struct {
	BaseRepo string `json:"baseRepo"`
	// HasManifest=false means the check COULDN'T run (no base repo, CDN
	// disabled, repo not mirrored). The caller must NOT gate generation then —
	// the engine's lazy path still works, it's just slower on first run.
	HasManifest  bool  `json:"hasManifest"`
	Ready        bool  `json:"ready"`
	TotalFiles   int   `json:"totalFiles"`
	MissingFiles int   `json:"missingFiles"`
	// Sum of the missing files' sizes (HEAD Content-Length); best-effort — a
	// file whose size can't be probed contributes 0, so treat this as "at
	// least" for display.
	MissingBytes int64 `json:"missingBytes"`
}

// Progress is emitted during Download — per-file byte progress plus overall
// position, shaped for a single progress bar with a caption.
type Progress struct {
	BaseRepo   string `json:"baseRepo"`
	File       string `json:"file"`
	FileIndex  int    `json:"fileIndex"`  // 1-based among the files being downloaded
	TotalFiles int    `json:"totalFiles"` // files being downloaded (missing only)
	// Bytes downloaded so far across all files this run / total expected.
	DoneBytes  int64 `json:"doneBytes"`
	TotalBytes int64 `json:"totalBytes"` // -1 when any size was unknown
	Percent    int   `json:"percent"`    // 0 when TotalBytes unknown
	Done       bool  `json:"done"`       // final event of a successful run
}

type Manager struct {
	bus  *logbus.Bus
	http *http.Client
}

func New(bus *logbus.Bus) *Manager {
	// No overall client timeout — multi-GB pulls are cancelled via ctx.
	return &Manager{bus: bus, http: &http.Client{}}
}

// repoDir is the flat-tree location for a repo. The desktop always launches
// the sidecar with IMAGE_MODEL_CACHE=<cacheDir>, and the engine's flat_root
// returns cache_dir verbatim when set — so the layout is <cacheDir>/<repo>/<rel>.
func repoDir(cacheDir, repo string) string {
	return filepath.Join(cacheDir, filepath.FromSlash(repo))
}

// Check reports whether repo's base components are fully present in the local
// tree. Never gates on failure: any error path degrades to HasManifest=false.
func (m *Manager) Check(ctx context.Context, cdnBase, cacheDir, repo string) Readiness {
	r := Readiness{BaseRepo: repo}
	if strings.TrimSpace(repo) == "" || strings.TrimSpace(cdnBase) == "" || strings.TrimSpace(cacheDir) == "" {
		// Self-contained model (SDXL/SD1.5), or CDN/cache disabled → nothing to
		// check; the ready=true default keeps Generate available.
		r.Ready = true
		return r
	}
	dir := repoDir(cacheDir, repo)

	// Fast path: the engine's own completion marker — written by its
	// _cdn_snapshot AND by our Download — means the tree is complete.
	if _, err := os.Stat(filepath.Join(dir, markerName)); err == nil {
		r.HasManifest = true
		r.Ready = true
		return r
	}

	files, err := m.fetchManifest(ctx, cdnBase, repo)
	if err != nil {
		m.bus.Warn("components", "manifest unavailable — not gating generation", map[string]any{
			"repo": repo, "err": err.Error(),
		})
		r.Ready = true // can't know → don't block (engine lazy path still works)
		return r
	}
	r.HasManifest = true
	r.TotalFiles = len(files)

	base := strings.TrimRight(cdnBase, "/") + "/" + repo
	var missing []string
	for _, rel := range files {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
			continue // engine semantics: an existing file is complete
		}
		missing = append(missing, rel)
	}
	r.MissingFiles = len(missing)
	// Size probes run in parallel (bounded): a repo has ~10-15 files and the
	// sequential HEADs made the UI's readiness verdict visibly late.
	sizes := make([]int64, len(missing))
	sem := make(chan struct{}, 8)
	var wg sync.WaitGroup
	for i, rel := range missing {
		wg.Add(1)
		go func(i int, rel string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			sizes[i] = m.probeSize(ctx, base+"/"+rel)
		}(i, rel)
	}
	wg.Wait()
	for _, s := range sizes {
		if s > 0 {
			r.MissingBytes += s
		}
	}
	r.Ready = r.MissingFiles == 0
	return r
}

// Download pulls every missing manifest file into the local tree and writes
// the engine's completion marker. Idempotent and resumable: present files are
// skipped, a cancelled run leaves no partial files (atomic .part + rename) and
// no marker, so the next run finishes the tree.
func (m *Manager) Download(
	ctx context.Context, cdnBase, cacheDir, repo string, onProgress func(Progress),
) error {
	if strings.TrimSpace(repo) == "" || strings.TrimSpace(cdnBase) == "" || strings.TrimSpace(cacheDir) == "" {
		return fmt.Errorf("components: nothing to download (repo/cdn/cache unset)")
	}
	dir := repoDir(cacheDir, repo)
	files, err := m.fetchManifest(ctx, cdnBase, repo)
	if err != nil {
		return fmt.Errorf("components: manifest for %s: %w", repo, err)
	}
	base := strings.TrimRight(cdnBase, "/") + "/" + repo

	// Missing files + total size first, so the progress bar has a denominator.
	type item struct {
		rel  string
		size int64
	}
	var todo []item
	var totalBytes int64
	sized := true
	for _, rel := range files {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
			continue
		}
		size := m.probeSize(ctx, base+"/"+rel)
		if size <= 0 {
			sized = false
		} else {
			totalBytes += size
		}
		todo = append(todo, item{rel: rel, size: size})
	}
	if !sized {
		totalBytes = -1
	}

	var doneBytes int64
	emit := func(p Progress) {
		if onProgress != nil {
			onProgress(p)
		}
	}
	// Progress callbacks fire per buffer (and, for multipart files, from the
	// last-writer stream) — throttle event emission to ~5/s so the renderer
	// isn't flooded on a fast link. The final per-file update always goes out.
	var lastEmit time.Time
	for i, it := range todo {
		dest := filepath.Join(dir, filepath.FromSlash(it.rel))
		m.bus.Info("components", "downloading "+it.rel, map[string]any{"repo": repo})
		fileStart := doneBytes
		err := m.fetchFile(ctx, base+"/"+it.rel, dest, it.size, func(fileDone int64) {
			doneBytes = fileStart + fileDone
			if now := time.Now(); now.Sub(lastEmit) < 200*time.Millisecond {
				return
			} else { //nolint:revive // keep lastEmit update adjacent to the check
				lastEmit = now
			}
			pct := 0
			if totalBytes > 0 {
				pct = int(min64(doneBytes*100/totalBytes, 100))
			}
			emit(Progress{
				BaseRepo: repo, File: it.rel, FileIndex: i + 1, TotalFiles: len(todo),
				DoneBytes: doneBytes, TotalBytes: totalBytes, Percent: pct,
			})
		})
		if err != nil {
			return fmt.Errorf("components: %s: %w", it.rel, err)
		}
		if it.size > 0 {
			doneBytes = fileStart + it.size
		}
	}

	// Marker ONLY after every file landed — mirrors the engine's _cdn_snapshot.
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("components: mkdir %s: %w", dir, err)
	}
	if err := os.WriteFile(filepath.Join(dir, markerName), nil, 0o644); err != nil {
		return fmt.Errorf("components: write marker: %w", err)
	}
	m.bus.Info("components", "base components complete", map[string]any{
		"repo": repo, "files": len(todo), "bytes": doneBytes,
	})
	emit(Progress{BaseRepo: repo, TotalFiles: len(todo), DoneBytes: doneBytes,
		TotalBytes: totalBytes, Percent: 100, Done: true})
	return nil
}

func (m *Manager) fetchManifest(ctx context.Context, cdnBase, repo string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	url := strings.TrimRight(cdnBase, "/") + "/" + repo + "/" + manifestName
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := m.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var files []string
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&files); err != nil {
		return nil, fmt.Errorf("bad manifest: %w", err)
	}
	// Guard against path escapes from a compromised/misconfigured mirror.
	clean := files[:0]
	for _, rel := range files {
		if rel == "" || strings.HasPrefix(rel, "/") || strings.Contains(rel, "..") {
			continue
		}
		clean = append(clean, rel)
	}
	return clean, nil
}

func (m *Manager) probeSize(ctx context.Context, url string) int64 {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, url, nil)
	if err != nil {
		return -1
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := m.http.Do(req)
	if err != nil {
		return -1
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return -1
	}
	return resp.ContentLength
}

// fetchFile downloads url to dest atomically (.part + rename). Large files
// (>= multipartThreshold, size known from the probe) go through parallel range
// requests; everything else — and any server refusing ranges — takes the
// single-stream path. onBytes receives the file's cumulative byte count
// (serialized — safe to call from the multipart streams).
func (m *Manager) fetchFile(
	ctx context.Context, url, dest string, size int64, onBytes func(int64),
) error {
	if size >= multipartThreshold {
		err := m.fetchRanged(ctx, url, dest, size, onBytes)
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return err // cancelled — don't re-download single-stream
		}
		m.bus.Warn("components", "ranged download failed; retrying single-stream", map[string]any{
			"url": url, "err": err.Error(),
		})
	}
	return m.fetchSingle(ctx, url, dest, onBytes)
}

// fetchRanged pulls url with multipartStreams concurrent Range requests into a
// pre-sized .part file (WriteAt at each stream's offset), then renames. The
// same multi-stream trick as the engine's download_parallel. Fails (for the
// caller's single-stream fallback) if the server answers 200 instead of 206.
func (m *Manager) fetchRanged(
	ctx context.Context, url, dest string, size int64, onBytes func(int64),
) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	part := dest + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return err
	}
	if err := out.Truncate(size); err != nil {
		out.Close()
		_ = os.Remove(part)
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	chunk := (size + int64(multipartStreams) - 1) / int64(multipartStreams)
	var (
		mu    sync.Mutex
		done  int64
		wg    sync.WaitGroup
		errMu sync.Mutex
		first error
	)
	fail := func(e error) {
		errMu.Lock()
		if first == nil {
			first = e
			cancel() // stop the sibling streams
		}
		errMu.Unlock()
	}
	for start := int64(0); start < size; start += chunk {
		end := min64(start+chunk, size) - 1
		wg.Add(1)
		go func(start, end int64) {
			defer wg.Done()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				fail(err)
				return
			}
			req.Header.Set("User-Agent", userAgent)
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
			resp, err := m.http.Do(req)
			if err != nil {
				fail(err)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusPartialContent {
				fail(fmt.Errorf("range request answered HTTP %d (no 206)", resp.StatusCode))
				return
			}
			buf := make([]byte, 1<<20)
			off := start
			for {
				n, rerr := resp.Body.Read(buf)
				if n > 0 {
					if _, werr := out.WriteAt(buf[:n], off); werr != nil {
						fail(werr)
						return
					}
					off += int64(n)
					// onBytes runs under the counter mutex — that's the
					// "serialized" guarantee the Download closure relies on
					// (it mutates shared progress state in the callback).
					mu.Lock()
					done += int64(n)
					if onBytes != nil {
						onBytes(done)
					}
					mu.Unlock()
				}
				if rerr == io.EOF {
					break
				}
				if rerr != nil {
					fail(rerr)
					return
				}
			}
			if off != end+1 {
				fail(fmt.Errorf("stream %d-%d truncated at %d", start, end, off))
			}
		}(start, end)
	}
	wg.Wait()
	closeErr := out.Close()
	if first == nil {
		first = closeErr
	}
	if first == nil && done != size {
		first = fmt.Errorf("incomplete: got %d of %d bytes", done, size)
	}
	if first != nil {
		_ = os.Remove(part)
		return first
	}
	return os.Rename(part, dest)
}

// fetchSingle is the plain sequential GET, verifying the Content-Length when
// the server sends one. No text/* guard here (unlike modelfetch): manifests
// legitimately list .txt/.json component files.
func (m *Manager) fetchSingle(
	ctx context.Context, url, dest string, onBytes func(int64),
) error {
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	resp, err := m.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	part := dest + ".part"
	out, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	var done int64
	buf := make([]byte, 1<<20)
	var copyErr error
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := out.Write(buf[:n]); werr != nil {
				copyErr = werr
				break
			}
			done += int64(n)
			if onBytes != nil {
				onBytes(done)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			copyErr = rerr
			break
		}
	}
	closeErr := out.Close()
	if copyErr == nil {
		copyErr = closeErr
	}
	if copyErr == nil && resp.ContentLength > 0 && done != resp.ContentLength {
		copyErr = fmt.Errorf("incomplete: got %d of %d bytes", done, resp.ContentLength)
	}
	if copyErr != nil {
		_ = os.Remove(part)
		return copyErr
	}
	return os.Rename(part, dest)
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}
