package sidecar

import (
	"strings"
	"testing"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

// The engine's CDN download lines become progress events (big files only),
// and the download state is cleared when inference starts.
func TestStderrDownloadProgress(t *testing.T) {
	m := &Manager{bus: logbus.New()}
	var got []types.GenerateProgress
	m.progress = func(p types.GenerateProgress) { got = append(got, p) }
	m.streamStderr(strings.NewReader(strings.Join([]string{
		"  config.json: 0/0 MiB (0%) [1 streams]   ",
		"  model.safetensors: 20/7341 MiB (0%) [8 streams]   ",
		"  model.safetensors: 3690/7341 MiB (50%) [8 streams]   ",
		"2026-11-16 INFO imference_engine.engine: Inference chunk 1-1/1 seeds=[1]",
		" 50%|#####     | 4/8 [00:20<00:20,  5.1s/it]",
	}, "\n")))
	if len(got) != 4 {
		t.Fatalf("events %+v", got)
	}
	if d := got[1].Download; d == nil || d.File != "model.safetensors" || d.DoneMiB != 3690 || d.TotalMiB != 7341 || got[1].Percent != 50 {
		t.Fatalf("download event %+v", got[1])
	}
	if got[2].Download != nil || got[2].Total != 0 {
		t.Fatalf("clear event %+v", got[2])
	}
	if got[3].Step != 4 || got[3].Total != 8 || got[3].Download != nil {
		t.Fatalf("step event %+v", got[3])
	}
}
