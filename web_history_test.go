//go:build web

package main

// The call history from the web version: an API key reads its calls, a
// browser wallet signs in once (personal_sign) and reads the calls it paid
// for; a result still within its 24 h comes back to the gallery.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ethereum/go-ethereum/common/hexutil"

	"imference-desktop-go/internal/cloud"
	"imference-desktop-go/internal/wallet"
)

func historyAPI(t *testing.T, apiURL *string, walletAuths *atomic.Int32) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/history", func(w http.ResponseWriter, r *http.Request) {
		if h := r.Header.Get("X-Wallet-Auth"); h != "" {
			raw, _ := base64.StdEncoding.DecodeString(h)
			var body struct{ Message, Signature string }
			_ = json.Unmarshal(raw, &body)
			signer, err := wallet.RecoverPersonalSigner(body.Message, hexutil.MustDecode(body.Signature))
			if err != nil || !strings.EqualFold(signer.Hex(), testWalletAddr) ||
				!strings.Contains(body.Message, cloud.HistorySignInStatement) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			walletAuths.Add(1)
		} else if r.Header.Get("Authorization") != "Bearer test-key" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_, _ = w.Write([]byte(`{"data":[{"request_id":"r1","created_at":"2026-11-02T10:00:00Z","rail":"x402","kind":"image","status":"done","credits_charged":0,"outputs":[{"kind":"image","format":"png","url":"` + *apiURL + `/blob/x.png"}],"available_until":"2026-11-03T10:00:00Z","expired":false}],"retention_hours":24}`))
	})
	mux.HandleFunc("/blob/x.png", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(tinyPNG()) })
	return mux
}

func TestHistoryWithTheBrowserWallet(t *testing.T) {
	var apiURL string
	var auths atomic.Int32
	api := httptest.NewServer(historyAPI(t, &apiURL, &auths))
	defer api.Close()
	apiURL = api.URL

	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	setPayMode(t, c, "wallet", testWalletAddr)
	signed := walletTab(t, srv, c, false)

	for i := 0; i < 2; i++ {
		code, m := c.call("ListCloudHistory", "", "")
		if code != http.StatusOK {
			t.Fatalf("ListCloudHistory: %d %v", code, m)
		}
		page := m["result"].(map[string]any)
		if page["rail"] != "x402" || len(page["data"].([]any)) != 1 {
			t.Fatalf("page: %v", page)
		}
	}
	if signed.Load() != 1 || auths.Load() != 2 {
		t.Fatalf("wallet signed %d times for %d reads, want 1 for 2", signed.Load(), auths.Load())
	}

	_, m := c.call("ListCloudHistory", "x402", "")
	item := m["result"].(map[string]any)["data"].([]any)[0]
	code, m := c.call("RedownloadCloudOutput", item, 0)
	if code != http.StatusOK || !strings.HasPrefix(m["result"].(map[string]any)["imageBase64"].(string), "data:") {
		t.Fatalf("RedownloadCloudOutput: %d %v", code, m)
	}
}

func TestHistoryNeedsAKeyOrAWallet(t *testing.T) {
	var apiURL string
	var auths atomic.Int32
	api := httptest.NewServer(historyAPI(t, &apiURL, &auths))
	defer api.Close()
	_, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	if code, _ := c.call("ListCloudHistory", "", ""); code == http.StatusOK {
		t.Fatal("a guest read a history")
	}
}
