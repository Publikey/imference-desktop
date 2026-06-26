package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"imference-desktop-go/internal/types"
)

// generateTimeout is generous because the first request after a sidecar boot
// pays a hidden cost: ModelManager.get_or_load() reads the full .safetensors
// (~5-7 GB for SDXL) from disk and copies it to VRAM, which can take 30 s+
// on fast hardware. Subsequent requests on the same model are fast. 30 min
// is a sanity bound; anything longer suggests torch fell back to CPU.
const generateTimeout = 30 * time.Minute

// generatePayload is the inbound shape the sidecar expects. Keys mirror
// the kwargs of imference_engine.Engine.generate, snake_case for Python.
type generatePayload struct {
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negative_prompt,omitempty"`
	Width          int     `json:"width,omitempty"`
	Height         int     `json:"height,omitempty"`
	NumSteps       int     `json:"num_steps,omitempty"`
	GuidanceScale  float64 `json:"guidance_scale,omitempty"`
	Seed           *int    `json:"seed,omitempty"`
	Scheduler      string  `json:"scheduler,omitempty"`
	ClipSkip       *int    `json:"clip_skip,omitempty"`
}

// generateResult mirrors what sidecar/main.py:generate returns.
type generateResult struct {
	Seeds  []int    `json:"seeds"`
	Images []string `json:"images"`
	Errors []string `json:"errors"`
	Device string   `json:"device,omitempty"`
}

// Generate POSTs a generation request to the running Python sidecar via
// stdio JSON-lines and waits for the matching response. Returns the
// unified GenerationResult shape the rest of the app already speaks.
func (m *Manager) Generate(ctx context.Context, req types.GenerationRequest) (types.GenerationResult, error) {
	if m.Status().State != "ready" {
		m.bus.Warn("sidecar", "Generate called but sidecar not ready", nil)
		return types.GenerationResult{}, errors.New("sidecar: not ready")
	}

	payload := generatePayload{
		Prompt:         req.Prompt,
		NegativePrompt: req.NegativePrompt,
		Width:          req.Width,
		Height:         req.Height,
		NumSteps:       req.NumSteps,
		GuidanceScale:  req.GuidanceScale,
		Seed:           req.Seed,
		Scheduler:      req.Scheduler,
		ClipSkip:       req.ClipSkip,
	}

	m.bus.Info("sidecar", "Generate start", map[string]any{
		"prompt": truncate(req.Prompt, 80),
		"steps":  req.NumSteps,
	})

	callCtx, cancel := context.WithTimeout(ctx, generateTimeout)
	defer cancel()
	start := time.Now()

	raw, err := m.Send(callCtx, payload)
	if err != nil {
		m.bus.Error("sidecar", "Generate failed", map[string]any{
			"err":      err.Error(),
			"duration": time.Since(start).String(),
		})
		return types.GenerationResult{}, fmt.Errorf("sidecar: %w", err)
	}

	var res generateResult
	if err := json.Unmarshal(raw, &res); err != nil {
		m.bus.Error("sidecar", "parse response failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, fmt.Errorf("sidecar: parse response: %w", err)
	}

	if len(res.Images) == 0 || res.Images[0] == "" {
		msg := "sidecar returned no image"
		if len(res.Errors) > 0 && res.Errors[0] != "" {
			msg = res.Errors[0]
		}
		m.bus.Error("sidecar", "no image returned", map[string]any{"msg": msg})
		return types.GenerationResult{}, errors.New(msg)
	}

	m.bus.Info("sidecar", "Generate ok", map[string]any{
		"seed":     res.Seeds[0],
		"duration": time.Since(start).String(),
	})

	return types.GenerationResult{
		ImageBase64: "data:image/png;base64," + res.Images[0],
		Seed:        res.Seeds[0],
		Source:      "local",
	}, nil
}
