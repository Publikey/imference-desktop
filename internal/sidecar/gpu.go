package sidecar

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// probeNvidiaVRAMGiB returns the total VRAM of the first NVIDIA GPU, in GiB.
//
// It shells out to `nvidia-smi` (present on every machine with the NVIDIA
// driver, in PATH on both Windows and Linux) rather than pulling an NVML cgo
// binding — no build-tag / cross-compile complications, and total memory is all
// we need. The second return is false when nvidia-smi is absent (no NVIDIA GPU,
// AMD/Intel/Apple, or a broken driver) or the output can't be parsed; callers
// treat that as "unknown, don't auto-tune".
//
// `--query-gpu=memory.total --format=csv,noheader,nounits` prints one line per
// GPU, the total in MiB (e.g. "8192"). We read the first GPU only — the sidecar
// loads a single model on cuda:0 by default. A 2s timeout keeps a hung driver
// from stalling sidecar startup.
func probeNvidiaVRAMGiB() (float64, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	out, err := exec.CommandContext(
		ctx, "nvidia-smi",
		"--query-gpu=memory.total", "--format=csv,noheader,nounits",
	).Output()
	if err != nil {
		return 0, false
	}

	line := strings.TrimSpace(string(out))
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = strings.TrimSpace(line[:i]) // first GPU only
	}
	mib, err := strconv.ParseFloat(line, 64)
	if err != nil || mib <= 0 {
		return 0, false
	}
	return mib / 1024.0, true
}
