//go:build web

package main

// Paying from the web version against a mock imference API: what a guest may
// do, how a short balance is reported, and the three purchases (per-run USDC
// signed by the browser wallet, a pack in USDC, a pack by card).

import (
	"bufio"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// Well-known Hardhat test key #0 — public, never fund it.
const (
	testWalletPK   = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	testWalletAddr = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	testPayTo      = "0x1111111111111111111111111111111111111111"
	usdcOnBase     = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

func b64JSON(v any) string {
	raw, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(raw)
}

// x402Gate answers a paid route like the API: a v2 challenge for amount, then
// the handler once a PAYMENT-SIGNATURE from testWalletAddr arrives.
func x402Gate(t *testing.T, amount string, paid func(w http.ResponseWriter, r *http.Request, payment map[string]any)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("PAYMENT-SIGNATURE")
		if h == "" {
			w.Header().Set("PAYMENT-REQUIRED", b64JSON(map[string]any{
				"x402Version": 2,
				"resource":    map[string]any{"url": "https://imference.com" + r.URL.Path},
				"accepts": []any{map[string]any{
					"scheme": "exact", "network": "eip155:8453", "amount": amount, "asset": usdcOnBase,
					"payTo": testPayTo, "maxTimeoutSeconds": 60, "extra": map[string]any{"name": "USD Coin", "version": "2"},
				}},
			}))
			w.WriteHeader(http.StatusPaymentRequired)
			_, _ = w.Write([]byte(`{}`))
			return
		}
		raw, _ := base64.StdEncoding.DecodeString(h)
		var payment map[string]any
		_ = json.Unmarshal(raw, &payment)
		auth := payment["payload"].(map[string]any)["authorization"].(map[string]any)
		if !strings.EqualFold(auth["from"].(string), testWalletAddr) || auth["value"] != amount {
			t.Errorf("payment authorization %v", auth)
		}
		w.Header().Set("PAYMENT-RESPONSE", b64JSON(map[string]any{"success": true, "transaction": "0xabc"}))
		paid(w, r, payment)
	}
}

// walletTab is the browser side of a session: it follows the event stream and
// signs each "web:sign" request with the test wallet (or refuses it).
func walletTab(t *testing.T, srv *webServer, c *client, refuse bool) (signed *atomic.Int32) {
	t.Helper()
	signed = &atomic.Int32{}
	req, _ := http.NewRequest(http.MethodGet, c.base+"/web/events", nil)
	resp, err := c.hc.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	key, _ := crypto.HexToECDSA(testWalletPK)
	go func() {
		rd := bufio.NewReader(resp.Body)
		for {
			line, err := rd.ReadString('\n')
			if err != nil {
				return
			}
			if !strings.HasPrefix(line, "data: ") {
				continue
			}
			var ev struct {
				Name string `json:"name"`
				Data struct {
					ID        string         `json:"id"`
					TypedData map[string]any `json:"typedData"`
				} `json:"data"`
			}
			if json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &ev) != nil || ev.Name != "web:sign" {
				continue
			}
			reply := map[string]any{"id": ev.Data.ID}
			if refuse {
				reply["error"] = "cancelled"
			} else {
				// What eth_signTypedData_v4 does with the typed data the tab got.
				td := ev.Data.TypedData
				dom := td["domain"].(map[string]any)
				dom["chainId"] = fmt.Sprint(dom["chainId"])
				raw, _ := json.Marshal(td)
				var typed apitypes.TypedData
				if err := json.Unmarshal(raw, &typed); err != nil {
					t.Errorf("typed data: %v", err)
					return
				}
				digest, _, err := apitypes.TypedDataAndHash(typed)
				if err != nil {
					t.Errorf("hash: %v", err)
					return
				}
				sig, _ := crypto.Sign(digest, key)
				sig[64] += 27
				reply["signature"] = hexutil.Encode(sig)
				signed.Add(1)
			}
			c.post("/web/sign", reply, true)
		}
	}()
	// Wait until the stream is registered: signing needs an open tab.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		srv.mu.Lock()
		n := 0
		for _, u := range srv.users {
			u.mu.Lock()
			n += len(u.subs)
			u.mu.Unlock()
		}
		srv.mu.Unlock()
		if n > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	return signed
}

func session(t *testing.T, c *client) map[string]any {
	t.Helper()
	_, m := c.post("/web/call", map[string]any{"methodName": "web.Session", "args": []any{}}, true)
	return m["result"].(map[string]any)
}

func setPayMode(t *testing.T, c *client, mode, address string) {
	t.Helper()
	code, m := c.post("/web/call", map[string]any{"methodName": "web.SetPayMode",
		"args": []any{map[string]any{"mode": mode, "address": address}}}, true)
	if code != http.StatusOK {
		t.Fatalf("SetPayMode: %d %v", code, m)
	}
}

// A guest browses freely, but a run asks for a way to pay.
func TestGuestNeedsAKeyToRun(t *testing.T) {
	_, hs := startServer(t, "")
	c := newClient(t, hs.URL)
	for _, call := range []struct {
		name string
		arg  any
	}{
		{"GenerateCloud", map[string]any{"prompt": "x"}},
		{"RunTool", map[string]any{"toolId": "upscale"}},
	} {
		code, m := c.call(call.name, call.arg)
		if code != http.StatusPaymentRequired || m["code"] != codeNeedsKey {
			t.Errorf("%s as guest: %d %v", call.name, code, m)
		}
	}
	if code, m := c.call("GetCreditBalance", ""); code != 200 || m["result"].(map[string]any)["configured"] != false {
		t.Errorf("GetCreditBalance as guest: %d %v", code, m)
	}
	if s := session(t, c); s["hasKey"] != false || s["payMode"] != "" {
		t.Errorf("session: %v", s)
	}
	if code, _ := c.post("/web/call", map[string]any{"methodName": "web.SetPayMode",
		"args": []any{map[string]any{"mode": "wallet", "address": "nope"}}}, true); code != http.StatusBadRequest {
		t.Errorf("SetPayMode with a bad address: %d", code)
	}
}

// The API's "not enough credits" becomes the code the payment dialog opens on.
func TestShortBalanceIsInsufficientCredits(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"error":"not enough credits"}`))
	}))
	defer api.Close()
	_, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.post("/web/login", map[string]string{"apiKey": "good-1"}, true)
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "x", "width": 512, "height": 512})
	if code != http.StatusPaymentRequired || m["code"] != codeInsufficient {
		t.Fatalf("GenerateCloud with a short balance: %d %v", code, m)
	}
}

// Per run in USDC: the guest's run goes through the x402 rail, the browser
// wallet signs, the server checks the signature and pays.
func TestPerRunPaymentWithTheBrowserWallet(t *testing.T) {
	t.Setenv("IMFERENCE_BASE_RPC", "http://127.0.0.1:1") // no balance check: the RPC is unreachable
	var apiURL string
	mux := http.NewServeMux()
	mux.Handle("/ondemand/generate", x402Gate(t, "5000", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		_, _ = w.Write([]byte(`{"request_id":"req-x","kind":"image"}`))
	}))
	mux.HandleFunc("/ondemand/status", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"RequestID":"req-x","Kind":"image","URL":"` + apiURL + `/blob/x.png","Format":"png","Seed":9}}`))
	})
	mux.HandleFunc("/blob/x.png", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(tinyPNG()) })
	api := httptest.NewServer(mux)
	defer api.Close()
	apiURL = api.URL

	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	setPayMode(t, c, "wallet", testWalletAddr)
	if s := session(t, c); s["payMode"] != "wallet" || !strings.EqualFold(s["payer"].(string), testWalletAddr) {
		t.Fatalf("session: %v", s)
	}
	signed := walletTab(t, srv, c, false)
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "a fox", "width": 512, "height": 512})
	if code != http.StatusOK || m["result"] == nil {
		t.Fatalf("GenerateCloud paid per run: %d %v", code, m)
	}
	if signed.Load() != 1 {
		t.Fatalf("wallet signed %d times", signed.Load())
	}
}

// Refusing in the wallet is a cancelled payment, not a failure.
func TestPerRunPaymentRefusedInTheWallet(t *testing.T) {
	t.Setenv("IMFERENCE_BASE_RPC", "http://127.0.0.1:1")
	api := httptest.NewServer(x402Gate(t, "5000", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		t.Error("paid without a signature")
	}))
	defer api.Close()
	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	setPayMode(t, c, "wallet", testWalletAddr)
	walletTab(t, srv, c, true)
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "a fox", "width": 512, "height": 512})
	if code != http.StatusPaymentRequired || m["code"] != codeCancelled {
		t.Fatalf("refused signature: %d %v", code, m)
	}
}

// A pack in USDC: a guest gets a new key with the credits, and the session
// moves to it.
func TestPackInUSDCCreatesTheKey(t *testing.T) {
	t.Setenv("IMFERENCE_BASE_RPC", "http://127.0.0.1:1")
	api := httptest.NewServer(x402Gate(t, "5000000", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["credits"] != float64(packCredits) || body["api_key"] != "" {
			t.Errorf("credits/add body %v", body)
		}
		_, _ = w.Write([]byte(`{"api_key":"good-pack","credits_added":5000}`))
	}))
	defer api.Close()
	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.call("GetVersion") // open the guest session
	walletTab(t, srv, c, false)
	code, m := c.post("/web/pay/pack", map[string]any{"address": testWalletAddr}, true)
	if code != http.StatusOK || m["apiKey"] != "good-pack" || m["creditsAdded"] != float64(5000) {
		t.Fatalf("pay/pack: %d %v", code, m)
	}
	if k := settingsKey(t, c); k != "good-pack" {
		t.Fatalf("session key after the pack: %q", k)
	}
}

// By card: an Embedded Checkout session for one pack. The page gets what it
// needs to mount Stripe's form; the session keeps its key until the payment is
// done (the page then signs in with the new key).
func TestCardCheckoutIsEmbedded(t *testing.T) {
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		if r.URL.Path != "/credits/add" || body["ui"] != "embedded" || body["quantity"] != float64(1) || r.Header.Get("Authorization") != "" {
			t.Errorf("credits/add: %s %v %q", r.URL.Path, body, r.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"client_secret":"cs_x_secret_y","publishable_key":"pk_test_1","api_key":"good-card"}`)
	}))
	defer api.Close()
	_, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	if code, _ := c.post("/web/pay/card", map[string]any{}, false); code != http.StatusForbidden {
		t.Fatalf("pay/card without CSRF header: %d", code)
	}
	code, m := c.post("/web/pay/card", map[string]any{}, true)
	if code != http.StatusOK || m["clientSecret"] != "cs_x_secret_y" || m["publishableKey"] != "pk_test_1" || m["apiKey"] != "good-card" {
		t.Fatalf("pay/card: %d %v", code, m)
	}
	if k := settingsKey(t, c); k != "" {
		t.Fatalf("session moved to the key before the payment: %q", k)
	}
}

// A tab opened as a guest that then signs in keeps receiving the signature
// requests: its event stream follows the session to the key's user.
func TestSignRequestsFollowTheSessionAfterSignIn(t *testing.T) {
	t.Setenv("IMFERENCE_BASE_RPC", "http://127.0.0.1:1")
	var apiURL string
	mux := http.NewServeMux()
	mux.Handle("/ondemand/generate", x402Gate(t, "5000", func(w http.ResponseWriter, r *http.Request, _ map[string]any) {
		_, _ = w.Write([]byte(`{"request_id":"req-y","kind":"image"}`))
	}))
	mux.HandleFunc("/ondemand/status", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"data":{"RequestID":"req-y","Kind":"image","URL":"` + apiURL + `/blob/y.png","Format":"png","Seed":3}}`))
	})
	mux.HandleFunc("/blob/y.png", func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(tinyPNG()) })
	api := httptest.NewServer(mux)
	defer api.Close()
	apiURL = api.URL

	srv, hs := startServer(t, api.URL)
	c := newClient(t, hs.URL)
	c.call("GetVersion")                  // guest session
	signed := walletTab(t, srv, c, false) // the tab's stream opens as the guest
	if code, _ := c.post("/web/login", map[string]string{"apiKey": "good-1"}, true); code != http.StatusOK {
		t.Fatalf("login: %d", code)
	}
	c.call("SaveSettings", map[string]any{"cloudModel": "flux-dev"})
	setPayMode(t, c, "wallet", testWalletAddr)
	code, m := c.call("GenerateCloud", map[string]any{"prompt": "a fox", "width": 512, "height": 512})
	if code != http.StatusOK || signed.Load() != 1 {
		t.Fatalf("GenerateCloud after sign-in: %d %v (signed %d)", code, m, signed.Load())
	}
}
