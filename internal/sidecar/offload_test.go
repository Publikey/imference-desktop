package sidecar

import "testing"

// Deterministic resolveOffload paths — the ones that never reach the GPU probe
// (explicit settings, light backends, non-CUDA devices). The Auto+VRAM paths
// depend on gpu.Detect and are exercised manually / in the app log.

func boolPtr(b bool) *bool { return &b }

func TestExplicitOffIsOffRegardlessOfBackend(t *testing.T) {
	v, m, _ := resolveOffload(boolPtr(false), "group", "auto", "krea2")
	if v != "0" || m != "model" {
		t.Fatalf("want 0/model, got %s/%s", v, m)
	}
}

func TestExplicitOnWithExplicitModeSkipsProbe(t *testing.T) {
	v, m, _ := resolveOffload(boolPtr(true), "group", "auto", "sdxl")
	if v != "1" || m != "group" {
		t.Fatalf("want 1/group, got %s/%s", v, m)
	}
	v, m, _ = resolveOffload(boolPtr(true), "model", "auto", "krea2")
	if v != "1" || m != "model" {
		t.Fatalf("want 1/model, got %s/%s", v, m)
	}
}

func TestExplicitOnLightBackendAutoModeIsModel(t *testing.T) {
	// Light backends never need group — resolved without probing the GPU.
	v, m, _ := resolveOffload(boolPtr(true), "", "auto", "sdxl")
	if v != "1" || m != "model" {
		t.Fatalf("want 1/model, got %s/%s", v, m)
	}
}

func TestAutoNonCudaDeviceIsOff(t *testing.T) {
	for _, dev := range []string{"cpu", "mps"} {
		v, m, _ := resolveOffload(nil, "", dev, "krea2")
		if v != "0" || m != "model" {
			t.Fatalf("device=%s: want 0/model, got %s/%s", dev, v, m)
		}
	}
}

func TestBogusModeSettingFallsBackToAuto(t *testing.T) {
	// "banana" is not a mode — a LIGHT backend's auto-pick resolves to model
	// without probing the GPU. (zimage is no longer light: its 12 GiB bf16
	// transformer put it in the heavy tables.)
	v, m, _ := resolveOffload(boolPtr(true), "banana", "auto", "sd15")
	if v != "1" || m != "model" {
		t.Fatalf("want 1/model, got %s/%s", v, m)
	}
}
