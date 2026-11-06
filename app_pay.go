package main

import (
	"errors"
	"os"
	"strings"

	"imference-desktop-go/internal/types"
	"imference-desktop-go/internal/wallet"
)

// StartCardCheckout starts an in-app card purchase of `packs` credit packs (Stripe
// Embedded Checkout, mounted by the frontend). It tops up the saved Imference
// key, or — for a buyer without one — the imference API creates a key for this
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

// SaveAPIKeyFile writes the saved Imference key to a text file the user picks
// (a native "Save as" dialog): the key holds the credits, and a copy outside
// the app is a way back to them if this computer is lost. Returns the path,
// or "" when the dialog was cancelled.
func (a *App) SaveAPIKeyFile() (string, error) {
	key := a.settings.Get().APIKey
	if key == "" {
		return "", errors.New("no Imference key to save")
	}
	if a.app == nil {
		return "", errors.New("app not ready")
	}
	path, err := a.app.Dialog.SaveFile().
		SetFilename("imference-key.txt").
		AddFilter("Text file", "*.txt").
		PromptForSingleSelection()
	if err != nil || path == "" {
		return "", nil // cancelled
	}
	body := "Imference key (it holds your credits)\n" + key +
		"\n\nUse it in Imference Desktop, Imference Web (https://imference.com/app) or Claude (MCP).\n" +
		"Lost it one day? https://imference.com/key (if you added a recovery email).\n"
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return "", err
	}
	return path, nil
}

// SaveWalletKeyFile writes the app wallet's private key to a text file the
// user picks (native "Save as"), the same way the Imference key is backed up.
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
		return types.Settings{}, errors.New("empty Imference key")
	}
	s := a.settings.Get()
	s.APIKey = key
	s.PaymentMode = "bearer"
	return a.SaveSettings(s)
}

// GetRecoveryEmail returns the saved Imference key's recovery email, masked
// ("j***@gmail.com"), or "" when none is linked.
func (a *App) GetRecoveryEmail() (string, error) {
	return a.cloud.GetRecoveryEmail(a.ctx, a.settings.Get().APIKey)
}

// AddRecoveryEmail links email to the saved Imference key at once;
// imference.com emails the key to it. Returns imference.com's message.
func (a *App) AddRecoveryEmail(email string) (string, error) {
	return a.cloud.AddRecoveryEmail(a.ctx, a.settings.Get().APIKey, email)
}

// RemoveRecoveryEmail unlinks the saved Imference key's recovery email.
func (a *App) RemoveRecoveryEmail() error {
	return a.cloud.RemoveRecoveryEmail(a.ctx, a.settings.Get().APIKey)
}

// CryptoCoins lists the coins a credit pack can be paid with (NOWPayments,
// behind the imference API).
func (a *App) CryptoCoins() ([]types.CryptoCoin, error) {
	return a.cloud.CryptoCoins(a.ctx)
}

// StartCryptoPayment creates a crypto payment for `packs` packs in coin: an
// exact amount and a deposit address. It tops up the saved Imference key or,
// for a buyer without one, a key the imference API creates (in APIKey).
func (a *App) StartCryptoPayment(packs int, coin string) (types.CryptoPayment, error) {
	p, err := a.cloud.StartCryptoPayment(a.ctx, a.settings.Get().APIKey, packs, coin)
	if err != nil {
		a.bus.Warn("app", "StartCryptoPayment failed", map[string]any{"err": err.Error()})
	}
	return p, err
}

// CryptoPaymentStatus reads a crypto payment's state, until it is credited.
func (a *App) CryptoPaymentStatus(orderID string) (types.CryptoStatus, error) {
	return a.cloud.CryptoPaymentStatus(a.ctx, orderID)
}
