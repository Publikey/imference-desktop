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

	"github.com/ethereum/go-ethereum/common"

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

// webUser is one user: one cloud-only App, shared by their tabs. A visitor
// without an API key is a guest: the app works, but generating needs a key
// with credits or a browser wallet paying per run (web_pay.go).
type webUser struct {
	id     string // sha256(api key)[:16], or "guest-<random>" — also the data folder name
	apiKey string // "" for a guest
	guest  bool
	app    *App

	mu       sync.Mutex
	subs     map[chan []byte]string // open event streams -> their session id
	lastSeen time.Time
	// payMode "wallet" = pay each run with the browser wallet at payer;
	// "" = credits (the API key).
	payMode string
	payer   common.Address
	signs   map[string]chan signReply // pending browser signatures, by id
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

// checkBasePath accepts "" or a URL path such as "/app". Anything else is a
// misconfiguration, e.g. Git Bash rewriting "/app" into "C:/Program Files/Git/app"
// when it is passed to az (set MSYS_NO_PATHCONV=1).
func checkBasePath(p string) error {
	if p == "" {
		return nil
	}
	if !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return fmt.Errorf("IMFERENCE_WEB_BASE %q: want a path such as /app", p)
	}
	for _, r := range p {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("/-_.", r)) {
			return fmt.Errorf("IMFERENCE_WEB_BASE %q: want a path such as /app", p)
		}
	}
	return nil
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
	mux.HandleFunc("GET /login", func(w http.ResponseWriter, r *http.Request) { // old bookmarks
		http.Redirect(w, r, s.path("/"), http.StatusFound)
	})
	mux.HandleFunc("POST /web/login", s.login)
	mux.HandleFunc("POST /web/pay/card", s.payCard)
	mux.HandleFunc("POST /web/pay/pack", s.payPack)
	mux.HandleFunc("POST /web/sign", s.sign)
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

// maxGuests bounds the guest Apps held in memory (each visitor without a key
// gets one); idle ones are evicted after cfg.idleAfter.
const maxGuests = 5000

var errTooManyGuests = errors.New("too many visitors right now, try again in a few minutes")

// sessionUser returns the request's user; a visitor without a valid session
// gets a fresh guest session (and its cookie).
func (s *webServer) sessionUser(w http.ResponseWriter, r *http.Request) (*webUser, error) {
	u, _, err := s.session(w, r)
	return u, err
}

// session is sessionUser with the session id.
func (s *webServer) session(w http.ResponseWriter, r *http.Request) (*webUser, string, error) {
	if u := s.userFor(r); u != nil {
		c, _ := r.Cookie(sessionCookie)
		return u, c.Value, nil
	}
	s.mu.Lock()
	guests := 0
	for _, u := range s.users {
		if u.guest {
			guests++
		}
	}
	s.mu.Unlock()
	if guests >= maxGuests {
		return nil, "", errTooManyGuests
	}
	u, err := s.newUser("guest-"+newSessionID()[:16], "")
	if err != nil {
		return nil, "", err
	}
	return u, s.startSession(w, u), nil
}

// startSession opens a new session for u, sets its cookie, returns its id.
func (s *webServer) startSession(w http.ResponseWriter, u *webUser) string {
	sid := newSessionID()
	s.mu.Lock()
	s.sessions[sid] = u.id
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: sid, Path: s.path("/"), HttpOnly: true,
		Secure: s.cfg.secure, SameSite: http.SameSiteStrictMode, MaxAge: 7 * 24 * 3600})
	return sid
}

// bindKey moves the request's session to the user of apiKey (signing in, or
// after a purchase created that key), or opens a session for it.
func (s *webServer) bindKey(w http.ResponseWriter, r *http.Request, apiKey string) error {
	u, err := s.ensureUser(apiKey)
	if err != nil {
		return err
	}
	if c, err := r.Cookie(sessionCookie); err == nil {
		s.mu.Lock()
		old, ok := s.sessions[c.Value]
		if ok {
			s.sessions[c.Value] = u.id
			// The session's open tabs now listen to the new user: signature
			// requests and progress go where the session is.
			if prev := s.users[old]; prev != nil && prev != u {
				prev.mu.Lock()
				u.mu.Lock()
				for ch, sid := range prev.subs {
					if sid == c.Value {
						delete(prev.subs, ch)
						u.subs[ch] = sid
					}
				}
				u.mu.Unlock()
				prev.mu.Unlock()
			}
		}
		s.mu.Unlock()
		if ok {
			return nil
		}
	}
	s.startSession(w, u)
	return nil
}

// ensureUser returns the App of an API key's user, creating it.
func (s *webServer) ensureUser(apiKey string) (*webUser, error) {
	return s.newUser(userID(apiKey), apiKey)
}

// newUser returns user uid, creating its App (cloud-only, own folders).
func (s *webServer) newUser(uid, apiKey string) (*webUser, error) {
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
	u := &webUser{id: uid, apiKey: apiKey, guest: apiKey == "", app: app, subs: map[chan []byte]string{},
		lastSeen: time.Now(), signs: map[string]chan signReply{}}
	app.x402Signer = u.browserSigner
	app.ctx = context.Background()
	if s.cfg.apiBase != "" {
		app.cloud.SetBaseURL(s.cfg.apiBase)
	}
	app.emitter = u.publish
	app.bus.SetEmitter(func(name string, data ...any) { app.emit(name, data...) })
	// Persist the web invariants (API key, payment rail, cloud tools) once.
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
			if u.guest {
				// Nobody can come back to a guest: its session is gone.
				_ = os.RemoveAll(filepath.Join(s.cfg.dataDir, "users", uid))
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
		code := ""
		if errors.Is(err, errUnknownKey) {
			code = "invalid_key"
		}
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": err.Error(), "code": code})
		return
	}
	if err := s.bindKey(w, r, key); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
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
	u, err := s.sessionUser(w, r)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	var req rpcRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, maxCallBody)).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "bad request: " + err.Error()})
		return
	}
	if strings.HasPrefix(req.MethodName, "web.") {
		res, err := s.webMethod(u, req)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"result": res})
		return
	}
	m, err := s.rpc.lookup(req)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	// A run needs a way to pay: credits on a key, or the browser wallet.
	if paidMethods[m.name] && !u.canPay() {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{
			"error": "an API key with credits is needed to generate", "code": codeNeedsKey})
		return
	}
	res, err := u.call(r.Context(), m, req.Args)
	payErr := err
	if payErr == nil {
		payErr = toolResultErr(res) // a tool's own error rides in its result
	}
	if code := payErrCode(payErr); code != "" {
		writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": payErr.Error(), "code": code})
		return
	}
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
	u, sid, err := s.session(w, r)
	if err != nil {
		http.Error(w, err.Error(), http.StatusServiceUnavailable)
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
	u.subs[ch] = sid
	u.mu.Unlock()
	defer func() {
		// The stream may have moved to another user (bindKey).
		s.mu.Lock()
		for _, u := range s.users {
			u.mu.Lock()
			if _, ok := u.subs[ch]; ok {
				delete(u.subs, ch)
				u.lastSeen = time.Now()
			}
			u.mu.Unlock()
		}
		s.mu.Unlock()
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

// static serves the web frontend. The app opens without a key: a visitor
// gets a guest session.
func (s *webServer) static(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" || p == "index.html" {
		if _, err := s.sessionUser(w, r); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
	}
	http.FileServerFS(s.assets).ServeHTTP(w, r)
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
	// The API answers 404 "user not found" for a key it doesn't know.
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden ||
		resp.StatusCode == http.StatusNotFound {
		return errUnknownKey
	}
	return fmt.Errorf("imference API answered %d", resp.StatusCode)
}
