//go:build web

// Web build of Imference: the same App (cloud-only) behind an HTTP server, one
// App per user, the same React frontend built with VITE target "web".
//
//	cd frontend && npm run build:web          # -> frontend/dist-web
//	go build -tags "web server" -o imference-web .
//	IMFERENCE_WEB_ADDR=:8090 ./imference-web
//
// The frontend keeps calling its generated Wails bindings; in the web build
// @wailsio/runtime is swapped for src/lib/web-runtime.ts, which sends the same
// calls (method ID = FNV-32a of "main.App.<Method>") to POST /web/call and
// receives events over GET /web/events (SSE). See web_server.go.
package main

import (
	"embed"
	"io/fs"
	"log"
	"net/http"
	"os"
	"time"
)

//go:embed all:frontend/dist-web
var webAssets embed.FS

// sidecarFiles is referenced by app.go (extractEmbeddedSidecar); the web build
// never runs a sidecar, so it embeds nothing.
var sidecarFiles embed.FS

func main() {
	addr := envOr("IMFERENCE_WEB_ADDR", "127.0.0.1:8090")
	dist, err := fs.Sub(webAssets, "frontend/dist-web")
	if err != nil {
		log.Fatal(err)
	}
	srv := newWebServer(webConfig{
		dataDir:   envOr("IMFERENCE_WEB_DATA", "web-data"),
		apiBase:   os.Getenv("IMFERENCE_BASE_URL"),
		secure:    os.Getenv("IMFERENCE_WEB_SECURE") == "1",
		idleAfter: 30 * time.Minute,
	}, dist)
	go srv.evictLoop()
	log.Printf("imference-web listening on http://%s (data: %s)", addr, srv.cfg.dataDir)
	hs := &http.Server{Addr: addr, Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second}
	log.Fatal(hs.ListenAndServe())
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
