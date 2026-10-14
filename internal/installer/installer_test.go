package installer

import (
	"context"
	"net/http"
	"net/http/httptest"
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
	// The GPU wheel is pinned (CUDA 12 build); the others follow PyPI.
	if got := onnxRuntimeSpec("onnxruntime-gpu"); got != "onnxruntime-gpu=="+OnnxRuntimeGPUVersion {
		t.Errorf("onnxRuntimeSpec(gpu) = %s", got)
	}
	if got := onnxRuntimeSpec("onnxruntime-directml"); got != "onnxruntime-directml" {
		t.Errorf("onnxRuntimeSpec(directml) = %s", got)
	}
}

func TestEngineTarballReachable(t *testing.T) {
	t.Setenv(EngineSourceEnvVar, "")
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	defer ok.Close()
	missing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer missing.Close()

	t.Setenv(EngineSourceEnvVar, ok.URL+"/engine.tar.gz")
	if !EngineTarballReachable(context.Background(), ok.Client()) {
		t.Fatal("reachable archive reported unreachable")
	}
	t.Setenv(EngineSourceEnvVar, missing.URL+"/engine.tar.gz")
	if EngineTarballReachable(context.Background(), missing.Client()) {
		t.Fatal("404 archive reported reachable")
	}
	t.Setenv(EngineSourceEnvVar, t.TempDir()) // editable local checkout: nothing to fetch
	if !EngineTarballReachable(context.Background(), nil) || EngineTarballURL() != "" {
		t.Fatal("editable override must count as reachable with no URL")
	}
}
