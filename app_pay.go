package main

import (
	"errors"
	"strings"

	"imference-desktop-go/internal/types"
)

// StartCardCheckout starts an in-app card purchase of one credit pack (Stripe
// Embedded Checkout, mounted by the frontend). It tops up the saved API key,
// or — for a buyer without one — the imference API creates a key for this
// purchase, returned in APIKey: the frontend adopts it (AdoptAPIKey) once
// Stripe reports the payment done, so an abandoned checkout changes nothing.
func (a *App) StartCardCheckout() (types.CardCheckout, error) {
	co, err := a.cloud.StartCardCheckout(a.ctx, a.settings.Get().APIKey)
	if err != nil {
		a.bus.Warn("app", "StartCardCheckout failed", map[string]any{"err": err.Error()})
		return types.CardCheckout{}, err
	}
	return types.CardCheckout{ClientSecret: co.ClientSecret, PublishableKey: co.PublishableKey, APIKey: co.APIKey}, nil
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
