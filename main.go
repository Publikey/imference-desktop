package main

import (
	"embed"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

//go:embed all:frontend/dist
var assets embed.FS

// sidecarFiles bundles the app's own Python glue (the thin wrapper that runs
// imference-engine and speaks the stdio protocol) into the binary, so a
// packaged/portable .exe is self-contained: it downloads the *engine* at install
// and carries its own *wrapper*. These are ~10 KB of app code, version-locked to
// the Go stdio contract — not the heavy engine (that stays a download).
// Extracted to %LOCALAPPDATA% at startup; see extractEmbeddedSidecar in app.go.
//
//go:embed sidecar/main.py sidecar/requirements.txt
var sidecarFiles embed.FS

// webviewDataPath returns a fixed, always-writable directory for the WebView2
// browser profile: "<UserCacheDir>/imference-desktop-go/webview2" (i.e.
// %LOCALAPPDATA%\... on Windows). Without this, Wails/WebView2 defaults the
// profile folder to a location tied to where the .exe is launched from, which
// fails to be created in some folders (e.g. OneDrive-backed Downloads/Desktop
// with Files-On-Demand, or read-only locations) — the WebView2 environment then
// can't initialize and the window silently never appears. Returns "" on error
// so Wails falls back to its default.
func webviewDataPath() string {
	base, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	dir := filepath.Join(base, "imference-desktop-go", "webview2")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ""
	}
	return dir
}

func main() {
	appModel := NewApp()

	// v3 separates the three phases: create the application (registers the App
	// as a service so its exported methods become frontend bindings), create the
	// single window, then run. The App's ServiceStartup/ServiceShutdown hooks
	// (app.go) wire the event bus and stop the Python sidecar on quit.
	app := application.New(application.Options{
		Name:        "Imference Desktop",
		Description: "AI image generation — cloud & local",
		Services: []application.Service{
			application.NewService(appModel),
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		Windows: application.WindowsOptions{
			// Pin the WebView2 profile to a known-writable dir so the app launches
			// from any folder (double-click in Downloads/Desktop, etc.). Without
			// this the window silently never appears from OneDrive/read-only dirs.
			WebviewUserDataPath: webviewDataPath(),
		},
	})

	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Imference Desktop",
		// Open wide enough to clear the 1280px (xl) breakpoint so the panel board
		// lands in its two-column layout by default instead of the stacked
		// single column. MinWidth stays permissive: shrinking below the
		// breakpoint still collapses to one column responsively.
		Width:            1360,
		Height:           860,
		MinWidth:         900,
		MinHeight:        600,
		BackgroundColour: application.RGBA{Red: 255, Green: 255, Blue: 255, Alpha: 255},
		URL:              "/",
	})

	if err := app.Run(); err != nil {
		println("Error:", err.Error())
	}
}
