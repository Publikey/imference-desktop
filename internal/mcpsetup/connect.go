package mcpsetup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ConnectResult says what Connect did.
type ConnectResult struct {
	Client string `json:"client"`
	// Done: the client is configured. False with Manual set: run/copy it yourself.
	Done bool `json:"done"`
	// ConfigPath: the file written (Claude Desktop).
	ConfigPath string `json:"configPath,omitempty"`
	// Backup: the previous config, copied before writing.
	Backup string `json:"backup,omitempty"`
	// Manual: a command (Claude Code without its CLI) or a JSON snippet (other apps).
	Manual string `json:"manual,omitempty"`
	// Restart: the client must be restarted to load the server.
	Restart bool `json:"restart"`
}

// Server is what a client runs.
type Server struct {
	Command string
	Args    []string
	Env     map[string]string
}

func (s Server) json() map[string]any {
	m := map[string]any{"command": s.Command, "args": s.Args}
	if len(s.Env) > 0 {
		m["env"] = s.Env
	}
	return m
}

// Snippet is the mcpServers block to paste in any client's config.
func (s Server) Snippet() string {
	b, _ := json.MarshalIndent(map[string]any{"mcpServers": map[string]any{ServerName: s.json()}}, "", "  ")
	return string(b)
}

// ConnectClaudeDesktop writes mcpServers.imference into Claude Desktop's
// config, keeping everything else (its own preferences included). The
// previous file is copied to <file>.bak first.
func ConnectClaudeDesktop(path string, s Server) (ConnectResult, error) {
	res := ConnectResult{Client: "claude-desktop", ConfigPath: path, Restart: true}
	doc := map[string]any{}
	old, err := os.ReadFile(path)
	switch {
	case err == nil && len(bytes.TrimSpace(old)) > 0:
		if err := json.Unmarshal(old, &doc); err != nil {
			return res, fmt.Errorf("Claude Desktop's config isn't valid JSON, so it wasn't changed (%s): %w", path, err)
		}
		res.Backup = path + ".bak"
		if err := os.WriteFile(res.Backup, old, 0o600); err != nil {
			return res, err
		}
	case err != nil && !errors.Is(err, os.ErrNotExist):
		return res, err
	}
	servers, _ := doc["mcpServers"].(map[string]any)
	if servers == nil {
		servers = map[string]any{}
	}
	// Repairing keeps what the user put in the entry's env (an API key…)
	// unless this connect sets it.
	if prev, ok := servers[ServerName].(map[string]any); ok {
		if env, ok := prev["env"].(map[string]any); ok {
			merged := map[string]string{}
			for k, v := range env {
				if sv, ok := v.(string); ok {
					merged[k] = sv
				}
			}
			for k, v := range s.Env {
				merged[k] = v
			}
			s.Env = merged
		}
	}
	servers[ServerName] = s.json()
	doc["mcpServers"] = servers
	out, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return res, err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return res, err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, append(out, '\n'), 0o600); err != nil {
		return res, err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return res, err
	}
	res.Done = true
	return res, nil
}

// quoteArg quotes a shell argument when needed (for a command to copy).
func quoteArg(a string) string {
	if a != "" && !strings.ContainsAny(a, " \t\"'$`\\&|;<>()") {
		return a
	}
	return `"` + strings.ReplaceAll(a, `"`, `\"`) + `"`
}

// claudeAddArgs: `claude mcp add -s user imference [-e K=V]… -- command args…`.
func claudeAddArgs(s Server) []string {
	args := []string{"mcp", "add", "-s", "user", ServerName}
	keys := make([]string, 0, len(s.Env))
	for k := range s.Env {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "-e", k+"="+s.Env[k])
	}
	return append(append(args, "--", s.Command), s.Args...)
}

// ClaudeCodeCommand is the command to run by hand.
func ClaudeCodeCommand(s Server) string {
	parts := []string{"claude"}
	for _, a := range claudeAddArgs(s) {
		parts = append(parts, quoteArg(a))
	}
	return strings.Join(parts, " ")
}

// ConnectClaudeCode adds the server at user scope with Claude Code's CLI
// (replacing a previous "imference" entry). Without the CLI, the result
// carries the command to run.
func (e Env) ConnectClaudeCode(ctx context.Context, cli string, s Server) (ConnectResult, error) {
	res := ConnectResult{Client: "claude-code", Restart: true}
	if cli == "" {
		res.Manual = ClaudeCodeCommand(s)
		return res, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, _ = e.Output(ctx, cli, "mcp", "remove", "-s", "user", ServerName)
	if _, err := e.Output(ctx, cli, claudeAddArgs(s)...); err != nil {
		res.Manual = ClaudeCodeCommand(s)
		return res, fmt.Errorf("claude mcp add failed (%v): run the command below in a terminal", err)
	}
	res.Done = true
	return res, nil
}
