//go:build web

package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"imference-desktop-go/internal/types"
)

const (
	sessionCookie = "imweb_session"
	csrfHeader    = "X-Imference-Web" // required on every POST: a cross-site form cannot set it
	maxCallBody   = 64 << 20          // tool inputs arrive as data URIs
)

type webConfig struct {
	basePath string // "" or e.g. "/app" when served behind the API's /app proxy
	dataDir  string
	apiBase  string // "" = https://imference.com
	secure   bool   // Secure cookie (behind HTTPS)
	// serverGallery keeps generated images on the server (IMFERENCE_WEB_GALLERY=server).
	// Default: the gallery lives on the user's disk, written by the browser.
	serverGallery bool
	idleAfter     time.Duration
	// checkKey validates an API key; nil = ask the imference API (GET /credits/balance).
	checkKey func(ctx context.Context, apiKey string) error
}

// webUser is one signed-in user: one cloud-only App, shared by their tabs.
type webUser struct {
	id     string // sha256(api key)[:16] — also the data folder name
	apiKey string
	app    *App

	mu       sync.Mutex
	subs     map[chan []byte]struct{}
	lastSeen time.Time
}

type webServer struct {
	cfg    webConfig
	assets fs.FS
	rpc    *rpcTable

	mu       sync.Mutex
	users    map[string]*webUser // by user id
	sessions map[string]string   // session id -> user id
}

func newWebServer(cfg webConfig, assets fs.FS) *webServer {
	if cfg.checkKey == nil {
		cfg.checkKey = func(ctx context.Context, key string) error { return checkKeyRemote(ctx, cfg.apiBase, key) }
	}
	return &webServer{cfg: cfg, assets: assets, rpc: newRPCTable(),
		users: map[string]*webUser{}, sessions: map[string]string{}}
}

// routes mounts the app under cfg.basePath. The frontend only uses relative
// URLs (assets, web/call, web/events, login), so the same build works at "/"
// and under a prefix such as "/app/".
func (s *webServer) routes() http.Handler {
	mux := s.mux()
	base := strings.TrimRight(s.cfg.basePath, "/")
	if base == "" {
		return securityHeaders(mux)
	}
	outer := http.NewServeMux()
	outer.Handle(base+"/", http.StripPrefix(base, mux))
	outer.HandleFunc(base, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, base+"/", http.StatusMovedPermanently)
	})
	return securityHeaders(outer)
}

func (s *webServer) mux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "ok") })
	mux.HandleFunc("GET /login", s.loginPage)
	mux.HandleFunc("POST /web/login", s.login)
	mux.HandleFunc("POST /web/logout", s.logout)
	mux.HandleFunc("POST /web/call", s.call)
	mux.HandleFunc("GET /web/events", s.events)
	mux.HandleFunc("GET /", s.static)
	return mux
}

// path prefixes p with the base path (for redirects and cookies).
func (s *webServer) path(p string) string {
	return strings.TrimRight(s.cfg.basePath, "/") + p
}

// ------------------------------------------------------------ sessions

func userID(apiKey string) string {
	sum := sha256.Sum256([]byte("imference-web:" + apiKey))
	return hex.EncodeToString(sum[:8])
}

func (s *webServer) userFor(r *http.Request) *webUser {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	uid, ok := s.sessions[c.Value]
	if !ok {
		return nil
	}
	u := s.users[uid]
	if u != nil {
		u.mu.Lock()
		u.lastSeen = time.Now()
		u.mu.Unlock()
	}
	return u
}

// ensureUser returns the user's App, creating it (cloud-only, own folders).
func (s *webServer) ensureUser(apiKey string) (*webUser, error) {
	uid := userID(apiKey)
	s.mu.Lock()
	defer s.mu.Unlock()
	if u := s.users[uid]; u != nil {
		return u, nil
	}
	root := filepath.Join(s.cfg.dataDir, "users", uid)
	if err := os.MkdirAll(filepath.Join(root, "gallery"), 0o700); err != nil {
		return nil, err
	}
	app := newApp(appOptions{configDir: root, outputDir: filepath.Join(root, "gallery"), cloudOnly: true,
		clientGallery: !s.cfg.serverGallery})
	u := &webUser{id: uid, apiKey: apiKey, app: app, subs: map[chan []byte]struct{}{}, lastSeen: time.Now()}
	app.ctx = context.Background()
	if s.cfg.apiBase != "" {
		app.cloud.SetBaseURL(s.cfg.apiBase)
	}
	app.emitter = u.publish
	app.bus.SetEmitter(func(name string, data ...any) { app.emit(name, data...) })
	// Persist the web invariants (API key, credits rail, cloud tools) once.
	if _, err := app.SaveSettings(webSettings(app.GetSettings(), u)); err != nil {
		return nil, err
	}
	app.applyToolsSettings(types.ToolsSettings{Mode: "cloud", LocalAPIDisabled: true})
	// Cloud jobs interrupted while the user was away finish now.
	go app.resumePendingCloud()
	s.users[uid] = u
	return u, nil
}

func (u *webUser) publish(name string, data ...any) {
	var payload any
	if len(data) == 1 {
		payload = data[0]
	} else if len(data) > 1 {
		payload = data
	}
	b, err := json.Marshal(map[string]any{"name": name, "data": payload})
	if err != nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	for ch := range u.subs {
		select {
		case ch <- b:
		default: // slow tab: drop rather than block the App
		}
	}
}

// evictLoop drops Apps idle for cfg.idleAfter with no open event stream.
// Pending cloud jobs are persisted and resume at the next sign-in.
func (s *webServer) evictLoop() {
	for range time.Tick(time.Minute) {
		s.evictIdle(time.Now())
	}
}

func (s *webServer) evictIdle(now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for uid, u := range s.users {
		u.mu.Lock()
		idle := len(u.subs) == 0 && now.Sub(u.lastSeen) > s.cfg.idleAfter
		u.mu.Unlock()
		if idle {
			delete(s.users, uid)
			for sid, v := range s.sessions {
				if v == uid {
					delete(s.sessions, sid)
				}
			}
		}
	}
}

func newSessionID() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ------------------------------------------------------------ handlers

func (s *webServer) login(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	var body struct {
		APIKey string `json:"apiKey"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || strings.TrimSpace(body.APIKey) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "apiKey required"})
		return
	}
	key := strings.TrimSpace(body.APIKey)
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	if err := s.cfg.checkKey(ctx, key); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error()})
		return
	}
	u, err := s.ensureUser(key)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	sid := newSessionID()
	s.mu.Lock()
	s.sessions[sid] = u.id
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: sid, Path: s.path("/"), HttpOnly: true,
		Secure: s.cfg.secure, SameSite: http.SameSiteStrictMode, MaxAge: 7 * 24 * 3600})
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (s *webServer) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: "", Path: s.path("/"), MaxAge: -1, HttpOnly: true,
		Secure: s.cfg.secure, SameSite: http.SameSiteStrictMode})
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}

func (s *webServer) call(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	u := s.userFor(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not signed in"})
		return
	}
	var req rpcRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxCallBody)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request: " + err.Error()})
		return
	}
	if req.MethodName == "web.GetConfig" {
		gallery := "client"
		if s.cfg.serverGallery {
			gallery = "server"
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": map[string]any{"gallery": gallery}})
		return
	}
	m, err := s.rpc.lookup(req)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	res, err := u.call(r.Context(), m, req.Args)
	if err != nil {
		status := http.StatusUnprocessableEntity
		if errors.Is(err, errNotOnWeb) {
			status = http.StatusNotImplemented
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"result": res})
}

// events streams the user's App events as Server-Sent Events.
func (s *webServer) events(w http.ResponseWriter, r *http.Request) {
	u := s.userFor(r)
	if u == nil {
		http.Error(w, "not signed in", http.StatusUnauthorized)
		return
	}
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	ch := make(chan []byte, 64)
	u.mu.Lock()
	u.subs[ch] = struct{}{}
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		delete(u.subs, ch)
		u.lastSeen = time.Now()
		u.mu.Unlock()
	}()
	_, _ = io.WriteString(w, ": connected\n\n")
	fl.Flush()
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ping.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			fl.Flush()
		case b := <-ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", b); err != nil {
				return
			}
			fl.Flush()
		}
	}
}

// static serves the web frontend; the app shell needs a session, assets don't.
func (s *webServer) static(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" || p == "index.html" {
		if s.userFor(r) == nil {
			http.Redirect(w, r, s.path("/login"), http.StatusFound)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
	}
	http.FileServerFS(s.assets).ServeHTTP(w, r)
}

func (s *webServer) loginPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = io.WriteString(w, loginHTML)
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "same-origin")
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// checkKeyRemote validates an API key against the imference API.
func checkKeyRemote(ctx context.Context, base, key string) error {
	if base == "" {
		base = "https://imference.com"
	}
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(base, "/")+"/credits/balance", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the imference API: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusOK {
		return nil
	}
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return errors.New("unknown API key")
	}
	return fmt.Errorf("imference API answered %d", resp.StatusCode)
}

const loginHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Imference · Sign in</title>
<link rel="icon" type="image/svg+xml" href="logo.svg">
<style>
:root{color-scheme:light dark;--bg:#f6f8fb;--card:#fff;--fg:#0f172a;--muted:#64748b;--line:#e2e8f0;--acc:#0b72e7}
@media (prefers-color-scheme:dark){:root{--bg:#0b1020;--card:#121a2e;--fg:#e2e8f0;--muted:#94a3b8;--line:#22304d}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
form{width:100%;max-width:380px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{color:var(--muted);margin:0 0 20px;font-size:14px}
label{display:block;font-size:13px;margin-bottom:6px}input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:transparent;color:inherit;font:inherit}
button{margin-top:16px;width:100%;padding:10px;border:0;border-radius:10px;background:var(--acc);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#dc2626;font-size:13px;min-height:20px;margin-top:10px}a{color:var(--acc)}
</style></head><body>
<form id="f"><h1>Imference</h1><p>Sign in with your imference.com API key. <a href="https://imference.com/payments" target="_blank" rel="noopener">Get a key</a></p>
<label for="k">API key</label><input id="k" name="k" type="password" autocomplete="current-password" required autofocus>
<button type="submit">Sign in</button><div class="err" id="e"></div></form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e'); e.textContent = '';
  const r = await fetch('web/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Imference-Web': '1'},
    body: JSON.stringify({apiKey: document.getElementById('k').value})});
  if (r.ok) { location.href = './'; return; }
  const j = await r.json().catch(() => ({}));
  e.textContent = j.error || ('Sign-in failed (' + r.status + ')');
});
</script></body></html>`
