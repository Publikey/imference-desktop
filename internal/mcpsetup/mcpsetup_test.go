package mcpsetup

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestVersions(t *testing.T) {
	for _, c := range []struct {
		v, min string
		ok     bool
	}{
		{"v22.21.1", MinNode, true}, {"v20.10.0", MinNode, true}, {"v20.9.0", MinNode, false},
		{"v18.20.4", MinNode, false}, {"0.5.0", MinMCP, true}, {"0.4.9", MinMCP, false}, {"", MinMCP, false},
		{"0.5.0-rc1", MinMCP, true},
	} {
		if got := AtLeast(c.v, c.min); got != c.ok {
			t.Errorf("AtLeast(%q, %q) = %v", c.v, c.min, got)
		}
	}
	if !Newer("0.5.1", "0.5.0") || Newer("0.5.0", "0.5.0") || Newer("", "0.1.0") {
		t.Fatal("Newer")
	}
}

func fakeEnv(t *testing.T) Env {
	t.Helper()
	home := t.TempDir()
	return Env{
		GOOS: "windows", GOARCH: "amd64", Home: home,
		AppData: filepath.Join(home, "AppData", "Roaming"), LocalAppData: filepath.Join(home, "AppData", "Local"),
		Dir:      filepath.Join(home, "AppData", "Roaming", "imference-desktop-go", "mcp"),
		LookPath: func(string) (string, error) { return "", exec.ErrNotFound },
		Output:   func(context.Context, string, ...string) (string, error) { return "", errors.New("no") },
	}
}

func writeJSON(t *testing.T, path string, v any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFindClients(t *testing.T) {
	e := fakeEnv(t)
	cdPath := filepath.Join(e.AppData, "Claude", "claude_desktop_config.json")
	writeJSON(t, cdPath, map[string]any{
		"preferences": map[string]any{"x": 1},
		"mcpServers": map[string]any{
			"imf":    map[string]any{"command": "npx", "args": []string{"-y", "imference-mcp"}, "env": map[string]string{"IMFERENCE_API_KEY": "k"}},
			"other":  map[string]any{"command": "docker", "args": []string{"run", "x"}},
			"mine":   map[string]any{"command": `C:\nodejs\node.exe`, "args": []string{filepath.Join(e.Dir, ScriptName)}},
			"global": map[string]any{"command": "node", "args": []string{`C:\Users\u\AppData\Roaming\npm\node_modules\imference-mcp\dist\index.js`}},
		},
	})
	writeJSON(t, filepath.Join(e.Home, ".claude.json"), map[string]any{
		"mcpServers": map[string]any{"openseo": map[string]any{"command": "x"}},
		"projects": map[string]any{
			`C:/proj`: map[string]any{"mcpServers": map[string]any{"imference": map[string]any{"command": "node", "args": []string{`C:\dev\Imference-mcp\dist\index.js`}}}},
		},
	})
	cs := e.FindClients()
	cd, cc := cs[0], cs[1]
	if !cd.Installed || cd.ConfigPath != cdPath || len(cd.Entries) != 3 {
		t.Fatalf("claude desktop = %+v", cd)
	}
	modes := map[string]string{}
	for _, en := range cd.Entries {
		modes[en.Name] = en.Mode
	}
	if modes["imf"] != "npx" || modes["mine"] != "desktop" || modes["global"] != "npm-global" {
		t.Fatalf("modes = %v", modes)
	}
	if !cd.Entries[1].HasAPIKey { // sorted: global, imf, mine
		t.Fatalf("api key flag: %+v", cd.Entries)
	}
	if !cc.Installed || len(cc.Entries) != 1 || cc.Entries[0].Scope != "C:/proj" || cc.Entries[0].Mode != "other" {
		t.Fatalf("claude code = %+v", cc)
	}
}

func TestConnectClaudeDesktopMergesAndBacksUp(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "claude_desktop_config.json")
	orig := `{"preferences":{"theme":"dark"},"mcpServers":{"other":{"command":"x"},"imference":{"command":"old","env":{"IMFERENCE_API_KEY":"kept"}}}}`
	if err := os.WriteFile(path, []byte(orig), 0o644); err != nil {
		t.Fatal(err)
	}
	res, err := ConnectClaudeDesktop(path, Server{Command: `C:\n\node.exe`, Args: []string{`C:\m\imference-mcp.js`}})
	if err != nil || !res.Done || !res.Restart {
		t.Fatalf("connect: %+v %v", res, err)
	}
	if b, _ := os.ReadFile(res.Backup); string(b) != orig {
		t.Fatalf("backup = %s", b)
	}
	var doc map[string]any
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	if doc["preferences"].(map[string]any)["theme"] != "dark" {
		t.Fatal("preferences lost")
	}
	servers := doc["mcpServers"].(map[string]any)
	if servers["other"] == nil {
		t.Fatal("other server lost")
	}
	imf := servers[ServerName].(map[string]any)
	if imf["command"] != `C:\n\node.exe` || imf["env"].(map[string]any)["IMFERENCE_API_KEY"] != "kept" {
		t.Fatalf("entry = %v", imf)
	}

	// Invalid JSON: never overwritten.
	_ = os.WriteFile(path, []byte("{nope"), 0o644)
	if _, err := ConnectClaudeDesktop(path, Server{Command: "n"}); err == nil {
		t.Fatal("invalid JSON must not be overwritten")
	}
	if b, _ := os.ReadFile(path); string(b) != "{nope" {
		t.Fatal("file changed")
	}

	// No file yet: created, no backup.
	fresh := filepath.Join(dir, "sub", "c.json")
	res, err = ConnectClaudeDesktop(fresh, Server{Command: "n", Args: []string{"s"}, Env: map[string]string{"IMFERENCE_API_KEY": "k"}})
	if err != nil || res.Backup != "" {
		t.Fatalf("fresh: %+v %v", res, err)
	}
}

func TestClaudeCode(t *testing.T) {
	s := Server{Command: `C:\Program Files\nodejs\node.exe`, Args: []string{`C:\m\imference-mcp.js`}, Env: map[string]string{"IMFERENCE_API_KEY": "k"}}
	want := `claude mcp add -s user imference -e IMFERENCE_API_KEY=k -- "C:\Program Files\nodejs\node.exe" "C:\m\imference-mcp.js"`
	if got := ClaudeCodeCommand(s); got != want {
		t.Fatalf("command:\n%s\n%s", got, want)
	}
	e := fakeEnv(t)
	var calls [][]string
	e.Output = func(_ context.Context, name string, args ...string) (string, error) {
		calls = append(calls, append([]string{name}, args...))
		return "", nil
	}
	res, err := e.ConnectClaudeCode(context.Background(), "claude", s)
	if err != nil || !res.Done || len(calls) != 2 || calls[0][2] != "remove" || calls[1][2] != "add" {
		t.Fatalf("cli: %+v %v %v", res, err, calls)
	}
	res, _ = e.ConnectClaudeCode(context.Background(), "", s)
	if res.Done || res.Manual != want {
		t.Fatalf("no cli: %+v", res)
	}
	if !strings.Contains(s.Snippet(), `"mcpServers"`) {
		t.Fatal("snippet")
	}
}

func sha(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func copyDownload(ctx context.Context, url, dest string, onPercent func(int)) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return errors.New(resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = io.Copy(f, resp.Body)
	if onPercent != nil {
		onPercent(100)
	}
	return err
}

func TestInstallServerAndNode(t *testing.T) {
	script := []byte("#!/usr/bin/env node\nconsole.log('hi')\n")
	var zbuf bytes.Buffer
	zw := zip.NewWriter(&zbuf)
	w, _ := zw.Create("node-v" + NodeVersion + "-win-x64/node.exe")
	_, _ = w.Write([]byte("NODEEXE"))
	_ = zw.Close()
	var tbuf bytes.Buffer
	gz := gzip.NewWriter(&tbuf)
	tw := tar.NewWriter(gz)
	body := []byte("NODEBIN")
	_ = tw.WriteHeader(&tar.Header{Name: "node-v" + NodeVersion + "-darwin-arm64/bin/node", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	_ = gz.Close()

	tamper := false
	mux := http.NewServeMux()
	var srv *httptest.Server
	mux.HandleFunc("/repos/"+Repo+"/releases/latest", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"tag_name": "v0.5.0", "assets": []map[string]string{
			{"name": ScriptName, "browser_download_url": srv.URL + "/dl/" + ScriptName},
			{"name": "SHA256SUMS", "browser_download_url": srv.URL + "/dl/SHA256SUMS"},
		}})
	})
	mux.HandleFunc("/dl/"+ScriptName, func(w http.ResponseWriter, _ *http.Request) {
		if tamper {
			_, _ = w.Write([]byte("evil"))
			return
		}
		_, _ = w.Write(script)
	})
	mux.HandleFunc("/dl/SHA256SUMS", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, sha(script)+"  "+ScriptName+"\n")
	})
	zipName := "node-v" + NodeVersion + "-win-x64.zip"
	tgzName := "node-v" + NodeVersion + "-darwin-arm64.tar.gz"
	mux.HandleFunc("/dist/v"+NodeVersion+"/SHASUMS256.txt", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, sha(zbuf.Bytes())+"  "+zipName+"\n"+sha(tbuf.Bytes())+"  "+tgzName+"\n")
	})
	mux.HandleFunc("/dist/v"+NodeVersion+"/"+zipName, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(zbuf.Bytes()) })
	mux.HandleFunc("/dist/v"+NodeVersion+"/"+tgzName, func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(tbuf.Bytes()) })
	srv = httptest.NewServer(mux)
	defer srv.Close()

	e := fakeEnv(t)
	e.GitHubAPI, e.NodeDist = srv.URL, srv.URL+"/dist"
	ctx := context.Background()
	rel, err := e.InstallServer(ctx, copyDownload, nil)
	if err != nil || rel.Version != "0.5.0" {
		t.Fatalf("install server: %+v %v", rel, err)
	}
	if b, _ := os.ReadFile(e.ScriptPath()); !bytes.Equal(b, script) {
		t.Fatal("script content")
	}
	if in := e.desktopInstall(); in == nil || in.Version != "0.5.0" {
		t.Fatalf("desktop install = %+v", in)
	}
	tamper = true
	if _, err := e.InstallServer(ctx, copyDownload, nil); err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("tampered: %v", err)
	}
	if b, _ := os.ReadFile(e.ScriptPath()); !bytes.Equal(b, script) {
		t.Fatal("a bad download replaced the good copy")
	}

	if err := e.InstallNode(ctx, copyDownload, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(e.NodePath()); string(b) != "NODEEXE" {
		t.Fatalf("node.exe = %q", b)
	}
	mac := e
	mac.GOOS, mac.GOARCH, mac.Dir = "darwin", "arm64", t.TempDir()
	if err := mac.InstallNode(ctx, copyDownload, nil); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(mac.NodePath()); string(b) != "NODEBIN" {
		t.Fatalf("node = %q", b)
	}

	// No release asset yet: a clear error.
	e2 := e
	e2.GitHubAPI = srv.URL + "/none"
	if _, err := e2.LatestRelease(ctx); err == nil {
		t.Fatal("missing release must fail")
	}
}

// Check runs a real server: a tiny Node script that answers initialize.
func TestCheck(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	dir := t.TempDir()
	ok := filepath.Join(dir, "ok.js")
	_ = os.WriteFile(ok, []byte(`process.stdin.once("data", () => {
  process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"imference",version:"9.9.9"}}}) + "\n");
});`), 0o644)
	bad := filepath.Join(dir, "bad.js")
	_ = os.WriteFile(bad, []byte(`console.error("Fatal: boom"); process.exit(1)`), 0o644)
	e := DefaultEnv(dir)
	if v, err := e.Check(context.Background(), node, []string{ok}); err != nil || v != "9.9.9" {
		t.Fatalf("ok: %q %v", v, err)
	}
	if _, err := e.Check(context.Background(), node, []string{bad}); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("bad: %v", err)
	}
	if _, err := e.Check(context.Background(), filepath.Join(dir, "missing-node"), nil); err == nil {
		t.Fatal("missing command")
	}
	nodes := e.FindNodes(context.Background())
	if len(nodes) == 0 || BestNode(nodes) == nil || runtime.GOOS == "" {
		t.Fatalf("nodes = %+v", nodes)
	}
}
