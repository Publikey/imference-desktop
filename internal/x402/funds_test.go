package x402

// Signing an EIP-3009 authorization is offline: it succeeds with an empty
// wallet, so nothing before settlement notices there is no money. These cover
// the check that does.

import (
	"errors"
	"math/big"
	"testing"
)

func TestInsufficientFundsErrorReadsLikeAnAnswer(t *testing.T) {
	// 0.30 USDC required, 0.12 held — atomic units, 6 decimals.
	e := &InsufficientFundsError{Required: big.NewInt(300_000), Available: big.NewInt(120_000)}
	got := e.Error()
	for _, want := range []string{"$0.3", "$0.12", "top it up"} {
		if !contains(got, want) {
			t.Errorf("message %q should mention %q", got, want)
		}
	}
	// It must survive wrapping: the cloud client tests for it with errors.As
	// several layers up.
	wrapped := errors.Join(errors.New("context"), error(e))
	var target *InsufficientFundsError
	if !errors.As(wrapped, &target) || target.Required.Cmp(big.NewInt(300_000)) != 0 {
		t.Error("the typed error must be recoverable through errors.As")
	}
}

// A wallet with exactly the price must not be refused — an off-by-one here
// blocks a payment that would have settled.
func TestEnsureFundsBoundary(t *testing.T) {
	price := big.NewInt(300_000)
	for _, c := range []struct {
		name      string
		available int64
		wantErr   bool
	}{
		{"more than enough", 400_000, false},
		{"exactly the price", 300_000, false},
		{"one unit short", 299_999, true},
		{"empty wallet", 0, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			available := big.NewInt(c.available)
			short := available.Cmp(price) < 0
			if short != c.wantErr {
				t.Errorf("available=%d vs price=%d: short=%v, want %v", c.available, price, short, c.wantErr)
			}
		})
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
