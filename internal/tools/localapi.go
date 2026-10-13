package tools

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/logbus"
)

// Local HTTP API for agents (the MCP server's run_on: local). Loopback only,
// Bearer token, discovery file next to the settings:
//
//	<UserConfigDir>/imference-desktop-go/local-api.json = {"port","token","pid"}  (0600)
//
//	GET  /v1/tools            -> {"version", "tools": [<catalog entry> + "local_available"]}
//	POST /v1/tools/{tool_id}  {"inputs": {name: path | https url | data URI | [...]}, "params": {...}}
//	                          -> {"tool_id", "outputs": [{name, type, format, path, text?}], "duration_ms"}
//	                          or {"error": {code, message}} (400 / 503 / 500)
//
// Runs are LOCAL ONLY and synchronous; outputs are also saved to the gallery.

// PreferredAPIPort is tried first so agents usually find a stable address;
// a random free port is used when it is taken.
const PreferredAPIPort = 47823

const (
	defaultInputMaxMB = 50
	apiBodyMaxBytes   = 64 << 20 // JSON body (data URIs included)
	urlFetchTimeout   = 2 * time.Minute
)

// APIOutput is one output in the API answer.
type APIOutput struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Format string `json:"format"`
	Path   string `json:"path,omitempty"`
	Text   string `json:"text,omitempty"`
}

// APIResult is a finished run.
type APIResult struct {
	ToolID     string      `json:"tool_id"`
	Outputs    []APIOutput `json:"outputs"`
	DurationMs int64       `json:"duration_ms"`
}

// APIBackend is what the server needs from the app.
type APIBackend interface {
	// LocalAvailable reports whether the tool can run on this machine now.
	LocalAvailable(toolID string) bool
	// RunLocal runs the tool locally on materialized input paths.
	RunLocal(ctx context.Context, toolID string, inputs map[string][]string, params map[string]any) (*APIResult, *Error)
}

// APIServer is the agents' HTTP API.
type APIServer struct {
	Catalog *Catalog
	Backend APIBackend
	Bus     *logbus.Bus
	Token   string
	// HTTPClient fetches URL inputs (tests swap it).
	HTTPClient *http.Client
	// AllowHTTP lets tests use plain-http URL inputs (production: https only).
	AllowHTTP bool

	mu       sync.Mutex
	srv      *http.Server
	listener net.Listener
	discPath string
}

// NewToken returns 32 random bytes, hex.
func NewToken() string {
	var b [32]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

// DiscoveryPath is <UserConfigDir>/imference-desktop-go/local-api.json.
func DiscoveryPath() (string, error) {
	dir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "imference-desktop-go", "local-api.json"), nil
}

// Discovery is the discovery file's content.
type Discovery struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
	PID   int    `json:"pid"`
}

// WriteDiscovery writes the discovery file (0600, atomic).
func WriteDiscovery(path string, d Discovery) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	data, _ := json.Marshal(d)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	_ = os.Chmod(tmp, 0o600)
	return os.Rename(tmp, path)
}

// RemoveDiscovery deletes the discovery file if it still belongs to this
// process (a second app instance may have replaced it).
func RemoveDiscovery(path string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var d Discovery
	if json.Unmarshal(raw, &d) == nil && d.PID != 0 && d.PID != os.Getpid() {
		return
	}
	_ = os.Remove(path)
}

// Start listens on 127.0.0.1 (preferred port, else random), serves, and writes
// the discovery file at discPath ("" = no file). Returns the port.
func (s *APIServer) Start(discPath string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.srv != nil {
		return s.listener.Addr().(*net.TCPAddr).Port, nil
	}
	if s.Token == "" {
		s.Token = NewToken()
	}
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", PreferredAPIPort))
	if err != nil {
		ln, err = net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			return 0, err
		}
	}
	port := ln.Addr().(*net.TCPAddr).Port
	s.listener = ln
	s.srv = &http.Server{Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func(srv *http.Server) { _ = srv.Serve(ln) }(s.srv)
	if discPath != "" {
		if err := WriteDiscovery(discPath, Discovery{Port: port, Token: s.Token, PID: os.Getpid()}); err != nil {
			s.Bus.Warn("tools", "local API discovery file not written", map[string]any{"err": err.Error()})
		} else {
			s.discPath = discPath
		}
	}
	s.Bus.Info("tools", "local tools API listening", map[string]any{"addr": ln.Addr().String()})
	return port, nil
}

// Port returns the listening port (0 when stopped).
func (s *APIServer) Port() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener == nil {
		return 0
	}
	return s.listener.Addr().(*net.TCPAddr).Port
}

// Stop shuts the server down and removes the discovery file.
func (s *APIServer) Stop() {
	s.mu.Lock()
	srv, disc := s.srv, s.discPath
	s.srv, s.listener, s.discPath = nil, nil, ""
	s.mu.Unlock()
	if disc != "" {
		RemoveDiscovery(disc)
	}
	if srv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}
}

// Handler is the routed, authenticated handler (exposed for httptest).
func (s *APIServer) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/tools", s.handleList)
	mux.HandleFunc("POST /v1/tools/{tool_id}", s.handleRun)
	mux.HandleFunc("GET /v1/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Browsers must not drive this API: refuse anything carrying an Origin
		// (a web page on another site) — agents and the MCP server send none.
		if r.Header.Get("Origin") != "" {
			writeErr(w, http.StatusForbidden, &Error{Code: CodeInvalidInput, Message: "cross-origin requests are not allowed"})
			return
		}
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		if s.Token == "" || subtle.ConstantTimeCompare([]byte(got), []byte(s.Token)) != 1 {
			writeErr(w, http.StatusUnauthorized, &Error{Code: CodeInvalidInput, Message: "missing or invalid bearer token"})
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (s *APIServer) handleList(w http.ResponseWriter, _ *http.Request) {
	tools := make([]json.RawMessage, 0, len(s.Catalog.Tools))
	for _, t := range s.Catalog.Tools {
		var m map[string]any
		if err := json.Unmarshal(s.Catalog.Raw(t.ID), &m); err != nil {
			continue
		}
		m["local_available"] = s.Backend.LocalAvailable(t.ID)
		b, _ := json.Marshal(m)
		tools = append(tools, b)
	}
	writeJSON(w, http.StatusOK, map[string]any{"version": s.Catalog.Version, "tools": tools})
}

type runBody struct {
	Inputs map[string]json.RawMessage `json:"inputs"`
	Params map[string]any             `json:"params"`
}

func (s *APIServer) handleRun(w http.ResponseWriter, r *http.Request) {
	toolID := r.PathValue("tool_id")
	t, ok := s.Catalog.Get(toolID)
	if !ok {
		writeErr(w, http.StatusNotFound, &Error{Code: CodeInvalidInput, Message: fmt.Sprintf("unknown tool %q", toolID), Field: "tool_id"})
		return
	}
	var body runBody
	dec := json.NewDecoder(io.LimitReader(r.Body, apiBodyMaxBytes))
	if err := dec.Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: "invalid JSON body: " + err.Error()})
		return
	}
	if !s.Backend.LocalAvailable(toolID) {
		writeErr(w, http.StatusServiceUnavailable, &Error{Code: CodeUnsupportedRuntime,
			Message: "this tool cannot run locally on this computer right now (use run_on: cloud)"})
		return
	}
	work, err := os.MkdirTemp("", "imference-api-")
	if err != nil {
		writeErr(w, http.StatusInternalServerError, &Error{Code: CodeInternal, Message: err.Error()})
		return
	}
	defer os.RemoveAll(work)

	inputs := map[string][]string{}
	for name, raw := range body.Inputs {
		spec, known := t.Input(name)
		if !known {
			writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: fmt.Sprintf("unknown input %q", name), Field: name})
			return
		}
		var vals []string
		var one string
		if json.Unmarshal(raw, &one) == nil {
			vals = []string{one}
		} else if json.Unmarshal(raw, &vals) != nil {
			writeErr(w, http.StatusBadRequest, &Error{Code: CodeInvalidInput, Message: "input " + name + " must be a string or a list of strings", Field: name})
			return
		}
		for i, v := range vals {
			p, terr := s.materialize(r.Context(), v, spec, filepath.Join(work, fmt.Sprintf("%s-%d", name, i)))
			if terr != nil {
				terr.Field = name
				writeErr(w, statusFor(terr.Code), terr)
				return
			}
			inputs[name] = append(inputs[name], p)
		}
	}
	res, terr := s.Backend.RunLocal(r.Context(), toolID, inputs, body.Params)
	if terr != nil {
		writeErr(w, statusFor(terr.Code), terr)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// materialize turns a path / https URL / data URI into a local file path.
func (s *APIServer) materialize(ctx context.Context, v string, spec InputSpec, destStem string) (string, *Error) {
	maxMB := spec.MaxMB
	if maxMB <= 0 {
		maxMB = defaultInputMaxMB
	}
	limit := int64(maxMB * (1 << 20))
	tooLarge := &Error{Code: CodeTooLarge, Message: fmt.Sprintf("input is over %g MB", maxMB)}
	v = strings.TrimSpace(v)
	switch {
	case v == "":
		return "", &Error{Code: CodeInvalidInput, Message: "empty input"}
	case strings.HasPrefix(v, "data:"):
		comma := strings.IndexByte(v, ',')
		if comma < 0 || !strings.Contains(v[:comma], ";base64") {
			return "", &Error{Code: CodeInvalidInput, Message: "data URI must be base64"}
		}
		if int64(len(v)-comma)*3/4 > limit {
			return "", tooLarge
		}
		data, err := base64.StdEncoding.DecodeString(v[comma+1:])
		if err != nil {
			return "", &Error{Code: CodeInvalidInput, Message: "data URI: " + err.Error()}
		}
		mt := strings.TrimSuffix(strings.TrimPrefix(v[:comma], "data:"), ";base64")
		dest := destStem + extFor(mt, "")
		if err := os.WriteFile(dest, data, 0o600); err != nil {
			return "", &Error{Code: CodeInternal, Message: err.Error()}
		}
		return dest, nil
	case strings.HasPrefix(v, "https://") || (s.AllowHTTP && strings.HasPrefix(v, "http://")):
		return s.fetchURL(ctx, v, limit, destStem, tooLarge)
	case strings.HasPrefix(v, "http://"):
		return "", &Error{Code: CodeInvalidInput, Message: "only https URLs are accepted"}
	default:
		p := v
		if strings.HasPrefix(p, "file://") {
			if u, err := url.Parse(p); err == nil {
				p = u.Path
			}
		}
		if !filepath.IsAbs(p) {
			return "", &Error{Code: CodeInvalidInput, Message: "local paths must be absolute: " + v}
		}
		st, err := os.Stat(p)
		if err != nil || st.IsDir() {
			return "", &Error{Code: CodeInvalidInput, Message: "file not found: " + v}
		}
		if st.Size() > limit {
			return "", tooLarge
		}
		return p, nil
	}
}

func (s *APIServer) fetchURL(ctx context.Context, src string, limit int64, destStem string, tooLarge *Error) (string, *Error) {
	client := s.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: urlFetchTimeout}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		return "", &Error{Code: CodeInvalidInput, Message: "bad URL: " + err.Error()}
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", &Error{Code: CodeInvalidInput, Message: "could not fetch input: " + err.Error()}
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", &Error{Code: CodeInvalidInput, Message: fmt.Sprintf("could not fetch input: HTTP %d", resp.StatusCode)}
	}
	if resp.ContentLength > limit {
		return "", tooLarge
	}
	u, _ := url.Parse(src)
	dest := destStem + extFor(resp.Header.Get("Content-Type"), filepath.Ext(u.Path))
	f, err := os.Create(dest)
	if err != nil {
		return "", &Error{Code: CodeInternal, Message: err.Error()}
	}
	n, err := io.Copy(f, io.LimitReader(resp.Body, limit+1))
	f.Close()
	if err != nil {
		return "", &Error{Code: CodeInvalidInput, Message: "could not fetch input: " + err.Error()}
	}
	if n > limit {
		return "", tooLarge
	}
	return dest, nil
}

// extFor picks a file extension from a MIME type, else the fallback.
func extFor(mimeType, fallback string) string {
	mt, _, _ := mime.ParseMediaType(mimeType)
	switch mt {
	case "image/png":
		return ".png"
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	case "video/mp4":
		return ".mp4"
	case "video/webm":
		return ".webm"
	case "video/quicktime":
		return ".mov"
	}
	if fallback != "" && len(fallback) <= 6 {
		return strings.ToLower(fallback)
	}
	return ".bin"
}

// statusFor maps a tool error code to the API's HTTP status.
func statusFor(code string) int {
	switch code {
	case CodeInvalidInput, CodeTooLarge:
		return http.StatusBadRequest
	case CodeUnsupportedRuntime, CodeWeightsMissing, CodeOOM:
		return http.StatusServiceUnavailable
	}
	return http.StatusInternalServerError
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, e *Error) {
	out := map[string]any{"code": e.Code, "message": e.Message}
	if e.Field != "" {
		out["field"] = e.Field
	}
	writeJSON(w, status, map[string]any{"error": out})
}

// ErrAPIDisabled is returned when the user turned the local API off.
var ErrAPIDisabled = errors.New("local tools API disabled in Settings")
