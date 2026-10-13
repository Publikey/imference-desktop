package installer

import (
	"strings"
	"testing"

	"imference-desktop-go/internal/gpu"
)

func TestEngineTarballPinsToolsRelease(t *testing.T) {
	t.Setenv(EngineSourceEnvVar, "")
	if got := PinnedEngineVersion(); got != "0.5.0" {
		t.Fatalf("PinnedEngineVersion = %q, want 0.5.0", got)
	}
	if !strings.Contains(EngineTarball, "/tags/v0.5.0.tar.gz") {
		t.Fatalf("EngineTarball must stay a tag pin, got %s", EngineTarball)
	}
	for _, extra := range []string{"sdxl", "krea2", "tools"} {
		if !strings.Contains(EngineTarball, extra) {
			t.Errorf("EngineTarball lacks the %q extra: %s", extra, EngineTarball)
		}
	}
}

func TestEngineSourceOverrideKeepsExtras(t *testing.T) {
	t.Setenv(EngineSourceEnvVar, "/src/imference-engine")
	spec, editable := resolveEngineSource()
	if !editable || spec != "/src/imference-engine["+EngineExtras+"]" {
		t.Fatalf("resolveEngineSource = %q editable=%v", spec, editable)
	}
	if PinnedEngineVersion() != "" {
		t.Fatal("a dev override must not enforce a pinned version")
	}
	t.Setenv(EngineSourceEnvVar, "https://example.com/engine.tar.gz")
	if spec, editable = resolveEngineSource(); editable || spec != "https://example.com/engine.tar.gz" {
		t.Fatalf("URL override: %q editable=%v", spec, editable)
	}
}

func TestOnnxRuntimePackage(t *testing.T) {
	cases := []struct {
		goos   string
		vendor gpu.Vendor
		want   string
	}{
		{"windows", gpu.VendorNVIDIA, "onnxruntime-gpu"},
		{"linux", gpu.VendorNVIDIA, "onnxruntime-gpu"},
		{"windows", gpu.VendorAMD, "onnxruntime-directml"},
		{"windows", gpu.VendorNone, "onnxruntime-directml"},
		{"linux", gpu.VendorAMD, "onnxruntime"},
		{"linux", gpu.VendorNone, "onnxruntime"},
		{"darwin", gpu.VendorApple, "onnxruntime"},
	}
	for _, c := range cases {
		if got := onnxRuntimePackage(c.goos, c.vendor); got != c.want {
			t.Errorf("onnxRuntimePackage(%s, %q) = %s, want %s", c.goos, c.vendor, got, c.want)
		}
	}
}
