package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Optional recovery email of an Imference key (imference.com/key). The key
// stays the only credential; the email only lets its owner get the key sent
// back to it. Adding one links it at once and emails the key to it.

const keyEmailPath = "/key/email"

type keyEmailResponse struct {
	EmailMasked *string `json:"email_masked"`
	Message     string  `json:"message"`
	Error       string  `json:"error"`
}

func (c *Client) keyEmail(ctx context.Context, method, apiKey string, body any) (keyEmailResponse, error) {
	var out keyEmailResponse
	if apiKey == "" {
		return out, errors.New("cloud: Imference key not set")
	}
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	var rdr io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = strings.NewReader(string(raw))
	}
	r, _ := http.NewRequestWithContext(reqCtx, method, c.base+keyEmailPath, rdr)
	r.Header.Set("Authorization", "Bearer "+apiKey)
	r.Header.Set("Accept", "application/json")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(r)
	if err != nil {
		return out, fmt.Errorf("cannot reach imference.com: %w", err)
	}
	defer resp.Body.Close()
	_ = json.NewDecoder(io.LimitReader(resp.Body, 16<<10)).Decode(&out)
	if resp.StatusCode != http.StatusOK {
		if out.Error != "" {
			return out, errors.New(out.Error)
		}
		if resp.StatusCode == http.StatusUnauthorized {
			return out, errors.New("this Imference key isn't recognised")
		}
		return out, fmt.Errorf("imference.com answered %d", resp.StatusCode)
	}
	return out, nil
}

// GetRecoveryEmail returns the key's recovery email, masked ("j***@gmail.com"),
// or "" when none is linked.
func (c *Client) GetRecoveryEmail(ctx context.Context, apiKey string) (string, error) {
	out, err := c.keyEmail(ctx, http.MethodGet, apiKey, nil)
	if err != nil || out.EmailMasked == nil {
		return "", err
	}
	return *out.EmailMasked, nil
}

// AddRecoveryEmail links email to the key; imference.com emails the key to it.
// Returns imference.com's message.
func (c *Client) AddRecoveryEmail(ctx context.Context, apiKey, email string) (string, error) {
	email = strings.TrimSpace(email)
	if email == "" {
		return "", errors.New("enter an email address")
	}
	out, err := c.keyEmail(ctx, http.MethodPost, apiKey, map[string]string{"email": email})
	return out.Message, err
}

// RemoveRecoveryEmail unlinks the key's recovery email.
func (c *Client) RemoveRecoveryEmail(ctx context.Context, apiKey string) error {
	_, err := c.keyEmail(ctx, http.MethodDelete, apiKey, nil)
	return err
}
