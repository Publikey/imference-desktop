// Package gpu detects the machine's GPU vendor, marketing name, and total
// VRAM. It backs two decisions elsewhere in the app:
//
//   - internal/installer picks the torch wheel source from the vendor
//     (CUDA index for NVIDIA, ROCm index / AMD wheels for AMD, PyPI for Apple).
//   - internal/sidecar's auto CPU-offload heuristic compares total VRAM
//     against a threshold.
//
// Everything shells out to vendor tools or reads sysfs/registry — no cgo, no
// NVML/ROCm-SMI library bindings — so the package cross-compiles cleanly and
// degrades to "unknown" instead of failing on machines without a driver.
package gpu

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Vendor identifies the GPU maker. The zero value means "none detected".
type Vendor string

const (
	VendorNVIDIA Vendor = "nvidia"
	VendorAMD    Vendor = "amd"
	VendorApple  Vendor = "apple"
	VendorNone   Vendor = ""
)

// Info is one detected GPU. VRAMGiB is 0 when the size couldn't be measured
// (probe tool missing / unparseable) — callers must treat 0 as "unknown",
// never as "no memory".
type Info struct {
	Vendor  Vendor
	Name    string  // marketing name when known ("AMD Radeon RX 7900 XTX"), "" otherwise
	VRAMGiB float64 // total VRAM of the selected GPU, 0 = unknown
}

// probeTimeout bounds each external probe (nvidia-smi, PowerShell) so a hung
// driver can't stall app startup. sysfs reads are effectively instant.
const probeTimeout = 3 * time.Second

// Detect returns the primary GPU. Preference order on multi-GPU machines is
// NVIDIA > AMD: hybrid laptops commonly pair an AMD iGPU with an NVIDIA dGPU
// (the reverse pairing effectively doesn't exist), and CUDA is the mature
// torch path, so when both vendors are present NVIDIA is the right target.
// Within a vendor, the adapter with the most VRAM wins (dGPU over iGPU).
func Detect(ctx context.Context) Info {
	if runtime.GOOS == "darwin" {
		// Apple Silicon: unified memory, no discrete VRAM number to report.
		return Info{Vendor: VendorApple, Name: "Apple Silicon"}
	}

	// nvidia-smi is the authoritative NVIDIA probe — present and in PATH on
	// every machine with the NVIDIA driver, on both Windows and Linux.
	if info, ok := probeNvidiaSMI(ctx); ok {
		return info
	}

	if runtime.GOOS == "windows" {
		return detectWindowsRegistry(ctx)
	}
	return detectLinuxSysfs()
}

// probeNvidiaSMI queries name + total memory of the first NVIDIA GPU in one
// shot. `--format=csv,noheader,nounits` prints one line per GPU, e.g.
// "NVIDIA GeForce RTX 4070, 12282" (memory in MiB). First GPU only — the
// sidecar loads a single model on cuda:0 by default.
func probeNvidiaSMI(ctx context.Context) (Info, bool) {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	cmd := exec.CommandContext(
		ctx, "nvidia-smi",
		"--query-gpu=name,memory.total", "--format=csv,noheader,nounits",
	)
	cmd.SysProcAttr = hideWindowAttr()
	out, err := cmd.Output()
	if err != nil {
		return Info{}, false
	}

	line := strings.TrimSpace(string(out))
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = strings.TrimSpace(line[:i])
	}
	if line == "" {
		return Info{}, false
	}
	// Split on the LAST comma: the memory field is a bare number while GPU
	// names could in principle contain punctuation.
	name, mem := line, ""
	if i := strings.LastIndex(line, ","); i >= 0 {
		name, mem = strings.TrimSpace(line[:i]), strings.TrimSpace(line[i+1:])
	}
	info := Info{Vendor: VendorNVIDIA, Name: name}
	if mib, err := strconv.ParseFloat(mem, 64); err == nil && mib > 0 {
		info.VRAMGiB = mib / 1024.0
	}
	return info, true
}

// detectLinuxSysfs scans /sys/class/drm for GPU PCI devices. The amdgpu
// driver exposes total VRAM in bytes at device/mem_info_vram_total, so AMD
// needs no external tool (rocm-smi isn't installed on most gaming boxes).
// An NVIDIA PCI id here without a working nvidia-smi means the proprietary
// driver is missing/broken — still reported as NVIDIA (VRAM unknown) so the
// installer targets the right wheel.
func detectLinuxSysfs() Info {
	const (
		pciVendorAMD    = "0x1002"
		pciVendorNVIDIA = "0x10de"
	)
	vendorFiles, _ := filepath.Glob("/sys/class/drm/card[0-9]*/device/vendor")

	var best Info
	sawNvidia := false
	for _, vf := range vendorFiles {
		raw, err := os.ReadFile(vf)
		if err != nil {
			continue
		}
		devDir := filepath.Dir(vf)
		switch strings.TrimSpace(string(raw)) {
		case pciVendorNVIDIA:
			sawNvidia = true
		case pciVendorAMD:
			gib := readSysfsVRAMGiB(filepath.Join(devDir, "mem_info_vram_total"))
			// Prefer the AMD adapter with the most VRAM (dGPU over the APU's
			// carve-out).
			if best.Vendor != VendorAMD || gib > best.VRAMGiB {
				best = Info{Vendor: VendorAMD, Name: "AMD Radeon (amdgpu)", VRAMGiB: gib}
			}
		}
	}
	if sawNvidia {
		// NVIDIA over AMD, matching Detect's documented preference.
		return Info{Vendor: VendorNVIDIA, Name: "NVIDIA GPU (driver not probed)"}
	}
	return best
}

// readSysfsVRAMGiB parses an amdgpu mem_info_vram_total file (bytes).
func readSysfsVRAMGiB(path string) float64 {
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	b, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil || b <= 0 {
		return 0
	}
	return b / (1024 * 1024 * 1024)
}

// winAdapter mirrors the PowerShell JSON: one display adapter from the
// registry's video class key. qwMemorySize is the QWORD VRAM in bytes —
// unlike WMI's Win32_VideoController.AdapterRAM (uint32) it doesn't cap at
// 4 GiB, which is why we read the registry instead of WMI.
type winAdapter struct {
	DriverDesc   string  `json:"DriverDesc"`
	QwMemorySize float64 `json:"HardwareInformation.qwMemorySize"`
}

// detectWindowsRegistry enumerates display adapters from the registry via a
// single PowerShell call. Used when nvidia-smi is absent — i.e. AMD/Intel
// machines, or an NVIDIA box with a broken driver install.
func detectWindowsRegistry(ctx context.Context) Info {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	// {4d36e968-…} is the fixed GUID of the Display Adapters device class.
	// 0* filters to the numbered adapter subkeys (0000, 0001, …).
	const script = `Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0*' -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc } | Select-Object DriverDesc,'HardwareInformation.qwMemorySize' | ConvertTo-Json -Compress`
	cmd := exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = hideWindowAttr()
	out, err := cmd.Output()
	if err != nil {
		return Info{}
	}
	adapters := parseWinAdapters(out)

	pick := func(v Vendor, match func(string) bool) (Info, bool) {
		var best Info
		found := false
		for _, a := range adapters {
			if !match(strings.ToLower(a.DriverDesc)) {
				continue
			}
			gib := a.QwMemorySize / (1024 * 1024 * 1024)
			if !found || gib > best.VRAMGiB {
				best = Info{Vendor: v, Name: a.DriverDesc, VRAMGiB: gib}
				found = true
			}
		}
		return best, found
	}

	// NVIDIA first (see Detect); reaching here means nvidia-smi failed, but
	// the wheel choice should still track the hardware.
	if info, ok := pick(VendorNVIDIA, func(d string) bool {
		return strings.Contains(d, "nvidia")
	}); ok {
		return info
	}
	if info, ok := pick(VendorAMD, func(d string) bool {
		return strings.Contains(d, "amd") || strings.Contains(d, "radeon")
	}); ok {
		return info
	}
	return Info{}
}

// parseWinAdapters decodes ConvertTo-Json output, which is a bare object for
// a single adapter and an array for several.
func parseWinAdapters(out []byte) []winAdapter {
	trimmed := strings.TrimSpace(string(out))
	if trimmed == "" {
		return nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var many []winAdapter
		if err := json.Unmarshal([]byte(trimmed), &many); err != nil {
			return nil
		}
		return many
	}
	var one winAdapter
	if err := json.Unmarshal([]byte(trimmed), &one); err != nil {
		return nil
	}
	return []winAdapter{one}
}
