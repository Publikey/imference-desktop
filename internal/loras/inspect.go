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
	"regexp"
	"strings"
)

// Families a LoRA can be detected as. "flux" covers FLUX-derived DiTs.
const (
	FamilySDXL   = "sdxl"
	FamilySD15   = "sd15"
	FamilySD2    = "sd2"
	FamilyFlux   = "flux"
	FamilyZImage = "zimage"
	FamilyKrea2  = "krea2"
	FamilyAnima  = "anima"
)

// Key layouts of the DiT families (original / ComfyUI / kohya / diffusers
// spellings, from diffusers' lora_conversion_utils). Checked before the UNet
// heuristics: an Anima LoRA in diffusers format has attn2.to_k too.
var ditKeys = []struct {
	re     *regexp.Regexp
	family string
}{
	{regexp.MustCompile(`(noise_refiner|context_refiner|(^|[._])layers[._]\d+[._](attention|feed_forward)[._])`), FamilyZImage},
	{regexp.MustCompile(`(txtfusion\.|text_fusion\.|\.attn\.(wq|wk|wv|wo|to_gate)\.|(^|\.)(tmlp|txtmlp)\.)`), FamilyKrea2},
	{regexp.MustCompile(`(llm_adapter\.|text_conditioner\.|adaln_modulation_(self_attn|cross_attn|mlp)|` +
		`\.(self_attn|cross_attn)\.(q_proj|k_proj|v_proj|output_proj)\.|transformer_blocks\.\d+\.norm[123]\.linear_[12])`), FamilyAnima},
}

// unetKeys mark UNet cross-attention: DiTs have attn2.to_k too, with other widths.
var unetKeys = []string{"down_blocks", "up_blocks", "mid_block", "input_blocks", "output_blocks", "middle_block"}

// maxHeaderBytes bounds the JSON header; a real one is a few hundred KB.
const maxHeaderBytes = 100 << 20

// supportedBackends are the backends whose engine side applies user LoRAs
// (imference-engine PipelineBackend.supports_loras). Flip one here when the
// engine enables it and the pinned engine version ships it (DiTs: v0.4.5).
var supportedBackends = map[string]bool{"sdxl": true, "zimage": true, "krea2": true, "anima": true}

// crossAttnWidth maps the input dim of an attn2.to_k down projection (the
// text-embedding width) to a family.
var crossAttnWidth = map[int]string{2048: FamilySDXL, 768: FamilySD15, 1024: FamilySD2}

// Info is what Inspect learned about a file.
type Info struct {
	Family string // "" when unrecognized
	Reason string // what the detection was based on
	// TriggerWords are the prompt words the LoRA was trained with, when the
	// file says so (see triggerWords). Empty when unknown.
	TriggerWords []string
	// TextEncoderTrained is true when the file carries text-encoder weights.
	// Without them no token was learned, so trigger words are optional: the
	// style applies regardless of the prompt.
	TextEncoderTrained bool
}

// maxTriggerWords caps what is surfaced to the UI.
const maxTriggerWords = 5

// triggerShare is the share of training captions a leading tag must start
// for it to count as the trigger (kohya keep_tokens puts it first).
const triggerShare = 0.8

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
	keys := make([]string, 0, len(header))
	for k := range header {
		if k != "__metadata__" {
			keys = append(keys, k)
		}
	}
	info := Info{
		TriggerWords:       triggerWords(metadata),
		TextEncoderTrained: hasTextEncoderKeys(keys),
	}
	switch {
	case familyFromMetadata(metadata) != "":
		info.Family, info.Reason = familyFromMetadata(metadata), "trainer metadata"
	case familyFromKeys(keys) != "":
		info.Family, info.Reason = familyFromKeys(keys), "key layout"
	case familyFromCrossAttention(header, keys) != "":
		info.Family, info.Reason = familyFromCrossAttention(header, keys), "cross-attention width"
	default:
		info.Reason = "unrecognized layout"
	}
	return info, nil
}

// triggerWords reads the trigger words from the metadata:
//   - modelspec.trigger_phrase when the trainer wrote one (comma-separated);
//   - otherwise kohya's ss_tag_frequency ({dataset_dir: {caption: count}}):
//     the leading tag shared by at least triggerShare of the captions. A
//     sentence caption ("pixelbuildings128 a red couch") contributes its
//     first word, a tag caption ("sks_girl, 1girl, smile") its first tag.
func triggerWords(md map[string]string) []string {
	if phrase := strings.TrimSpace(md["modelspec.trigger_phrase"]); phrase != "" {
		return splitWords(phrase)
	}
	var freq map[string]map[string]int
	if json.Unmarshal([]byte(md["ss_tag_frequency"]), &freq) != nil || folderLabelsOnly(freq) {
		return nil
	}
	lead := map[string]int{}
	total := 0
	for _, captions := range freq {
		for caption, n := range captions {
			if n <= 0 {
				n = 1
			}
			total += n
			first := strings.TrimSpace(strings.SplitN(caption, ",", 2)[0])
			if fields := strings.Fields(first); len(fields) > 1 && !strings.Contains(caption, ",") {
				first = fields[0] // sentence caption: its first word
			}
			if first != "" {
				lead[first] += n
			}
		}
	}
	var out []string
	for word, n := range lead {
		if total > 0 && float64(n) >= triggerShare*float64(total) {
			out = append(out, word)
		}
	}
	return out // at most one word can pass an 80 % share
}

// folderLabelsOnly is true when the "captions" are just kohya folder labels:
// several dataset folders (<repeats>_<label>) each captioned by exactly its own
// label — caption-less training sorted into folders (Detail Tweaker XL: 1_misc /
// 1_all / 1_portrait / 1_anime). Those are bookkeeping, not trigger words. A
// single folder (Dreambooth-style "10_sks woman") is kept: its label IS the trigger.
func folderLabelsOnly(freq map[string]map[string]int) bool {
	if len(freq) < 2 {
		return false
	}
	for folder, captions := range freq {
		label := folder
		if repeats, rest, ok := strings.Cut(folder, "_"); ok && repeats != "" && strings.Trim(repeats, "0123456789") == "" {
			label = rest
		}
		if len(captions) != 1 {
			return false
		}
		if _, ok := captions[label]; !ok {
			return false
		}
	}
	return true
}

func splitWords(phrase string) []string {
	var out []string
	for _, w := range strings.Split(phrase, ",") {
		if w = strings.TrimSpace(w); w != "" && len(out) < maxTriggerWords {
			out = append(out, w)
		}
	}
	return out
}

func hasTextEncoderKeys(keys []string) bool {
	for _, k := range keys {
		if strings.HasPrefix(k, "lora_te") || strings.HasPrefix(k, "text_encoder") ||
			strings.Contains(k, ".text_encoder") {
			return true
		}
	}
	return false
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
	case strings.HasPrefix(base, "zimage"), strings.HasPrefix(base, "z_image"), strings.HasPrefix(base, "z-image"):
		return FamilyZImage
	case strings.HasPrefix(base, "krea"):
		return FamilyKrea2
	case strings.HasPrefix(base, "anima"):
		return FamilyAnima
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
	case strings.Contains(arch, "z-image"), strings.Contains(arch, "zimage"):
		return FamilyZImage
	case strings.Contains(arch, "krea"):
		return FamilyKrea2
	case strings.Contains(arch, "anima"):
		return FamilyAnima
	}
	return ""
}

func familyFromKeys(keys []string) string {
	for _, d := range ditKeys {
		for _, k := range keys {
			if d.re.MatchString(k) {
				return d.family
			}
		}
	}
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
		if !strings.Contains(k, "attn2") || !strings.Contains(k, "to_k") || !isUNetKey(k) {
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

func isUNetKey(k string) bool {
	for _, u := range unetKeys {
		if strings.Contains(k, u) {
			return true
		}
	}
	return false
}
