// Package cloud is the HTTP client for the imference.com credit-based image
// generation endpoint. Mirrors the contract from
// imference-desktop/src/renderer/src/lib/cloud.ts and the Go server-side
// definitions in C:\git windows\imference\app\models\image.go.
package cloud

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"imference-desktop-go/internal/logbus"
	"imference-desktop-go/internal/types"
)

const (
	defaultBase    = "https://imference.com"
	postTimeout    = 30 * time.Second
	statusTimeout  = 10 * time.Second
	pollInterval   = 1 * time.Second
	overallTimeout = 120 * time.Second
)

type Client struct {
	base string
	http *http.Client
	bus  *logbus.Bus
}

func New(bus *logbus.Bus) *Client {
	return &Client{
		base: defaultBase,
		http: &http.Client{Timeout: 60 * time.Second}, // per-request timeouts override
		bus:  bus,
	}
}

// postBody mirrors PostImagePayload in imference/app/models/image.go.
// snake_case JSON tags match the Go server's expectations.
type postBody struct {
	Model          string  `json:"model"`
	Prompt         string  `json:"prompt"`
	NegativePrompt string  `json:"negative_prompt,omitempty"`
	Width          int     `json:"width,omitempty"`
	Height         int     `json:"height,omitempty"`
	NumSteps       int     `json:"num_steps,omitempty"`
	GuidanceScale  float64 `json:"guidance_scale,omitempty"`
	Seed           *int    `json:"seed,omitempty"`
	BatchNbr       int     `json:"batch_nbr,omitempty"`
}

type postResponse struct {
	RequestID string `json:"request_id"`
}

// statusResponse mirrors GetImageResponse in imference/app/models/image.go.
// Note the PascalCase JSON keys — the Go server uses default field names.
type statusResponse struct {
	Data struct {
		RequestID string `json:"RequestID"`
		URL       string `json:"URL"`
		Format    string `json:"Format"`
		Seed      int    `json:"Seed"`
		Timestamp string `json:"Timestamp"`
	} `json:"data"`
}

type statusErrorBody struct {
	Error string `json:"error"`
}

// Generate runs the full POST → poll → download → base64 dance and returns
// a unified GenerationResult ready for the frontend.
func (c *Client) Generate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
) (types.GenerationResult, error) {
	if apiKey == "" {
		return types.GenerationResult{}, errors.New("cloud: API key not set")
	}
	if model == "" {
		return types.GenerationResult{}, errors.New("cloud: cloud model not set")
	}

	overallCtx, cancel := context.WithTimeout(ctx, overallTimeout)
	defer cancel()

	c.bus.Info("cloud", "Generate start", map[string]any{
		"model":  model,
		"prompt": truncate(req.Prompt, 80),
		"width":  req.Width,
		"height": req.Height,
		"steps":  req.NumSteps,
	})

	requestID, err := c.postGenerate(overallCtx, apiKey, model, req)
	if err != nil {
		c.bus.Error("cloud", "postGenerate failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "postGenerate ok", map[string]any{"request_id": requestID})

	imageURL, seed, err := c.pollStatus(overallCtx, apiKey, requestID)
	if err != nil {
		c.bus.Error("cloud", "pollStatus failed", map[string]any{"err": err.Error()})
		return types.GenerationResult{}, err
	}
	c.bus.Info("cloud", "pollStatus ok", map[string]any{"url": imageURL, "seed": seed})

	b64, mime, err := c.downloadAsBase64(overallCtx, imageURL)
	if err != nil {
		c.bus.Error("cloud", "download failed", map[string]any{"err": err.Error(), "url": imageURL})
		return types.GenerationResult{}, fmt.Errorf("cloud: download image: %w", err)
	}
	c.bus.Info("cloud", "download ok", map[string]any{"bytes": len(b64) * 3 / 4, "mime": mime})

	return types.GenerationResult{
		ImageBase64: "data:" + mime + ";base64," + b64,
		Seed:        seed,
		Source:      "cloud",
	}, nil
}

func (c *Client) postGenerate(
	ctx context.Context,
	apiKey, model string,
	req types.GenerationRequest,
) (string, error) {
	body := postBody{
		Model:          model,
		Prompt:         req.Prompt,
		NegativePrompt: req.NegativePrompt,
		Width:          req.Width,
		Height:         req.Height,
		NumSteps:       req.NumSteps,
		GuidanceScale:  req.GuidanceScale,
		Seed:           req.Seed,
		BatchNbr:       1,
	}
	buf, _ := json.Marshal(body)

	postCtx, cancel := context.WithTimeout(ctx, postTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(postCtx, http.MethodPost, c.base+"/image/generate", bytes.NewReader(buf))
	r.Header.Set("Authorization", "Bearer "+apiKey)
	r.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(r)
	if err != nil {
		return "", fmt.Errorf("cloud: POST /image/generate: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Surface the raw body when possible — most failures here are
		// auth-related (401, 402, 403) and the server message is useful.
		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return "", fmt.Errorf("cloud: /image/generate HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed postResponse
	if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
		return "", fmt.Errorf("cloud: parse /image/generate response: %w", err)
	}
	if parsed.RequestID == "" {
		return "", errors.New("cloud: /image/generate returned empty request_id")
	}
	return parsed.RequestID, nil
}

func (c *Client) pollStatus(ctx context.Context, apiKey, requestID string) (string, int, error) {
	statusURL := c.base + "/image/status?request_id=" + url.QueryEscape(requestID)

	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	// Try once immediately, then on every tick. This makes the typical
	// "image was already cached server-side" path return in <1s instead of
	// waiting for the first tick.
	if got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey); err != nil {
		return "", 0, err
	} else if done {
		return got, seed, nil
	}

	for {
		select {
		case <-ctx.Done():
			return "", 0, fmt.Errorf("cloud: status polling timed out after %s", overallTimeout)
		case <-ticker.C:
			got, seed, done, err := c.fetchStatus(ctx, statusURL, apiKey)
			if err != nil {
				return "", 0, err
			}
			if done {
				return got, seed, nil
			}
		}
	}
}

// fetchStatus returns (url, seed, done, err). done=false with err=nil means
// "not ready yet, keep polling" — matches the 404 the server returns while
// the job is still in the queue.
func (c *Client) fetchStatus(ctx context.Context, statusURL, apiKey string) (string, int, bool, error) {
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()

	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, statusURL, nil)
	r.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := c.http.Do(r)
	if err != nil {
		return "", 0, false, fmt.Errorf("cloud: GET /image/status: %w", err)
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusOK:
		var parsed statusResponse
		if err := json.NewDecoder(resp.Body).Decode(&parsed); err != nil {
			return "", 0, false, fmt.Errorf("cloud: parse /image/status: %w", err)
		}
		return parsed.Data.URL, parsed.Data.Seed, true, nil
	case http.StatusNotFound:
		// Expected while job is pending — the server returns
		// {"error": "image not found or not ready yet"}.
		_, _ = io.Copy(io.Discard, resp.Body)
		return "", 0, false, nil
	default:
		var errBody statusErrorBody
		_ = json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("HTTP %d", resp.StatusCode)
		}
		return "", 0, false, fmt.Errorf("cloud: /image/status: %s", msg)
	}
}

// downloadAsBase64 fetches the Azure Blob URL and returns its base64
// payload + mime type. Keeps the frontend's data: URL pipeline identical
// between cloud and local modes.
func (c *Client) downloadAsBase64(ctx context.Context, src string) (string, string, error) {
	c.bus.Trace("cloud", "GET "+src, nil)
	r, _ := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	r.Header.Set("User-Agent", "imference-desktop-go/0.0.1")
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(r)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		// Surface a snippet of the body — Azure Blob returns useful XML
		// (AuthenticationFailed, BlobNotFound, etc.) that beats a bare 404.
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		c.bus.Warn("cloud", "blob non-200", map[string]any{
			"status":  resp.StatusCode,
			"snippet": string(snippet),
			"url":     src,
		})
		return "", "", fmt.Errorf("HTTP %d downloading image: %s", resp.StatusCode, string(snippet))
	}
	mime := resp.Header.Get("Content-Type")
	if mime == "" {
		mime = "image/webp"
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", "", err
	}
	return base64.StdEncoding.EncodeToString(raw), mime, nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
