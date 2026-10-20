# !/usr/bin/env bash
# Pre-run sanity check for the mainnet smoke suite.
#
# Run it the SAME way as the tests (`bash verification.sh`) so it resolves keys in the
# same child-shell context `run_a_test.sh` uses (it sources whatever env you source).
# It prints the addresses the run will actually use, plus funding — eyeball before
# spending. Does NOT send any transaction.

set -u

. ./.env

RPC="${ARB_RPC_URL:-${RPC_URL_42161:-}}"
USDC="${USDC_ADDR:-0xaf88d065e77c8cC2239327C5EDb3A432268e5831}"

addr() { cast wallet address --private-key "$1" 2>/dev/null || echo "<invalid/unset>"; }

SIGNER_ADDR="$(addr "${SIGNER_PRIVATE_KEY_42161:-}")"
POSTMAN_ADDR="$(addr "${ASP_POSTMAN_PRIVATE_KEY:-}")"

echo "signer  (SIGNER_PRIVATE_KEY_42161): $SIGNER_ADDR"
echo "postman (ASP_POSTMAN_PRIVATE_KEY):  $POSTMAN_ADDR"

if [ -z "$RPC" ]; then
    echo "WARN: no ARB_RPC_URL / RPC_URL_42161 set — skipping balance + on-chain checks"
    exit 0
fi

eth="$(cast balance "$SIGNER_ADDR" --rpc-url "$RPC" 2>/dev/null || echo 0)"
usdc="$(cast call "$USDC" 'balanceOf(address)(uint256)' "$SIGNER_ADDR" --rpc-url "$RPC" 2>/dev/null || echo 0)"
echo "signer ETH:  $(cast from-wei "$eth" 2>/dev/null || echo '?')"
echo "signer USDC: $(cast from-wei "${usdc%% *}" 6 2>/dev/null || echo '?')"

# Sanity flags
[ "$SIGNER_ADDR" = "$POSTMAN_ADDR" ] && echo "WARN: signer == postman (postman split has no effect)"
case "$SIGNER_ADDR" in
    0x0967755AfA2016866D12EefB820705026842dCe8) echo "WARN: signer is the STRANDED 0x0967 account";;
    0x6faEc3e55476AcBfB58A37b9ea2D0f58C8CC42dC) echo "WARN: signer is the POLLUTED 0x6faE account (registered with foreign keys)";;
esac
