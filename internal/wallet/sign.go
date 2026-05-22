package wallet

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"time"

	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/common/hexutil"
	"github.com/ethereum/go-ethereum/common/math"
	"github.com/ethereum/go-ethereum/crypto"
	"github.com/ethereum/go-ethereum/signer/core/apitypes"
)

// Authorization is the EIP-3009 TransferWithAuthorization payload —
// the exact shape that goes into the x402 X-PAYMENT header. All numeric
// fields are stringified uint256 because that's what the Coinbase
// facilitator expects on the wire (matches x402-fetch's encodePayment).
type Authorization struct {
	From        string `json:"from"`
	To          string `json:"to"`
	Value       string `json:"value"`       // atomic units of the asset (USDC: 6 decimals)
	ValidAfter  string `json:"validAfter"`  // unix seconds
	ValidBefore string `json:"validBefore"` // unix seconds
	Nonce       string `json:"nonce"`       // 0x-prefixed 32-byte hex
}

// SignedAuthorization pairs the authorization with its ECDSA signature
// over the EIP-712 typed data. Signature is 0x-prefixed 65-byte hex
// (r ‖ s ‖ v, with v adjusted to 27/28).
type SignedAuthorization struct {
	Authorization Authorization `json:"authorization"`
	Signature     string        `json:"signature"`
}

// SignEIP3009Params is what the x402 client passes in based on the
// payment requirements it received in the 402 body.
type SignEIP3009Params struct {
	PayTo             common.Address // accepts[i].payTo
	Value             *big.Int       // accepts[i].maxAmountRequired (already parsed from string)
	Asset             common.Address // accepts[i].asset (USDC contract)
	ChainID           int64          // 8453 for base mainnet
	DomainName        string         // accepts[i].extra.name ("USD Coin")
	DomainVersion     string         // accepts[i].extra.version ("2")
	MaxTimeoutSeconds int64          // accepts[i].maxTimeoutSeconds
}

// SignEIP3009 builds the typed data, signs it with the wallet's private
// key, and returns the SignedAuthorization that the x402 client wraps
// into the X-PAYMENT header.
//
// Time bounds match x402-fetch: validAfter = now - 600s (allows slight
// server clock skew), validBefore = now + maxTimeoutSeconds. Nonce is
// 32 fresh random bytes — the USDC contract enforces uniqueness, so
// reusing one would fail at the facilitator.
func (w *Wallet) SignEIP3009(p SignEIP3009Params) (SignedAuthorization, error) {
	now := time.Now().Unix()
	validAfter := now - 600
	validBefore := now + p.MaxTimeoutSeconds

	var nonceBytes [32]byte
	if _, err := rand.Read(nonceBytes[:]); err != nil {
		return SignedAuthorization{}, fmt.Errorf("wallet: read random nonce: %w", err)
	}
	nonceHex := "0x" + hex.EncodeToString(nonceBytes[:])

	from := w.Address()

	auth := Authorization{
		From:        from.Hex(),
		To:          p.PayTo.Hex(),
		Value:       p.Value.String(),
		ValidAfter:  fmt.Sprintf("%d", validAfter),
		ValidBefore: fmt.Sprintf("%d", validBefore),
		Nonce:       nonceHex,
	}

	// Construct the EIP-712 typed data exactly mirroring
	// x402-fetch.bundle.mjs:signAuthorization3 and authorizationTypes:
	//   types.TransferWithAuthorization = [
	//     {from address}, {to address}, {value uint256},
	//     {validAfter uint256}, {validBefore uint256}, {nonce bytes32}
	//   ]
	//   domain = { name, version, chainId, verifyingContract: asset }
	typedData := apitypes.TypedData{
		Types: apitypes.Types{
			"EIP712Domain": []apitypes.Type{
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"TransferWithAuthorization": []apitypes.Type{
				{Name: "from", Type: "address"},
				{Name: "to", Type: "address"},
				{Name: "value", Type: "uint256"},
				{Name: "validAfter", Type: "uint256"},
				{Name: "validBefore", Type: "uint256"},
				{Name: "nonce", Type: "bytes32"},
			},
		},
		PrimaryType: "TransferWithAuthorization",
		Domain: apitypes.TypedDataDomain{
			Name:              p.DomainName,
			Version:           p.DomainVersion,
			ChainId:           math.NewHexOrDecimal256(p.ChainID),
			VerifyingContract: p.Asset.Hex(),
		},
		Message: apitypes.TypedDataMessage{
			"from":        from.Hex(),
			"to":          p.PayTo.Hex(),
			"value":       p.Value.String(),
			"validAfter":  fmt.Sprintf("%d", validAfter),
			"validBefore": fmt.Sprintf("%d", validBefore),
			"nonce":       nonceHex,
		},
	}

	// Use the library helper instead of building 0x1901||domainSep||messageHash
	// by hand — TypedDataAndHash does both HashStruct calls in the order the
	// EIP-712 spec mandates. Removes a class of subtle bugs.
	digest, _, err := apitypes.TypedDataAndHash(typedData)
	if err != nil {
		return SignedAuthorization{}, fmt.Errorf("wallet: EIP712 hash: %w", err)
	}

	signature, err := crypto.Sign(digest, w.priv)
	if err != nil {
		return SignedAuthorization{}, fmt.Errorf("wallet: sign EIP712 digest: %w", err)
	}

	// Paranoid self-check: ecrecover our own signature and confirm it
	// resolves back to `from`. If this fails, the hashing is wrong on our
	// side and we'd otherwise eat a "Bad Request" mystery from the
	// facilitator without knowing why. crypto.SigToPub expects V=0/1, which
	// is what crypto.Sign just produced — do this BEFORE bumping V.
	pubkey, err := crypto.SigToPub(digest, signature)
	if err != nil {
		return SignedAuthorization{}, fmt.Errorf("wallet: recover pubkey from own signature: %w", err)
	}
	recovered := crypto.PubkeyToAddress(*pubkey)
	if recovered != from {
		return SignedAuthorization{}, fmt.Errorf(
			"wallet: signature self-check failed: recovered %s, expected %s — EIP-712 hash is wrong",
			recovered.Hex(), from.Hex(),
		)
	}

	// Bump V from 0/1 (secp256k1 recovery id) to 27/28 (Ethereum canonical)
	// for the facilitator's ecrecover.
	if signature[64] < 27 {
		signature[64] += 27
	}

	return SignedAuthorization{
		Authorization: auth,
		Signature:     hexutil.Encode(signature),
	}, nil
}
