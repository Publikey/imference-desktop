package installer

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"imference-desktop-go/internal/types"
)

const minPyMajor, minPyMinor = 3, 10

type pyCandidate struct {
	cmd  string
	args []string
}

// pythonSeriesPreference orders the minor series we ask for by name, best
// first. 3.12 leads because it has the widest wheel coverage for our stack
// (it's also the series AMD's ROCm-for-Windows wheels require — see
// rocmWindowsPythonSeries). Anything >= 3.10 is still accepted; this list only
// decides *which* interpreter wins on a machine that has several. A bare
// `python3` newer than everything here (3.14+) is accepted last: it generally
// resolves, but it's outside what the engine pin is tested against, so we
// prefer landing on a known-good series.
var pythonSeriesPreference = []string{"3.12", "3.11", "3.13", "3.10"}

// pythonCandidates is tried in order; first match >= 3.10 wins. On Windows the
// `py` launcher (PEP 397) is the preferred entry point because it knows about
// every installed interpreter. The versioned `pythonX.Y` names matter on
// macOS/Linux, where Homebrew and the python.org installer always ship them
// but bare `python3` may point at something too old (Xcode's 3.9 stub) or
// newer than we've tested. Bare `python3` / `python` stay last, for
// single-install machines.
var pythonCandidates = buildPythonCandidates()

func buildPythonCandidates() []pyCandidate {
	out := make([]pyCandidate, 0, 2*len(pythonSeriesPreference)+3)
	for _, s := range pythonSeriesPreference {
		out = append(out, pyCandidate{"py", []string{"-" + s}})
	}
	out = append(out, pyCandidate{"py", []string{"-3"}})
	for _, s := range pythonSeriesPreference {
		out = append(out, pyCandidate{"python" + s, nil})
	}
	return append(out, pyCandidate{"python3", nil}, pyCandidate{"python", nil})
}

// fallbackPythonPaths returns absolute interpreter locations to probe after
// the PATH candidates come up empty.
//
// PATH is not trustworthy for a bundled GUI app. An app launched from
// Finder/Dock on macOS inherits launchd's PATH — /usr/bin:/bin:/usr/sbin:/sbin
// — not the user's shell PATH. Homebrew (/opt/homebrew/bin), pyenv and conda
// are all invisible there, and the only `python3` on that PATH is Xcode's
// 3.9.6 stub, which fails the >= 3.10 floor. The user then gets "no Python
// found" on a machine with several usable interpreters installed. Probing
// absolute paths is the only reliable way out.
//
// Windows returns nil: the `py` launcher already enumerates every registered
// install independently of PATH.
func fallbackPythonPaths() []string {
	if runtime.GOOS == "windows" {
		return nil
	}

	out := make([]string, 0, 4*len(pythonSeriesPreference)+8)
	for _, s := range pythonSeriesPreference {
		out = append(out,
			"/opt/homebrew/bin/python"+s, // Homebrew, Apple Silicon
			"/usr/local/bin/python"+s,    // Homebrew on Intel; common Linux prefix
			"/opt/local/bin/python"+s,    // MacPorts
			"/Library/Frameworks/Python.framework/Versions/"+s+"/bin/python3", // python.org installer
		)
	}
	out = append(out, "/opt/homebrew/bin/python3", "/usr/local/bin/python3")

	home, err := os.UserHomeDir()
	if err != nil {
		return out
	}
	// Version-manager layouts we can't name exactly. Glob results come back
	// sorted, so the choice is deterministic; any match >= 3.10 is fine here.
	for _, pattern := range []string{
		".pyenv/versions/*/bin/python3",
		"miniconda3/bin/python3",
		"miniforge3/bin/python3",
		"anaconda3/bin/python3",
	} {
		matches, _ := filepath.Glob(filepath.Join(home, pattern))
		out = append(out, matches...)
	}
	return out
}

// DetectPython walks the candidates and returns the first interpreter that
// reports a version >= 3.10. Returns a typed error with a hint when nothing
// matches — the frontend surfaces the message directly.
func DetectPython(ctx context.Context) (types.PythonInfo, error) {
	var tried []string
	for _, c := range pythonCandidates {
		path, version, ok := probe(ctx, c.cmd, c.args)
		if ok {
			return types.PythonInfo{Path: path, Version: version}, nil
		}
		tried = append(tried, strings.TrimSpace(c.cmd+" "+strings.Join(c.args, " ")))
	}
	// PATH exhausted — try the absolute locations a GUI-launched app can't see.
	for _, p := range fallbackPythonPaths() {
		if path, version, ok := probe(ctx, p, nil); ok {
			return types.PythonInfo{Path: path, Version: version}, nil
		}
	}
	return types.PythonInfo{}, noPythonFoundError(tried)
}

// noPythonFoundError spells out where we looked. The previous message said
// only "not found on PATH", which is actively misleading when the app's PATH
// is launchd's four-entry default and the user is looking at a working
// `python3` in their terminal — so we print the PATH we actually searched.
func noPythonFoundError(tried []string) error {
	msg := fmt.Sprintf(
		"installer: no Python %d.%d+ found. Tried on PATH: %s",
		minPyMajor, minPyMinor, strings.Join(tried, ", "),
	)
	if n := len(fallbackPythonPaths()); n > 0 {
		msg += fmt.Sprintf("; also probed %d standard locations (Homebrew, python.org, MacPorts, pyenv, conda)", n)
	}
	msg += ". PATH was: " + os.Getenv("PATH")
	if runtime.GOOS == "darwin" {
		msg += ". Note: an app launched from Finder/Dock only sees " +
			"/usr/bin:/bin:/usr/sbin:/sbin, where the only python3 is Xcode's 3.9 stub"
	}
	return errors.New(msg + ". Install Python from https://www.python.org/downloads/ and click Install again")
}

// detectPythonSeries finds an interpreter of the exact "major.minor" series
// (e.g. "3.12") when series is non-empty, or delegates to DetectPython (any
// >= 3.10) when it's "". The exact-series path exists for AMD's
// ROCm-for-Windows torch wheels, which are built for a single Python ABI
// (cp312) — a 3.11 interpreter would pass the generic check and then fail the
// torch phase with pip's opaque "not a supported wheel on this platform".
func detectPythonSeries(ctx context.Context, series string) (types.PythonInfo, error) {
	if series == "" {
		return DetectPython(ctx)
	}
	candidates := []pyCandidate{
		{"py", []string{"-" + series}}, // Windows launcher, pinned
		{"python" + series, nil},
		{"python3", nil},
		{"python", nil},
	}
	var tried []string
	for _, c := range candidates {
		path, version, ok := probe(ctx, c.cmd, c.args)
		if ok && strings.HasPrefix(version, series+".") {
			return types.PythonInfo{Path: path, Version: version}, nil
		}
		tried = append(tried, strings.TrimSpace(c.cmd+" "+strings.Join(c.args, " ")))
	}
	// Same PATH-blindness caveat as DetectPython, filtered to the required
	// series. No-op on Windows (where this branch actually runs today), but it
	// keeps the two detection routes behaving alike if another platform ever
	// needs a pinned series.
	for _, p := range fallbackPythonPaths() {
		if path, version, ok := probe(ctx, p, nil); ok && strings.HasPrefix(version, series+".") {
			return types.PythonInfo{Path: path, Version: version}, nil
		}
	}
	return types.PythonInfo{}, fmt.Errorf(
		"installer: Python %s is required for AMD's ROCm-for-Windows torch wheels "+
			"(they are cp%s-only), but none was found on PATH (tried: %s). "+
			"Install Python %s from https://www.python.org/downloads/ then click Install again",
		series, strings.ReplaceAll(series, ".", ""), strings.Join(tried, ", "), series,
	)
}

// probe runs `<cmd> <args...> -c "import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])"`.
// This single-shot gives us both the interpreter's absolute path (more reliable
// than which/where) and the version in one parse — and trivially weeds out
// candidates that don't exist or aren't real Pythons.
func probe(ctx context.Context, cmd string, args []string) (path, version string, ok bool) {
	probeCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	args = append(append([]string(nil), args...),
		"-c",
		"import sys; print(sys.executable); print('%d.%d.%d' % sys.version_info[:3])",
	)
	probe := exec.CommandContext(probeCtx, cmd, args...)
	probe.SysProcAttr = hideWindowAttr() // no console flash under the GUI build
	out, err := probe.Output()
	if err != nil {
		return "", "", false
	}

	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 {
		return "", "", false
	}
	path = strings.TrimSpace(lines[0])
	version = strings.TrimSpace(lines[1])

	major, minor, err := parseMajorMinor(version)
	if err != nil {
		return "", "", false
	}
	if major < minPyMajor || (major == minPyMajor && minor < minPyMinor) {
		return "", "", false
	}
	return path, version, true
}

func parseMajorMinor(v string) (int, int, error) {
	parts := strings.SplitN(v, ".", 3)
	if len(parts) < 2 {
		return 0, 0, errors.New("not enough parts")
	}
	major, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	minor, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	return major, minor, nil
}
