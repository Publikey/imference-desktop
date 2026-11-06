package cloud

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"imference-desktop-go/internal/logbus"
)

func TestCryptoPayment(t *testing.T) {
	var gotAuth string
	var gotBody map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/credits/crypto/coins":
			_, _ = w.Write([]byte(`{"coins":[{"code":"usdttrc20","name":"USDT (Tron)","min_usd":1},{"code":"btc","name":"Bitcoin","min_usd":2.5}],"pack_usd":5}`))
		case r.Method == http.MethodPost && r.URL.Path == "/credits/crypto":
			gotAuth = r.Header.Get("Authorization")
			_ = json.NewDecoder(r.Body).Decode(&gotBody)
			if gotBody["pay_currency"] == "nope" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"error":"This coin is not available. Pick another one."}`))
				return
			}
			_, _ = w.Write([]byte(`{"order_id":"o-1","api_key":"im_new","pay_address":"TXy3","pay_amount":"5.0213","pay_currency":"usdttrc20","coin_name":"USDT (Tron)","network":"trx","payin_extra_id":"","expires_at":"2026-11-06T12:10:00Z","credits":10000}`))
		case r.Method == http.MethodGet && r.URL.Path == "/credits/crypto/o-1":
			_, _ = w.Write([]byte(`{"status":"partially_paid","credits":10000,"credited":4500}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	c := New(logbus.New())
	c.SetBaseURL(srv.URL)
	ctx := context.Background()

	coins, err := c.CryptoCoins(ctx)
	if err != nil || len(coins) != 2 || coins[0].Code != "usdttrc20" || coins[1].MinUSD != 2.5 {
		t.Fatalf("coins: %+v %v", coins, err)
	}

	p, err := c.StartCryptoPayment(ctx, "", 2, "usdttrc20")
	if err != nil {
		t.Fatal(err)
	}
	if gotAuth != "" || gotBody["quantity"] != float64(2) || gotBody["pay_currency"] != "usdttrc20" {
		t.Fatalf("request: auth %q body %v", gotAuth, gotBody)
	}
	if p.OrderID != "o-1" || p.APIKey != "im_new" || p.PayAddress != "TXy3" || p.PayAmount != "5.0213" || p.Credits != 10000 || p.ExpiresAt == "" {
		t.Fatalf("payment: %+v", p)
	}
	// A top-up sends the key; out-of-range packs are clamped.
	if _, err := c.StartCryptoPayment(ctx, "im_old", 1000, "usdttrc20"); err != nil {
		t.Fatal(err)
	}
	if gotAuth != "Bearer im_old" || gotBody["quantity"] != float64(MaxPacks) {
		t.Fatalf("top-up: auth %q body %v", gotAuth, gotBody)
	}
	// The API's message comes through.
	if _, err := c.StartCryptoPayment(ctx, "", 1, "nope"); err == nil || err.Error() != "This coin is not available. Pick another one." {
		t.Fatalf("error: %v", err)
	}

	st, err := c.CryptoPaymentStatus(ctx, "o-1")
	if err != nil || st.Status != "partially_paid" || st.Credited != 4500 || st.Credits != 10000 {
		t.Fatalf("status: %+v %v", st, err)
	}
}
