package gpu

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseWinAdaptersSingleObject(t *testing.T) {
	// ConvertTo-Json emits a bare object when there's exactly one adapter.
	out := []byte(`{"DriverDesc":"AMD Radeon RX 7900 XTX","HardwareInformation.qwMemorySize":25753026560}`)
	got := parseWinAdapters(out)
	if len(got) != 1 {
		t.Fatalf("want 1 adapter, got %d", len(got))
	}
	if got[0].DriverDesc != "AMD Radeon RX 7900 XTX" {
		t.Errorf("DriverDesc = %q", got[0].DriverDesc)
	}
	if gib := got[0].QwMemorySize / (1024 * 1024 * 1024); gib < 23.9 || gib > 24.1 {
		t.Errorf("VRAM GiB = %f, want ~24", gib)
	}
}

func TestParseWinAdaptersArray(t *testing.T) {
	out := []byte(`[{"DriverDesc":"AMD Radeon(TM) Graphics","HardwareInformation.qwMemorySize":536870912},` +
		`{"DriverDesc":"NVIDIA GeForce RTX 4070","HardwareInformation.qwMemorySize":12884901888}]`)
	got := parseWinAdapters(out)
	if len(got) != 2 {
		t.Fatalf("want 2 adapters, got %d", len(got))
	}
	if got[1].DriverDesc != "NVIDIA GeForce RTX 4070" {
		t.Errorf("DriverDesc[1] = %q", got[1].DriverDesc)
	}
}

func TestParseWinAdaptersGarbage(t *testing.T) {
	for _, in := range []string{"", "   ", "not json", `{"broken":`} {
		if got := parseWinAdapters([]byte(in)); got != nil {
			t.Errorf("parseWinAdapters(%q) = %v, want nil", in, got)
		}
	}
}

func TestReadSysfsVRAMGiB(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mem_info_vram_total")

	// amdgpu prints the byte count followed by a newline. 16 GiB card:
	if err := os.WriteFile(path, []byte("17163091968\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if gib := readSysfsVRAMGiB(path); gib < 15.9 || gib > 16.1 {
		t.Errorf("VRAM GiB = %f, want ~16", gib)
	}

	if gib := readSysfsVRAMGiB(filepath.Join(dir, "missing")); gib != 0 {
		t.Errorf("missing file: got %f, want 0", gib)
	}
	if err := os.WriteFile(path, []byte("junk"), 0o644); err != nil {
		t.Fatal(err)
	}
	if gib := readSysfsVRAMGiB(path); gib != 0 {
		t.Errorf("junk content: got %f, want 0", gib)
	}
}
