// Package wallet manages the EVM keypair used to sign x402 payment
// authorizations on Base mainnet. The private key never leaves this
// package — callers use Signer methods to request signatures and the
// public Address() for display/lookups.
//
// Storage: the private key (hex-encoded, no 0x prefix) is persisted in
// the OS secrets store (Windows Credential Manager via wincred). The
// public address is also mirrored to settings.json so the renderer can
// display it before/without unlocking the keychain.
//
// Security model: the wallet is intentionally a "burner" — only fund
// what you're OK losing on this machine. We do not encrypt the key
// beyond what the OS keychain provides; the OS already enforces per-user
// access. A "compromised machine" threat model is out of scope.
package wallet

import (
	"crypto/ecdsa"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

// Wallet is a thin wrapper around an ECDSA secp256k1 key. Construct via
// Generate() or Import(); never expose the embedded private key outside
// this package.
type Wallet struct {
	priv *ecdsa.PrivateKey
}

// Generate creates a fresh secp256k1 keypair using crypto/rand under the
// hood (via go-ethereum/crypto.GenerateKey).
func Generate() (*Wallet, error) {
	priv, err := crypto.GenerateKey()
	if err != nil {
		return nil, fmt.Errorf("wallet: generate key: %w", err)
	}
	return &Wallet{priv: priv}, nil
}

// Import parses a hex-encoded private key (with or without 0x prefix,
// case-insensitive, 64 hex chars / 32 bytes). Returns an error on any
// malformed input — does NOT silently accept partial / padded keys.
func Import(hexKey string) (*Wallet, error) {
	k := strings.TrimSpace(hexKey)
	k = strings.TrimPrefix(k, "0x")
	k = strings.TrimPrefix(k, "0X")
	if len(k) != 64 {
		return nil, fmt.Errorf("wallet: private key must be 64 hex chars (got %d)", len(k))
	}
	if _, err := hex.DecodeString(k); err != nil {
		return nil, fmt.Errorf("wallet: private key is not valid hex: %w", err)
	}
	priv, err := crypto.HexToECDSA(k)
	if err != nil {
		return nil, fmt.Errorf("wallet: parse private key: %w", err)
	}
	return &Wallet{priv: priv}, nil
}

// Address returns the public EVM address derived from the private key.
// Safe to expose to the renderer / log / settings.json.
func (w *Wallet) Address() common.Address {
	return crypto.PubkeyToAddress(w.priv.PublicKey)
}

// PrivateKeyHex returns the 64-char lowercase hex (no 0x prefix) form
// of the private key. ONLY called by the "Export private key" path —
// the renderer should immediately display + invite the user to back it
// up. Never log this value.
func (w *Wallet) PrivateKeyHex() string {
	return hex.EncodeToString(crypto.FromECDSA(w.priv))
}

// privateKey is package-internal access for sign.go. Stays unexported
// so other packages can't reach in.
func (w *Wallet) privateKey() *ecdsa.PrivateKey {
	return w.priv
}

var ErrNoWallet = errors.New("wallet: no wallet configured in keychain")
