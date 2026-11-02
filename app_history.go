package main

import (
	"errors"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum/common"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
)

// Cloud call history: the calls this user's API key or wallet paid for, read
// from the API (GET /history). The server keeps the call and its results only,
// never the prompt or the settings, and serves result URLs for 24 h: within
// that window a result can be downloaded again into the gallery.

const historyPageSize = 30

// historySigner personal_signs the history sign-in: the keychain wallet on the
// desktop, the browser wallet on the web.
type historySigner interface {
	Address() common.Address
	SignPersonal(message string) (string, error)
}

// historyAuthCache keeps one signed sign-in until shortly before it expires,
// so paging the history does not ask the wallet again.
type historyAuthCache struct {
	mu     sync.Mutex
	addr   common.Address
	header string
	until  time.Time
}

var errNoHistoryRail = errors.New("no API key or wallet to read a history with")

func (a *App) loadHistorySigner() (historySigner, error) {
	if a.historySigner != nil {
		return a.historySigner()
	}
	w, err := wallet.LoadFromKeychain()
	if err != nil {
		return nil, errNoWallet
	}
	return w, nil
}

// historyRails lists the rails this user can read: "credits" with an API key,
// "x402" with a wallet.
func (a *App) historyRails() []string {
	var rails []string
	if a.settings.Get().APIKey != "" {
		rails = append(rails, "credits")
	}
	if _, err := a.loadHistorySigner(); err == nil {
		rails = append(rails, "x402")
	}
	return rails
}

// walletAuth returns a valid X-Wallet-Auth for signer, signing a new sign-in
// only when the cached one is for another wallet or about to expire.
func (a *App) walletAuth(signer historySigner) (string, error) {
	c := &a.historyAuth
	c.mu.Lock()
	defer c.mu.Unlock()
	addr := signer.Address()
	now := time.Now()
	if c.header != "" && c.addr == addr && now.Before(c.until) {
		return c.header, nil
	}
	ttl := a.historyTTL
	if ttl <= 0 {
		ttl = time.Hour
	}
	msg, err := cloud.HistorySignInMessage(a.cloud.Base(), addr, now, ttl)
	if err != nil {
		return "", err
	}
	sig, err := signer.SignPersonal(msg)
	if err != nil {
		return "", err
	}
	c.addr, c.header, c.until = addr, cloud.WalletAuthHeader(msg, sig), now.Add(ttl-5*time.Minute)
	return c.header, nil
}

// ListCloudHistory returns one page of the cloud call history, newest first.
// rail "credits" reads the API key's calls, "x402" the wallet's (signed in
// with the wallet, no payment); "" picks the payment mode's rail when it is
// available, else the other one. cursor is the previous page's NextCursor.
func (a *App) ListCloudHistory(rail, cursor string) (types.CloudHistoryPage, error) {
	rails := a.historyRails()
	if len(rails) == 0 {
		return types.CloudHistoryPage{Data: []types.CloudHistoryItem{}, Rails: []string{}}, errNoHistoryRail
	}
	if rail == "" {
		rail = cloudRail(a.settings.Get().PaymentMode)
	}
	if !contains(rails, rail) {
		rail = rails[0]
	}
	var apiKey, auth string
	if rail == "credits" {
		apiKey = a.settings.Get().APIKey
	} else {
		signer, err := a.loadHistorySigner()
		if err != nil {
			return types.CloudHistoryPage{}, err
		}
		if auth, err = a.walletAuth(signer); err != nil {
			return types.CloudHistoryPage{}, err
		}
	}
	page, err := a.cloud.History(a.ctx, apiKey, auth, cursor, historyPageSize)
	if errors.Is(err, cloud.ErrHistoryUnauthorized) && auth != "" {
		// The server refused the cached sign-in (clock, restart): sign again once.
		a.historyAuth.mu.Lock()
		a.historyAuth.header = ""
		a.historyAuth.mu.Unlock()
		signer, serr := a.loadHistorySigner()
		if serr != nil {
			return types.CloudHistoryPage{}, serr
		}
		if auth, err = a.walletAuth(signer); err != nil {
			return types.CloudHistoryPage{}, err
		}
		page, err = a.cloud.History(a.ctx, "", auth, cursor, historyPageSize)
	}
	if err != nil {
		a.bus.Warn("app", "ListCloudHistory failed", map[string]any{"err": err.Error(), "rail": rail})
		return types.CloudHistoryPage{}, err
	}
	page.Rail, page.Rails = rail, rails
	return page, nil
}

// RedownloadCloudOutput downloads a past cloud result again (its URL is served
// for 24 h) and saves it to the gallery like a fresh one. The prompt and the
// settings were never kept, so the saved file carries only what the history
// knows: where it came from, its size and its time.
func (a *App) RedownloadCloudOutput(item types.CloudHistoryItem, index int) (types.GenerationResult, error) {
	if index < 0 || index >= len(item.Outputs) || item.Outputs[index].URL == "" {
		return types.GenerationResult{}, errors.New("this result is no longer available")
	}
	out := item.Outputs[index]
	dataURL, err := a.cloud.DownloadOutput(a.ctx, out.URL)
	if err != nil {
		a.bus.Warn("app", "RedownloadCloudOutput failed", map[string]any{"err": err.Error(), "request_id": item.RequestID})
		return types.GenerationResult{}, err
	}
	result := types.GenerationResult{ImageBase64: dataURL, Source: "cloud"}
	meta := types.GenerationMeta{Width: out.Width, Height: out.Height}
	if item.Kind == "tool" {
		result.Source = "tool"
		meta.Tool, meta.RanOn = item.ToolID, "cloud"
	}
	a.autoSave(&result, meta)
	return result, nil
}
