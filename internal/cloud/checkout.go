package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// PackCredits is one credit pack (what a card checkout buys): $5.
const PackCredits = 5000

// CardCheckout is a Stripe Embedded Checkout for one credit pack. The page
// mounts Stripe's form with ClientSecret / PublishableKey; nobody leaves the
// app. APIKey is the key the credits land on: the caller's own when it sent
// one, otherwise a new key the imference API created for this purchase (the
// buyer's account from then on).
type CardCheckout struct {
	ClientSecret   string `json:"clientSecret"`
	PublishableKey string `json:"publishableKey"`
	APIKey         string `json:"apiKey"`
}

// StartCardCheckout asks the imference API at base for a card checkout of one
// pack, topping up apiKey (or creating a key when it is empty). The credits
// themselves arrive later, from Stripe's webhook on imference.com: the caller
// polls the balance once Stripe reports the payment done.
func StartCardCheckout(ctx context.Context, httpc *http.Client, base, apiKey string) (CardCheckout, error) {
	if httpc == nil {
		httpc = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"quantity": 1, "ui": "embedded"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(base, "/")+"/credits/add", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return CardCheckout{}, fmt.Errorf("cannot reach the imference API: %w", err)
	}
	defer resp.Body.Close()
	var out struct {
		ClientSecret   string `json:"client_secret"`
		PublishableKey string `json:"publishable_key"`
		APIKey         string `json:"api_key"`
		Error          string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out)
	if resp.StatusCode != http.StatusOK || out.ClientSecret == "" || out.PublishableKey == "" || out.APIKey == "" {
		if out.Error != "" {
			return CardCheckout{}, errors.New(out.Error)
		}
		return CardCheckout{}, fmt.Errorf("the imference API answered %d", resp.StatusCode)
	}
	return CardCheckout{ClientSecret: out.ClientSecret, PublishableKey: out.PublishableKey, APIKey: out.APIKey}, nil
}

// StartCardCheckout runs the package function against this client's API.
func (c *Client) StartCardCheckout(ctx context.Context, apiKey string) (CardCheckout, error) {
	return StartCardCheckout(ctx, c.http, c.base, apiKey)
}
