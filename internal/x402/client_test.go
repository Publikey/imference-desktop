package x402

// The payment flow against a mock paid API: what the client signs, what it
// refuses, and what it does with the answer (the client side of the
// x402-conformance checks C1-C3). The mock answers like imference.com: a v2
// challenge in the PAYMENT-REQUIRED header and a v1 challenge as the body.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"imference-desktop-go/internal/wallet"
)

// Well-known Hardhat test key #0 — public, never fund it.
const (
	testPK      = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
	testPayer   = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	testPayTo   = "0x1111111111111111111111111111111111111111"
	usdcBase    = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
	usdcSepolia = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
)

func offer(over map[string]any) map[string]any {
	o := map[string]any{
		"scheme":            "exact",
		"network":           "eip155:8453",
		"amount":            "50000",
		"asset":             usdcBase,
		"payTo":             testPayTo,
		"maxTimeoutSeconds": 60,
		"extra":             map[string]any{"name": "USD Coin", "version": "2", "paymentFlow": "upfront"},
	}
	for k, v := range over {
		o[k] = v
	}
	return o
}

// asV1 turns a v2 offer into its v1 spelling.
func asV1(o map[string]any) map[string]any {
	v := map[string]any{}
	for k, x := range o {
		v[k] = x
	}
	v["maxAmountRequired"] = o["amount"]
	delete(v, "amount")
	if o["network"] == "eip155:8453" {
		v["network"] = "base"
	}
	return v
}

type call struct {
	header  string         // "none", "v1" or "v2"
	payment map[string]any // decoded payment header
	body    string
}

type mockAPI struct {
	mu      sync.Mutex
	calls   []call
	accepts []map[string]any
	v2      bool // send the PAYMENT-REQUIRED header
	settle  bool
	srv     *httptest.Server
}

func newMock(t *testing.T) *mockAPI {
	m := &mockAPI{accepts: []map[string]any{offer(nil)}, v2: true, settle: true}
	m.srv = httptest.NewServer(http.HandlerFunc(m.serve))
	t.Cleanup(m.srv.Close)
	return m
}

func b64(v any) string {
	raw, _ := json.Marshal(v)
	return base64.StdEncoding.EncodeToString(raw)
}

func unb64(s string) map[string]any {
	raw, _ := base64.StdEncoding.DecodeString(s)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return out
}

func (m *mockAPI) serve(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	c := call{header: "none", body: string(body)}
	if h := r.Header.Get("PAYMENT-SIGNATURE"); h != "" {
		c.header, c.payment = "v2", unb64(h)
	} else if h := r.Header.Get("X-PAYMENT"); h != "" {
		c.header, c.payment = "v1", unb64(h)
	}
	m.mu.Lock()
	m.calls = append(m.calls, c)
	m.mu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	if c.header == "none" {
		if m.v2 {
			w.Header().Set("PAYMENT-REQUIRED", b64(map[string]any{
				"x402Version": 2,
				"error":       "Payment required",
				"resource":    map[string]any{"url": m.srv.URL + r.URL.Path, "description": "test", "mimeType": "application/json"},
				"accepts":     m.accepts,
				"extensions":  map[string]any{"bazaar": map[string]any{"info": "kept as is"}},
			}))
		}
		v1 := make([]map[string]any, len(m.accepts))
		for i, o := range m.accepts {
			v1[i] = asV1(o)
		}
		w.WriteHeader(http.StatusPaymentRequired)
		_ = json.NewEncoder(w).Encode(map[string]any{"x402Version": 1, "error": "X-PAYMENT header is required", "accepts": v1})
		return
	}
	if !m.settle {
		// Settlement refused: the API answers 402 again.
		w.WriteHeader(http.StatusPaymentRequired)
		_, _ = w.Write([]byte(`{"x402Version":2,"error":"invalid_transaction_state"}`))
		return
	}
	w.Header().Set("PAYMENT-RESPONSE", b64(map[string]any{"success": true, "transaction": "0xabc", "network": "eip155:8453", "payer": testPayer}))
	_, _ = w.Write([]byte(`{"request_id":"r1","kind":"image"}`))
}

func (m *mockAPI) headers() []string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]string, len(m.calls))
	for i, c := range m.calls {
		out[i] = c.header
	}
	return out
}

func newTestClient(t *testing.T, balance int64) *Client {
	t.Helper()
	w, err := wallet.Import(testPK)
	if err != nil {
		t.Fatal(err)
	}
	c := New(w)
	c.Balance = func(context.Context, common.Address, bool) (*big.Int, error) { return big.NewInt(balance), nil }
	return c
}

func post(t *testing.T, c *Client, m *mockAPI) (*http.Response, error) {
	t.Helper()
	return c.DoJSON(context.Background(), http.MethodPost, m.srv.URL+"/ondemand/generate", map[string]any{"model": "flux", "prompt": "x"}, nil)
}

func eq(a, b []string) bool { return strings.Join(a, ",") == strings.Join(b, ",") }

// C3: a v2 challenge is paid with PAYMENT-SIGNATURE, never X-PAYMENT, and the
// offer, resource and extensions go back unchanged.
func TestPaysV2WithPaymentSignature(t *testing.T) {
	m := newMock(t)
	resp, err := post(t, newTestClient(t, 1_000_000), m)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := m.headers(); !eq(got, []string{"none", "v2"}) {
		t.Fatalf("payment headers %v, want [none v2]", got)
	}
	p := m.calls[1].payment
	if p["x402Version"].(float64) != 2 {
		t.Errorf("x402Version %v", p["x402Version"])
	}
	wantAccepted, _ := json.Marshal(offer(nil))
	gotAccepted, _ := json.Marshal(p["accepted"])
	if string(gotAccepted) != string(wantAccepted) {
		t.Errorf("accepted not echoed unchanged:\n got %s\nwant %s", gotAccepted, wantAccepted)
	}
	if res, _ := p["resource"].(map[string]any); res["url"] != m.srv.URL+"/ondemand/generate" {
		t.Errorf("resource not echoed: %v", p["resource"])
	}
	if ext, _ := p["extensions"].(map[string]any); ext["bazaar"] == nil {
		t.Errorf("extensions not echoed: %v", p["extensions"])
	}
	auth := p["payload"].(map[string]any)["authorization"].(map[string]any)
	if !strings.EqualFold(auth["from"].(string), testPayer) || !strings.EqualFold(auth["to"].(string), testPayTo) || auth["value"] != "50000" {
		t.Errorf("authorization %v", auth)
	}
	if m.calls[1].body != m.calls[0].body || m.calls[1].body == "" {
		t.Errorf("retry body %q differs from the first %q", m.calls[1].body, m.calls[0].body)
	}
}

// Without a PAYMENT-REQUIRED header, the v1 body is paid with X-PAYMENT.
func TestFallsBackToV1WithoutTheHeader(t *testing.T) {
	m := newMock(t)
	m.v2 = false
	resp, err := post(t, newTestClient(t, 1_000_000), m)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if got := m.headers(); !eq(got, []string{"none", "v1"}) {
		t.Fatalf("payment headers %v, want [none v1]", got)
	}
	p := m.calls[1].payment
	if p["x402Version"].(float64) != 1 || p["network"] != "base" || p["scheme"] != "exact" {
		t.Errorf("v1 payment %v", p)
	}
}

// C2: an offer above the cap is refused before anything is signed.
func TestRefusesOfferAboveCap(t *testing.T) {
	m := newMock(t)
	m.accepts = []map[string]any{offer(map[string]any{"amount": "2000000"})} // $2 > $1 default cap
	_, err := post(t, newTestClient(t, 10_000_000), m)
	if err == nil || !strings.Contains(err.Error(), "max allowed") {
		t.Fatalf("err = %v, want a cap refusal", err)
	}
	if got := m.headers(); !eq(got, []string{"none"}) {
		t.Fatalf("payment headers %v, want [none]", got)
	}
}

// C2: anything but exact USDC on Base mainnet is refused — and a v2 server is
// never paid in v1 instead, even though its body offers v1.
func TestRefusesOffersOffBaseUSDC(t *testing.T) {
	for name, bad := range map[string]map[string]any{
		"testnet":               offer(map[string]any{"network": "eip155:84532", "asset": usdcSepolia}),
		"another chain":         offer(map[string]any{"network": "eip155:1"}),
		"another token":         offer(map[string]any{"asset": "0x2222222222222222222222222222222222222222"}),
		"another scheme":        offer(map[string]any{"scheme": "upto"}),
		"zero amount":           offer(map[string]any{"amount": "0"}),
		"v1 network name in v2": offer(map[string]any{"network": "base"}),
	} {
		t.Run(name, func(t *testing.T) {
			m := newMock(t)
			m.accepts = []map[string]any{bad}
			_, err := post(t, newTestClient(t, 1_000_000), m)
			if err == nil || !strings.Contains(err.Error(), "no acceptable payment requirement") {
				t.Fatalf("err = %v, want a refusal", err)
			}
			if got := m.headers(); !eq(got, []string{"none"}) {
				t.Fatalf("payment headers %v, want [none]", got)
			}
		})
	}
}

// C2: among several offers, the one it may sign is paid.
func TestPicksThePayableOffer(t *testing.T) {
	m := newMock(t)
	m.accepts = []map[string]any{
		offer(map[string]any{"network": "eip155:84532", "asset": usdcSepolia}),
		offer(map[string]any{"amount": "5000000"}), // over the cap
		offer(nil),
	}
	resp, err := post(t, newTestClient(t, 1_000_000), m)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	acc := m.calls[1].payment["accepted"].(map[string]any)
	if acc["network"] != "eip155:8453" || acc["amount"] != "50000" {
		t.Errorf("paid %v", acc)
	}
}

// C1: a refused settlement is an error, never a result.
func TestRefusedSettlementIsAnError(t *testing.T) {
	m := newMock(t)
	m.settle = false
	resp, err := post(t, newTestClient(t, 1_000_000), m)
	if err == nil {
		resp.Body.Close()
		t.Fatal("a refused settlement returned a response")
	}
	if !strings.Contains(err.Error(), "invalid_transaction_state") {
		t.Errorf("err %v should carry the server's reason", err)
	}
}

// A refused settlement with a short wallet says so, rather than the protocol
// error.
func TestRefusedSettlementWithShortWallet(t *testing.T) {
	m := newMock(t)
	m.settle = false
	c := newTestClient(t, 0)
	calls := 0
	c.Balance = func(context.Context, common.Address, bool) (*big.Int, error) {
		calls++
		if calls == 1 {
			return big.NewInt(1_000_000), nil // cached read before signing
		}
		return big.NewInt(10_000), nil // the chain, re-asked after the refusal
	}
	_, err := post(t, c, m)
	var funds *InsufficientFundsError
	if !errors.As(err, &funds) {
		t.Fatalf("err = %v, want InsufficientFundsError", err)
	}
}

// An empty wallet is told before anything is signed.
func TestEmptyWalletSignsNothing(t *testing.T) {
	m := newMock(t)
	_, err := post(t, newTestClient(t, 0), m)
	var funds *InsufficientFundsError
	if !errors.As(err, &funds) {
		t.Fatalf("err = %v, want InsufficientFundsError", err)
	}
	if got := m.headers(); !eq(got, []string{"none"}) {
		t.Fatalf("payment headers %v, want [none]", got)
	}
}

// A free route (no 402) is passed through untouched.
func TestNo402PassesThrough(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("PAYMENT-SIGNATURE") != "" || r.Header.Get("X-PAYMENT") != "" {
			t.Error("paid a free route")
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()
	resp, err := newTestClient(t, 0).DoJSON(context.Background(), http.MethodGet, srv.URL, map[string]any{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}
