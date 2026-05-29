//go:build !windows && !darwin

package wallet

import "errors"

// On platforms other than Windows and macOS the POC has no keychain backend
// (Linux Secret Service is TODO). The wallet surface keeps the same API so
// callers don't need build tags, but every operation reports errNoBackend so
// the renderer can show a helpful message.

var errNoBackend = errors.New("wallet: keychain backend not implemented on this OS (Windows + macOS only)")

func LoadFromKeychain() (*Wallet, error) { return nil, errNoBackend }
func SaveToKeychain(_ *Wallet) error     { return errNoBackend }
func DeleteFromKeychain() error          { return errNoBackend }
