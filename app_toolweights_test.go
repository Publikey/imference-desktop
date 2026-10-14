package main

import (
	"testing"

	"imference-desktop-go/internal/tools"
)

func TestWeightsForPicksTheVariant(t *testing.T) {
	c, err := tools.Builtin()
	if err != nil {
		t.Fatal(err)
	}
	rb, _ := c.Get("remove-background")
	// No model param: the default (BiRefNet-lite) only.
	if w := weightsFor(rb, map[string]any{}); len(w) != 1 || w[0].When["model"] != "birefnet-lite" {
		t.Fatalf("default variant: %+v", w)
	}
	if w := weightsFor(rb, map[string]any{"model": "u2netp"}); len(w) != 1 || w[0].SizeMB > 10 {
		t.Fatalf("u2netp: %+v", w)
	}
	// A tool with two unconditional files (restore-faces: GFPGAN + YuNet).
	rf, _ := c.Get("restore-faces")
	if w := weightsFor(rf, map[string]any{}); len(w) != 2 {
		t.Fatalf("restore-faces: %+v", w)
	}
}
