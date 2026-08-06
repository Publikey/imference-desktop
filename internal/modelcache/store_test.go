package modelcache

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := New(dir)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	clock := time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)
	s.now = func() time.Time { return clock }
	return s, dir
}

func writeFile(t *testing.T, dir, name string, size int64) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return p
}

func entry(key string, bytes int64, used time.Time) Entry {
	stamp := used.UTC().Format(time.RFC3339)
	return Entry{Key: key, ModelCode: "m-" + key, Bytes: bytes, AddedAt: stamp, LastUsedAt: stamp}
}

func TestStoreRoundTripSurvivesReload(t *testing.T) {
	s, dir := newTestStore(t)
	if err := s.Put(entry("a.safetensors", 3*gb, at(2))); err != nil {
		t.Fatalf("Put: %v", err)
	}

	reopened, err := New(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := reopened.List()
	if len(got) != 1 || got[0].Key != "a.safetensors" || got[0].Bytes != 3*gb {
		t.Errorf("after reload: %+v", got)
	}
	if reopened.TotalBytes() != 3*gb {
		t.Errorf("TotalBytes = %d, want %d", reopened.TotalBytes(), 3*gb)
	}
}

// A corrupt index must never wedge the app — start empty, no error.
func TestStoreCorruptIndexStartsEmpty(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, IndexFileName), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	s, err := New(dir)
	if err != nil {
		t.Fatalf("New on corrupt index: %v", err)
	}
	if len(s.List()) != 0 {
		t.Errorf("expected empty store, got %+v", s.List())
	}
}

func TestStorePutIsUpsert(t *testing.T) {
	s, _ := newTestStore(t)
	_ = s.Put(entry("a.safetensors", 1*gb, at(5)))
	_ = s.Put(entry("a.safetensors", 2*gb, at(1)))
	if got := s.List(); len(got) != 1 || got[0].Bytes != 2*gb {
		t.Errorf("upsert failed: %+v", got)
	}
}

func TestStoreTouchReordersList(t *testing.T) {
	s, _ := newTestStore(t)
	_ = s.Put(entry("old.safetensors", gb, at(30)))
	_ = s.Put(entry("new.safetensors", gb, at(1)))

	if got := s.List(); got[0].Key != "new.safetensors" {
		t.Fatalf("pre-touch order: %s first", got[0].Key)
	}
	if err := s.Touch("old.safetensors"); err != nil {
		t.Fatalf("Touch: %v", err)
	}
	if got := s.List(); got[0].Key != "old.safetensors" {
		t.Errorf("post-touch order: %s first, want old.safetensors", got[0].Key)
	}
}

func TestStoreTouchUnknownKeyIsNoop(t *testing.T) {
	s, _ := newTestStore(t)
	if err := s.Touch("nope.safetensors"); err != nil {
		t.Errorf("Touch on unknown key: %v", err)
	}
}

func TestStoreDelete(t *testing.T) {
	s, _ := newTestStore(t)
	_ = s.Put(entry("a.safetensors", gb, at(1)))
	if err := s.Delete("a.safetensors"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if len(s.List()) != 0 {
		t.Error("entry survived Delete")
	}
	if err := s.Delete("a.safetensors"); err != nil {
		t.Errorf("second Delete should be a no-op: %v", err)
	}
}

func TestReconcileIndexesUnknownFiles(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "found.safetensors", 2048)

	rep, err := s.Reconcile(nil)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if rep.Indexed != 1 || rep.Orphans != 1 {
		t.Errorf("report = %+v, want 1 indexed / 1 orphan", rep)
	}
	got := s.List()
	if len(got) != 1 || got[0].Bytes != 2048 || got[0].ModelCode != "" {
		t.Errorf("entry = %+v", got)
	}
	if got[0].LastUsedAt == "" {
		t.Error("LastUsedAt not seeded from ModTime")
	}
}

func TestReconcileDropsVanishedEntries(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "kept.safetensors", 512)
	_ = s.Put(entry("kept.safetensors", 512, at(1)))
	_ = s.Put(entry("gone.safetensors", gb, at(1)))

	rep, err := s.Reconcile(nil)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if rep.Dropped != 1 {
		t.Errorf("Dropped = %d, want 1", rep.Dropped)
	}
	if got := s.List(); len(got) != 1 || got[0].Key != "kept.safetensors" {
		t.Errorf("entries = %+v", got)
	}
}

func TestReconcileRemovesPartFiles(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "half.safetensors.part", 128)
	writeFile(t, dir, "whole.safetensors", 256)

	rep, err := s.Reconcile(nil)
	if err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if rep.PartsRemoved != 1 {
		t.Errorf("PartsRemoved = %d, want 1", rep.PartsRemoved)
	}
	if _, err := os.Stat(filepath.Join(dir, "half.safetensors.part")); !os.IsNotExist(err) {
		t.Error(".part file still on disk")
	}
	if len(s.List()) != 1 {
		t.Errorf("entries = %+v, want only the whole file", s.List())
	}
}

func TestReconcileIgnoresNonWeightsAndSubdirs(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "notes.txt", 10)
	writeFile(t, dir, IndexFileName, 10)
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, dir, "real.safetensors", 100)

	if _, err := s.Reconcile(nil); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := s.List(); len(got) != 1 || got[0].Key != "real.safetensors" {
		t.Errorf("entries = %+v", got)
	}
}

// Custom checkpoints living inside the models dir must stay invisible to the
// index — that's what keeps the eviction planner from ever seeing them.
func TestReconcileSkipsProtectedPaths(t *testing.T) {
	s, dir := newTestStore(t)
	mine := writeFile(t, dir, "my-own.safetensors", 100)
	writeFile(t, dir, "managed.safetensors", 100)

	if _, err := s.Reconcile(map[string]bool{mine: true}); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	for _, e := range s.List() {
		if e.Key == "my-own.safetensors" {
			t.Error("protected file was indexed")
		}
	}
	if len(s.List()) != 1 {
		t.Errorf("entries = %+v", s.List())
	}
}

func TestReconcileCorrectsDriftedSize(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "a.safetensors", 4096)
	_ = s.Put(entry("a.safetensors", 999, at(1)))

	if _, err := s.Reconcile(nil); err != nil {
		t.Fatalf("Reconcile: %v", err)
	}
	if got := s.List(); got[0].Bytes != 4096 {
		t.Errorf("Bytes = %d, want 4096 (disk wins)", got[0].Bytes)
	}
}

func TestRelabelMigratesLegacyName(t *testing.T) {
	s, dir := newTestStore(t)
	legacy := LegacyFileName("https://cdn.example/anima_baseV10.safetensors")
	writeFile(t, dir, legacy, 100)
	if _, err := s.Reconcile(nil); err != nil {
		t.Fatal(err)
	}

	refs := []CatalogRef{{ModelCode: "anima-base", ModelName: "Anima Base", ModelURL: "https://cdn.example/anima_baseV10.safetensors"}}
	renamed, err := s.Relabel(refs)
	if err != nil {
		t.Fatalf("Relabel: %v", err)
	}

	canonical := FileName("anima-base", "https://cdn.example/anima_baseV10.safetensors")
	if renamed[legacy] != canonical {
		t.Errorf("renamed = %v, want %q -> %q", renamed, legacy, canonical)
	}
	if _, err := os.Stat(filepath.Join(dir, canonical)); err != nil {
		t.Errorf("canonical file missing: %v", err)
	}
	got := s.List()
	if len(got) != 1 || got[0].Key != canonical || got[0].ModelCode != "anima-base" {
		t.Errorf("entry = %+v", got)
	}
}

func TestRelabelIsIdempotent(t *testing.T) {
	s, dir := newTestStore(t)
	url := "https://cdn.example/x.safetensors"
	writeFile(t, dir, LegacyFileName(url), 100)
	if _, err := s.Reconcile(nil); err != nil {
		t.Fatal(err)
	}
	refs := []CatalogRef{{ModelCode: "x", ModelName: "X", ModelURL: url}}

	if _, err := s.Relabel(refs); err != nil {
		t.Fatal(err)
	}
	second, err := s.Relabel(refs)
	if err != nil {
		t.Fatalf("second Relabel: %v", err)
	}
	if len(second) != 0 {
		t.Errorf("second pass renamed %v, want nothing", second)
	}
	if len(s.List()) != 1 {
		t.Errorf("entries duplicated: %+v", s.List())
	}
}

func TestRelabelIgnoresUnknownFiles(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "mystery.safetensors", 100)
	if _, err := s.Reconcile(nil); err != nil {
		t.Fatal(err)
	}

	renamed, err := s.Relabel([]CatalogRef{{ModelCode: "other", ModelURL: "https://cdn.example/other.safetensors"}})
	if err != nil {
		t.Fatalf("Relabel: %v", err)
	}
	if len(renamed) != 0 {
		t.Errorf("renamed = %v, want nothing", renamed)
	}
	if got := s.List(); len(got) != 1 || got[0].ModelCode != "" {
		t.Errorf("entry should stay an orphan: %+v", got)
	}
}

// Models with no weights URL (the WAN video entries) must not claim the
// fallback filename and hijack an unrelated file.
func TestRelabelSkipsModelsWithoutURL(t *testing.T) {
	s, dir := newTestStore(t)
	writeFile(t, dir, "model.safetensors", 100)
	if _, err := s.Reconcile(nil); err != nil {
		t.Fatal(err)
	}

	if _, err := s.Relabel([]CatalogRef{{ModelCode: "wan22-t2v", ModelURL: ""}}); err != nil {
		t.Fatalf("Relabel: %v", err)
	}
	if got := s.List(); got[0].ModelCode != "" {
		t.Errorf("URL-less model claimed a file: %+v", got)
	}
}
