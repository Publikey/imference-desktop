package main

import (
	"embed"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/windows"
)

//go:embed all:frontend/dist
var assets embed.FS

// Version is the app version, injected at build time via
// -ldflags "-X main.Version=<tag>". "dev" for local `wails dev`/`wails build`.
var Version = "dev"

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
	app := NewApp()

	err := wails.Run(&options.App{
		Title:     "Imference Desktop",
		Width:     1100,
		Height:    780,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 255, G: 255, B: 255, A: 1},
		OnStartup:        app.startup,
		OnBeforeClose:    app.onBeforeClose,
		Bind: []interface{}{
			app,
		},
		Windows: &windows.Options{
			WebviewIsTransparent:              false,
			WindowIsTranslucent:               false,
			DisableFramelessWindowDecorations: false,
			// Pin the WebView2 profile to a known-writable dir so the app launches
			// from any folder (double-click in Downloads/Desktop, etc.).
			WebviewUserDataPath: webviewDataPath(),
		},
	})
	if err != nil {
		println("Error:", err.Error())
	}
}
