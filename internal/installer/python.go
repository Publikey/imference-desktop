package installer

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
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

// pythonCandidates is tried in order; first match >= 3.10 wins. On Windows the
// `py` launcher (PEP 397) is the preferred entry point because it knows about
// every installed interpreter; we still fall back to bare `python3` / `python`
// for users who have a single install on PATH.
var pythonCandidates = []pyCandidate{
	{"py", []string{"-3.11"}},
	{"py", []string{"-3.10"}},
	{"py", []string{"-3"}},
	{"python3", nil},
	{"python", nil},
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
		tried = append(tried, c.cmd+" "+strings.Join(c.args, " "))
	}
	return types.PythonInfo{}, fmt.Errorf(
		"installer: no Python %d.%d+ found on PATH (tried: %s). Install from https://www.python.org/downloads/",
		minPyMajor, minPyMinor, strings.Join(tried, ", "),
	)
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
