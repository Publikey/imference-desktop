package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/modelfetch"
	"imference-desktop-go/internal/settings"
	"imference-desktop-go/internal/types"
)

// newLoraTestApp builds an App whose settings live in a temp config dir.
func newLoraTestApp(t *testing.T, backend string) *App {
	t.Helper()
	t.Setenv("HOME", t.TempDir())    // POSIX UserConfigDir base
	t.Setenv("APPDATA", t.TempDir()) // Windows UserConfigDir base
	store, err := settings.New()
	if err != nil {
		t.Fatal(err)
	}
	a := &App{settings: store, bus: logbus.New()}
	s := store.Get()
	s.LocalModel = &types.ModelInfo{ModelCode: "m", BackendType: backend}
	if _, err := store.Save(s); err != nil {
		t.Fatal(err)
	}
	return a
}

// writeTestLora writes a header-only safetensors LoRA with one tensor key.
func writeTestLora(t *testing.T, name, key string, shape []int) string {
	t.Helper()
	blob, _ := json.Marshal(map[string]any{
		key: map[string]any{"dtype": "F16", "shape": shape, "data_offsets": []int{0, 0}},
	})
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, uint64(len(blob)))
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, append(buf, blob...), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestAddLoraRecordsFamily(t *testing.T) {
	a := newLoraTestApp(t, "sdxl")
	path := writeTestLora(t, "style.safetensors", "lora_te2_x.lora_down.weight", []int{4, 1280})
	s, err := a.AddLora(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Loras) != 1 || s.Loras[0].Family != "sdxl" || s.Loras[0].Name != "style" {
		t.Fatalf("unexpected library: %+v", s.Loras)
	}
	if _, err := a.AddLora(filepath.Join(t.TempDir(), "x.ckpt")); err == nil {
		t.Fatal("a non-.safetensors file must be refused")
	}
}

func TestValidateLoras(t *testing.T) {
	a := newLoraTestApp(t, "sdxl")
	xl := writeTestLora(t, "xl.safetensors", "lora_te2_x.lora_down.weight", []int{4, 1280})
	sd15 := writeTestLora(t, "old.safetensors",
		"lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight", []int{4, 768})
	for _, p := range []string{xl, sd15} {
		if _, err := a.AddLora(p); err != nil {
			t.Fatal(err)
		}
	}

	req := types.GenerationRequest{Loras: []types.LoraRef{{Path: xl, Weight: 0.8}}}
	if err := a.validateLoras(&req); err != nil {
		t.Fatalf("compatible LoRA refused: %v", err)
	}
	if req.Loras[0].Name != "xl" {
		t.Fatalf("name not filled from the library: %+v", req.Loras[0])
	}

	cases := map[string][]types.LoraRef{
		"is for sd15":        {{Path: sd15, Weight: 1}},
		"not in the library": {{Path: filepath.Join(t.TempDir(), "other.safetensors"), Weight: 1}},
		"at most 4":          {{Path: xl}, {Path: xl}, {Path: xl}, {Path: xl}, {Path: xl}},
	}
	for want, loras := range cases {
		req := types.GenerationRequest{Loras: loras}
		if err := a.validateLoras(&req); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("want error containing %q, got %v", want, err)
		}
	}

	za := newLoraTestApp(t, "zimage")
	req = types.GenerationRequest{Loras: []types.LoraRef{{Path: xl, Weight: 1}}}
	if err := za.validateLoras(&req); err == nil || !strings.Contains(err.Error(), "not supported") {
		t.Fatalf("LoRAs on zimage must be refused, got %v", err)
	}
}

// servedLora serves a header-only safetensors LoRA over HTTP and returns its
// catalog entry (URL + SHA256 of exactly what's served).
func servedLora(t *testing.T, key string, shape []int) (types.CatalogLora, func()) {
	t.Helper()
	path := writeTestLora(t, "served.safetensors", key, shape)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write(body)
	}))
	sum := sha256.Sum256(body)
	return types.CatalogLora{
		Code: "detail-tweaker-xl", Name: "Detail Tweaker XL", Engine: "sdxl",
		CompatibleFamilyCodes: []string{"sdxl"}, URL: srv.URL + "/x.safetensors",
		SHA256: strings.ToUpper(hex.EncodeToString(sum[:])), SizeBytes: int64(len(body)),
		TriggerWords: []string{}, WeightDefault: 1.5, WeightMin: -3, WeightMax: 3,
	}, srv.Close
}

func TestFetchCatalogLora(t *testing.T) {
	l, stop := servedLora(t, "lora_te2_x.lora_down.weight", []int{4, 1280})
	defer stop()
	dir := t.TempDir()

	entry, err := fetchCatalogLora(t.Context(), modelfetch.New(logbus.New()), l, dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if entry.Path != filepath.Join(dir, "detail-tweaker-xl.safetensors") || !entry.Managed ||
		entry.CatalogCode != "detail-tweaker-xl" || *entry.WeightDefault != 1.5 || *entry.WeightMin != -3 {
		t.Errorf("unexpected entry: %+v", entry)
	}

	// SHA256 mismatch: refused and the file is gone.
	bad := l
	bad.Code = "bad-sha"
	bad.SHA256 = strings.Repeat("0", 64)
	if _, err := fetchCatalogLora(t.Context(), modelfetch.New(logbus.New()), bad, dir, nil); err == nil ||
		!strings.Contains(err.Error(), "SHA256") {
		t.Fatalf("want a SHA256 error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "bad-sha.safetensors")); !os.IsNotExist(err) {
		t.Error("a file failing the SHA256 check must be removed")
	}
}

func TestFetchCatalogLoraRefusesAnotherFamily(t *testing.T) {
	l, stop := servedLora(t,
		"lora_unet_down_blocks_0_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight", []int{4, 768})
	defer stop()
	if _, err := fetchCatalogLora(t.Context(), modelfetch.New(logbus.New()), l, t.TempDir(), nil); err == nil ||
		!strings.Contains(err.Error(), "sd15") {
		t.Fatalf("an SD1.5 file served as an SDXL LoRA must be refused, got %v", err)
	}
}

func TestValidateLorasCatalogFamilyAndBounds(t *testing.T) {
	a := newLoraTestApp(t, "sdxl")
	s := a.settings.Get()
	s.LocalModel.FamilyCode = "illustrious"
	path := writeTestLora(t, "cat.safetensors", "lora_te2_x.lora_down.weight", []int{4, 1280})
	wd, wmin, wmax := 1.5, -3.0, 3.0
	s.Loras = []types.LoraEntry{{
		Path: path, Name: "Detail", Family: "sdxl", CatalogCode: "detail",
		CompatibleFamilyCodes: []string{"sdxl"}, WeightDefault: &wd, WeightMin: &wmin, WeightMax: &wmax,
	}}
	if _, err := a.settings.Save(s); err != nil {
		t.Fatal(err)
	}

	req := types.GenerationRequest{Loras: []types.LoraRef{{Path: path, Weight: 1.5}}}
	if err := a.validateLoras(&req); err == nil || !strings.Contains(err.Error(), "illustrious") {
		t.Fatalf("an sdxl-only catalog LoRA on an illustrious model must be refused, got %v", err)
	}

	s.LocalModel.FamilyCode = "sdxl"
	if _, err := a.settings.Save(s); err != nil {
		t.Fatal(err)
	}
	req = types.GenerationRequest{Loras: []types.LoraRef{{Path: path, Weight: 1.5}}}
	if err := a.validateLoras(&req); err != nil {
		t.Fatalf("compatible catalog LoRA refused: %v", err)
	}
	req = types.GenerationRequest{Loras: []types.LoraRef{{Path: path, Weight: 3.5}}}
	if err := a.validateLoras(&req); err == nil || !strings.Contains(err.Error(), "maximum") {
		t.Fatalf("a weight above the catalog max must be refused, got %v", err)
	}
}
