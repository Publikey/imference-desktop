package loras

import (
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeLora writes a header-only safetensors file (Inspect never reads data).
func writeLora(t *testing.T, tensors map[string][]int, metadata map[string]string) string {
	t.Helper()
	header := map[string]any{}
	for k, shape := range tensors {
		header[k] = map[string]any{"dtype": "F16", "shape": shape, "data_offsets": []int{0, 0}}
	}
	if metadata != nil {
		header["__metadata__"] = metadata
	}
	blob, err := json.Marshal(header)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 8)
	binary.LittleEndian.PutUint64(buf, uint64(len(blob)))
	path := filepath.Join(t.TempDir(), "l.safetensors")
	if err := os.WriteFile(path, append(buf, blob...), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestInspectDetectsFamily(t *testing.T) {
	cases := []struct {
		name     string
		tensors  map[string][]int
		metadata map[string]string
		family   string
		reason   string
	}{
		{"kohya metadata sdxl", map[string][]int{"lora_unet_x.lora_down.weight": {4, 8}},
			map[string]string{"ss_base_model_version": "sdxl_base_v1-0"}, "sdxl", "trainer metadata"},
		{"modelspec sdxl", map[string][]int{"x.lora_A.weight": {4, 8}},
			map[string]string{"modelspec.architecture": "stable-diffusion-xl-v1-base/lora"}, "sdxl", "trainer metadata"},
		{"kohya metadata sd15", map[string][]int{"lora_unet_x.lora_down.weight": {4, 8}},
			map[string]string{"ss_base_model_version": "sd_v1"}, "sd15", "trainer metadata"},
		{"second text encoder", map[string][]int{"lora_te2_text_model_encoder_layers_0_mlp_fc1.lora_down.weight": {4, 1280}},
			nil, "sdxl", "key layout"},
		{"ldm unet naming", map[string][]int{"lora_unet_input_blocks_4_1_proj_in.lora_down.weight": {4, 640}},
			nil, "sdxl", "key layout"},
		{"flux blocks", map[string][]int{"lora_unet_double_blocks_0_img_attn_proj.lora_down.weight": {4, 3072}},
			nil, "flux", "key layout"},
		{"diffusers sdxl width", map[string][]int{"unet.down_blocks.1.attentions.0.transformer_blocks.0.attn2.to_k.lora_A.weight": {4, 2048}},
			nil, "sdxl", "cross-attention width"},
		{"kohya sd15 width", map[string][]int{"lora_unet_down_blocks_1_attentions_0_transformer_blocks_0_attn2_to_k.lora_down.weight": {4, 768}},
			nil, "sd15", "cross-attention width"},
		{"unknown dit", map[string][]int{"layers.0.attention.to_q.lora_A.weight": {4, 3840}},
			nil, "", "unrecognized layout"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info, err := Inspect(writeLora(t, c.tensors, c.metadata))
			if err != nil {
				t.Fatal(err)
			}
			if info.Family != c.family || info.Reason != c.reason {
				t.Fatalf("got (%q, %q), want (%q, %q)", info.Family, info.Reason, c.family, c.reason)
			}
		})
	}
}

func TestInspectTriggerWords(t *testing.T) {
	sentence := `{"50_pixelbuildings128": {"pixelbuildings128 a red couch": 1, "pixelbuildings128 a pine tree": 2}}`
	tags := `{"10_char": {"sks_girl, 1girl, smile": 3, "sks_girl, solo": 1, "1girl, outdoors": 1}}`
	mixed := `{"10_x": {"a, b": 1, "c, d": 1}}`
	cases := []struct {
		name string
		md   map[string]string
		want []string
	}{
		{"trigger phrase", map[string]string{"modelspec.trigger_phrase": "neon style, glow"}, []string{"neon style", "glow"}},
		{"sentence captions", map[string]string{"ss_tag_frequency": sentence}, []string{"pixelbuildings128"}},
		{"leading tag at 80%", map[string]string{"ss_tag_frequency": tags}, []string{"sks_girl"}},
		{"no dominant tag", map[string]string{"ss_tag_frequency": mixed}, nil},
		{"no metadata", nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info, err := Inspect(writeLora(t, map[string][]int{"x.lora_A.weight": {4, 8}}, c.md))
			if err != nil {
				t.Fatal(err)
			}
			if strings.Join(info.TriggerWords, "|") != strings.Join(c.want, "|") {
				t.Fatalf("got %q, want %q", info.TriggerWords, c.want)
			}
		})
	}
}

func TestInspectTextEncoderTrained(t *testing.T) {
	unetOnly, _ := Inspect(writeLora(t, map[string][]int{"lora_unet_input_blocks_1_0.lora_down.weight": {4, 8}}, nil))
	withTE, _ := Inspect(writeLora(t, map[string][]int{"lora_te1_text_model_x.lora_down.weight": {4, 8}}, nil))
	if unetOnly.TextEncoderTrained || !withTE.TextEncoderTrained {
		t.Fatalf("unet-only=%v with-te=%v", unetOnly.TextEncoderTrained, withTE.TextEncoderTrained)
	}
}

func TestInspectRejectsNonSafetensors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pickled.safetensors")
	if err := os.WriteFile(path, []byte("\x80\x02}q\x00(X\x05\x00\x00\x00model"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Inspect(path); err == nil {
		t.Fatal("expected an error for a pickled file")
	}
}

func TestCompatibleAndBackendSupports(t *testing.T) {
	if !Compatible("sdxl", "sdxl") || !Compatible("", "sdxl") || Compatible("sd15", "sdxl") {
		t.Fatal("Compatible: wrong verdict")
	}
	if !BackendSupports("sdxl") || BackendSupports("zimage") {
		t.Fatal("BackendSupports: only sdxl is wired")
	}
}
