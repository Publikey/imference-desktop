package mcpsetup

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Node is one Node.js found on the machine.
type Node struct {
	Path    string `json:"path"`
	Version string `json:"version"`
	// Source: system (the user's own install) or desktop (Desktop's portable copy).
	Source string `json:"source"`
	// OK: recent enough for the MCP server (>= MinNode).
	OK bool `json:"ok"`
}

// Install is a copy of the MCP server on disk.
type Install struct {
	// Kind: desktop (Desktop's copy) or npm-global.
	Kind    string `json:"kind"`
	Script  string `json:"script"`
	Version string `json:"version"`
}

// Entry is one imference-mcp server configured in a client.
type Entry struct {
	// Scope: user, or the project folder (Claude Code project-scoped servers).
	Scope   string   `json:"scope"`
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	// Mode: desktop (Desktop's copy), npm-global, npx (latest from npm at
	// each start), other (a dev checkout, a custom path…).
	Mode      string `json:"mode"`
	HasAPIKey bool   `json:"hasApiKey"`
	// Health: ok, failed, unchecked (npx, or not checked yet).
	Health      string `json:"health"`
	HealthError string `json:"healthError,omitempty"`
	// Version is what the server reported (health check), when known.
	Version string `json:"version,omitempty"`
	// Env is kept to re-check and repair; never sent to the UI.
	Env map[string]string `json:"-"`
}

// Client is one AI app Desktop knows how to connect.
type Client struct {
	// ID: claude-desktop, claude-code.
	ID   string `json:"id"`
	Name string `json:"name"`
	// Installed: the app (its config folder, or its CLI) is on this computer.
	Installed bool `json:"installed"`
	// ConfigPath: Claude Desktop's config file.
	ConfigPath string `json:"configPath,omitempty"`
	// CLI: Claude Code's `claude` executable ("" = not on PATH).
	CLI     string  `json:"cli,omitempty"`
	Entries []Entry `json:"entries"`
}

// Status is what the Settings pane shows.
type Status struct {
	Node     *Node     `json:"node"`
	Nodes    []Node    `json:"nodes"`
	Installs []Install `json:"installs"`
	Clients  []Client  `json:"clients"`
	// Script: the server Desktop would connect (its copy, else an npm-global one).
	Script        string `json:"script"`
	ScriptVersion string `json:"scriptVersion"`
	Dir           string `json:"dir"`
}

// ---------------------------------------------------------------------------
// Node.js
// ---------------------------------------------------------------------------

func (e Env) nodeVersion(ctx context.Context, path string) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	v, err := e.Output(ctx, path, "--version")
	if err != nil || !strings.HasPrefix(v, "v") {
		return ""
	}
	return v
}

// nodeCandidates lists the places a Node.js may live, best guesses first.
func (e Env) nodeCandidates(ctx context.Context) []string {
	var out []string
	if p, err := e.LookPath("node"); err == nil {
		out = append(out, p)
	}
	if e.GOOS == "windows" {
		for _, base := range []string{os.Getenv("ProgramFiles"), `C:\Program Files`} {
			if base != "" {
				out = append(out, filepath.Join(base, "nodejs", "node.exe"))
			}
		}
		if e.AppData != "" {
			out = append(out, filepath.Join(e.AppData, "nvm", "*", "node.exe"))
		}
		if e.LocalAppData != "" {
			out = append(out, filepath.Join(e.LocalAppData, "Volta", "bin", "node.exe"))
		}
		return expand(out)
	}
	// A GUI app doesn't see the terminal's PATH (nvm, Homebrew on Apple
	// Silicon): ask the login shell, then look in the usual folders.
	if e.Shell != "" {
		sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		if p, err := e.Output(sctx, e.Shell, "-lc", "command -v node"); err == nil && filepath.IsAbs(p) {
			out = append(out, p)
		}
		cancel()
	}
	out = append(out,
		"/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node",
		filepath.Join(e.Home, ".volta", "bin", "node"),
		filepath.Join(e.Home, ".nvm", "versions", "node", "*", "bin", "node"),
		filepath.Join(e.Home, ".local", "share", "fnm", "node-versions", "*", "installation", "bin", "node"),
		filepath.Join(e.Home, ".asdf", "shims", "node"),
	)
	return expand(out)
}

// expand resolves globs (newest version folder first) and drops duplicates.
func expand(paths []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, p := range paths {
		matches := []string{p}
		if strings.Contains(p, "*") {
			matches, _ = filepath.Glob(p)
			sort.Slice(matches, func(i, j int) bool { return Newer(versionInPath(matches[i]), versionInPath(matches[j])) })
		}
		for _, m := range matches {
			key := strings.ToLower(filepath.Clean(m))
			if seen[key] {
				continue
			}
			if fi, err := os.Stat(m); err != nil || fi.IsDir() {
				continue
			}
			seen[key] = true
			out = append(out, m)
		}
	}
	return out
}

func versionInPath(p string) string {
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		if strings.HasPrefix(part, "v") && strings.Count(part, ".") >= 1 {
			return part
		}
	}
	return ""
}

// FindNodes lists the usable-or-not Node.js installs; the first OK one wins
// (the user's own, then Desktop's portable copy).
func (e Env) FindNodes(ctx context.Context) []Node {
	var out []Node
	for _, p := range e.nodeCandidates(ctx) {
		if v := e.nodeVersion(ctx, p); v != "" {
			out = append(out, Node{Path: p, Version: v, Source: "system", OK: AtLeast(v, MinNode)})
		}
	}
	if p := e.NodePath(); fileExists(p) {
		if v := e.nodeVersion(ctx, p); v != "" {
			out = append(out, Node{Path: p, Version: v, Source: "desktop", OK: AtLeast(v, MinNode)})
		}
	}
	return out
}

// BestNode is the Node.js to run the server with (nil = none fits).
func BestNode(nodes []Node) *Node {
	for i := range nodes {
		if nodes[i].OK {
			return &nodes[i]
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Installs
// ---------------------------------------------------------------------------

// desktopVersionFile records the release Desktop's copy came from.
const desktopVersionFile = "version.json"

func (e Env) desktopInstall() *Install {
	if !fileExists(e.ScriptPath()) {
		return nil
	}
	in := &Install{Kind: "desktop", Script: e.ScriptPath()}
	if b, err := os.ReadFile(filepath.Join(e.Dir, desktopVersionFile)); err == nil {
		var v struct{ Version string }
		if json.Unmarshal(b, &v) == nil {
			in.Version = v.Version
		}
	}
	return in
}

// npmGlobalRoots: where `npm i -g` puts packages, for each Node found.
func (e Env) npmGlobalRoots(nodes []Node) []string {
	var roots []string
	if e.GOOS == "windows" {
		if e.AppData != "" {
			roots = append(roots, filepath.Join(e.AppData, "npm", "node_modules"))
		}
		for _, n := range nodes {
			roots = append(roots, filepath.Join(filepath.Dir(n.Path), "node_modules"))
		}
		return roots
	}
	for _, n := range nodes {
		// <prefix>/bin/node → <prefix>/lib/node_modules
		roots = append(roots, filepath.Join(filepath.Dir(filepath.Dir(n.Path)), "lib", "node_modules"))
	}
	return roots
}

// FindInstalls lists Desktop's copy and npm-global installs.
func (e Env) FindInstalls(nodes []Node) []Install {
	var out []Install
	if in := e.desktopInstall(); in != nil {
		out = append(out, *in)
	}
	seen := map[string]bool{}
	for _, root := range e.npmGlobalRoots(nodes) {
		pkg := filepath.Join(root, "imference-mcp")
		key := strings.ToLower(filepath.Clean(pkg))
		if seen[key] {
			continue
		}
		seen[key] = true
		b, err := os.ReadFile(filepath.Join(pkg, "package.json"))
		if err != nil {
			continue
		}
		var meta struct{ Version string }
		_ = json.Unmarshal(b, &meta)
		script := filepath.Join(pkg, "dist", "index.js")
		if fileExists(script) {
			out = append(out, Install{Kind: "npm-global", Script: script, Version: meta.Version})
		}
	}
	return out
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// ClaudeDesktopConfigs: where Claude Desktop reads claude_desktop_config.json
// (the Microsoft Store build keeps its own virtualized copy).
func (e Env) ClaudeDesktopConfigs() []string {
	switch e.GOOS {
	case "windows":
		var out []string
		if e.AppData != "" {
			out = append(out, filepath.Join(e.AppData, "Claude", "claude_desktop_config.json"))
		}
		if e.LocalAppData != "" {
			if m, _ := filepath.Glob(filepath.Join(e.LocalAppData, "Packages", "Claude_*", "LocalCache", "Roaming", "Claude")); len(m) > 0 {
				out = append(out, filepath.Join(m[0], "claude_desktop_config.json"))
			}
		}
		return out
	case "darwin":
		return []string{filepath.Join(e.Home, "Library", "Application Support", "Claude", "claude_desktop_config.json")}
	default:
		return []string{filepath.Join(e.Home, ".config", "Claude", "claude_desktop_config.json")}
	}
}

// claudeCodeConfig is Claude Code's user config (~/.claude.json).
func (e Env) claudeCodeConfig() string { return filepath.Join(e.Home, ".claude.json") }

type serverJSON struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

func readServers(path string) (map[string]serverJSON, map[string]map[string]serverJSON, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, nil, err
	}
	var doc struct {
		MCPServers map[string]serverJSON `json:"mcpServers"`
		Projects   map[string]struct {
			MCPServers map[string]serverJSON `json:"mcpServers"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(b, &doc); err != nil {
		return nil, nil, fmt.Errorf("%s: %w", path, err)
	}
	projects := map[string]map[string]serverJSON{}
	for p, v := range doc.Projects {
		if len(v.MCPServers) > 0 {
			projects[p] = v.MCPServers
		}
	}
	return doc.MCPServers, projects, nil
}

// isImference: the entry runs imference-mcp (whatever its name).
func isImference(s serverJSON) bool {
	if strings.Contains(strings.ToLower(s.Command), "imference-mcp") {
		return true
	}
	for _, a := range s.Args {
		if strings.Contains(strings.ToLower(a), "imference-mcp") {
			return true
		}
	}
	return false
}

func (e Env) entryMode(s serverJSON) string {
	all := strings.ToLower(s.Command + " " + strings.Join(s.Args, " "))
	base := strings.ToLower(strings.TrimSuffix(filepath.Base(s.Command), filepath.Ext(s.Command)))
	switch {
	case base == "npx" || strings.Contains(all, "npx"):
		return "npx"
	case strings.Contains(all, strings.ToLower(filepath.Clean(e.Dir))):
		return "desktop"
	case strings.Contains(filepath.ToSlash(all), "node_modules/imference-mcp"):
		return "npm-global"
	default:
		return "other"
	}
}

func (e Env) toEntries(scope string, servers map[string]serverJSON) []Entry {
	names := make([]string, 0, len(servers))
	for n := range servers {
		names = append(names, n)
	}
	sort.Strings(names)
	var out []Entry
	for _, n := range names {
		s := servers[n]
		if !isImference(s) {
			continue
		}
		_, key := s.Env["IMFERENCE_API_KEY"]
		out = append(out, Entry{Scope: scope, Name: n, Command: s.Command, Args: s.Args, Mode: e.entryMode(s),
			HasAPIKey: key, Health: "unchecked", Env: s.Env})
	}
	return out
}

// FindClients reads each client's configuration.
func (e Env) FindClients() []Client {
	var clients []Client

	cd := Client{ID: "claude-desktop", Name: "Claude Desktop", Entries: []Entry{}}
	for _, p := range e.ClaudeDesktopConfigs() {
		if dirExists(filepath.Dir(p)) {
			cd.Installed = true
			if cd.ConfigPath == "" || fileExists(p) {
				cd.ConfigPath = p
			}
		}
		if servers, _, err := readServers(p); err == nil {
			cd.Entries = append(cd.Entries, e.toEntries("user", servers)...)
		}
	}
	if cd.ConfigPath == "" {
		cd.ConfigPath = e.ClaudeDesktopConfigs()[0]
	}
	clients = append(clients, cd)

	cc := Client{ID: "claude-code", Name: "Claude Code", Entries: []Entry{}}
	if p, err := e.LookPath("claude"); err == nil {
		cc.CLI = p
	} else if p := filepath.Join(e.Home, ".local", "bin", e.exe("claude")); fileExists(p) {
		cc.CLI = p
	}
	if servers, projects, err := readServers(e.claudeCodeConfig()); err == nil {
		cc.Installed = true
		cc.Entries = append(cc.Entries, e.toEntries("user", servers)...)
		dirs := make([]string, 0, len(projects))
		for d := range projects {
			dirs = append(dirs, d)
		}
		sort.Strings(dirs)
		for _, d := range dirs {
			cc.Entries = append(cc.Entries, e.toEntries(d, projects[d])...)
		}
	}
	cc.Installed = cc.Installed || cc.CLI != ""
	clients = append(clients, cc)
	return clients
}

// Detect gathers the whole picture. check: also start each configured server
// once (except npx ones) to see that it answers.
func (e Env) Detect(ctx context.Context, check bool) Status {
	st := Status{Dir: e.Dir, Installs: []Install{}}
	st.Nodes = e.FindNodes(ctx)
	st.Node = BestNode(st.Nodes)
	st.Installs = append(st.Installs, e.FindInstalls(st.Nodes)...)
	if st.Nodes == nil {
		st.Nodes = []Node{}
	}
	for _, in := range st.Installs {
		if in.Kind == "desktop" || st.Script == "" {
			st.Script, st.ScriptVersion = in.Script, in.Version
		}
	}
	st.Clients = e.FindClients()
	if check {
		var wg sync.WaitGroup
		for ci := range st.Clients {
			for ei := range st.Clients[ci].Entries {
				en := &st.Clients[ci].Entries[ei]
				if en.Mode == "npx" {
					continue
				}
				wg.Add(1)
				go func() {
					defer wg.Done()
					v, err := e.Check(ctx, en.Command, en.Args)
					if err != nil {
						en.Health, en.HealthError = "failed", err.Error()
						return
					}
					en.Health, en.Version = "ok", v
				}()
			}
		}
		wg.Wait()
	}
	return st
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

// CheckTimeout bounds one start of the server.
var CheckTimeout = 20 * time.Second

// Check starts the server like a client would, sends an MCP initialize and
// returns the version it reports.
func (e Env) Check(ctx context.Context, command string, args []string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, CheckTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, command, args...)
	hideWindow(cmd)
	// The bundled tool catalog: no network call before answering.
	cmd.Env = append(os.Environ(), "IMFERENCE_TOOLS_CATALOG=bundled")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	var stderr strings.Builder
	cmd.Stderr = &limitWriter{w: &stderr, n: 4096}
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("can't start %s: %w", command, err)
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()
	init := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"imference-desktop-check","version":"0"}}}` + "\n"
	if _, err := io.WriteString(stdin, init); err != nil {
		return "", err
	}
	type res struct {
		v   string
		err error
	}
	ch := make(chan res, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			var msg struct {
				ID     any `json:"id"`
				Result struct {
					ServerInfo struct{ Name, Version string } `json:"serverInfo"`
				} `json:"result"`
			}
			if json.Unmarshal(sc.Bytes(), &msg) == nil && msg.Result.ServerInfo.Name != "" {
				ch <- res{v: msg.Result.ServerInfo.Version}
				return
			}
		}
		ch <- res{err: errors.New("the server exited without answering")}
	}()
	select {
	case r := <-ch:
		if r.err != nil {
			return "", withStderr(r.err, stderr.String())
		}
		return r.v, nil
	case <-ctx.Done():
		return "", withStderr(errors.New("the server didn't answer in time"), stderr.String())
	}
}

func withStderr(err error, stderr string) error {
	var lines []string
	for _, l := range strings.Split(strings.ReplaceAll(stderr, "\r", ""), "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return err
	}
	// Node prints "Error: Cannot find module …" above its stack: that line says it all.
	for _, l := range lines {
		if strings.Contains(l, "Error") || strings.HasPrefix(l, "Fatal") {
			return fmt.Errorf("%w: %s", err, l)
		}
	}
	return fmt.Errorf("%w: %s", err, lines[len(lines)-1])
}

type limitWriter struct {
	w io.Writer
	n int
}

func (l *limitWriter) Write(p []byte) (int, error) {
	if l.n > 0 {
		k := min(len(p), l.n)
		_, _ = l.w.Write(p[:k])
		l.n -= k
	}
	return len(p), nil
}

func fileExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && !fi.IsDir()
}

func dirExists(p string) bool {
	fi, err := os.Stat(p)
	return err == nil && fi.IsDir()
}
