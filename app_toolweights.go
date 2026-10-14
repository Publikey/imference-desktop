package main

// Explicit download of an editing tool's weights (the Edit panel's
// "Download model" button), so a local run never starts a multi-hundred-MB
// download implicitly — the same rule as the Create panel's local models.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"imference-desktop-go/internal/modelfetch"
	"imference-desktop-go/internal/sidecar"
	"imference-desktop-go/internal/tools"
)

// ToolWeightsProgress is the "tools:weights" event.
type ToolWeightsProgress struct {
	ToolID  string `json:"toolId"`
	Percent int    `json:"percent"`
	// Done is set once (finished, failed or cancelled); Error is set on failure.
	Done      bool   `json:"done"`
	Error     string `json:"error,omitempty"`
	Cancelled bool   `json:"cancelled,omitempty"`
}

var (
	toolDLMu     sync.Mutex
	toolDLCancel context.CancelFunc
)

// toolsCDNBase is the tools weights mirror the sidecar uses (TOOLS_MODEL_CDN,
// else the image CDN's "/tools").
func toolsCDNBase() string {
	if v := strings.TrimSpace(os.Getenv("TOOLS_MODEL_CDN")); v != "" {
		return strings.TrimRight(v, "/")
	}
	if base := strings.TrimRight(sidecar.ImageCDNBase(), "/"); base != "" {
		return base + "/tools"
	}
	return ""
}

// weightsFor is the weights a run of t with params fetches: the files whose
// "when" matches the params (a missing param takes its default).
func weightsFor(t tools.Tool, params map[string]any) []tools.WeightFile {
	value := func(name string) any {
		if v, ok := params[name]; ok && v != nil {
			return v
		}
		for _, p := range t.Params {
			if p.Name == name {
				return p.Default
			}
		}
		return nil
	}
	var out []tools.WeightFile
	for _, w := range t.Weights {
		ok := true
		for k, v := range w.When {
			if fmt.Sprint(value(k)) != fmt.Sprint(v) {
				ok = false
				break
			}
		}
		if ok {
			out = append(out, w)
		}
	}
	return out
}

// DownloadToolWeights fetches the missing weights of a local run of toolID
// with params into the tools cache (progress on "tools:weights"). Returns at
// once; the download runs in the background.
func (a *App) DownloadToolWeights(toolID string, params map[string]any) error {
	if a.cloudOnly {
		return errors.New("not available in the web version")
	}
	if a.toolsCat == nil {
		return errors.New("tools catalog unavailable")
	}
	t, ok := a.toolsCat.Get(toolID)
	if !ok {
		return fmt.Errorf("unknown tool %q", toolID)
	}
	cdn, cache := toolsCDNBase(), toolsCacheDirInUse()
	if cdn == "" || cache == "" {
		return errors.New("no weights mirror or cache directory configured")
	}
	var todo []tools.WeightFile
	var total float64
	for _, w := range weightsFor(t, params) {
		if st, err := os.Stat(filepath.Join(cache, filepath.FromSlash(w.Path))); err == nil && st.Size() > 0 {
			continue
		}
		todo = append(todo, w)
		total += w.SizeMB
	}
	emit := func(p ToolWeightsProgress) {
		p.ToolID = toolID
		if a.canEmit() {
			a.emit("tools:weights", p)
		}
	}
	if len(todo) == 0 {
		emit(ToolWeightsProgress{Percent: 100, Done: true})
		return nil
	}

	ctx, cancel := context.WithCancel(a.ctx)
	toolDLMu.Lock()
	if toolDLCancel != nil {
		toolDLCancel()
	}
	toolDLCancel = cancel
	toolDLMu.Unlock()

	go func() {
		defer func() {
			cancel()
			toolDLMu.Lock()
			toolDLCancel = nil
			toolDLMu.Unlock()
		}()
		a.bus.Info("tools", "weights download start", map[string]any{"tool": toolID, "files": len(todo), "mb": total})
		done := 0.0
		for _, w := range todo {
			dest := filepath.Join(cache, filepath.FromSlash(w.Path))
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				emit(ToolWeightsProgress{Done: true, Error: err.Error()})
				return
			}
			_, err := modelfetch.New(a.bus).Fetch(ctx, cdn+"/"+w.Path, dest, 1, func(p modelfetch.Progress) {
				frac := 0.0
				if p.Total > 0 {
					frac = float64(p.Downloaded) / float64(p.Total)
				}
				pct := 100 * (done + frac*w.SizeMB) / max(total, 1)
				emit(ToolWeightsProgress{Percent: int(pct)})
			})
			if err != nil {
				if errors.Is(err, context.Canceled) {
					emit(ToolWeightsProgress{Done: true, Cancelled: true})
					return
				}
				a.bus.Error("tools", "weights download failed", map[string]any{"tool": toolID, "err": err.Error()})
				emit(ToolWeightsProgress{Done: true, Error: err.Error()})
				return
			}
			done += w.SizeMB
		}
		a.bus.Info("tools", "weights download done", map[string]any{"tool": toolID})
		emit(ToolWeightsProgress{Percent: 100, Done: true})
	}()
	return nil
}

// CancelToolWeights aborts the running tool weights download, if any.
func (a *App) CancelToolWeights() {
	toolDLMu.Lock()
	defer toolDLMu.Unlock()
	if toolDLCancel != nil {
		toolDLCancel()
	}
}
