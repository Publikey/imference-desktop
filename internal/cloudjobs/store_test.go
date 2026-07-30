package cloudjobs

import (
	"testing"

	"imference-desktop-go/internal/types"
)

// Persistence is the whole point — verify Add/List/Remove survive a reload
// (simulating an app restart) via a temp HOME so the real store is untouched.
func TestStoreRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())          // POSIX UserConfigDir base
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("APPDATA", t.TempDir()) // Windows UserConfigDir base

	s, err := New()
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if got := s.List(); len(got) != 0 {
		t.Fatalf("fresh store not empty: %d", len(got))
	}

	a := types.PendingCloudJob{JobID: "j1", RequestID: "r1", Kind: "image", Rail: "credits", Prompt: "cat"}
	b := types.PendingCloudJob{JobID: "j2", RequestID: "r2", Kind: "video", Rail: "x402", Prompt: "fox"}
	if err := s.Add(a); err != nil {
		t.Fatal(err)
	}
	if err := s.Add(b); err != nil {
		t.Fatal(err)
	}
	if got := len(s.List()); got != 2 {
		t.Fatalf("want 2 after adds, got %d", got)
	}

	// Reload from disk (new Store, same paths) — must see both.
	s2, err := New()
	if err != nil {
		t.Fatalf("reload New: %v", err)
	}
	if got := len(s2.List()); got != 2 {
		t.Fatalf("want 2 after reload, got %d", got)
	}

	// Remove one, reload again → one left, and it's the right one.
	if err := s2.Remove("j1"); err != nil {
		t.Fatal(err)
	}
	s3, err := New()
	if err != nil {
		t.Fatal(err)
	}
	left := s3.List()
	if len(left) != 1 || left[0].JobID != "j2" {
		t.Fatalf("after remove+reload want [j2], got %+v", left)
	}
}
