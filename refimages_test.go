package main

import (
	"testing"

	"imference-desktop-go/internal/types"
)

// Slot 0 and SourceImage are the same picture: the sidecar contract has always
// said "source_image", and reference images are additive on top of it. Whichever
// one a caller fills, both must arrive populated downstream.
func TestNormalizeRefImages(t *testing.T) {
	cases := []struct {
		name       string
		in         types.GenerationRequest
		wantSource string
		wantRefs   []string
	}{
		{
			"legacy caller sets only SourceImage",
			types.GenerationRequest{SourceImage: "data:image/png;base64,AAA"},
			"data:image/png;base64,AAA",
			[]string{"data:image/png;base64,AAA"},
		},
		{
			"new caller sets only RefImages",
			types.GenerationRequest{RefImages: []string{"first"}},
			"first",
			[]string{"first"},
		},
		{
			"two frames — slot 0 becomes the source",
			types.GenerationRequest{RefImages: []string{"first", "last"}},
			"first",
			[]string{"first", "last"},
		},
		{
			"empty slots are dropped, not sent as placeholders",
			types.GenerationRequest{RefImages: []string{"", "  ", "real"}},
			"real",
			[]string{"real"},
		},
		{
			"prompt-only stays prompt-only",
			types.GenerationRequest{},
			"",
			nil,
		},
		{
			"an explicit SourceImage is not overwritten by slot 0",
			types.GenerationRequest{SourceImage: "explicit", RefImages: []string{"slot0"}},
			"explicit",
			[]string{"slot0"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := c.in
			normalizeRefImages(&req)
			if req.SourceImage != c.wantSource {
				t.Errorf("SourceImage = %q, want %q", req.SourceImage, c.wantSource)
			}
			if len(req.RefImages) != len(c.wantRefs) {
				t.Fatalf("RefImages = %v, want %v", req.RefImages, c.wantRefs)
			}
			for i := range c.wantRefs {
				if req.RefImages[i] != c.wantRefs[i] {
					t.Errorf("RefImages[%d] = %q, want %q", i, req.RefImages[i], c.wantRefs[i])
				}
			}
		})
	}
}

// A user checkpoint has no catalog row, so the backend that loads it decides
// whether the reference-image box appears at all.
func TestCustomRefImages(t *testing.T) {
	cases := map[string]int{
		"sdxl": 1, "sd15": 1, "zimage": 1, "flux": 1, "chroma": 1, "qwenimage": 1,
		"anima": 1, // img2img since imference-engine v0.4.5
		// Krea 2 has no img2img pipeline — the box must stay hidden.
		"krea2": 0,
		"":      0,
	}
	for backend, want := range cases {
		if got := customRefImages(backend); got != want {
			t.Errorf("customRefImages(%q) = %d, want %d", backend, got, want)
		}
	}
}
