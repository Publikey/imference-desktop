package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"time"

	"imference-desktop-go/internal/mcpsetup"
	"imference-desktop-go/internal/modelfetch"
)

// Settings › AI agents: connect Claude (or any MCP client) to Imference
// through the Imference MCP server, downloaded on demand (internal/mcpsetup).
//
//   - MCPStatus: what's on this computer (Node.js, the server, which clients
//     already run it and whether it starts).
//   - ConnectMCP: makes sure a server + a Node.js are on disk, then configures
//     the client (Claude Desktop's config file, Claude Code's CLI) or returns
//     the snippet to paste in any other client.
//   - UpdateMCP: replaces Desktop's copy with the latest release.
// Progress of downloads: the "mcp:progress" event ({stage, percent}).

// MCPStatusInfo is the AI agents pane.
type MCPStatusInfo struct {
	mcpsetup.Status
	// Latest release of the server ("" = unknown: offline, or not checked).
	Latest string `json:"latest"`
	// UpdateAvailable: Desktop's copy is older than Latest.
	UpdateAvailable bool `json:"updateAvailable"`
	// MinVersion: the oldest server that generates through Desktop.
	MinVersion string `json:"minVersion"`
	// APIKeySet: a credits API key is saved (what "let AI agents spend my credits" hands out).
	APIKeySet bool `json:"apiKeySet"`
}

// mcpEnv is the machine as mcpsetup sees it (tests replace it).
var mcpEnv = func() mcpsetup.Env {
	dir, _ := os.UserConfigDir()
	return mcpsetup.DefaultEnv(filepath.Join(dir, "imference-desktop-go"))
}

// mcpMu serializes installs and connects (two clicks, one download).
var mcpMu sync.Mutex

// MCPStatus reports the setup. check: also start each configured server once
// and look up the latest release (a few seconds).
func (a *App) MCPStatus(check bool) MCPStatusInfo {
	e := mcpEnv()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	info := MCPStatusInfo{Status: e.Detect(ctx, check), MinVersion: mcpsetup.MinMCP, APIKeySet: a.settings.Get().APIKey != ""}
	if check {
		if rel, err := e.LatestRelease(ctx); err == nil {
			info.Latest = rel.Version
			for _, in := range info.Installs {
				if in.Kind == "desktop" && mcpsetup.Newer(rel.Version, in.Version) {
					info.UpdateAvailable = true
				}
			}
		}
	}
	return info
}

func (a *App) mcpDownload(ctx context.Context, url, dest string, onPercent func(int)) error {
	_, err := modelfetch.New(a.bus).Fetch(ctx, url, dest, 1<<62, func(p modelfetch.Progress) {
		if onPercent != nil {
			onPercent(p.Percent)
		}
	})
	return err
}

func (a *App) mcpEnsure(ctx context.Context, update bool) (string, []string, error) {
	cmd, args, version, err := mcpEnv().Ensure(ctx, a.mcpDownload, update, func(p mcpsetup.Progress) {
		if a.canEmit() {
			a.emit("mcp:progress", p)
		}
	})
	if err != nil {
		a.bus.Warn("mcp", "MCP server setup failed", map[string]any{"err": err.Error()})
		return "", nil, err
	}
	a.bus.Info("mcp", "MCP server ready", map[string]any{"node": cmd, "server": args, "version": version})
	return cmd, args, nil
}

// ConnectMCP configures client ("claude-desktop", "claude-code" or "other")
// to run the Imference MCP server, downloading what's missing first. No key
// goes into the client's config: for cloud runs the server asks Desktop for
// the account's key, when Settings › AI agents allows it.
func (a *App) ConnectMCP(client string) (mcpsetup.ConnectResult, error) {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	cmd, args, err := a.mcpEnsure(ctx, false)
	if err != nil {
		return mcpsetup.ConnectResult{Client: client}, err
	}
	s := mcpsetup.Server{Command: cmd, Args: args}
	e := mcpEnv()
	var res mcpsetup.ConnectResult
	switch client {
	case "claude-desktop":
		res, err = mcpsetup.ConnectClaudeDesktop(findClient(e, client).ConfigPath, s)
	case "claude-code":
		c := findClient(e, client)
		// Repairing keeps what the previous user-scope entry had in its env.
		for _, en := range c.Entries {
			if en.Scope == "user" && en.Name == mcpsetup.ServerName {
				for k, v := range en.Env {
					if _, set := s.Env[k]; !set {
						if s.Env == nil {
							s.Env = map[string]string{}
						}
						s.Env[k] = v
					}
				}
			}
		}
		res, err = e.ConnectClaudeCode(ctx, c.CLI, s)
	case "other":
		res = mcpsetup.ConnectResult{Client: client, Manual: s.Snippet()}
	default:
		return res, errors.New("unknown client " + client)
	}
	fields := map[string]any{"client": client, "done": res.Done}
	if err != nil {
		fields["err"] = err.Error()
		a.bus.Warn("mcp", "connect failed", fields)
	} else {
		a.bus.Info("mcp", "client connected", fields)
	}
	return res, err
}

// UpdateMCP replaces Desktop's copy of the server with the latest release
// (the clients' configs point at the same file: nothing else to change).
func (a *App) UpdateMCP() error {
	mcpMu.Lock()
	defer mcpMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	_, _, err := a.mcpEnsure(ctx, true)
	return err
}

func findClient(e mcpsetup.Env, id string) mcpsetup.Client {
	for _, c := range e.FindClients() {
		if c.ID == id {
			return c
		}
	}
	return mcpsetup.Client{ID: id}
}
