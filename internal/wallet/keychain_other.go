//go:build !windows

package wallet

import "errors"

// On non-Windows the POC has no keychain backend (yet). The wallet
// surface keeps the same API so callers don't need build tags, but
// every operation reports ErrNoKeychainBackend so the renderer can
// show a helpful message.

var errNoBackend = errors.New("wallet: keychain backend not implemented on this OS (POC is Windows-only)")

func LoadFromKeychain() (*Wallet, error) { return nil, errNoBackend }
func SaveToKeychain(_ *Wallet) error     { return errNoBackend }
func DeleteFromKeychain() error          { return errNoBackend }
