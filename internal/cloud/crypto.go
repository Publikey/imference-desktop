package cloud

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"imference-desktop-go/internal/types"
)

// Credit packs paid in crypto, through the imference API (NOWPayments behind
// it): the coins offered, a payment to make (an exact amount and a deposit
// address), and its state until the credits land.

type apiError struct {
	Error string `json:"error"`
}

func cryptoDo(ctx context.Context, httpc *http.Client, method, u, apiKey string, body, out any) error {
	if httpc == nil {
		httpc = http.DefaultClient
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	var rdr io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		rdr = strings.NewReader(string(raw))
	}
	req, _ := http.NewRequestWithContext(ctx, method, u, rdr)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+apiKey)
	}
	resp, err := httpc.Do(req)
	if err != nil {
		return fmt.Errorf("cannot reach the imference API: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if resp.StatusCode != http.StatusOK {
		var e apiError
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			return errors.New(e.Error)
		}
		return fmt.Errorf("the imference API answered %d", resp.StatusCode)
	}
	return json.Unmarshal(raw, out)
}

// CryptoCoins lists the coins a pack can be paid with.
func CryptoCoins(ctx context.Context, httpc *http.Client, base string) ([]types.CryptoCoin, error) {
	var out struct {
		Coins []struct {
			Code   string  `json:"code"`
			Name   string  `json:"name"`
			MinUSD float64 `json:"min_usd"`
		} `json:"coins"`
	}
	if err := cryptoDo(ctx, httpc, http.MethodGet, strings.TrimRight(base, "/")+"/credits/crypto/coins", "", nil, &out); err != nil {
		return nil, err
	}
	coins := make([]types.CryptoCoin, 0, len(out.Coins))
	for _, c := range out.Coins {
		coins = append(coins, types.CryptoCoin{Code: c.Code, Name: c.Name, MinUSD: c.MinUSD})
	}
	if len(coins) == 0 {
		return nil, errors.New("crypto payments are not available right now")
	}
	return coins, nil
}

// StartCryptoPayment creates a payment of `packs` packs in coin, on apiKey
// (or on a new key when it is empty).
func StartCryptoPayment(ctx context.Context, httpc *http.Client, base, apiKey string, packs int, coin string) (types.CryptoPayment, error) {
	var out struct {
		OrderID      string `json:"order_id"`
		APIKey       string `json:"api_key"`
		PayAddress   string `json:"pay_address"`
		PayAmount    string `json:"pay_amount"`
		PayCurrency  string `json:"pay_currency"`
		CoinName     string `json:"coin_name"`
		Network      string `json:"network"`
		PayinExtraID string `json:"payin_extra_id"`
		ExpiresAt    string `json:"expires_at"`
		Credits      int64  `json:"credits"`
	}
	body := map[string]any{"quantity": ClampPacks(packs), "pay_currency": coin}
	if err := cryptoDo(ctx, httpc, http.MethodPost, strings.TrimRight(base, "/")+"/credits/crypto", apiKey, body, &out); err != nil {
		return types.CryptoPayment{}, err
	}
	if out.OrderID == "" || out.PayAddress == "" || out.APIKey == "" {
		return types.CryptoPayment{}, errors.New("the imference API returned an incomplete payment")
	}
	return types.CryptoPayment{
		OrderID: out.OrderID, APIKey: out.APIKey, PayAddress: out.PayAddress, PayAmount: out.PayAmount,
		PayCurrency: out.PayCurrency, CoinName: out.CoinName, Network: out.Network, PayinExtraID: out.PayinExtraID,
		ExpiresAt: out.ExpiresAt, Credits: out.Credits,
	}, nil
}

// CryptoPaymentStatus reads a payment's state.
func CryptoPaymentStatus(ctx context.Context, httpc *http.Client, base, orderID string) (types.CryptoStatus, error) {
	var out types.CryptoStatus
	u := strings.TrimRight(base, "/") + "/credits/crypto/" + url.PathEscape(orderID)
	err := cryptoDo(ctx, httpc, http.MethodGet, u, "", nil, &out)
	return out, err
}

// CryptoCoins runs the package function against this client's API.
func (c *Client) CryptoCoins(ctx context.Context) ([]types.CryptoCoin, error) {
	return CryptoCoins(ctx, c.http, c.base)
}

// StartCryptoPayment runs the package function against this client's API.
func (c *Client) StartCryptoPayment(ctx context.Context, apiKey string, packs int, coin string) (types.CryptoPayment, error) {
	return StartCryptoPayment(ctx, c.http, c.base, apiKey, packs, coin)
}

// CryptoPaymentStatus runs the package function against this client's API.
func (c *Client) CryptoPaymentStatus(ctx context.Context, orderID string) (types.CryptoStatus, error) {
	return CryptoPaymentStatus(ctx, c.http, c.base, orderID)
}
