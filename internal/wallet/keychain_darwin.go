//go:build darwin

package wallet

import (
	"errors"
	"fmt"
	"os/exec"
	"strings"
)

// macOS keychain backend. We shell out to /usr/bin/security rather than
// linking the Security.framework via cgo: it keeps the build pure-Go (mirroring
// the wincred approach on Windows), needs no extra module, and the CLI ships on
// every macOS install. The key is stored as a generic-password item in the
// user's login keychain — visible in Keychain Access under keychainService.
//
// Security note: passing the key as a `-w <value>` argv is briefly visible to
// other processes of the same user via `ps`. That's consistent with this
// wallet's stated threat model (burner key, "compromised machine" is out of
// scope — see wallet.go). The OS already gates the login keychain per-user.
const (
	securityBin = "/usr/bin/security"

	// keychainService is the item's service attribute — the name shown in
	// Keychain Access. Matches the Windows credential target for parity.
	keychainService = "imference-desktop-go:wallet-private-key"

	// keychainAccount is a fixed account label so the (service, account)
	// primary key is stable across regenerate/import — letting `-U` upsert in
	// place rather than accumulate duplicate items (which would make a
	// find-generic-password lookup ambiguous).
	keychainAccount = "wallet-private-key"
)

// LoadFromKeychain reads the persisted private key from the login keychain.
// Returns ErrNoWallet when no matching item exists.
func LoadFromKeychain() (*Wallet, error) {
	// -w makes security print just the password (our hex key) to stdout.
	out, err := exec.Command(securityBin,
		"find-generic-password",
		"-s", keychainService,
		"-a", keychainAccount,
		"-w",
	).Output()
	if err != nil {
		// security exits non-zero (errSecItemNotFound, 44) when the item is
		// missing. We don't parse the code — any failure means "no usable
		// wallet", and Generate/Import will resolve it.
		return nil, ErrNoWallet
	}
	hexKey := strings.TrimSpace(string(out))
	if hexKey == "" {
		return nil, ErrNoWallet
	}
	return Import(hexKey)
}

// SaveToKeychain stores the private key as a generic-password item, overwriting
// any existing one. -U upserts on the (service, account) primary key, so a
// regenerate/import replaces the old key in place.
func SaveToKeychain(w *Wallet) error {
	if w == nil {
		return errors.New("wallet: cannot save nil wallet")
	}
	out, err := exec.Command(securityBin,
		"add-generic-password",
		"-s", keychainService,
		"-a", keychainAccount,
		"-D", "private key", // kind, shown in Keychain Access
		"-j", w.Address().Hex(), // comment: which wallet this holds (address only)
		"-w", w.PrivateKeyHex(),
		"-U", // update the item if it already exists
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("wallet: write to login keychain: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// DeleteFromKeychain removes the stored item. A missing item is not an error —
// safe to call when nothing is stored.
func DeleteFromKeychain() error {
	out, err := exec.Command(securityBin,
		"delete-generic-password",
		"-s", keychainService,
		"-a", keychainAccount,
	).CombinedOutput()
	if err != nil {
		// errSecItemNotFound → nothing to delete; treat as success.
		if strings.Contains(string(out), "could not be found") {
			return nil
		}
		return fmt.Errorf("wallet: delete from login keychain: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}
