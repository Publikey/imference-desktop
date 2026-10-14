package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelcache"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/types"
)

// An empty production catalog (no qwen-image-edit row yet) must still let
// "Edit with instructions" switch to the edit model: the built-in GGUF entry.
func TestBuiltinEditModelStandsInForTheCatalog(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "format") {
			_, _ = w.Write([]byte(`{"formats": []}`))
			return
		}
		_, _ = w.Write([]byte(`{"models": []}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", home)
	t.Setenv("LOCALAPPDATA", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	store, err := settings.New()
	if err != nil {
		t.Fatal(err)
	}
	bus := logbus.New()
	c := cloud.New(bus)
	c.SetBaseURL(srv.URL)
	a := &App{settings: store, bus: bus, ctx: context.Background(), cloud: c}

	m, err := a.localCatalogModel(cloud.DefaultEditModel)
	if err != nil {
		t.Fatal(err)
	}
	if m.BackendType != cloud.EditBackend || m.BaseModel != "Qwen/Qwen-Image-Edit-2511" ||
		!strings.HasSuffix(m.ModelURL, ".gguf") || *m.StepsDefault != 4 || *m.CfgDefault != 1.0 {
		t.Fatalf("builtin %+v", m)
	}
	if !strings.HasSuffix(modelcache.FileName(m.ModelCode, m.ModelURL), ".gguf") {
		t.Fatal("cache key must keep .gguf")
	}
	if _, err := a.localCatalogModel("nope"); err == nil {
		t.Fatal("unknown models still fail")
	}
	if c := a.localEditCandidate(); c == nil || c.ModelCode != cloud.DefaultEditModel {
		t.Fatalf("candidate %+v", c)
	}

	// Nothing to switch back to yet.
	if err := a.SwitchBackFromEditModel(); err == nil {
		t.Fatal("switch back without a previous model must fail")
	}
	// With an edit model loaded and a remembered previous one, the dialog
	// offers to switch back (the previous model must resolve in the catalog:
	// here only the built-in edit model does, so Previous stays nil).
	s := store.Get()
	s.LocalModel = &types.ModelInfo{ModelCode: cloud.DefaultEditModel, BackendType: cloud.EditBackend}
	s.PreviousLocalModel = "sdxl-x"
	if _, err := store.Save(s); err != nil {
		t.Fatal(err)
	}
	info := a.ListEditModels()
	if info.Local == nil || info.LocalCandidate == nil || info.Previous != nil {
		t.Fatalf("info %+v", info)
	}
}

// ToolGenModels: the loaded model vs the image's own, and the way back from an
// edit model (no tools catalog here: the cloud side is left empty).
func TestToolGenModels(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(r.URL.Path, "format") {
			_, _ = w.Write([]byte(`{"formats": []}`))
			return
		}
		_, _ = w.Write([]byte(`{"models": []}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("APPDATA", home)
	t.Setenv("LOCALAPPDATA", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))
	store, err := settings.New()
	if err != nil {
		t.Fatal(err)
	}
	bus := logbus.New()
	c := cloud.New(bus)
	c.SetBaseURL(srv.URL)
	a := &App{settings: store, bus: bus, ctx: context.Background(), cloud: c}

	s := store.Get()
	s.LocalModel = &types.ModelInfo{ModelCode: "sdxl-a", Name: "SDXL A", BackendType: "sdxl"}
	_, _ = store.Save(s)
	m := a.ToolGenModels("vary", "", &types.GenerationMeta{ModelCode: "sdxl-a", ModelName: "SDXL A"})
	if !m.LocalIsSource || m.SourceModelName != "SDXL A" || m.Previous != nil {
		t.Fatalf("same model: %+v", m)
	}
	m = a.ToolGenModels("vary", "", &types.GenerationMeta{ModelCode: "other"})
	if m.LocalIsSource || m.SourceLocal != nil {
		t.Fatalf("other model (not in the local catalog): %+v", m)
	}
	// An edit model loaded, switched to from a model the catalog resolves.
	s.LocalModel = &types.ModelInfo{ModelCode: cloud.DefaultEditModel, BackendType: cloud.EditBackend}
	s.PreviousLocalModel = cloud.DefaultEditModel // resolvable here (built-in entry)
	_, _ = store.Save(s)
	if m := a.ToolGenModels("vary", "", nil); m.Previous == nil || m.Local == nil {
		t.Fatalf("edit model loaded: %+v", m)
	}
}
