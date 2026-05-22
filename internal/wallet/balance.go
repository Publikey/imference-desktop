package wallet

import (
	"context"
	"errors"
	"fmt"
	"math/big"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/ethclient"
)

// USDCBaseAddress is the USDC ERC-20 contract on Base mainnet. 6 decimals.
// Hardcoded because this POC only supports Base mainnet — when we add
// multi-network support, this becomes a per-network constant.
var USDCBaseAddress = common.HexToAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")

// USDCDecimals on Base mainnet — used by both balance formatting and
// the maxAmountRequired conversion in the x402 client.
const USDCDecimals = 6

// defaultRPCURL is the public Base mainnet RPC. Rate-limited but free
// and good enough for the POC. Override via IMFERENCE_BASE_RPC env var
// for users who have their own Alchemy/Infura endpoint.
const defaultRPCURL = "https://mainnet.base.org"

// balanceCache holds the last balance read with a TTL — keeps the
// SettingsDialog's 30s auto-refresh from hammering the RPC during a
// burst of opens.
type balanceCache struct {
	mu      sync.Mutex
	addr    common.Address
	value   *big.Int
	fetched time.Time
}

const balanceCacheTTL = 10 * time.Second

var globalBalanceCache = &balanceCache{}

// USDCBalance returns the formatted USDC balance ("1.234") of the given
// address on Base mainnet. force=true bypasses the in-memory cache.
//
// Errors are returned as-is — callers should display them in the UI
// rather than treating them as zero balance (a network blip shouldn't
// look like an empty wallet).
func USDCBalance(ctx context.Context, addr common.Address, force bool) (string, error) {
	if !force {
		globalBalanceCache.mu.Lock()
		hit := globalBalanceCache.addr == addr && time.Since(globalBalanceCache.fetched) < balanceCacheTTL && globalBalanceCache.value != nil
		var v *big.Int
		if hit {
			v = new(big.Int).Set(globalBalanceCache.value)
		}
		globalBalanceCache.mu.Unlock()
		if hit {
			return formatUSDC(v), nil
		}
	}

	value, err := rawUSDCBalance(ctx, addr)
	if err != nil {
		return "", err
	}

	globalBalanceCache.mu.Lock()
	globalBalanceCache.addr = addr
	globalBalanceCache.value = new(big.Int).Set(value)
	globalBalanceCache.fetched = time.Now()
	globalBalanceCache.mu.Unlock()

	return formatUSDC(value), nil
}

func rawUSDCBalance(ctx context.Context, addr common.Address) (*big.Int, error) {
	rpcURL := os.Getenv("IMFERENCE_BASE_RPC")
	if rpcURL == "" {
		rpcURL = defaultRPCURL
	}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	client, err := ethclient.DialContext(dialCtx, rpcURL)
	if err != nil {
		return nil, fmt.Errorf("wallet: dial RPC %s: %w", rpcURL, err)
	}
	defer client.Close()

	// balanceOf(address) selector = first 4 bytes of keccak256("balanceOf(address)")
	// = 0x70a08231. Manually composed to avoid pulling abigen for one call.
	const balanceOfSelector = "0x70a08231"
	data := common.FromHex(balanceOfSelector + addressTo32Bytes(addr))

	callCtx, cancel2 := context.WithTimeout(ctx, 8*time.Second)
	defer cancel2()

	result, err := client.CallContract(callCtx, ethereum.CallMsg{
		To:   &USDCBaseAddress,
		Data: data,
	}, nil)
	if err != nil {
		return nil, fmt.Errorf("wallet: USDC.balanceOf call: %w", err)
	}
	if len(result) == 0 {
		return nil, errors.New("wallet: USDC.balanceOf returned empty (USDC contract on chosen RPC may be missing)")
	}
	return new(big.Int).SetBytes(result), nil
}

// addressTo32Bytes left-pads a 20-byte address to a 32-byte hex chunk
// (no 0x prefix) as expected by ABI uint256/address encoding.
func addressTo32Bytes(a common.Address) string {
	hexAddr := strings.TrimPrefix(a.Hex(), "0x")
	return strings.Repeat("0", 64-len(hexAddr)) + hexAddr
}

// formatUSDC renders an atomic uint256 USDC value (6 decimals) as a
// human string like "1.234567" with trailing zeros trimmed (and at
// least one digit after the dot, e.g. "0.0").
func formatUSDC(atomic *big.Int) string {
	if atomic == nil {
		return "0.0"
	}
	whole := new(big.Int).Quo(atomic, big.NewInt(1_000_000))
	frac := new(big.Int).Mod(atomic, big.NewInt(1_000_000))
	fracStr := fmt.Sprintf("%06d", frac)
	fracStr = strings.TrimRight(fracStr, "0")
	if fracStr == "" {
		fracStr = "0"
	}
	return fmt.Sprintf("%s.%s", whole.String(), fracStr)
}
