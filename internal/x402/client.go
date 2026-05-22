// Package x402 implements the client side of the x402 payment protocol
// (Coinbase variant, v1) for EVM networks. It wraps an http.Client so
// callers can issue arbitrary requests against an x402-gated endpoint
// without thinking about the 402-retry dance.
//
// Wire protocol confirmed against the imference.com server and the
// `x402` npm package source (the `x402-fetch.bundle.mjs` shipped with
// the imference playground). When a request returns 402, the body looks
// like:
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
// We pick the first acceptable `accepts` entry (network=base, scheme=exact,
// asset=USDC, amount ≤ maxAmount), have the signer produce an EIP-3009
// TransferWithAuthorization signature against the USDC contract, then
// reissue the original request with the signed payload base64-JSON in
// the X-PAYMENT header.
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

	"github.com/ethereum/go-ethereum/common"

	"imference-desktop-go/internal/wallet"
)

// BaseMainnetChainID is hardcoded — POC supports only Base mainnet.
const BaseMainnetChainID = 8453

// PaymentRequirement mirrors the JSON in `accepts[i]`. Fields kept as
// strings on the wire match what the facilitator emits and consumes.
type PaymentRequirement struct {
	Scheme            string `json:"scheme"`
	Network           string `json:"network"`
	MaxAmountRequired string `json:"maxAmountRequired"`
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

// PaymentRequiredBody is the 402 response shape.
type PaymentRequiredBody struct {
	X402Version int                  `json:"x402Version"`
	Error       string               `json:"error"`
	Accepts     []PaymentRequirement `json:"accepts"`
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

// Client wraps an underlying http.Client with x402 retry logic.
type Client struct {
	HTTP      *http.Client
	Signer    *wallet.Wallet
	MaxAmount *big.Int // atomic units; reject 402s that ask for more
	Logger    Logger
}

// New returns a Client with sane defaults: short HTTP timeout, nop
// logger, MaxAmount = 1 USDC (= 1_000_000 atomic on a 6-decimal asset)
// as a "shouldn't accidentally pay $1 per request" sanity bound.
func New(signer *wallet.Wallet) *Client {
	return &Client{
		HTTP:      &http.Client{}, // caller's responsibility to set timeouts on the request via context
		Signer:    signer,
		MaxAmount: big.NewInt(1_000_000), // 1 USDC
		Logger:    nopLogger{},
	}
}

// Do executes req. If the server returns 402, it parses the body, signs
// an EIP-3009 authorization, attaches the X-PAYMENT header, and reissues
// the request. The returned response is the FINAL response — either the
// success after the retry, or a non-402 error from the first call, or a
// hard error from the retry.
//
// The request body must be re-readable: pass an *bytes.Reader (or a
// fresh body in a GetBody hook). For convenience, DoJSON below handles
// the common JSON-POST case.
func (c *Client) Do(req *http.Request) (*http.Response, error) {
	if c.Signer == nil {
		return nil, errors.New("x402: no signer configured")
	}
	logger := c.Logger
	if logger == nil {
		logger = nopLogger{}
	}

	// First attempt: no payment header.
	logger.Info("x402", "POST without payment", map[string]any{
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

	var pr PaymentRequiredBody
	if err := json.NewDecoder(resp.Body).Decode(&pr); err != nil {
		return nil, fmt.Errorf("x402: parse 402 body: %w", err)
	}
	logger.Info("x402", "402 received", map[string]any{
		"x402Version":   pr.X402Version,
		"acceptsLength": len(pr.Accepts),
	})
	pick, err := c.pickRequirement(pr.Accepts)
	if err != nil {
		return nil, err
	}
	logger.Info("x402", "picked requirement", map[string]any{
		"network":           pick.Network,
		"asset":             pick.Asset,
		"payTo":             pick.PayTo,
		"maxAmountRequired": pick.MaxAmountRequired,
	})

	value, ok := new(big.Int).SetString(pick.MaxAmountRequired, 10)
	if !ok {
		return nil, fmt.Errorf("x402: maxAmountRequired %q is not a valid integer", pick.MaxAmountRequired)
	}
	if c.MaxAmount != nil && value.Cmp(c.MaxAmount) > 0 {
		return nil, fmt.Errorf("x402: would pay %s atomic units but max allowed is %s — bump Client.MaxAmount if intentional",
			value.String(), c.MaxAmount.String())
	}

	signed, err := c.Signer.SignEIP3009(wallet.SignEIP3009Params{
		PayTo:             common.HexToAddress(pick.PayTo),
		Value:             value,
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

	header, err := encodeXPayment(pr.X402Version, pick, signed)
	if err != nil {
		return nil, err
	}

	// Trace-log the full base64 X-PAYMENT so a failed verify can be
	// decoded post-mortem and diffed against what the JS x402-fetch
	// playground produces. Trace level → won't pollute the default
	// info/warn view but is in the panel if needed.
	logger.Info("x402", "X-PAYMENT payload (base64, decodable)", map[string]any{
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
	retry.Header.Set("X-PAYMENT", header)

	logger.Info("x402", "retrying with X-PAYMENT", map[string]any{"headerLen": len(header)})
	resp2, err := c.HTTP.Do(retry)
	if err != nil {
		return nil, fmt.Errorf("x402: retry request: %w", err)
	}
	if resp2.StatusCode == http.StatusPaymentRequired {
		body, _ := io.ReadAll(io.LimitReader(resp2.Body, 512))
		resp2.Body.Close()
		return nil, fmt.Errorf("x402: still 402 after payment: %s", string(body))
	}
	logger.Info("x402", "retry succeeded", map[string]any{"status": resp2.StatusCode})
	return resp2, nil
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

// pickRequirement filters accepts[] to the first one we can actually
// satisfy with this POC's wallet (Base mainnet + scheme=exact + USDC
// asset address known). Returns a clear error when none match.
func (c *Client) pickRequirement(accepts []PaymentRequirement) (PaymentRequirement, error) {
	if len(accepts) == 0 {
		return PaymentRequirement{}, errors.New("x402: server returned no payment requirements in accepts[]")
	}
	for _, r := range accepts {
		if r.Scheme != "exact" {
			continue
		}
		if r.Network != "base" {
			continue
		}
		if r.Asset == "" || r.PayTo == "" {
			continue
		}
		// Check the asset is the USDC contract we know.
		if !common.IsHexAddress(r.Asset) || !common.IsHexAddress(r.PayTo) {
			continue
		}
		if common.HexToAddress(r.Asset) != wallet.USDCBaseAddress {
			continue
		}
		return r, nil
	}
	return PaymentRequirement{}, fmt.Errorf("x402: no acceptable payment requirement (need scheme=exact, network=base, asset=USDC; got %d options)", len(accepts))
}

// encodeXPayment base64+JSON-encodes the signed payload exactly the way
// x402-fetch's encodePayment does, so the Coinbase facilitator on the
// server side parses it without complaints.
func encodeXPayment(version int, pr PaymentRequirement, signed wallet.SignedAuthorization) (string, error) {
	var payload SignedPayload
	payload.X402Version = version
	payload.Scheme = pr.Scheme
	payload.Network = pr.Network
	payload.Payload.Signature = signed.Signature
	payload.Payload.Authorization = signed.Authorization

	raw, err := json.Marshal(payload)
	if err != nil {
		return "", fmt.Errorf("x402: marshal X-PAYMENT body: %w", err)
	}
	return base64.StdEncoding.EncodeToString(raw), nil
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
