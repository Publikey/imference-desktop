package modelfetch

// Parallel-range download path for the big checkpoint pulls. A single HTTP
// connection to the CDN often caps well below link speed; six concurrent
// Range requests into a pre-sized .part file (WriteAt at each stream's
// offset) is the same trick as the engine's download_parallel — and the
// internal/components downloader. Kept inside modelfetch (rather than shared)
// so each downloader keeps its own semantics: this one is wired behind
// Fetch's reuse check and text/* guard.

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
)

const (
	// Files at/above this size use parallel ranges; below it (nothing
	// modelfetch handles, in practice) the setup overhead isn't worth it.
	rangedThreshold = 64 << 20 // 64 MB
	rangedStreams   = 6
)

// fetchRanged pulls url (whose size is known from the HEAD probe) with
// rangedStreams concurrent Range requests into partPath, reporting cumulative
// progress on whole-percent changes (same cadence as progressWriter). Returns
// an error — leaving no partial file — when the server answers 200 instead of
// 206, so Fetch can fall back to the single-stream path.
func (f *Fetcher) fetchRanged(
	ctx context.Context, url, partPath string, size int64, onProgress func(Progress),
) error {
	out, err := os.OpenFile(partPath, os.O_CREATE|os.O_TRUNC|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("modelfetch: create %s: %w", partPath, err)
	}
	if err := out.Truncate(size); err != nil {
		out.Close()
		_ = os.Remove(partPath)
		return fmt.Errorf("modelfetch: presize %s: %w", partPath, err)
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	chunk := (size + int64(rangedStreams) - 1) / int64(rangedStreams)
	var (
		mu      sync.Mutex
		done    int64
		lastPct = -1
		wg      sync.WaitGroup
		errMu   sync.Mutex
		first   error
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
		end := start + chunk
		if end > size {
			end = size
		}
		end--
		wg.Add(1)
		go func(start, end int64) {
			defer wg.Done()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
			if err != nil {
				fail(err)
				return
			}
			req.Header.Set("User-Agent", "imference-desktop-go/0.0.1")
			req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))
			resp, err := f.http.Do(req)
			if err != nil {
				fail(err)
				return
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusPartialContent {
				fail(fmt.Errorf("modelfetch: range request answered HTTP %d (no 206)", resp.StatusCode))
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
					mu.Lock()
					done += int64(n)
					pct := int(min(done*100/size, 100))
					if pct != lastPct && onProgress != nil {
						lastPct = pct
						onProgress(Progress{Downloaded: done, Total: size, Percent: pct})
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
				fail(fmt.Errorf("modelfetch: stream %d-%d truncated at %d", start, end, off))
			}
		}(start, end)
	}
	wg.Wait()
	closeErr := out.Close()
	if first == nil {
		first = closeErr
	}
	if first == nil && done != size {
		first = fmt.Errorf("modelfetch: incomplete ranged download — got %d of %d bytes", done, size)
	}
	if first != nil {
		_ = os.Remove(partPath)
		return first
	}
	return nil
}
