package modelcache

import (
	"strings"
	"testing"
)

// The whole point of the hashed scheme is that two models can never share a
// file. The catalog's two WAN entries are the regression target: both fall back
// to "model.safetensors" under the legacy rule.
func TestFileNameIsUnique(t *testing.T) {
	cases := []struct{ code, url string }{
		{"wan22-i2v", ""},
		{"wan22-t2v", ""},
		{"anima-base", "https://cdn.example/anima_baseV10.safetensors"},
		{"anima-turbo", "https://cdn.example/anima_turboV10.safetensors"},
		// Same basename, different models — the case the legacy rule got wrong.
		{"model-a", "https://cdn.example/a/diffusion_pytorch_model.safetensors"},
		{"model-b", "https://cdn.example/b/diffusion_pytorch_model.safetensors"},
		// Same code, re-pointed URL — must be a different file, not a stale reuse.
		{"repointed", "https://cdn.example/v1.safetensors"},
		{"repointed", "https://cdn.example/v2.safetensors"},
	}
	seen := map[string]string{}
	for _, c := range cases {
		got := FileName(c.code, c.url)
		if prev, dup := seen[got]; dup {
			t.Errorf("collision: %q and %q both produce %q", prev, c.code+" "+c.url, got)
		}
		seen[got] = c.code + " " + c.url
		if !strings.HasSuffix(got, ".safetensors") {
			t.Errorf("FileName(%q, %q) = %q, want .safetensors suffix", c.code, c.url, got)
		}
	}
}

func TestFileNameIsDeterministic(t *testing.T) {
	a := FileName("anima-base", "https://cdn.example/x.safetensors")
	b := FileName("anima-base", "https://cdn.example/x.safetensors")
	if a != b {
		t.Errorf("not deterministic: %q vs %q", a, b)
	}
}

func TestSlug(t *testing.T) {
	cases := []struct{ in, want string }{
		{"anima-base", "anima-base"},
		{"Nova_Anime_XL", "nova_anime_xl"},
		{"custom:sdxl", "custom-sdxl"},
		{"a/b\\c", "a-b-c"},
		{"  spaced  out  ", "spaced-out"},
		{"héllo wörld", "h-llo-w-rld"},
		{"", "model"},
		{"???", "model"},
		{"...---...", "model"},
	}
	for _, c := range cases {
		if got := Slug(c.in); got != c.want {
			t.Errorf("Slug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestSlugTruncatesButFileNameStaysUnique(t *testing.T) {
	long := strings.Repeat("verylongmodelname", 20) // 340 chars
	if r := []rune(Slug(long)); len(r) > maxSlugRune {
		t.Errorf("Slug not truncated: %d runes", len(r))
	}
	if FileName(long+"-a", "u") == FileName(long+"-b", "u") {
		t.Error("truncated slugs collided — the hash suffix should prevent this")
	}
}

// A file literally named "nul.safetensors" is a Windows device name; the hash
// suffix means we never produce one.
func TestFileNameAvoidsWindowsDeviceNames(t *testing.T) {
	for _, dev := range []string{"nul", "con", "prn", "aux", "com1", "lpt1"} {
		got := FileName(dev, "https://cdn.example/x.safetensors")
		if got == dev+".safetensors" {
			t.Errorf("FileName(%q) produced a bare device name: %q", dev, got)
		}
	}
}

// LegacyFileName is the migration contract with files already on disk: it must
// keep reproducing the historical app.sdxlModelPath rule exactly.
func TestLegacyFileName(t *testing.T) {
	cases := []struct{ url, want string }{
		{"https://cdn.example/anima_baseV10.safetensors", "anima_baseV10.safetensors"},
		{"https://cdn.example/a/b/c/model_v2.safetensors", "model_v2.safetensors"},
		{"https://cdn.example/x.safetensors?token=abc", "x.safetensors"},
		{"https://cdn.example/weights.bin", "model.safetensors"},
		{"https://cdn.example/", "model.safetensors"},
		{"", "model.safetensors"},
		{"not a url at all", "model.safetensors"},
	}
	for _, c := range cases {
		if got := LegacyFileName(c.url); got != c.want {
			t.Errorf("LegacyFileName(%q) = %q, want %q", c.url, got, c.want)
		}
	}
}

func TestIsSafeKey(t *testing.T) {
	safe := []string{"anima-base-1a2b3c4d.safetensors", "model.safetensors"}
	unsafe := []string{
		"", "index.json", "..", "../x.safetensors", "a/b.safetensors",
		`a\b.safetensors`, "x.bin", "..x..safetensors",
	}
	for _, k := range safe {
		if !IsSafeKey(k) {
			t.Errorf("IsSafeKey(%q) = false, want true", k)
		}
	}
	for _, k := range unsafe {
		if IsSafeKey(k) {
			t.Errorf("IsSafeKey(%q) = true, want false", k)
		}
	}
}
