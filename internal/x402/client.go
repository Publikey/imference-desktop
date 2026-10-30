// Package x402 implements the client side of the x402 payment protocol
// (Coinbase variant, v2 with a v1 fallback) for EVM networks. It wraps an
// http.Client so callers can issue arbitrary requests against an x402-gated
// endpoint without thinking about the 402-retry dance.
//
// v2 (what imference.com offers): the 402 carries a base64-JSON
// PAYMENT-REQUIRED header,
//
//	{
//	  "x402Version": 2,
//	  "resource": {"url": "...", "description": "...", "mimeType": "..."},
//	  "accepts": [{
//	    "scheme": "exact", "network": "eip155:8453",
//	    "amount": "50000", "payTo": "0x...", "asset": "0x...",
//	    "maxTimeoutSeconds": 60, "extra": {"name": "USD Coin", "version": "2"}
//	  }],
//	  "extensions": {...}
//	}
//
// and the retry sends a base64-JSON PAYMENT-SIGNATURE header
// {x402Version: 2, resource, accepted: <the offer, unchanged>, payload,
// extensions}. When that header is present we pay v2 and never downgrade to
// v1, whatever the body says.
//
// v1 (only when the 402 has no PAYMENT-REQUIRED header, e.g. a server whose
// v2 rail isn't up yet): the challenge is the body,
//
//	{
//	  "x402Version": 1,
//	  "error": "...",
//	  "accepts": [{
//	    "scheme": "exact", "network": "base",
//	    "maxAmountRequired": "50000",        // atomic units of `asset`
//	    "payTo": "0x...", "asset": "0x...",  // USDC contract on Base
//	    "maxTimeoutSeconds": 60,
//	    "extra": { "name": "USD Coin", "version": "2" }
//	  }]
//	}
//
// and the payment goes back base64-JSON in the X-PAYMENT header.
//
// Either way we pick the first acceptable offer (exact, Base mainnet, USDC,
// 0 < amount ≤ MaxAmount), have the signer produce an EIP-3009
// TransferWithAuthorization signature against the USDC contract, and reissue
// the original request once. An offer we may not sign is refused before
// anything is signed.
package x402

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strings"

	"github.com/ethereum/go-ethereum/common"

	"imference-desktop-go/internal/wallet"
)

// BaseMainnetChainID is hardcoded — POC supports only Base mainnet.
const BaseMainnetChainID = 8453

// Network names of Base mainnet in each protocol version.
const (
	networkV1 = "base"
	networkV2 = "eip155:8453" // CAIP-2
)

// Header names. v2 carries everything in headers; v1 has its challenge in
// the body.
const (
	headerPaymentRequired  = "PAYMENT-REQUIRED"
	headerPaymentSignature = "PAYMENT-SIGNATURE"
	headerPaymentResponse  = "PAYMENT-RESPONSE"
	headerXPayment         = "X-PAYMENT"
	headerXPaymentResponse = "X-PAYMENT-RESPONSE"
)

// PaymentRequirement mirrors the JSON in `accepts[i]`. Fields kept as
// strings on the wire match what the facilitator emits and consumes. The
// price is MaxAmountRequired in v1 and Amount in v2.
type PaymentRequirement struct {
	Scheme            string `json:"scheme"`
	Network           string `json:"network"`
	MaxAmountRequired string `json:"maxAmountRequired"`
	Amount            string `json:"amount"`
	Resource          string `json:"resource"`
	Description       string `json:"description"`
	MimeType          string `json:"mimeType"`
	PayTo             string `json:"payTo"`
	MaxTimeoutSeconds int64  `json:"maxTimeoutSeconds"`
	Asset             string `json:"asset"`
	Extra             struct {
		Name    string `json:"name"`
		Version string `json:"version"`
	} `json:"extra"`
}

// PaymentRequiredBody is the v1 402 body.
type PaymentRequiredBody struct {
	X402Version int                  `json:"x402Version"`
	Error       string               `json:"error"`
	Accepts     []PaymentRequirement `json:"accepts"`
}

// paymentRequiredV2 is the decoded PAYMENT-REQUIRED header. resource,
// extensions and each offer stay raw: they go back to the server exactly as
// received, so a field this client doesn't know about can't be lost.
type paymentRequiredV2 struct {
	X402Version int               `json:"x402Version"`
	Error       string            `json:"error"`
	Resource    json.RawMessage   `json:"resource"`
	Accepts     []json.RawMessage `json:"accepts"`
	Extensions  json.RawMessage   `json:"extensions,omitempty"`
}

// paymentPayloadV2 is what goes base64-JSON into PAYMENT-SIGNATURE.
type paymentPayloadV2 struct {
	X402Version int             `json:"x402Version"`
	Resource    json.RawMessage `json:"resource,omitempty"`
	Accepted    json.RawMessage `json:"accepted"`
	Payload     exactPayload    `json:"payload"`
	Extensions  json.RawMessage `json:"extensions,omitempty"`
}

type exactPayload struct {
	Signature     string               `json:"signature"`
	Authorization wallet.Authorization `json:"authorization"`
}

// challenge is a parsed 402, either version, reduced to what Do needs: the
// offer it picked, its price, and what to echo back with the signature.
type challenge struct {
	version int
	offer   PaymentRequirement
	value   *big.Int
	// v2 only: echoed unchanged in PAYMENT-SIGNATURE.
	resource, accepted, extensions json.RawMessage
}

// SignedPayload is what we base64+JSON-encode into the X-PAYMENT header.
// Field names match x402-fetch's encodePayment() output exactly so the
// Coinbase facilitator deserializes it cleanly.
type SignedPayload struct {
	X402Version int    `json:"x402Version"`
	Scheme      string `json:"scheme"`
	Network     string `json:"network"`
	Payload     struct {
		Signature     string               `json:"signature"`
		Authorization wallet.Authorization `json:"authorization"`
	} `json:"payload"`
}

// Logger is a thin abstraction so we can wire logbus without importing it
// here. Set Client.Logger to surface phases in the in-app LogPanel.
type Logger interface {
	Info(source, message string, data ...any)
	Warn(source, message string, data ...any)
	Error(source, message string, data ...any)
}

// nopLogger is the default — silent. Real callers inject a logbus
// adapter that publishes with source="x402".
type nopLogger struct{}

func (nopLogger) Info(string, string, ...any)  {}
func (nopLogger) Warn(string, string, ...any)  {}
func (nopLogger) Error(string, string, ...any) {}

// Signer is whatever signs the EIP-3009 authorization: the local wallet
// (*wallet.Wallet), or, in the web version, the user's browser wallet.
type Signer interface {
	Address() common.Address
	SignEIP3009(p wallet.SignEIP3009Params) (wallet.SignedAuthorization, error)
}

// Client wraps an underlying http.Client with x402 retry logic.
type Client struct {
	HTTP      *http.Client
	Signer    Signer
	MaxAmount *big.Int // atomic units; reject 402s that ask for more
	Logger    Logger
	// Balance reads the wallet's USDC balance in atomic units; nil means
	// wallet.USDCBalanceAtomic (Base mainnet RPC). Tests swap it out.
	Balance func(ctx context.Context, addr common.Address, force bool) (*big.Int, error)
}

// New returns a Client with sane defaults: short HTTP timeout, nop
// logger, MaxAmount = 1 USDC (= 1_000_000 atomic on a 6-decimal asset)
// as a "shouldn't accidentally pay $1 per request" sanity bound.
func New(signer Signer) *Client {
	return &Client{
		HTTP:      &http.Client{}, // caller's responsibility to set timeouts on the request via context
		Signer:    signer,
		MaxAmount: big.NewInt(1_000_000), // 1 USDC
		Logger:    nopLogger{},
	}
}

// log returns the configured logger, or a no-op one.
func (c *Client) log() Logger {
	if c.Logger == nil {
		return nopLogger{}
	}
	return c.Logger
}

// InsufficientFundsError says the wallet cannot cover a run, with both numbers
// the user needs: what it costs and what they hold. Typed so the caller can
// recognise it — every other x402 failure is a protocol or network problem, and
// this one is neither.
type InsufficientFundsError struct {
	Required  *big.Int // atomic USDC units
	Available *big.Int
}

func (e *InsufficientFundsError) Error() string {
	return fmt.Sprintf(
		"not enough USDC: this run costs $%s but the wallet holds $%s — top it up to generate",
		wallet.FormatUSDC(e.Required), wallet.FormatUSDC(e.Available),
	)
}

// ensureFunds reports whether the signer can cover `required` atomic units.
//
// A balance the chain won't tell us about is NOT treated as insufficient: an RPC
// blip must not block a payment that would have gone through. The settlement
// itself remains the authority — this only converts the one failure we can
// explain into a sentence the user can act on.
func (c *Client) ensureFunds(ctx context.Context, required *big.Int, force bool) error {
	if c.Signer == nil || required == nil {
		return nil
	}
	balance := c.Balance
	if balance == nil {
		balance = wallet.USDCBalanceAtomic
	}
	available, err := balance(ctx, c.Signer.Address(), force)
	if err != nil {
		c.log().Warn("x402", "balance check unavailable — letting the payment proceed",
			map[string]any{"err": err.Error()})
		return nil
	}
	if available.Cmp(required) >= 0 {
		return nil
	}
	return &InsufficientFundsError{Required: new(big.Int).Set(required), Available: new(big.Int).Set(available)}
}

// Do executes req. If the server returns 402, it reads the challenge (the
// PAYMENT-REQUIRED header in v2, the body in v1), signs an EIP-3009
// authorization, attaches it (PAYMENT-SIGNATURE in v2, X-PAYMENT in v1), and
// reissues the request. The returned response is the FINAL response — either
// the success after the retry, or a non-402 error from the first call, or a
// hard error from the retry.
//
// The request body must be re-readable: pass an *bytes.Reader (or a
// fresh body in a GetBody hook). For convenience, DoJSON below handles
// the common JSON-POST case.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if c.Signer == nil {
		return nil, errors.New("x402: no signer configured")
	}
	logger := c.log()

	// First attempt: no payment header.
	logger.Info("x402", "request without payment", map[string]any{
		"method": req.Method,
		"url":    req.URL.String(),
	})
	bodyBytes, err := snapshotBody(req)
	if err != nil {
		return nil, err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("x402: initial request: %w", err)
	}
	if resp.StatusCode != http.StatusPaymentRequired {
		return resp, nil
	}
	// 402 path — parse, sign, retry.
	defer resp.Body.Close()

	ch, err := c.readChallenge(resp)
	if err != nil {
		return nil, err
	}
	pick := ch.offer
	logger.Info("x402", "picked requirement", map[string]any{
		"x402Version": ch.version,
		"network":     pick.Network,
		"asset":       pick.Asset,
		"payTo":       pick.PayTo,
		"amount":      ch.value.String(),
	})

	// Can this wallet actually pay? Signing an EIP-3009 authorization is an
	// OFFLINE operation: it succeeds with an empty wallet, the header goes out
	// looking perfectly valid, and the failure only surfaces when the
	// facilitator tries to settle — as an opaque 500 from the generate call,
	// with nothing pointing at the balance. Ask before signing, so the user is
	// told what's wrong instead of what broke.
	if err := c.ensureFunds(req.Context(), ch.value, false); err != nil {
		return nil, err
	}

	signed, err := c.Signer.SignEIP3009(wallet.SignEIP3009Params{
		PayTo:             common.HexToAddress(pick.PayTo),
		Value:             ch.value,
		Asset:             common.HexToAddress(pick.Asset),
		ChainID:           BaseMainnetChainID,
		DomainName:        pick.Extra.Name,
		DomainVersion:     pick.Extra.Version,
		MaxTimeoutSeconds: pick.MaxTimeoutSeconds,
	})
	if err != nil {
		return nil, fmt.Errorf("x402: sign EIP3009: %w", err)
	}
	logger.Info("x402", "EIP3009 signed", map[string]any{
		"nonce":       signed.Authorization.Nonce,
		"validBefore": signed.Authorization.ValidBefore,
	})

	headerName, header, err := encodePayment(ch, signed)
	if err != nil {
		return nil, err
	}

	// Log the full base64 payment so a failed verify can be decoded
	// post-mortem and diffed against what the JS clients produce.
	logger.Info("x402", headerName+" payload (base64, decodable)", map[string]any{
		"header": header,
	})

	// Build the retry request — fresh from the snapshot, with the new header.
	retry := req.Clone(req.Context())
	retry.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	if retry.GetBody != nil {
		// Keep GetBody consistent in case the transport retries internally.
		retry.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(bodyBytes)), nil
		}
	}
	retry.ContentLength = int64(len(bodyBytes))
	retry.Header.Set(headerName, header)

	logger.Info("x402", "retrying with "+headerName, map[string]any{"headerLen": len(header)})
	resp2, err := c.HTTP.Do(retry)
	if err != nil {
		return nil, fmt.Errorf("x402: retry request: %w", err)
	}
	// Settlement rejected. The pre-check ran against a cached balance (10 s), so
	// a withdrawal in between still lands here — re-ask the chain before letting
	// an opaque status code stand in for "you're out of USDC".
	if resp2.StatusCode >= 400 {
		if err := c.ensureFunds(req.Context(), ch.value, true); err != nil {
			body, _ := io.ReadAll(io.LimitReader(resp2.Body, 512))
			resp2.Body.Close()
			logger.Warn("x402", "payment failed and the wallet is short", map[string]any{
				"status": resp2.StatusCode, "body": string(body),
			})
			return nil, err
		}
	}
	if resp2.StatusCode == http.StatusPaymentRequired {
		body, _ := io.ReadAll(io.LimitReader(resp2.Body, 512))
		resp2.Body.Close()
		return nil, fmt.Errorf("x402: still 402 after payment: %s", string(body))
	}
	logger.Info("x402", "retry done", map[string]any{
		"status":  resp2.StatusCode,
		"receipt": paymentReceipt(resp2.Header),
	})
	return resp2, nil
}

// readChallenge parses a 402. A PAYMENT-REQUIRED header means v2 and only
// v2: a server that offers v2 is paid in v2, the v1 body next to it is
// ignored. Without the header, the body is a v1 challenge.
func (c *Client) readChallenge(resp *http.Response) (challenge, error) {
	if h := resp.Header.Get(headerPaymentRequired); h != "" {
		raw, err := decodeBase64(h)
		if err != nil {
			return challenge{}, fmt.Errorf("x402: decode %s header: %w", headerPaymentRequired, err)
		}
		var pr paymentRequiredV2
		if err := json.Unmarshal(raw, &pr); err != nil {
			return challenge{}, fmt.Errorf("x402: parse %s header: %w", headerPaymentRequired, err)
		}
		if pr.X402Version != 2 {
			return challenge{}, fmt.Errorf("x402: %s header has x402Version %d, want 2", headerPaymentRequired, pr.X402Version)
		}
		c.log().Info("x402", "402 received", map[string]any{"x402Version": 2, "acceptsLength": len(pr.Accepts)})
		offers := make([]PaymentRequirement, len(pr.Accepts))
		for i, a := range pr.Accepts {
			if json.Unmarshal(a, &offers[i]) != nil {
				offers[i] = PaymentRequirement{} // unreadable offer: never picked
			}
		}
		i, value, err := c.pickRequirement(offers, 2)
		if err != nil {
			return challenge{}, err
		}
		return challenge{
			version: 2, offer: offers[i], value: value,
			resource: pr.Resource, accepted: pr.Accepts[i], extensions: pr.Extensions,
		}, nil
	}

	var pr PaymentRequiredBody
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return challenge{}, fmt.Errorf("x402: parse 402 body: %w", err)
	}
	c.log().Info("x402", "402 received", map[string]any{"x402Version": pr.X402Version, "acceptsLength": len(pr.Accepts)})
	if pr.X402Version != 1 {
		return challenge{}, fmt.Errorf("x402: 402 without a %s header and x402Version %d in the body", headerPaymentRequired, pr.X402Version)
	}
	i, value, err := c.pickRequirement(pr.Accepts, 1)
	if err != nil {
		return challenge{}, err
	}
	return challenge{version: 1, offer: pr.Accepts[i], value: value}, nil
}

// DoJSON is a convenience for the typical "POST JSON, get 402, retry"
// case. ctx, headers, and reqBody (struct or map) → final response.
func (c *Client) DoJSON(ctx context.Context, method, url string, reqBody any, extraHeaders http.Header) (*http.Response, error) {
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("x402: marshal request body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	for k, vs := range extraHeaders {
		for _, v := range vs {
			req.Header.Add(k, v)
		}
	}
	// Set GetBody so Do() can re-read on retry without reading the original twice.
	req.GetBody = func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(bodyBytes)), nil
	}
	req.ContentLength = int64(len(bodyBytes))
	return c.Do(req)
}

// pickRequirement returns the index and price of the first offer this
// wallet may sign: scheme exact, Base mainnet (as `version` names it), the
// USDC contract, a valid payTo, and 0 < price ≤ MaxAmount. Nothing else is
// ever signed — another chain, a testnet, another token or a price above the
// cap is refused with a clear error.
func (c *Client) pickRequirement(accepts []PaymentRequirement, version int) (int, *big.Int, error) {
	if len(accepts) == 0 {
		return 0, nil, errors.New("x402: server returned no payment requirements in accepts[]")
	}
	network := networkV1
	if version == 2 {
		network = networkV2
	}
	var overCap *big.Int
	for i, r := range accepts {
		if r.Scheme != "exact" || r.Network != network {
			continue
		}
		if !common.IsHexAddress(r.Asset) || !common.IsHexAddress(r.PayTo) {
			continue
		}
		if common.HexToAddress(r.Asset) != wallet.USDCBaseAddress {
			continue
		}
		price := r.MaxAmountRequired
		if version == 2 {
			price = r.Amount
		}
		value, ok := new(big.Int).SetString(price, 10)
		if !ok || value.Sign() <= 0 {
			continue
		}
		if c.MaxAmount != nil && value.Cmp(c.MaxAmount) > 0 {
			overCap = value
			continue
		}
		return i, value, nil
	}
	if overCap != nil {
		return 0, nil, fmt.Errorf("x402: would pay %s atomic units but max allowed is %s — bump Client.MaxAmount if intentional",
			overCap.String(), c.MaxAmount.String())
	}
	return 0, nil, fmt.Errorf("x402: no acceptable payment requirement (need scheme=exact, network=%s, asset=USDC; got %d options)", network, len(accepts))
}

// encodePayment returns the header name and base64-JSON value carrying the
// signed authorization, in the challenge's protocol version. v1 matches
// x402-fetch's encodePayment; v2 matches @x402/fetch (offer, resource and
// extensions echoed unchanged).
func encodePayment(ch challenge, signed wallet.SignedAuthorization) (string, string, error) {
	name := headerXPayment
	var v any
	if ch.version == 2 {
		name = headerPaymentSignature
		v = paymentPayloadV2{
			X402Version: 2,
			Resource:    ch.resource,
			Accepted:    ch.accepted,
			Payload:     exactPayload{Signature: signed.Signature, Authorization: signed.Authorization},
			Extensions:  ch.extensions,
		}
	} else {
		var payload SignedPayload
		payload.X402Version = 1
		payload.Scheme = ch.offer.Scheme
		payload.Network = ch.offer.Network
		payload.Payload.Signature = signed.Signature
		payload.Payload.Authorization = signed.Authorization
		v = payload
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return "", "", fmt.Errorf("x402: marshal %s body: %w", name, err)
	}
	return name, base64.StdEncoding.EncodeToString(raw), nil
}

// paymentReceipt decodes the settlement receipt (PAYMENT-RESPONSE in v2,
// X-PAYMENT-RESPONSE in v1) for the log; nil when absent or unreadable.
func paymentReceipt(h http.Header) map[string]any {
	v := h.Get(headerPaymentResponse)
	if v == "" {
		v = h.Get(headerXPaymentResponse)
	}
	if v == "" {
		return nil
	}
	raw, err := decodeBase64(v)
	if err != nil {
		return nil
	}
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil {
		return nil
	}
	return out
}

// decodeBase64 accepts standard base64 with or without padding.
func decodeBase64(s string) ([]byte, error) {
	s = strings.TrimSpace(s)
	if b, err := base64.StdEncoding.DecodeString(s); err == nil {
		return b, nil
	}
	return base64.RawStdEncoding.DecodeString(strings.TrimRight(s, "="))
}

// snapshotBody reads the request body (if any) into a buffer and
// rewinds the original so the initial request still succeeds. Returns
// the bytes for use in the retry.
func snapshotBody(req *http.Request) ([]byte, error) {
	if req.Body == nil {
		return nil, nil
	}
	b, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, fmt.Errorf("x402: read request body: %w", err)
	}
	req.Body = io.NopCloser(bytes.NewReader(b))
	req.ContentLength = int64(len(b))
	return b, nil
}
