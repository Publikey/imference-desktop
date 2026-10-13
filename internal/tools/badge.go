package tools

import (
	"slices"
	"strings"

	"imference-desktop-go/internal/gpu"
)

// Badge says where a tool would run on this machine, shown next to every tool
// in the menus.
type Badge string

const (
	BadgeLocal       Badge = "local"       // runs here, at full speed
	BadgeLocalSlow   Badge = "local_slow"  // runs here on CPU, slowly
	BadgeCloud       Badge = "cloud"       // only the cloud can run it
	BadgeUnavailable Badge = "unavailable" // neither (no local runtime, no cloud queue)
)

// IsLocal reports whether the badge allows a local run.
func (b Badge) IsLocal() bool { return b == BadgeLocal || b == BadgeLocalSlow }

// Probe is what the tools sidecar reports about its runtime (op "probe").
type Probe struct {
	Providers     []string `json:"providers"`    // onnxruntime execution providers
	FFmpeg        bool     `json:"ffmpeg"`       // ffmpeg on PATH or bundled by imageio-ffmpeg
	TorchDevice   string   `json:"torch_device"` // cuda | rocm | mps | cpu | "" (no torch)
	RAMGB         float64  `json:"ram_gb"`
	EngineVersion string   `json:"engine_version"`
}

// Host is everything the badge depends on.
type Host struct {
	GOOS            string
	GPU             gpu.Info
	EngineInstalled bool   // the engine venv exists
	Probe           *Probe // nil until the tools sidecar answered once: guess from the GPU
	// Generation tools run on the loaded generation model.
	GenerationReady   bool   // the generation sidecar is ready
	GenerationImg2Img bool   // and its backend accepts a source image
	GenerationDevice  string // its device label ("cuda:0", "cuda:0(rocm)", "mps", "cpu")
}

// Assessment is a tool's badge plus the device it would use and why.
type Assessment struct {
	Badge  Badge  `json:"badge"`
	Device string `json:"device,omitempty"` // local device when the badge is local*
	// Reason is a stable code for the UI tooltip: why the tool is not local
	// (engine_not_installed, no_onnxruntime, no_ffmpeg, low_ram,
	// generation_not_ready, no_img2img, generation_on_cpu, no_device) or "".
	Reason string `json:"reason,omitempty"`
}

// torchTools run on torch rather than onnxruntime (Florence-2 for describe):
// their accelerator is torch's device, not an ONNX execution provider.
var torchTools = map[string]bool{"describe": true}

// accelPreference is the order the engine itself prefers (onnx_util._AUTO_ORDER).
var accelPreference = []string{"cuda", "rocm", "directml", "mps"}

// Assess computes the badge of t on host h.
func Assess(t Tool, h Host) Assessment {
	cloudOr := func(reason string) Assessment {
		if t.CloudAvailable {
			return Assessment{Badge: BadgeCloud, Reason: reason}
		}
		return Assessment{Badge: BadgeUnavailable, Reason: reason}
	}

	if t.IsGeneration() {
		switch {
		case !h.GenerationReady:
			return cloudOr("generation_not_ready")
		case !h.GenerationImg2Img:
			return cloudOr("no_img2img")
		}
		dev := deviceClass(h.GenerationDevice)
		if !slices.Contains(t.Runtimes.Local, dev) {
			return cloudOr("generation_on_cpu")
		}
		return Assessment{Badge: BadgeLocal, Device: dev}
	}

	if !h.EngineInstalled {
		return cloudOr("engine_not_installed")
	}
	if p := h.Probe; p != nil {
		if t.Category == "video" && !p.FFmpeg {
			return cloudOr("no_ffmpeg")
		}
		if usesONNX(t) && len(p.Providers) == 0 {
			return cloudOr("no_onnxruntime")
		}
		if t.Runtimes.MinRAMGB > 0 && p.RAMGB > 0 && p.RAMGB < t.Runtimes.MinRAMGB {
			return cloudOr("low_ram")
		}
	}

	accels := h.accelerators(torchTools[t.ID])
	for _, dev := range accelPreference {
		if !slices.Contains(t.Runtimes.Local, dev) || !slices.Contains(accels, dev) {
			continue
		}
		if t.Runtimes.MinVRAMGB > 0 && h.GPU.VRAMGiB > 0 && h.GPU.VRAMGiB < t.Runtimes.MinVRAMGB {
			continue // known too small: fall through to CPU
		}
		return Assessment{Badge: BadgeLocal, Device: dev}
	}
	if slices.Contains(t.Runtimes.Local, "cpu") {
		if t.Runtimes.SlowOnCPU {
			return Assessment{Badge: BadgeLocalSlow, Device: "cpu"}
		}
		return Assessment{Badge: BadgeLocal, Device: "cpu"}
	}
	return cloudOr("no_device")
}

// usesONNX: tools with weights run an ONNX model (except the torch ones);
// the pure Pillow / ffmpeg utilities need no onnxruntime.
func usesONNX(t Tool) bool { return t.WeightsMB > 0 && !torchTools[t.ID] }

// accelerators lists the GPU devices a tool can use: from the probe when the
// tools sidecar has answered, else guessed from the detected GPU and the
// onnxruntime flavor the installer picks for it (installer.onnxRuntimePackage).
func (h Host) accelerators(torch bool) []string {
	var out []string
	if p := h.Probe; p != nil {
		if torch {
			if d := p.TorchDevice; d != "" && d != "cpu" {
				out = append(out, d)
			}
			return out
		}
		for _, prov := range p.Providers {
			switch prov {
			case "CUDAExecutionProvider", "TensorrtExecutionProvider":
				out = append(out, "cuda")
			case "ROCMExecutionProvider", "MIGraphXExecutionProvider":
				out = append(out, "rocm")
			case "DmlExecutionProvider":
				out = append(out, "directml")
			}
			// CoreML is opt-in in the engine (device="mps"), never picked by auto.
		}
		return out
	}
	switch {
	case torch && h.GPU.Vendor == gpu.VendorNVIDIA:
		return []string{"cuda"}
	case torch && h.GPU.Vendor == gpu.VendorAMD:
		return []string{"rocm"}
	case torch && h.GPU.Vendor == gpu.VendorApple:
		return []string{"mps"}
	case torch:
		return nil
	case h.GOOS == "darwin":
		return nil
	case h.GPU.Vendor == gpu.VendorNVIDIA:
		return []string{"cuda"}
	case h.GOOS == "windows" && h.GPU.Vendor != gpu.VendorNone:
		return []string{"directml"}
	}
	return nil
}

// deviceClass maps the generation sidecar's device label to a runtime name.
func deviceClass(label string) string {
	l := strings.ToLower(strings.TrimSpace(label))
	switch {
	case strings.Contains(l, "rocm"):
		return "rocm"
	case strings.HasPrefix(l, "cuda"):
		return "cuda"
	case strings.HasPrefix(l, "mps"):
		return "mps"
	case l == "" || l == "unknown":
		return "unknown"
	default:
		return "cpu"
	}
}

// Route is where a run goes.
type Route string

const (
	RouteLocal Route = "local"
	RouteCloud Route = "cloud"
)

// Modes for the global setting and the per-run selector.
const (
	ModeAuto  = "auto"
	ModeLocal = "local"
	ModeCloud = "cloud"
)

// NormalizeMode maps anything unknown to auto.
func NormalizeMode(m string) string {
	switch m {
	case ModeLocal, ModeCloud:
		return m
	}
	return ModeAuto
}

// Decide picks where to run t. auto = local when the badge is local or
// local_slow, else the cloud. A forced mode that this machine (or the cloud)
// cannot honor is an error — the UI then proposes the other side with its
// price; it never switches silently.
func Decide(mode string, t Tool, a Assessment) (Route, *Error) {
	switch NormalizeMode(mode) {
	case ModeLocal:
		if a.Badge.IsLocal() {
			return RouteLocal, nil
		}
		return "", &Error{Code: CodeUnsupportedRuntime, Message: "this tool cannot run on this computer (" + a.Reason + ")"}
	case ModeCloud:
		if t.CloudAvailable {
			return RouteCloud, nil
		}
		return "", &Error{Code: CodeUnsupportedRuntime, Message: "this tool has no cloud runtime"}
	default:
		if a.Badge.IsLocal() {
			return RouteLocal, nil
		}
		if t.CloudAvailable {
			return RouteCloud, nil
		}
		return "", &Error{Code: CodeUnsupportedRuntime, Message: "this tool cannot run here or in the cloud (" + a.Reason + ")"}
	}
}
