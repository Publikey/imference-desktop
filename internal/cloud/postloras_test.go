package cloud

import (
	"encoding/json"
	"strings"
	"testing"

	"imference-desktop-go/internal/types"
)

// The cloud body carries catalog codes + weights under "loras" (imference's
// PostImagePayload.Loras), and nothing at all when no LoRA is picked.
func TestPostBodyLoras(t *testing.T) {
	with, _ := json.Marshal(postBody{Model: "m", Prompt: "p",
		Loras: postLoras([]types.CloudLoraRef{{Code: "detail-tweaker-xl", Weight: 1.5}})})
	if !strings.Contains(string(with), `"loras":[{"code":"detail-tweaker-xl","weight":1.5}]`) {
		t.Errorf("unexpected body: %s", with)
	}
	without, _ := json.Marshal(postBody{Model: "m", Prompt: "p", Loras: postLoras(nil)})
	if strings.Contains(string(without), "loras") {
		t.Errorf("no LoRA must mean no loras key: %s", without)
	}
}
