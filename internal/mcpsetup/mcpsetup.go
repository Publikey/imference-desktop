// Package mcpsetup connects AI apps (Claude Desktop, Claude Code…) to
// Imference through the Imference MCP server (github.com/Publikey/Imference-mcp).
//
// Desktop doesn't embed the MCP server: it finds what's already there, and
// downloads what's missing on demand.
//
//   - Detect: is imference-mcp already wired into a client (any mcpServers
//     entry whose command/args mention imference-mcp), installed (npm global,
//     or Desktop's own copy), and is there a Node.js >= MinNode (PATH, the
//     login shell on macOS, common install folders, Desktop's own copy)?
//   - Install: the single-file server (imference-mcp.js, a GitHub release
//     asset, sha256-checked) and, only when no usable Node is found, the
//     official portable Node (nodejs.org, sha256-checked).
//   - Connect: Claude Desktop's claude_desktop_config.json (merged, .bak
//     first), Claude Code through its CLI (`claude mcp add -s user`), or a
//     snippet to copy for any other client. Absolute paths everywhere, so the
//     client never depends on its own PATH to find node.
package mcpsetup

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	// ServerName is the mcpServers key Desktop writes.
	ServerName = "imference"
	// MinNode is the oldest Node.js the MCP server runs on (its engines field).
	MinNode = "20.10.0"
	// NodeVersion is the portable Node.js Desktop downloads when none fits.
	NodeVersion = "22.21.1"
	// MinMCP is the first MCP version that generates through Desktop (run_on).
	MinMCP = "0.5.0"
	// Repo hosts the MCP releases (imference-mcp.js + SHA256SUMS).
	Repo = "Publikey/Imference-mcp"
	// ScriptName is the single-file server.
	ScriptName = "imference-mcp.js"
)

// Env is everything detection and installation read from the machine
// (tests fake it).
type Env struct {
	GOOS, GOARCH string
	Home         string
	// AppData / LocalAppData: Windows only.
	AppData, LocalAppData string
	// Dir is Desktop's MCP folder (<UserConfigDir>/imference-desktop-go/mcp).
	Dir      string
	LookPath func(file string) (string, error)
	// Output runs a command and returns its trimmed stdout.
	Output func(ctx context.Context, name string, args ...string) (string, error)
	// Shell is the login shell (macOS/Linux: $SHELL), "" = none.
	Shell string
	// GitHubAPI / NodeDist override the download hosts (tests).
	GitHubAPI, NodeDist string
}

// DefaultEnv reads the real machine. configRoot is Desktop's config folder
// (<UserConfigDir>/imference-desktop-go).
func DefaultEnv(configRoot string) Env {
	home, _ := os.UserHomeDir()
	return Env{
		GOOS: runtime.GOOS, GOARCH: runtime.GOARCH, Home: home,
		AppData: os.Getenv("APPDATA"), LocalAppData: os.Getenv("LOCALAPPDATA"),
		Dir:      filepath.Join(configRoot, "mcp"),
		LookPath: exec.LookPath,
		Output: func(ctx context.Context, name string, args ...string) (string, error) {
			cmd := exec.CommandContext(ctx, name, args...)
			hideWindow(cmd)
			out, err := cmd.Output()
			return strings.TrimSpace(string(out)), err
		},
		Shell:     os.Getenv("SHELL"),
		GitHubAPI: "https://api.github.com",
		NodeDist:  "https://nodejs.org/dist",
	}
}

func (e Env) exe(name string) string {
	if e.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// ScriptPath is Desktop's copy of the server.
func (e Env) ScriptPath() string { return filepath.Join(e.Dir, ScriptName) }

// NodePath is Desktop's portable Node.js.
func (e Env) NodePath() string { return filepath.Join(e.Dir, "node", e.exe("node")) }

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

func segments(v string) [3]int {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+ "); i >= 0 {
		v = v[:i]
	}
	var out [3]int
	for i, p := range strings.SplitN(v, ".", 3) {
		n, _ := strconv.Atoi(p)
		out[i] = n
	}
	return out
}

// AtLeast reports whether version v >= min ("v22.1.0", "0.5.0"…).
func AtLeast(v, min string) bool {
	if strings.TrimSpace(v) == "" {
		return false
	}
	a, b := segments(v), segments(min)
	for i := range a {
		if a[i] != b[i] {
			return a[i] > b[i]
		}
	}
	return true
}

// Newer reports whether a > b.
func Newer(a, b string) bool { return a != "" && AtLeast(a, b) && !AtLeast(b, a) }
