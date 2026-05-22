//go:build windows

package wallet

import (
	"errors"
	"fmt"

	"github.com/danieljoos/wincred"
)

// credentialTarget is the Generic-credential target name under which the
// wallet private key is stored in Windows Credential Manager. Visible
// in the Credential Manager UI under this exact name.
const credentialTarget = "imference-desktop-go:wallet-private-key"

// LoadFromKeychain reads the persisted private key. Returns ErrNoWallet
// if no credential exists at the target — caller should offer Generate
// or Import in that case.
func LoadFromKeychain() (*Wallet, error) {
	cred, err := wincred.GetGenericCredential(credentialTarget)
	if err != nil {
		// wincred returns a syscall error with code 1168 (ERROR_NOT_FOUND)
		// when the credential is missing. We treat any error as "no wallet"
		// rather than parsing the syscall code — Generate/Import will
		// resolve it.
		return nil, ErrNoWallet
	}
	hexKey := string(cred.CredentialBlob)
	if hexKey == "" {
		return nil, ErrNoWallet
	}
	return Import(hexKey)
}

// SaveToKeychain persists the wallet's private key as a Generic Windows
// credential. Username field is the wallet address (visible in the
// Credential Manager UI to help the user identify which wallet this is).
// Overwrites any existing credential at the target.
func SaveToKeychain(w *Wallet) error {
	if w == nil {
		return errors.New("wallet: cannot save nil wallet")
	}
	cred := wincred.NewGenericCredential(credentialTarget)
	cred.UserName = w.Address().Hex()
	cred.CredentialBlob = []byte(w.PrivateKeyHex())
	if err := cred.Write(); err != nil {
		return fmt.Errorf("wallet: write to Credential Manager: %w", err)
	}
	return nil
}

// DeleteFromKeychain removes the persisted credential. Safe to call
// even when nothing is stored.
func DeleteFromKeychain() error {
	cred, err := wincred.GetGenericCredential(credentialTarget)
	if err != nil {
		return nil // nothing to delete
	}
	if err := cred.Delete(); err != nil {
		return fmt.Errorf("wallet: delete from Credential Manager: %w", err)
	}
	return nil
}
