// Package loras identifies user LoRA files and gates them per backend.
//
// Detection mirrors imference-engine's managers/lora_inspect.py (the engine
// re-checks at load time; doing it here too lets the UI reject or filter a
// file at import instead of failing a generation later). Only the safetensors
// header is read — 8-byte little-endian length + JSON (tensor names, shapes,
// __metadata__) — never the tensor data.
package loras

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// Families a LoRA can be detected as. "flux" covers FLUX-derived DiTs.
const (
	FamilySDXL = "sdxl"
	FamilySD15 = "sd15"
	FamilySD2  = "sd2"
	FamilyFlux = "flux"
)

// maxHeaderBytes bounds the JSON header; a real one is a few hundred KB.
const maxHeaderBytes = 100 << 20

// supportedBackends are the backends whose engine side applies user LoRAs
// (imference-engine PipelineBackend.supports_loras). Flip one here when the
// engine enables it and the pinned engine version ships it.
var supportedBackends = map[string]bool{"sdxl": true}

// crossAttnWidth maps the input dim of an attn2.to_k down projection (the
// text-embedding width) to a family.
var crossAttnWidth = map[int]string{2048: FamilySDXL, 768: FamilySD15, 1024: FamilySD2}

// Info is what Inspect learned about a file.
type Info struct {
	Family string // "" when unrecognized
	Reason string // what the detection was based on
}

// BackendSupports reports whether generations on backend accept LoRAs.
func BackendSupports(backend string) bool { return supportedBackends[backend] }

// Compatible is true unless the LoRA was positively identified for another
// family — an unrecognized layout is let through for the engine to judge.
func Compatible(family, backend string) bool { return family == "" || family == backend }

// Inspect reads path's safetensors header and detects the target family.
// It errors for files that are not safetensors (pickled .pt/.ckpt included).
func Inspect(path string) (Info, error) {
	f, err := os.Open(path)
	if err != nil {
		return Info{}, err
	}
	defer f.Close()

	var n uint64
	if err := binary.Read(f, binary.LittleEndian, &n); err != nil {
		return Info{}, errors.New("not a safetensors file (too short)")
	}
	if n == 0 || n > maxHeaderBytes {
		return Info{}, errors.New("not a safetensors file (bad header length)")
	}
	blob := make([]byte, n)
	if _, err := io.ReadFull(f, blob); err != nil {
		return Info{}, errors.New("not a safetensors file (truncated header)")
	}
	var header map[string]json.RawMessage
	if err := json.Unmarshal(blob, &header); err != nil {
		return Info{}, fmt.Errorf("not a safetensors file (%v)", err)
	}

	var metadata map[string]string
	if raw, ok := header["__metadata__"]; ok {
		_ = json.Unmarshal(raw, &metadata) // malformed metadata = no metadata
	}
	if fam := familyFromMetadata(metadata); fam != "" {
		return Info{fam, "trainer metadata"}, nil
	}
	keys := make([]string, 0, len(header))
	for k := range header {
		if k != "__metadata__" {
			keys = append(keys, k)
		}
	}
	if fam := familyFromKeys(keys); fam != "" {
		return Info{fam, "key layout"}, nil
	}
	if fam := familyFromCrossAttention(header, keys); fam != "" {
		return Info{fam, "cross-attention width"}, nil
	}
	return Info{"", "unrecognized layout"}, nil
}

func familyFromMetadata(md map[string]string) string {
	base := strings.ToLower(md["ss_base_model_version"])
	switch {
	case strings.HasPrefix(base, "sdxl"):
		return FamilySDXL
	case strings.HasPrefix(base, "sd_v1"):
		return FamilySD15
	case strings.HasPrefix(base, "sd_v2"):
		return FamilySD2
	case strings.HasPrefix(base, "flux"):
		return FamilyFlux
	}
	arch := strings.ToLower(md["modelspec.architecture"])
	switch {
	case strings.HasPrefix(arch, "stable-diffusion-xl"):
		return FamilySDXL
	case strings.HasPrefix(arch, "stable-diffusion-v1"):
		return FamilySD15
	case strings.HasPrefix(arch, "stable-diffusion-v2"):
		return FamilySD2
	case strings.HasPrefix(arch, "flux"):
		return FamilyFlux
	}
	return ""
}

func familyFromKeys(keys []string) string {
	for _, k := range keys {
		if strings.HasPrefix(k, "lora_te2_") || strings.Contains(k, "text_encoder_2.") ||
			strings.HasPrefix(k, "lora_unet_input_blocks_") ||
			strings.HasPrefix(k, "lora_unet_output_blocks_") ||
			strings.HasPrefix(k, "lora_unet_middle_block_") {
			return FamilySDXL
		}
	}
	for _, k := range keys {
		if strings.Contains(k, "double_blocks") || strings.Contains(k, "single_blocks") ||
			strings.Contains(k, "single_transformer_blocks") {
			return FamilyFlux
		}
	}
	return ""
}

func familyFromCrossAttention(header map[string]json.RawMessage, keys []string) string {
	for _, k := range keys {
		if !strings.Contains(k, "attn2") || !strings.Contains(k, "to_k") {
			continue
		}
		if !strings.HasSuffix(k, "lora_down.weight") && !strings.HasSuffix(k, "lora_A.weight") {
			continue
		}
		var t struct {
			Shape []int `json:"shape"`
		}
		if json.Unmarshal(header[k], &t) == nil && len(t.Shape) >= 2 {
			return crossAttnWidth[t.Shape[1]]
		}
	}
	return ""
}
