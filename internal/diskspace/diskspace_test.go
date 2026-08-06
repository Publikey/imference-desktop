package diskspace

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDirSize(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.bin"), make([]byte, 1024), 0o644); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "sub")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sub, "b.bin"), make([]byte, 512), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := DirSize(dir)
	if err != nil {
		t.Fatalf("DirSize: %v", err)
	}
	if got != 1536 {
		t.Errorf("DirSize = %d, want 1536 (recursive sum)", got)
	}
}

func TestDirSizeMissingRoot(t *testing.T) {
	// A missing directory is 0 bytes, not a crash — the storage screen asks
	// about folders that may not exist yet (model-cache before first run).
	if got, _ := DirSize(filepath.Join(t.TempDir(), "nope")); got != 0 {
		t.Errorf("DirSize on missing dir = %d, want 0", got)
	}
}

// Smoke test: the syscall path differs per OS, so just assert it answers
// plausibly rather than asserting an exact figure.
func TestFreeBytes(t *testing.T) {
	got, err := FreeBytes(t.TempDir())
	if err != nil {
		t.Fatalf("FreeBytes: %v", err)
	}
	if got <= 0 {
		t.Errorf("FreeBytes = %d, want a positive figure", got)
	}
}

// The directory is created if absent — GetDiskFreeSpaceEx requires it to exist.
func TestFreeBytesCreatesMissingDir(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "not", "yet", "there")
	if _, err := FreeBytes(dir); err != nil {
		t.Fatalf("FreeBytes on missing dir: %v", err)
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("directory not created: %v", err)
	}
}
