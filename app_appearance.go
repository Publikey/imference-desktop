package main

// Window appearance: the native window's background follows the app theme, so
// the frame the OS paints before the webview's first frame (and behind it while
// it resizes) is the app's canvas, not a white flash in dark mode.
//
// The renderer resolves the theme (stored choice or the OS, frontend
// lib/theme.ts) and reports it with SetAppearance; it is kept in window.json so
// the next launch opens in the right colour. Before the first report (first
// launch) the OS appearance decides.

import (
	"encoding/json"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Canvas colours, from the design tokens (design/tokens: --im-canvas).
var (
	canvasLight = application.RGBA{Red: 0xf8, Green: 0xf9, Blue: 0xfb, Alpha: 255}
	canvasDark  = application.RGBA{Red: 0x0a, Green: 0x0d, Blue: 0x11, Alpha: 255}
)

func windowBackground(dark bool) application.RGBA {
	if dark {
		return canvasDark
	}
	return canvasLight
}

type appearanceFile struct {
	Dark bool `json:"dark"`
}

// appearancePath is <UserConfigDir>/imference-desktop-go/window.json ("" when
// the OS has no config dir). Overridden in tests.
var appearancePath = func() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "imference-desktop-go", "window.json")
}

// loadAppearance returns the last reported theme; known is false before the
// first report (or when the file is unreadable).
func loadAppearance() (dark, known bool) {
	p := appearancePath()
	if p == "" {
		return false, false
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return false, false
	}
	var f appearanceFile
	if json.Unmarshal(b, &f) != nil {
		return false, false
	}
	return f.Dark, true
}

func saveAppearance(dark bool) error {
	p := appearancePath()
	if p == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	b, _ := json.Marshal(appearanceFile{Dark: dark})
	return os.WriteFile(p, b, 0o644)
}

// SetAppearance is called by the renderer whenever the resolved theme changes
// (launch, a manual switch, the OS flipping while on "system"). It repaints
// every window's native background and remembers the choice for next launch.
// The web build has no native window: nothing to do.
func (a *App) SetAppearance(dark bool) {
	if a.cloudOnly {
		return
	}
	if cur, known := loadAppearance(); !known || cur != dark {
		if err := saveAppearance(dark); err != nil {
			a.bus.Warn("app", "appearance: save failed", map[string]any{"error": err.Error()})
		}
	}
	if a.app == nil {
		return
	}
	for _, w := range a.app.Window.GetAll() {
		w.SetBackgroundColour(windowBackground(dark))
	}
}

// applyOSAppearance paints the windows from the OS appearance on a first launch
// (no reported theme yet). Called once the application runs.
func (a *App) applyOSAppearance() {
	if a.cloudOnly || a.app == nil {
		return
	}
	if _, known := loadAppearance(); known {
		return
	}
	dark := a.app.Env.IsDarkMode()
	for _, w := range a.app.Window.GetAll() {
		w.SetBackgroundColour(windowBackground(dark))
	}
}
