package cloud

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"

	"imference-desktop-go/internal/types"
)

// apiLora mirrors models.ImLora in imference/app/models/lora.go (GET /api/loras).
type apiLora struct {
	LoraCode              string   `json:"lora_code"`
	Name                  string   `json:"name"`
	ShortDescription      string   `json:"short_description"`
	MediumDescription     string   `json:"medium_description"`
	Image                 string   `json:"image"`
	Category              string   `json:"category"`
	ImEngine              string   `json:"im_engine"`
	ModelFamilyCode       string   `json:"model_family_code"`
	FamilyName            string   `json:"family_name"`
	CompatibleFamilyCodes []string `json:"compatible_family_codes"`
	LoraURL               string   `json:"lora_url"`
	Filename              string   `json:"filename"`
	SHA256                string   `json:"sha256"`
	SizeBytes             *int64   `json:"size_bytes"`
	TriggerWords          []string `json:"trigger_words"`
	TextEncoderTrained    *bool    `json:"text_encoder_trained"`
	WeightDefault         float64  `json:"weight_default"`
	WeightMin             float64  `json:"weight_min"`
	WeightMax             float64  `json:"weight_max"`
	ImLocal               *bool    `json:"im_local"`
	ImCloud               *bool    `json:"im_cloud"`
	CreatorName           string   `json:"creator_name"`
	CreatorURL            string   `json:"creator_url"`
	Licence               string   `json:"licence"`
}

// ErrUnknownModel is returned by ListLoras when the catalog doesn't know the
// model (a user checkpoint, typically) — callers fall back to an engine filter.
var ErrUnknownModel = fmt.Errorf("cloud: model not in the catalog")

// ListLoras fetches the curated LoRA catalog. With modelCode set, only the
// LoRAs compatible with that catalog model are returned (server-side family
// filter); ErrUnknownModel when the catalog doesn't know it. local picks the
// placement flag that must not be false: im_local for the local engine,
// im_cloud for cloud generations. Public endpoint, no auth.
func (c *Client) ListLoras(ctx context.Context, modelCode string, local bool) ([]types.CatalogLora, error) {
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	u := c.base + "/api/loras"
	if modelCode != "" {
		u += "?model=" + url.QueryEscape(modelCode)
	}
	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, u, nil)
	r.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(r)
	if err != nil {
		return nil, fmt.Errorf("cloud: GET /api/loras: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound && modelCode != "" {
		return nil, ErrUnknownModel
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("cloud: /api/loras HTTP %d: %s", resp.StatusCode, string(body))
	}

	var parsed struct {
		Loras []apiLora `json:"loras"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return nil, fmt.Errorf("cloud: parse /api/loras: %w", err)
	}
	out := make([]types.CatalogLora, 0, len(parsed.Loras))
	for _, l := range parsed.Loras {
		flag := l.ImCloud
		if local {
			flag = l.ImLocal
		}
		if flag != nil && !*flag {
			continue
		}
		var size int64
		if l.SizeBytes != nil {
			size = *l.SizeBytes
		}
		out = append(out, types.CatalogLora{
			Code: l.LoraCode, Name: l.Name,
			ShortDescription: l.ShortDescription, MediumDescription: l.MediumDescription,
			Image: l.Image, Category: l.Category,
			Engine: l.ImEngine, FamilyCode: l.ModelFamilyCode, FamilyName: l.FamilyName,
			CompatibleFamilyCodes: l.CompatibleFamilyCodes,
			URL:                   l.LoraURL, Filename: l.Filename, SHA256: l.SHA256, SizeBytes: size,
			TriggerWords: l.TriggerWords, TextEncoderTrained: l.TextEncoderTrained,
			WeightDefault: l.WeightDefault, WeightMin: l.WeightMin, WeightMax: l.WeightMax,
			CreatorName: l.CreatorName, CreatorURL: l.CreatorURL, Licence: l.Licence,
		})
	}
	return out, nil
}
