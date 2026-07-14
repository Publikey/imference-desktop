// Package installer creates a self-contained Python venv with imference-engine
// and its CUDA-enabled torch installed. Used by App.InstallEngine to deliver
// the one-click Local mode setup.
//
// The package is intentionally Wails-free: callers wire the progress channel
// to runtime.EventsEmit themselves, and stdout/stderr from pip is published
// to a logbus.Bus injected at construction time. Both decisions keep the
// install logic unit-testable without spinning up a webview.
package installer

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelfetch"
	"imference-desktop-go/internal/types"
)

// EngineTarball is the default pip-installable source, pinned to a tagged
// release for reproducible installs. Bump this when adopting a newer engine
// release (and adapt the sidecar/Go to any API changes first). Using a fixed
// tag — not refs/heads/main — so the desktop never silently picks up a drifting
// main that could break the sidecar.
//
// For local development, override via the IMFERENCE_ENGINE_SOURCE env var.
// See resolveEngineSource() below.
const EngineTarball = "imference-engine[sdxl,sd15,zimage,flux,chroma,qwenimage,anima] @ https://github.com/Publikey/imference-engine/archive/refs/tags/v0.3.1.tar.gz"

// EngineSourceEnvVar lets a developer point the installer at a local
// imference-engine checkout instead of the GitHub tarball. Set to an absolute
// path (e.g. "C:\git windows\imference-engine") and the engine phase will
// pip-install it in editable mode — code edits become visible after a sidecar
// restart, no Reinstall needed.
const EngineSourceEnvVar = "IMFERENCE_ENGINE_SOURCE"

// resolveEngineSource picks between the local override and the GitHub default.
// Returns the spec to pass to pip and whether it should be installed editable
// (-e). Local override → editable, URL → regular install.
func resolveEngineSource() (spec string, editable bool) {
	override := strings.TrimSpace(os.Getenv(EngineSourceEnvVar))
	if override == "" {
		return EngineTarball, false
	}
	// Looks like a URL? Treat as remote install, no -e.
	if strings.HasPrefix(override, "http://") || strings.HasPrefix(override, "https://") {
		return override, false
	}
	// Local path → editable install with all image-backend extras. Pip accepts
	// "path[extras]" syntax even on Windows paths with spaces. The seven image
	// backends share byte-identical deps (torch + diffusers 0.39 + transformers +
	// sentencepiece), so this resolves once — matching the pinned GitHub tarball.
	return override + "[sdxl,sd15,zimage,flux,chroma,qwenimage,anima]", true
}

// pinnedEngineVersionRe pulls the X.Y.Z out of the EngineTarball tag URL
// (".../tags/v0.3.0.tar.gz" -> "0.3.0").
var pinnedEngineVersionRe = regexp.MustCompile(`/tags/v?([0-9]+\.[0-9]+\.[0-9]+)\.tar\.gz`)

// PinnedEngineVersion is the imference-engine version the desktop ships with,
// parsed from EngineTarball. It returns "" when a dev source override
// (IMFERENCE_ENGINE_SOURCE) is active — a local/editable checkout has no pinned
// version to enforce — or when the URL can't be parsed. The startup version
// check compares this against the installed version and force-reinstalls on a
// mismatch, so a stale venv can't silently run an old engine (e.g. diffusers
// 0.38 whose CPU offload doesn't actually cut VRAM).
func PinnedEngineVersion() string {
	if strings.TrimSpace(os.Getenv(EngineSourceEnvVar)) != "" {
		return ""
	}
	m := pinnedEngineVersionRe.FindStringSubmatch(EngineTarball)
	if len(m) != 2 {
		return ""
	}
	return m[1]
}

// TorchIndexURL is the CUDA 12.4 wheel index. We use cu124 (not cu121) because
// imference-engine's pyproject.toml pins torch>=2.6 in the image extras, and
// the cu121 index stops at torch 2.5.x. If we used cu121, pip would later
// uninstall our CUDA torch and pull the CPU torch 2.6+ from PyPI to satisfy
// the engine's constraint. cu124 ships torch 2.6+ wheels and is compatible
// with NVIDIA drivers shipped from late 2024 onwards.
const TorchIndexURL = "https://download.pytorch.org/whl/cu124"

// TorchSpec is the version constraint we install. Mirroring the engine's
// pyproject.toml exactly so pip is satisfied in one shot — no later "found a
// version that doesn't match, let me swap it" surprises in the engine phase.
const TorchSpec = "torch>=2.6"

// torchInstallArgs returns the `pip` arguments (and a UI message) for the torch
// phase, varying by OS:
//
//   - macOS: the default PyPI wheels ship Apple's MPS (Metal) backend, so we
//     install torch straight from PyPI with NO custom index. Pinning the cu124
//     index here would fail — that index has no darwin wheels — and even a CPU
//     fallback would lose GPU acceleration on Apple Silicon.
//   - Windows/Linux: install the CUDA 12.4 build from the pytorch.org index.
//
// torchvision is intentionally not installed here; imference-engine[sdxl,sd15,zimage,flux,chroma,qwenimage,anima]
// pulls whatever it needs, and on macOS the matching MPS torchvision resolves
// from PyPI in the engine phase.
func torchInstallArgs() (args []string, message string) {
	if runtime.GOOS == "darwin" {
		return []string{"install", "--upgrade", TorchSpec},
			"Downloading torch (Apple Silicon / MPS) from PyPI"
	}
	return []string{"install", "--upgrade", TorchSpec, "--index-url", TorchIndexURL},
		"Downloading torch (CUDA 12.4, ~3 GB) — this is the long one"
}

// SDEmbedTarball is the GitHub archive URL for sd_embed (weighted prompt
// embeddings + BREAK keyword). MUST be installed with --no-deps because
// sd_embed's setup.py declares unconstrained `torch` + `torchvision`
// dependencies that would clobber our CUDA torch with the CPU wheel.
// All transitive deps it actually uses (torch, transformers, ftfy) are
// already in imference-engine[sdxl,sd15,zimage,flux,chroma,qwenimage,anima].
//
// Pinned to a COMMIT, not refs/heads/main: sd_embed has no PyPI release, so a
// moving `main` would silently change prompt-encoding behaviour between installs
// (and can't be rolled back). This SHA is the current head of main (2025-04-24).
const SDEmbedTarball = "sd-embed @ https://github.com/xhinker/sd_embed/archive/4a47f71150a22942fa606fb741a1c971d95ba56f.tar.gz"

// SDXLModelURL is the default single-file SDXL checkpoint the app downloads so
// the user never has to hand-pick a .safetensors. Must point directly at a
// .safetensors file (a 200 response with the raw bytes — not an HTML page or a
// redirect to a login). The cache filename is derived from this URL's basename
// in app.sdxlModelPath, so different models cache to different files.
const SDXLModelURL = "https://gen-models.ml-cnd-gen.cc/sdxl/cyberrealisticPony_v130.safetensors"

// sdxlModelMinBytes is the cross-launch reuse floor: an existing file at the
// model path larger than this is treated as a complete prior download and
// reused. It's deliberately a loose "this is plausibly a real multi-GB
// checkpoint, not a saved error page or stub" sanity bound rather than an
// exact size — true completeness of a fresh download is enforced separately by
// modelfetch's Content-Length check. Kept model-agnostic so swapping
// SDXLModelURL doesn't require retuning it.
const sdxlModelMinBytes = 1_000_000_000

type Options struct {
	// VenvDir is where the engine venv lives. Recommended: os.UserCacheDir()/imference-desktop-go/engine-venv.
	VenvDir string
	// SidecarRequirementsPath points to sidecar/requirements.txt — used in the
	// "sidecar-deps" phase. Caller computes via the same resolver as the
	// sidecar script path (filepath.Join(app.GetAppPath(), "sidecar", "requirements.txt")).
	SidecarRequirementsPath string
	// ModelURL / ModelPath drive the optional "model" phase: download the SDXL
	// weights to ModelPath. When ModelPath is empty the phase is skipped (e.g.
	// the user wants to supply their own checkpoint). ModelURL defaults to
	// SDXLModelURL when empty but ModelPath is set.
	ModelURL  string
	ModelPath string
	// EngineOnly skips the detect / venv / torch / sidecar-deps phases and just
	// force-replaces the imference-engine package (uninstall + install the pinned
	// tarball) plus sd-embed. Used by the startup version check to upgrade a
	// stale engine without a 3 GB torch re-pull. Requires an existing venv.
	EngineOnly bool
}

// Installer runs the 5-phase setup. Safe to instantiate but only one Install()
// at a time per instance (callers should also serialize at the app layer).
type Installer struct {
	bus *logbus.Bus

	mu      sync.Mutex
	running bool
}

func New(bus *logbus.Bus) *Installer {
	return &Installer{bus: bus}
}

// Install runs all phases sequentially. The progress channel is closed when
// the function returns (success or failure). Caller may pass nil to skip
// progress events and just rely on logbus / final error.
func (i *Installer) Install(ctx context.Context, opts Options, progress chan<- types.InstallProgress) error {
	i.mu.Lock()
	if i.running {
		i.mu.Unlock()
		return errors.New("installer: another install is already in progress")
	}
	i.running = true
	i.mu.Unlock()

	defer func() {
		i.mu.Lock()
		i.running = false
		i.mu.Unlock()
		if progress != nil {
			close(progress)
		}
	}()

	emit := func(p types.InstallProgress) {
		if progress != nil {
			// Non-blocking: drop events if nobody's listening. Prevents
			// install from stalling if the renderer disconnects mid-run.
			select {
			case progress <- p:
			default:
			}
		}
	}

	if opts.EngineOnly {
		return i.reinstallEngineOnly(ctx, opts.VenvDir, emit)
	}

	// ----- Phase 1: detect Python -----
	emit(types.InstallProgress{Phase: "detect", Message: "Looking for Python 3.10+ on PATH…"})
	i.bus.Info("installer", "detect phase start", nil)
	py, err := DetectPython(ctx)
	if err != nil {
		i.bus.Error("installer", "detect failed", map[string]any{"err": err.Error()})
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	i.bus.Info("installer", "detect ok", map[string]any{"path": py.Path, "version": py.Version})
	emit(types.InstallProgress{
		Phase:   "detect",
		Message: fmt.Sprintf("Found Python %s at %s", py.Version, py.Path),
	})

	// ----- Phase 2: ensure venv (create if missing, reuse if healthy) -----
	emit(types.InstallProgress{Phase: "venv", Message: "Checking venv at " + opts.VenvDir})
	i.bus.Info("installer", "venv phase start", map[string]any{"dir": opts.VenvDir})
	reused, err := i.ensureVenv(ctx, py.Path, opts.VenvDir)
	if err != nil {
		i.bus.Error("installer", "venv failed", map[string]any{"err": err.Error()})
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	venvPython := venvPythonPath(opts.VenvDir)
	venvMsg := "Venv created"
	if reused {
		venvMsg = "Venv already present, reusing"
	}
	i.bus.Info("installer", "venv ok", map[string]any{"python": venvPython, "reused": reused})
	emit(types.InstallProgress{Phase: "venv", Message: venvMsg})

	// ----- Phase 3: pip install torch (CUDA on Win/Linux, MPS on macOS) -----
	torchArgs, torchMsg := torchInstallArgs()
	emit(types.InstallProgress{Phase: "torch", Message: torchMsg})
	i.bus.Info("installer", "torch phase start", map[string]any{"os": runtime.GOOS, "args": torchArgs})
	if err := i.runPip(ctx, venvPython, "torch", emit, torchArgs...); err != nil {
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	emit(types.InstallProgress{Phase: "torch", Message: "torch installed", PercentEstimate: 100})

	// ----- Phase 4: pip install sidecar deps (runqy-python) -----
	emit(types.InstallProgress{Phase: "sidecar-deps", Message: "Installing runqy-python (stdio protocol)"})
	i.bus.Info("installer", "sidecar-deps phase start", map[string]any{"reqs": opts.SidecarRequirementsPath})
	if err := i.runPip(ctx, venvPython, "sidecar-deps", emit,
		"install", "-r", opts.SidecarRequirementsPath,
	); err != nil {
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	emit(types.InstallProgress{Phase: "sidecar-deps", Message: "Sidecar deps installed", PercentEstimate: 100})

	// ----- Phase 5: pip install imference-engine -----
	engineSpec, editable := resolveEngineSource()
	engineMsg := "Downloading imference-engine from GitHub"
	if editable {
		engineMsg = "Installing imference-engine from local source (editable)"
	}
	emit(types.InstallProgress{Phase: "engine", Message: engineMsg})
	i.bus.Info("installer", "engine phase start", map[string]any{
		"spec":     engineSpec,
		"editable": editable,
	})
	pipArgs := []string{"install"}
	if editable {
		pipArgs = append(pipArgs, "-e")
	}
	pipArgs = append(pipArgs, engineSpec)
	if err := i.runPip(ctx, venvPython, "engine", emit, pipArgs...); err != nil {
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	emit(types.InstallProgress{Phase: "engine", Message: "imference-engine installed", PercentEstimate: 100})

	// ----- Phase 6: pip install sd-embed (weighted prompts + BREAK keyword) -----
	// Separate phase BECAUSE sd_embed's setup.py declares unconstrained torch +
	// torchvision deps. Without --no-deps, pip would tear down our CUDA torch
	// and install the CPU wheel as a "satisfying" alternative. With --no-deps,
	// we just pull the sd_embed module bytes into site-packages and rely on
	// the engine's existing torch/transformers/ftfy install.
	emit(types.InstallProgress{
		Phase:   "extras",
		Message: "Installing sd-embed (weighted prompts) with --no-deps",
	})
	i.bus.Info("installer", "extras phase start", map[string]any{"tarball": SDEmbedTarball})
	if err := i.runPip(ctx, venvPython, "extras", emit,
		"install", "--no-deps", SDEmbedTarball,
	); err != nil {
		// Non-fatal: the engine works without sd_embed, just falls back to raw
		// prompts (with a runtime warning). Log + continue.
		i.bus.Warn("installer", "sd-embed install failed; engine will use raw prompts", map[string]any{
			"err": err.Error(),
		})
		emit(types.InstallProgress{Phase: "extras", Message: "sd-embed install failed (non-fatal)"})
	} else {
		emit(types.InstallProgress{Phase: "extras", Message: "sd-embed installed", PercentEstimate: 100})
	}

	// ----- Phase 7: download SDXL weights (optional) -----
	// Skipped when the caller supplies no ModelPath (e.g. user brings their own
	// checkpoint). The download is atomic + reuse-aware, so a Reinstall with the
	// model already present is a fast no-op rather than a 7 GB re-pull.
	if opts.ModelPath != "" {
		modelURL := opts.ModelURL
		if modelURL == "" {
			modelURL = SDXLModelURL
		}
		emit(types.InstallProgress{Phase: "model", Message: "Downloading SDXL weights (~6.9 GB)"})
		i.bus.Info("installer", "model phase start", map[string]any{"url": modelURL, "dest": opts.ModelPath})
		reused, derr := modelfetch.New(i.bus).Fetch(ctx, modelURL, opts.ModelPath, sdxlModelMinBytes,
			func(p modelfetch.Progress) {
				emit(types.InstallProgress{
					Phase:           "model",
					Message:         fmt.Sprintf("Downloading SDXL weights — %s / %s", humanBytes(p.Downloaded), humanBytes(p.Total)),
					PercentEstimate: p.Percent,
				})
			},
		)
		if derr != nil {
			i.bus.Error("installer", "model download failed", map[string]any{"err": derr.Error()})
			emit(types.InstallProgress{Phase: "error", Error: derr.Error(), Done: true})
			return derr
		}
		msg := "SDXL weights downloaded"
		if reused {
			msg = "SDXL weights already present, reusing"
		}
		i.bus.Info("installer", "model ok", map[string]any{"reused": reused, "path": opts.ModelPath})
		emit(types.InstallProgress{Phase: "model", Message: msg, PercentEstimate: 100})
	}

	// ----- Done -----
	i.bus.Info("installer", "install complete", map[string]any{"python": venvPython})
	emit(types.InstallProgress{
		Phase:           "done",
		Message:         "Engine ready at " + venvPython,
		PercentEstimate: 100,
		Done:            true,
	})
	return nil
}

// reinstallEngineOnly force-replaces just the imference-engine package (+ the
// best-effort sd-embed extra) in an existing venv, skipping the expensive
// torch / venv phases. The uninstall makes the pinned tarball authoritative (a
// direct-URL pip install can otherwise treat a same-named install as already
// satisfied), and the tarball's own pins pull any upgraded transitive deps
// (e.g. diffusers 0.38 -> 0.39). Shares the "engine"/"extras" phase labels with
// Install so the frontend's progress UI renders identically.
func (i *Installer) reinstallEngineOnly(
	ctx context.Context, venvDir string, emit func(types.InstallProgress),
) error {
	venvPython := venvPythonPath(venvDir)
	if _, err := os.Stat(venvPython); err != nil {
		e := fmt.Errorf("engine-only reinstall: venv python missing at %s", venvPython)
		emit(types.InstallProgress{Phase: "error", Error: e.Error(), Done: true})
		return e
	}

	// Force-uninstall first (best-effort: a missing package is not an error).
	emit(types.InstallProgress{Phase: "engine", Message: "Removing outdated imference-engine"})
	i.bus.Info("installer", "engine-only: uninstall", nil)
	_ = i.runPip(ctx, venvPython, "engine", emit, "uninstall", "-y", "imference-engine")

	engineSpec, editable := resolveEngineSource()
	emit(types.InstallProgress{Phase: "engine", Message: "Installing pinned imference-engine"})
	i.bus.Info("installer", "engine-only: install", map[string]any{"spec": engineSpec, "editable": editable})
	pipArgs := []string{"install"}
	if editable {
		pipArgs = append(pipArgs, "-e")
	}
	pipArgs = append(pipArgs, engineSpec)
	if err := i.runPip(ctx, venvPython, "engine", emit, pipArgs...); err != nil {
		emit(types.InstallProgress{Phase: "error", Error: err.Error(), Done: true})
		return err
	}
	emit(types.InstallProgress{Phase: "engine", Message: "imference-engine installed", PercentEstimate: 100})

	// sd-embed (weighted prompts) — same best-effort --no-deps as the full install.
	emit(types.InstallProgress{Phase: "extras", Message: "Installing sd-embed (weighted prompts) with --no-deps"})
	if err := i.runPip(ctx, venvPython, "extras", emit, "install", "--no-deps", SDEmbedTarball); err != nil {
		i.bus.Warn("installer", "sd-embed install failed; engine will use raw prompts", map[string]any{"err": err.Error()})
		emit(types.InstallProgress{Phase: "extras", Message: "sd-embed install failed (non-fatal)"})
	} else {
		emit(types.InstallProgress{Phase: "extras", Message: "sd-embed installed", PercentEstimate: 100})
	}

	i.bus.Info("installer", "engine-only reinstall complete", map[string]any{"python": venvPython})
	emit(types.InstallProgress{Phase: "done", Message: "Engine updated at " + venvPython, PercentEstimate: 100, Done: true})
	return nil
}

// ensureVenv returns (reused, error). When the venv at `dir` already has a
// working python.exe, it's reused — pip in the subsequent phases will say
// "already satisfied" for cached deps, turning a Reinstall click into a ~30s
// no-op instead of a 9 min rebuild. When the venv is missing or its python
// can't even report --version, we wipe + recreate from scratch.
//
// To force a true fresh install (e.g. to refresh the engine code from main
// when the version number hasn't bumped), delete the venv folder manually:
//
//	Remove-Item -Recurse "$env:LOCALAPPDATA\imference-desktop-go\engine-venv"
//
// then click Reinstall.
func (i *Installer) ensureVenv(ctx context.Context, pythonPath, dir string) (bool, error) {
	venvPython := venvPythonPath(dir)
	if _, err := os.Stat(venvPython); err == nil {
		checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		probe := exec.CommandContext(checkCtx, venvPython, "--version")
		probe.SysProcAttr = hideWindowAttr() // no console flash under the GUI build
		if probeErr := probe.Run(); probeErr == nil {
			i.bus.Info("installer", "reusing existing venv", map[string]any{"dir": dir})
			return true, nil
		}
		i.bus.Warn("installer", "existing venv python is broken, wiping", map[string]any{"dir": dir})
	}

	if _, err := os.Stat(dir); err == nil {
		i.bus.Info("installer", "wiping existing venv", map[string]any{"dir": dir})
		if err := os.RemoveAll(dir); err != nil {
			return false, fmt.Errorf("installer: wipe existing venv %s: %w", dir, err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(dir), 0o755); err != nil {
		return false, fmt.Errorf("installer: mkdir %s: %w", filepath.Dir(dir), err)
	}

	cmd := exec.CommandContext(ctx, pythonPath, "-m", "venv", dir)
	cmd.SysProcAttr = hideWindowAttr()
	out, err := cmd.CombinedOutput()
	if err != nil {
		i.bus.Error("installer", "venv create failed", map[string]any{
			"err":    err.Error(),
			"output": string(out),
		})
		return false, fmt.Errorf("installer: create venv: %w (output: %s)", err, string(out))
	}
	return false, nil
}

// pipProgressRE matches lines like:
//
//	"Downloading torch-2.6.0+cu121-cp311-cp311-win_amd64.whl (2.7 GB)"
//
// and the live-progress lines pip prints during big downloads:
//
//	"  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 1.2/2.7 GB 1.5 MB/s eta 0:14"
//
// We don't reliably get a percent from pip, so we estimate from the human-readable
// fraction. Best-effort — when it fails we just emit Percent=0 and the UI shows
// an indeterminate bar.
var pipFractionRE = regexp.MustCompile(`(\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)\s*([KMGT]?B)`)

// runPip executes `<venvPython> -m pip <args...>`, streams stdout/stderr line
// by line to the logbus (trace level), and tries to parse progress percentages
// out of pip's output to publish via emit().
func (i *Installer) runPip(
	ctx context.Context,
	venvPython, phase string,
	emit func(types.InstallProgress),
	args ...string,
) error {
	allArgs := append([]string{"-m", "pip"}, args...)
	cmd := exec.CommandContext(ctx, venvPython, allArgs...)
	cmd.SysProcAttr = hideWindowAttr()
	// Disable pip's animations so we get parseable per-line output.
	cmd.Env = append(os.Environ(),
		"PIP_PROGRESS_BAR=on", // keep progress, but on a new line each tick
		"PYTHONUNBUFFERED=1",  // flush per line
		"PIP_DISABLE_PIP_VERSION_CHECK=1",
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("installer: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("installer: stderr pipe: %w", err)
	}

	i.bus.Info("installer", "running pip", map[string]any{"args": args})
	start := time.Now()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("installer: pip start: %w", err)
	}

	// Drain both streams in parallel — they get the same treatment.
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); i.consumePipLines(stdout, phase, emit) }()
	go func() { defer wg.Done(); i.consumePipLines(stderr, phase, emit) }()
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("installer: pip %s failed: %w", phase, err)
	}
	i.bus.Info("installer", "pip ok", map[string]any{
		"phase":    phase,
		"duration": time.Since(start).String(),
	})
	return nil
}

func (i *Installer) consumePipLines(r io.Reader, phase string, emit func(types.InstallProgress)) {
	scanner := bufio.NewScanner(r)
	// pip download progress lines can be long-ish; bump the buffer.
	scanner.Buffer(make([]byte, 0, 64*1024), 256*1024)
	// Custom split: pip emits the live download progress with carriage returns
	// (\r) instead of newlines so a single terminal line gets overwritten in
	// place. Default ScanLines only sees \n, so during the ~5min torch download
	// we'd hear nothing. Splitting on either character lets each \r-update
	// surface as its own "line" — empty tokens get dropped by the consumer.
	scanner.Split(scanLinesOrCRs)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		i.bus.Trace("installer", line, nil)
		if pct, ok := parsePipPercent(line); ok {
			emit(types.InstallProgress{
				Phase:           phase,
				Message:         truncate(line, 120),
				PercentEstimate: pct,
			})
		}
	}
}

// scanLinesOrCRs is a bufio.SplitFunc that treats either \r or \n as a line
// terminator. Empty tokens are returned for consecutive separators (e.g. \r\n
// produces a token then an empty token); the consumer must filter them.
func scanLinesOrCRs(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func parsePipPercent(line string) (int, bool) {
	m := pipFractionRE.FindStringSubmatch(line)
	if m == nil {
		return 0, false
	}
	cur, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, false
	}
	tot, err := strconv.ParseFloat(m[2], 64)
	if err != nil || tot == 0 {
		return 0, false
	}
	pct := int((cur / tot) * 100)
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	return pct, true
}

// venvPythonPath returns the path to the venv's interpreter. On Windows venvs
// the exe lives at Scripts/python.exe; on POSIX it's bin/python.
func venvPythonPath(venvDir string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(venvDir, "Scripts", "python.exe")
	}
	return filepath.Join(venvDir, "bin", "python")
}

// VenvPython is the exported variant for callers (app.go) that need to read
// the resolved interpreter path after a successful install.
func VenvPython(venvDir string) string {
	return venvPythonPath(venvDir)
}

// EngineInfoFor probes whether a venv at the given path looks usable. We don't
// try to import imference_engine here — just check the interpreter exists, runs,
// and reports a version. The sidecar's healthz handles the deeper validation.
func EngineInfoFor(ctx context.Context, venvDir string) types.EngineInfo {
	py := venvPythonPath(venvDir)
	info := types.EngineInfo{VenvDir: venvDir, PythonPath: py, PinnedVersion: PinnedEngineVersion()}
	if _, err := os.Stat(py); err != nil {
		return info
	}
	probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	probe := exec.CommandContext(probeCtx, py, "--version")
	probe.SysProcAttr = hideWindowAttr() // no console flash under the GUI build
	if err := probe.Run(); err != nil {
		return info
	}
	info.Installed = true
	info.EngineVersion = probeEngineVersion(ctx, py)
	if info.PinnedVersion != "" && info.EngineVersion != "" &&
		info.EngineVersion != info.PinnedVersion {
		info.Outdated = true
	}
	return info
}

// probeEngineVersion reads the installed imference-engine version from the venv
// via importlib.metadata. Returns "" when the package isn't installed or the
// probe fails/times out — callers treat "" as "unknown, don't enforce".
func probeEngineVersion(ctx context.Context, py string) string {
	probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(probeCtx, py, "-c",
		"import importlib.metadata as m; print(m.version('imference-engine'))")
	cmd.SysProcAttr = hideWindowAttr()
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// humanBytes renders a byte count as a short human string ("6.9 GB"). Returns
// "?" for a negative total (server sent no Content-Length).
func humanBytes(n int64) string {
	if n < 0 {
		return "?"
	}
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for x := n / unit; x >= unit; x /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %cB", float64(n)/float64(div), "KMGTPE"[exp])
}
