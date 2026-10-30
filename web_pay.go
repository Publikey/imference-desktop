//go:build web

package main

// Paying from the web version. A visitor has three ways to pay a run:
//
//   - credits on an API key: bought by card (POST web/pay/card -> Stripe
//     Checkout) or in USDC (POST web/pay/pack -> x402 on /ondemand/credits/add);
//   - per run in USDC, with the browser wallet (payMode "wallet"): GenerateCloud
//     and RunTool take the x402 rail, exactly like the desktop with its own
//     wallet, except that the signature comes from the browser.
//
// The browser wallet signs; the server never holds a key. When the x402 client
// needs a signature (browserSign), the server builds the EIP-3009
// authorization, sends its EIP-712 typed data to the user's tab ("web:sign"
// event), and waits for the tab to post the wallet's signature to web/sign. The
// signature is checked against the authorization before it is used.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"

	"imference-desktop-go/internal/wallet"
	"imference-desktop-go/internal/x402"
)

// packCredits is the one pack sold in the app: 5000 credits for $5
// (1 credit = $0.001 = 1000 atomic USDC).
const packCredits = 5000

// Error codes the frontend turns into the payment dialog.
const (
	codeNeedsKey      = "needs_key"            // no key, no wallet: nothing can pay
	codeInsufficient  = "insufficient_credits" // the key's balance is too low
	codeCancelled     = "payment_cancelled"    // the user refused to sign
	codeInsufficientU = "insufficient_usdc"    // the wallet can't cover it
	codeNoWallet      = "needs_wallet"         // per-run mode without a connected wallet
)

var (
	errUnknownKey    = errors.New("unknown API key")
	errSignCancelled = errors.New("payment cancelled in the wallet")
	errSignTimeout   = errors.New("the wallet did not sign in time")
	errNoTab         = errors.New("open Imference in a browser tab to sign the payment")
	errNoPayer       = errors.New("connect a wallet to pay per run")
)

const signTimeout = 3 * time.Minute

// paidMethods cost money: the server refuses them up front when the session
// has no way to pay, so the browser can ask for one.
var paidMethods = map[string]bool{"GenerateCloud": true, "RunTool": true}

type signReply struct {
	Signature string `json:"signature"`
	Error     string `json:"error"` // "cancelled" when the user refused
}

func (u *webUser) canPay() bool {
	u.mu.Lock()
	defer u.mu.Unlock()
	return u.apiKey != "" || u.payMode == "wallet"
}

// paymentMode is the App's settings rail for this user.
func (u *webUser) paymentMode() string {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.payMode == "wallet" {
		return "x402"
	}
	return "credits"
}

// browserSigner is the App's x402Signer: the wallet connected in the tab.
func (u *webUser) browserSigner() (x402.Signer, error) {
	u.mu.Lock()
	addr := u.payer
	u.mu.Unlock()
	if addr == (common.Address{}) {
		return nil, errNoPayer
	}
	return &browserSign{u: u, addr: addr}, nil
}

// browserSign gets an EIP-3009 signature from the user's browser wallet.
type browserSign struct {
	u    *webUser
	addr common.Address
}

func (b *browserSign) Address() common.Address { return b.addr }

func (b *browserSign) SignEIP3009(p wallet.SignEIP3009Params) (wallet.SignedAuthorization, error) {
	auth, td, err := wallet.NewEIP3009(b.addr, p)
	if err != nil {
		return wallet.SignedAuthorization{}, err
	}
	id := newSessionID()[:16]
	ch := make(chan signReply, 1)
	b.u.mu.Lock()
	if len(b.u.subs) == 0 {
		b.u.mu.Unlock()
		return wallet.SignedAuthorization{}, errNoTab
	}
	b.u.signs[id] = ch
	b.u.mu.Unlock()
	defer func() {
		b.u.mu.Lock()
		delete(b.u.signs, id)
		b.u.mu.Unlock()
	}()

	b.u.publish("web:sign", map[string]any{
		"id":        id,
		"address":   b.addr.Hex(),
		"amount":    p.Value.String(), // atomic USDC
		"payTo":     p.PayTo.Hex(),
		"chainId":   p.ChainID,
		"typedData": browserTypedData(td),
	})
	var rep signReply
	select {
	case rep = <-ch:
	case <-time.After(signTimeout):
		return wallet.SignedAuthorization{}, errSignTimeout
	}
	if rep.Error == "cancelled" {
		return wallet.SignedAuthorization{}, errSignCancelled
	}
	if rep.Error != "" {
		return wallet.SignedAuthorization{}, fmt.Errorf("wallet: %s", rep.Error)
	}
	sig, err := hexutil.Decode(rep.Signature)
	if err != nil {
		return wallet.SignedAuthorization{}, fmt.Errorf("wallet: bad signature: %w", err)
	}
	// Never forward a signature that isn't this authorization by this wallet:
	// the facilitator would refuse it, after the user was told it was paid.
	signer, err := wallet.RecoverSigner(td, sig)
	if err != nil {
		return wallet.SignedAuthorization{}, err
	}
	if signer != b.addr {
		return wallet.SignedAuthorization{}, fmt.Errorf("wallet: signed by %s, expected %s", signer.Hex(), b.addr.Hex())
	}
	if sig[64] < 27 {
		sig[64] += 27
	}
	return wallet.SignedAuthorization{Authorization: auth, Signature: hexutil.Encode(sig)}, nil
}

// browserTypedData is the typed data in the shape eth_signTypedData_v4 takes
// (chainId as a number: wallets compare it with the active chain).
func browserTypedData(td apitypes.TypedData) map[string]any {
	chainID := int64(0)
	if td.Domain.ChainId != nil {
		chainID = (*big.Int)(td.Domain.ChainId).Int64()
	}
	return map[string]any{
		"types":       td.Types,
		"primaryType": td.PrimaryType,
		"domain": map[string]any{
			"name":              td.Domain.Name,
			"version":           td.Domain.Version,
			"chainId":           chainID,
			"verifyingContract": td.Domain.VerifyingContract,
		},
		"message": td.Message,
	}
}

// payErrCode recognises the failures the payment dialog handles.
func payErrCode(err error) string {
	if err == nil {
		return ""
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "not enough credits"):
		return codeInsufficient
	case strings.Contains(msg, errSignCancelled.Error()):
		return codeCancelled
	case strings.Contains(msg, "not enough USDC"):
		return codeInsufficientU
	case strings.Contains(msg, errNoPayer.Error()):
		return codeNoWallet
	}
	return ""
}

// toolResultErr is the error a RunTool result carries, if any.
func toolResultErr(res any) error {
	if r, ok := res.(ToolRunResult); ok && r.Error != nil {
		return errors.New(r.Error.Message)
	}
	return nil
}

// webMethod answers the web-only calls (not App methods).
func (s *webServer) webMethod(u *webUser, req rpcRequest) (any, error) {
	switch req.MethodName {
	case "web.GetConfig":
		gallery := "client"
		if s.cfg.serverGallery {
			gallery = "server"
		}
		return map[string]any{"gallery": gallery, "packCredits": packCredits, "packUsd": packCredits / 1000}, nil
	case "web.Session":
		u.mu.Lock()
		defer u.mu.Unlock()
		payer := ""
		if u.payer != (common.Address{}) {
			payer = u.payer.Hex()
		}
		keyHint := "" // the key's last characters, to tell keys apart in Settings
		if n := len(u.apiKey); n >= 8 {
			keyHint = u.apiKey[n-4:]
		}
		return map[string]any{"hasKey": u.apiKey != "", "keyHint": keyHint, "payMode": u.payMode, "payer": payer}, nil
	case "web.SetPayMode":
		var body struct {
			Mode    string `json:"mode"` // "wallet" | "" (credits)
			Address string `json:"address"`
		}
		if len(req.Args) > 0 {
			if err := json.Unmarshal(req.Args[0], &body); err != nil {
				return nil, err
			}
		}
		u.mu.Lock()
		switch body.Mode {
		case "wallet":
			if !common.IsHexAddress(body.Address) {
				u.mu.Unlock()
				return nil, errors.New("invalid wallet address")
			}
			u.payMode, u.payer = "wallet", common.HexToAddress(body.Address)
		case "":
			u.payMode = ""
		default:
			u.mu.Unlock()
			return nil, fmt.Errorf("unknown pay mode %q", body.Mode)
		}
		u.mu.Unlock()
		if _, err := u.app.SaveSettings(webSettings(u.app.GetSettings(), u)); err != nil {
			return nil, err
		}
		return map[string]any{"payMode": body.Mode}, nil
	}
	return nil, fmt.Errorf("unknown method %q", req.MethodName)
}

func (s *webServer) api() string {
	if s.cfg.apiBase != "" {
		return strings.TrimRight(s.cfg.apiBase, "/")
	}
	return "https://imference.com"
}

// payCard starts a Stripe Embedded Checkout for one pack: the page mounts
// Stripe's form with the client secret, nobody leaves the app. The API creates
// the key first (or tops up the session's); a guest's session moves to it only
// once the payment is done (the page signs in with it then), so an abandoned
// checkout changes nothing.
func (s *webServer) payCard(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	u, err := s.sessionUser(w, r)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]any{"quantity": 1, "ui": "embedded"})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, s.api()+"/credits/add", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	if u.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+u.apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "cannot reach the imference API: " + err.Error()})
		return
	}
	defer resp.Body.Close()
	var out struct {
		ClientSecret   string `json:"client_secret"`
		PublishableKey string `json:"publishable_key"`
		APIKey         string `json:"api_key"`
		Error          string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out)
	if resp.StatusCode != http.StatusOK || out.ClientSecret == "" || out.PublishableKey == "" || out.APIKey == "" {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("the imference API answered %d", resp.StatusCode)
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"clientSecret": out.ClientSecret, "publishableKey": out.PublishableKey, "apiKey": out.APIKey})
}

// payPack buys one pack in USDC with the browser wallet at body.address: x402
// on /ondemand/credits/add, credited to the session's key, or to a new key the
// session then moves to.
func (s *webServer) payPack(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	u, err := s.sessionUser(w, r)
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	var body struct {
		Address string `json:"address"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || !common.IsHexAddress(body.Address) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "wallet address required"})
		return
	}
	xc := x402.New(&browserSign{u: u, addr: common.HexToAddress(body.Address)})
	xc.HTTP = &http.Client{Timeout: 60 * time.Second}
	xc.MaxAmount = big.NewInt(packCredits * 1000) // exactly the pack, never more
	xc.Logger = u.app.bus
	resp, err := xc.DoJSON(r.Context(), http.MethodPost, s.api()+"/ondemand/credits/add",
		map[string]any{"credits": packCredits, "api_key": u.apiKey}, nil)
	if err != nil {
		if code := payErrCode(err); code != "" {
			writeJSON(w, http.StatusPaymentRequired, map[string]string{"error": err.Error(), "code": code})
			return
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	defer resp.Body.Close()
	var out struct {
		APIKey       string `json:"api_key"`
		CreditsAdded int64  `json:"credits_added"`
		Error        string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&out)
	if resp.StatusCode != http.StatusOK || out.APIKey == "" {
		msg := out.Error
		if msg == "" {
			msg = fmt.Sprintf("the imference API answered %d", resp.StatusCode)
		}
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": msg})
		return
	}
	if err := s.bindKey(w, r, out.APIKey); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"apiKey": out.APIKey, "creditsAdded": out.CreditsAdded})
}

// sign receives the wallet's answer to a "web:sign" request.
func (s *webServer) sign(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get(csrfHeader) != "1" {
		http.Error(w, "missing "+csrfHeader+" header", http.StatusForbidden)
		return
	}
	u := s.userFor(r)
	if u == nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "no session"})
		return
	}
	var body struct {
		ID string `json:"id"`
		signReply
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil || body.ID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "id required"})
		return
	}
	u.mu.Lock()
	ch := u.signs[body.ID]
	u.mu.Unlock()
	if ch == nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no payment waiting for this signature"})
		return
	}
	select {
	case ch <- body.signReply:
	default:
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "1"})
}
