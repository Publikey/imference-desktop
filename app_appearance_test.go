package main

import (
	"path/filepath"
	"testing"

	"imference-desktop-go/internal/logbus"
)

func TestAppearanceRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "imference-desktop-go", "window.json")
	old := appearancePath
	appearancePath = func() string { return p }
	t.Cleanup(func() { appearancePath = old })

	if _, known := loadAppearance(); known {
		t.Fatal("first launch: appearance must be unknown")
	}
	a := &App{}
	a.bus = logbus.New()
	a.SetAppearance(true) // no running app: persists only
	if dark, known := loadAppearance(); !known || !dark {
		t.Fatalf("after SetAppearance(true): dark=%v known=%v", dark, known)
	}
	a.SetAppearance(false)
	if dark, _ := loadAppearance(); dark {
		t.Fatal("after SetAppearance(false): still dark")
	}
	if windowBackground(true) != canvasDark || windowBackground(false) != canvasLight {
		t.Fatal("windowBackground must map to the canvas tokens")
	}
}

func TestAppearanceWebIsNoop(t *testing.T) {
	p := filepath.Join(t.TempDir(), "window.json")
	old := appearancePath
	appearancePath = func() string { return p }
	t.Cleanup(func() { appearancePath = old })
	(&App{cloudOnly: true}).SetAppearance(true)
	if _, known := loadAppearance(); known {
		t.Fatal("the web build must not write a window appearance")
	}
}
