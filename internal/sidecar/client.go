package sidecar

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"imference-desktop-go/internal/types"
)

const generateTimeout = 5 * time.Minute

// generateResponse mirrors sidecar/main.py's GenerateResponse.
type generateResponse struct {
	Seeds  []int    `json:"seeds"`
	Images []string `json:"images"`
	Errors []string `json:"errors"`
}

// errorBody is what FastAPI returns on HTTPException.
type errorBody struct {
	Detail any `json:"detail"`
}

// Generate POSTs to the running sidecar's /generate endpoint. Returns an
// error if the sidecar isn't ready or the call fails.
func (m *Manager) Generate(ctx context.Context, req types.GenerationRequest) (types.GenerationResult, error) {
	port := m.Port()
	if port == 0 {
		return types.GenerationResult{}, errors.New("sidecar: not ready")
	}

	buf, _ := json.Marshal(req)
	callCtx, cancel := context.WithTimeout(ctx, generateTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(
		callCtx,
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%d/generate", port),
		bytes.NewReader(buf),
	)
	r.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: generateTimeout + 5*time.Second}
	resp, err := client.Do(r)
	if err != nil {
		return types.GenerationResult{}, fmt.Errorf("sidecar: POST /generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Bubble FastAPI's HTTPException detail when present; falls back to
		// HTTP status for opaque errors. Pydantic 422 detail is a list, so
		// we just stringify whatever shape arrives.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		var parsed errorBody
		_ = json.Unmarshal(body, &parsed)
		if parsed.Detail != nil {
			return types.GenerationResult{}, fmt.Errorf("sidecar: HTTP %d: %v", resp.StatusCode, parsed.Detail)
		}
		return types.GenerationResult{}, fmt.Errorf("sidecar: HTTP %d: %s", resp.StatusCode, string(body))
	}

	var parsed generateResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return types.GenerationResult{}, fmt.Errorf("sidecar: parse response: %w", err)
	}
	if len(parsed.Images) == 0 || parsed.Images[0] == "" {
		msg := "sidecar returned no image"
		if len(parsed.Errors) > 0 && parsed.Errors[0] != "" {
			msg = parsed.Errors[0]
		}
		return types.GenerationResult{}, errors.New(msg)
	}

	return types.GenerationResult{
		ImageBase64: "data:image/png;base64," + parsed.Images[0],
		Seed:        parsed.Seeds[0],
		Source:      "local",
	}, nil
}
