package cloud

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"imference-desktop-go/internal/types"
)

// Call history (GET /history on the API). The server keeps each call and its
// results, never the prompt or the settings, and hands out result URLs for
// 24 h. An API key reads its own calls; a wallet (x402) proves it is the payer
// with a Sign-In with Ethereum message (EIP-4361) signed by personal_sign.

const historyPath = "/history"

// HistorySignInStatement is the statement the API requires (imference
// app/api/wallet_auth.go): a signature made for another purpose never works.
const HistorySignInStatement = "Read my Imference call history."

// HistorySignInMessage is the EIP-4361 message granting read access to the
// call history of addr on the API at base, from now until now+ttl (the API
// accepts at most 24 h).
func HistorySignInMessage(base string, addr common.Address, now time.Time, ttl time.Duration) (string, error) {
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("cloud: bad API base %q", base)
	}
	var n [12]byte
	if _, err := rand.Read(n[:]); err != nil {
		return "", err
	}
	iso := func(t time.Time) string { return t.UTC().Format(time.RFC3339) }
	return strings.Join([]string{
		u.Host + " wants you to sign in with your Ethereum account:",
		addr.Hex(),
		"",
		HistorySignInStatement,
		"",
		"URI: " + u.Scheme + "://" + u.Host + historyPath,
		"Version: 1",
		"Chain ID: 8453",
		"Nonce: " + hex.EncodeToString(n[:]),
		"Issued At: " + iso(now),
		"Expiration Time: " + iso(now.Add(ttl)),
	}, "\n"), nil
}

// WalletAuthHeader is the X-Wallet-Auth value for a signed sign-in message.
func WalletAuthHeader(message, signature string) string {
	raw, _ := json.Marshal(map[string]string{"message": message, "signature": signature})
	return base64.StdEncoding.EncodeToString(raw)
}

// Base is the API base URL this client talks to.
func (c *Client) Base() string { return c.base }

// ErrHistoryUnauthorized: the API refused the key or the wallet sign-in.
var ErrHistoryUnauthorized = errors.New("cloud: history: not authorized")

// History reads one page of the call history, newest first: the API key's
// calls when apiKey is set, else the wallet's (walletAuth = X-Wallet-Auth).
func (c *Client) History(ctx context.Context, apiKey, walletAuth, cursor string, limit int) (types.CloudHistoryPage, error) {
	q := url.Values{}
	if limit > 0 {
		q.Set("limit", fmt.Sprint(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	reqCtx, cancel := context.WithTimeout(ctx, statusTimeout)
	defer cancel()
	target := c.base + historyPath
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	r, _ := http.NewRequestWithContext(reqCtx, http.MethodGet, target, nil)
	r.Header.Set("Accept", "application/json")
	switch {
	case apiKey != "":
		r.Header.Set("Authorization", "Bearer "+apiKey)
	case walletAuth != "":
		r.Header.Set("X-Wallet-Auth", walletAuth)
	default:
		return types.CloudHistoryPage{}, errors.New("cloud: history needs an API key or a wallet")
	}
	resp, err := c.http.Do(r)
	if err != nil {
		return types.CloudHistoryPage{}, fmt.Errorf("cloud: GET %s: %w", historyPath, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return types.CloudHistoryPage{}, fmt.Errorf("%w: %s", ErrHistoryUnauthorized, strings.TrimSpace(string(body)))
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return types.CloudHistoryPage{}, fmt.Errorf("cloud: %s HTTP %d: %s", historyPath, resp.StatusCode, string(body))
	}
	var page types.CloudHistoryPage
	if err := json.NewDecoder(resp.Body).Decode(&page); err != nil {
		return types.CloudHistoryPage{}, fmt.Errorf("cloud: parse %s: %w", historyPath, err)
	}
	if page.Data == nil {
		page.Data = []types.CloudHistoryItem{}
	}
	return page, nil
}

// DownloadOutput fetches a result again (a history URL still within its 24 h)
// as a data URL, with the same retries as a fresh result.
func (c *Client) DownloadOutput(ctx context.Context, src string) (string, error) {
	u, err := url.Parse(src)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") {
		return "", fmt.Errorf("cloud: not a result URL: %q", src)
	}
	b64, mime, err := c.downloadWithRetry(ctx, src)
	if err != nil {
		return "", fmt.Errorf("cloud: download result: %w", err)
	}
	return "data:" + mime + ";base64," + b64, nil
}
