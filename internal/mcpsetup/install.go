package mcpsetup

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Download fetches url into dest (the caller removes dest on failure).
// onPercent may be nil.
type Download func(ctx context.Context, url, dest string, onPercent func(int)) error

// Progress of an install, for the UI.
type Progress struct {
	// Stage: release, server, node, done.
	Stage   string `json:"stage"`
	Percent int    `json:"percent"`
}

// Release is the latest MCP release that carries the single-file server.
type Release struct {
	Version   string
	ScriptURL string
	SumsURL   string
}

var httpClient = &http.Client{Timeout: 30 * time.Second}

func getJSON(ctx context.Context, url string, v any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "imference-desktop")
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

func getText(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "imference-desktop")
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s: HTTP %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return string(b), err
}

// LatestRelease finds the newest MCP release with imference-mcp.js + SHA256SUMS.
func (e Env) LatestRelease(ctx context.Context) (Release, error) {
	var rel struct {
		TagName string `json:"tag_name"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := getJSON(ctx, strings.TrimRight(e.GitHubAPI, "/")+"/repos/"+Repo+"/releases/latest", &rel); err != nil {
		return Release{}, fmt.Errorf("can't reach the Imference MCP releases: %w", err)
	}
	out := Release{Version: strings.TrimPrefix(rel.TagName, "v")}
	for _, a := range rel.Assets {
		switch a.Name {
		case ScriptName:
			out.ScriptURL = a.URL
		case "SHA256SUMS":
			out.SumsURL = a.URL
		}
	}
	if out.ScriptURL == "" || out.SumsURL == "" {
		return Release{}, fmt.Errorf("the latest Imference MCP release (%s) has no %s to download yet", rel.TagName, ScriptName)
	}
	return out, nil
}

// sumFor reads "<sha256>  <name>" (or "<sha256> *<name>") lines.
func sumFor(sums, name string) string {
	sc := bufio.NewScanner(strings.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// fetchVerified downloads url to dest through a temp file, checks its sha256.
func fetchVerified(ctx context.Context, dl Download, url, dest, want string, onPercent func(int)) error {
	if want == "" {
		return fmt.Errorf("no checksum published for %s", filepath.Base(url))
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.part", dest, time.Now().UnixNano())
	defer os.Remove(tmp)
	if err := dl(ctx, url, tmp, onPercent); err != nil {
		return err
	}
	got, err := fileSHA256(tmp)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s doesn't match its published checksum (got %s…)", filepath.Base(url), got[:12])
	}
	_ = os.Remove(dest)
	return os.Rename(tmp, dest)
}

// InstallServer downloads the latest single-file server into Desktop's folder.
func (e Env) InstallServer(ctx context.Context, dl Download, onPercent func(int)) (Release, error) {
	rel, err := e.LatestRelease(ctx)
	if err != nil {
		return rel, err
	}
	sums, err := getText(ctx, rel.SumsURL)
	if err != nil {
		return rel, err
	}
	if err := fetchVerified(ctx, dl, rel.ScriptURL, e.ScriptPath(), sumFor(sums, ScriptName), onPercent); err != nil {
		return rel, err
	}
	b, _ := json.Marshal(map[string]string{"version": rel.Version})
	return rel, os.WriteFile(filepath.Join(e.Dir, desktopVersionFile), b, 0o644)
}

// nodeArchive is the official archive for this platform and the path of the
// node binary inside it.
func (e Env) nodeArchive() (name, inner string, err error) {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64"}[e.GOARCH]
	if arch == "" {
		return "", "", fmt.Errorf("no portable Node.js for %s/%s", e.GOOS, e.GOARCH)
	}
	v := "v" + NodeVersion
	switch e.GOOS {
	case "windows":
		base := "node-" + v + "-win-" + arch
		return base + ".zip", base + "/node.exe", nil
	case "darwin":
		base := "node-" + v + "-darwin-" + arch
		return base + ".tar.gz", base + "/bin/node", nil
	case "linux":
		base := "node-" + v + "-linux-" + arch
		return base + ".tar.gz", base + "/bin/node", nil
	}
	return "", "", fmt.Errorf("no portable Node.js for %s", e.GOOS)
}

// InstallNode downloads the official portable Node.js (sha256 from
// nodejs.org's SHASUMS256.txt) and keeps only the node binary.
func (e Env) InstallNode(ctx context.Context, dl Download, onPercent func(int)) error {
	name, inner, err := e.nodeArchive()
	if err != nil {
		return err
	}
	base := strings.TrimRight(e.NodeDist, "/") + "/v" + NodeVersion + "/"
	sums, err := getText(ctx, base+"SHASUMS256.txt")
	if err != nil {
		return fmt.Errorf("can't reach nodejs.org: %w", err)
	}
	archive := filepath.Join(e.Dir, "node", name)
	defer os.Remove(archive)
	if err := fetchVerified(ctx, dl, base+name, archive, sumFor(sums, name), onPercent); err != nil {
		return err
	}
	dest := e.NodePath()
	tmp := dest + ".part"
	defer os.Remove(tmp)
	if strings.HasSuffix(name, ".zip") {
		err = extractZip(archive, inner, tmp)
	} else {
		err = extractTarGz(archive, inner, tmp)
	}
	if err != nil {
		return err
	}
	_ = os.Remove(dest)
	return os.Rename(tmp, dest)
}

func writeExec(r io.Reader, dest string) error {
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, r); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func extractZip(archive, inner, dest string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, f := range zr.File {
		if f.Name != inner {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		defer rc.Close()
		return writeExec(rc, dest)
	}
	return fmt.Errorf("%s not found in the Node.js archive", inner)
}

func extractTarGz(archive, inner, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return fmt.Errorf("%s not found in the Node.js archive", inner)
		}
		if err != nil {
			return err
		}
		if h.Name == inner && h.Typeflag == tar.TypeReg {
			return writeExec(tr, dest)
		}
	}
}

// Ensure makes sure a server and a Node to run it are on disk: the user's
// Node when it fits, else the portable one; Desktop's copy of the server
// (downloaded when missing, or when update is set). Returns the command to
// put in a client config.
func (e Env) Ensure(ctx context.Context, dl Download, update bool, onProgress func(Progress)) (command string, args []string, version string, err error) {
	report := func(stage string, pct int) {
		if onProgress != nil {
			onProgress(Progress{Stage: stage, Percent: pct})
		}
	}
	nodes := e.FindNodes(ctx)
	node := BestNode(nodes)
	in := e.desktopInstall()
	if in == nil && !update && node != nil {
		// An npm-global install recent enough: use it, nothing to download.
		for _, g := range e.FindInstalls(nodes) {
			if g.Kind == "npm-global" && AtLeast(g.Version, MinMCP) {
				in = &g
				break
			}
		}
	}
	if in == nil || update {
		report("server", 0)
		rel, err := e.InstallServer(ctx, dl, func(p int) { report("server", p) })
		if err != nil {
			return "", nil, "", err
		}
		in = &Install{Kind: "desktop", Script: e.ScriptPath(), Version: rel.Version}
	}
	if node == nil {
		report("node", 0)
		if err := e.InstallNode(ctx, dl, func(p int) { report("node", p) }); err != nil {
			return "", nil, "", err
		}
		node = BestNode(e.FindNodes(ctx))
		if node == nil {
			return "", nil, "", errors.New("the downloaded Node.js doesn't start on this computer")
		}
	}
	report("done", 100)
	return node.Path, []string{in.Script}, in.Version, nil
}
