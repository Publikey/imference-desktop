package cloud

import "testing"

func boolp(b bool) *bool { return &b }
func intp(n int) *int    { return &n }

// Reference-image slots are read against WHERE the model runs. The catalog's
// accepts_image_input describes the HOSTED endpoint's wiring, so it is
// authoritative for cloud runs and for telling local t2v from i2v — but it must
// not retire local img2img, which is the sidecar's own capability with any
// checkpoint it can load.
func TestRefImageSlots(t *testing.T) {
	cases := []struct {
		name         string
		accepts      *bool
		max          *int
		localBackend string
		want         int
	}{
		{"columns absent, local model keeps img2img", nil, nil, "sdxl", 1},
		{"columns absent, cloud model offers none", nil, nil, "", 0},
		// The regression this guards: the catalog marks most models
		// accepts_image_input=false because the hosted endpoint takes no init
		// image, which said nothing about running them locally — and silently
		// removed the img2img box for every local model.
		{"explicit false still leaves local img2img", boolp(false), nil, "sdxl", 1},
		{"explicit false with a stale max still leaves one", boolp(false), intp(2), "sdxl", 1},
		{"explicit false means none in the cloud", boolp(false), nil, "", 0},
		// Video is the case the flag really decides locally: a text-to-video
		// model has nothing to do with a source image.
		{"local text-to-video takes no image", boolp(false), nil, "wan", 0},
		{"local image-to-video takes one", boolp(true), intp(1), "wan", 1},
		{"local video interpolation takes two", boolp(true), intp(2), "wan", 2},
		// Anima is a text-to-image-only pipeline: no image input at all, so the
		// local floor must not apply and a catalog "true" can't conjure one.
		{"anima takes no reference image, flag absent", nil, nil, "anima", 0},
		{"anima takes no reference image, flag false", boolp(false), nil, "anima", 0},
		{"anima takes no reference image, even if the catalog says yes", boolp(true), intp(1), "anima", 0},
		{"true with no max means one slot", boolp(true), nil, "sdxl", 1},
		{"true with max 1", boolp(true), intp(1), "sdxl", 1},
		{"true with max 2 — first + last frame", boolp(true), intp(2), "sdxl", 2},
		{"a cloud model may declare two", boolp(true), intp(2), "", 2},
		{"max clamped to what the UI can render", boolp(true), intp(9), "sdxl", maxRefImageSlots},
		{"nonsense max falls back to one", boolp(true), intp(0), "sdxl", 1},
		{"negative max falls back to one", boolp(true), intp(-3), "sdxl", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := refImageSlots(apiModel{AcceptsImageInput: c.accepts, ImageInputMax: c.max}, c.localBackend)
			if got != c.want {
				t.Errorf("refImageSlots(accepts=%v, max=%v, backend=%q) = %d, want %d",
					c.accepts, c.max, c.localBackend, got, c.want)
			}
		})
	}
}

// toModelInfo applies the same "locally runnable" test ListModels uses: the
// im_local flag alone isn't enough without weights and a known backend. The
// same row yields different slot counts in the local and cloud lists.
func TestToModelInfoRefImages(t *testing.T) {
	cases := []struct {
		name     string
		m        apiModel
		forLocal bool
		want     int
	}{
		{
			"local with weights and engine → 1",
			apiModel{ImLocal: true, ModelURL: "https://cdn/x.safetensors", ImEngine: "sdxl"},
			true, 1,
		},
		{
			"the same row in the cloud list → the catalog's answer",
			apiModel{ImLocal: true, ModelURL: "https://cdn/x.safetensors", ImEngine: "sdxl", AcceptsImageInput: boolp(false)},
			false, 0,
		},
		{
			"a cloud-declared-false row still does img2img locally",
			apiModel{ImLocal: true, ModelURL: "https://cdn/x.safetensors", ImEngine: "sdxl", AcceptsImageInput: boolp(false)},
			true, 1,
		},
		{
			"im_local but no weights → cloud-side default",
			apiModel{ImLocal: true, ModelURL: "", ImEngine: "wan22"},
			true, 0,
		},
		{
			"im_local but unknown engine → cloud-side default",
			apiModel{ImLocal: true, ModelURL: "https://cdn/x.safetensors", ImEngine: "external"},
			true, 0,
		},
		{
			"an explicit capability always wins",
			apiModel{ImLocal: false, AcceptsImageInput: boolp(true), ImageInputMax: intp(2)},
			false, 2,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := toModelInfo(c.m, c.forLocal).RefImages; got != c.want {
				t.Errorf("RefImages = %d, want %d", got, c.want)
			}
		})
	}
}

// SupportsRefImages is the one place that answers "can this backend start from
// an image", for catalog models and user checkpoints alike.
func TestSupportsRefImages(t *testing.T) {
	yes := []string{"sdxl", "sd15", "zimage", "flux", "chroma", "qwenimage"}
	no := []string{"anima", "wan", "", "external"}
	for _, b := range yes {
		if !SupportsRefImages(b) {
			t.Errorf("SupportsRefImages(%q) = false, want true", b)
		}
	}
	for _, b := range no {
		if SupportsRefImages(b) {
			t.Errorf("SupportsRefImages(%q) = true, want false", b)
		}
	}
}

func TestToModelInfoHasAudio(t *testing.T) {
	cases := []struct {
		name string
		in   *bool
		want bool
	}{
		{"column absent", nil, false},
		{"explicit false", boolp(false), false},
		{"explicit true", boolp(true), true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := toModelInfo(apiModel{HasAudio: c.in}, false).HasAudio; got != c.want {
				t.Errorf("HasAudio = %v, want %v", got, c.want)
			}
		})
	}
}
