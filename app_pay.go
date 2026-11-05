package main

import (
	"errors"
	"os"
	"strings"

	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
)

// StartCardCheckout starts an in-app card purchase of `packs` credit packs (Stripe
// Embedded Checkout, mounted by the frontend). It tops up the saved API key,
// or — for a buyer without one — the imference API creates a key for this
// purchase, returned in APIKey: the frontend adopts it (AdoptAPIKey) once
// Stripe reports the payment done, so an abandoned checkout changes nothing.
func (a *App) StartCardCheckout(packs int) (types.CardCheckout, error) {
	co, err := a.cloud.StartCardCheckout(a.ctx, a.settings.Get().APIKey, packs)
	if err != nil {
		a.bus.Warn("app", "StartCardCheckout failed", map[string]any{"err": err.Error()})
		return types.CardCheckout{}, err
	}
	return types.CardCheckout{ClientSecret: co.ClientSecret, PublishableKey: co.PublishableKey, APIKey: co.APIKey}, nil
}

// SaveAPIKeyFile writes the saved API key to a text file the user picks (a
// native "Save as" dialog): the key is the account, a copy outside the app is
// the only way back to the credits if this computer is lost. Returns the path,
// or "" when the dialog was cancelled.
func (a *App) SaveAPIKeyFile() (string, error) {
	key := a.settings.Get().APIKey
	if key == "" {
		return "", errors.New("no API key to save")
	}
	if a.app == nil {
		return "", errors.New("app not ready")
	}
	path, err := a.app.Dialog.SaveFile().
		SetFilename("imference-api-key.txt").
		AddFilter("Text file", "*.txt").
		PromptForSingleSelection()
	if err != nil || path == "" {
		return "", nil // cancelled
	}
	body := "Imference API key (your account: it holds your credits)\n" + key +
		"\n\nUse it in Imference Desktop, on https://imference.com, in Claude (MCP) or through the API.\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// SaveWalletKeyFile writes the app wallet's private key to a text file the
// user picks (native "Save as"), the same way the account key is backed up.
// Anyone holding that file can spend the wallet's USDC: the file says so.
// Returns the path, or "" when cancelled.
func (a *App) SaveWalletKeyFile() (string, error) {
	w, err := wallet.LoadFromKeychain()
	if err != nil {
		return "", err
	}
	if a.app == nil {
		return "", errors.New("app not ready")
	}
	path, err := a.app.Dialog.SaveFile().
		SetFilename("imference-wallet-key.txt").
		AddFilter("Text file", "*.txt").
		PromptForSingleSelection()
	if err != nil || path == "" {
		return "", nil // cancelled
	}
	body := "Imference Desktop wallet (USDC on the Base network)\n" +
		"Address: " + w.Address().Hex() + "\n" +
		"Private key: " + w.PrivateKeyHex() + "\n\n" +
		"Anyone with this private key can spend the wallet's USDC. Keep this file private.\n" +
		"It can be imported back into Imference Desktop or into any Ethereum wallet (MetaMask, Rabby...).\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	a.bus.Info("app", "wallet private key saved to a file", map[string]any{"address": w.Address().Hex()})
	return path, nil
}

// AdoptAPIKey saves key as the credits key and makes credits the payment
// method: after a purchase (the key the API created), or a key the user
// pasted ("I already have a key").
func (a *App) AdoptAPIKey(key string) (types.Settings, error) {
	key = strings.TrimSpace(key)
	if key == "" {
		return types.Settings{}, errors.New("empty API key")
	}
	s := a.settings.Get()
	s.APIKey = key
	s.PaymentMode = "bearer"
	return a.SaveSettings(s)
}
