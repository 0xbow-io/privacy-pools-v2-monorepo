#!/usr/bin/env bash
# Starts a LOCAL relayer on the V2 PRODUCTION contracts (.relayer-prod-config.json:
# mainnet + bsc + citrea, RelaySwaps 0xd0395c08...) so the prod reshield test can be
# driven with server-side logs. Same on-chain path as the real prod relayer —
# only the relayer signer / fee receiver differ.
#
# Secrets from .envirgo. Signer defaults to FAT_WALLET_PRIVATE_0 (0x0967); it pays
# RelaySwaps.executeUnwrapped gas on mainnet (~1.6M gas) and receives the fee.
#
# Usage:  ./run_prod_relayer_local.sh            (foreground, Ctrl-C to stop)
#         then RELAYER_URL=http://localhost:3000 ./run_prod_eth_bsc_reshield.sh
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC2046
eval "$(awk '/^set -gx /{printf "export %s=%s\n", $3, $4}' .envirgo)"

RELAYER_SIGNER_KEY_VAR="${RELAYER_SIGNER_KEY_VAR:-FAT_WALLET_PRIVATE_0}"
SIGNER_KEY="${!RELAYER_SIGNER_KEY_VAR}"
SIGNER_ADDRESS="$(cast wallet address --private-key "$SIGNER_KEY")"

export CONFIG_PATH="$(pwd)/.relayer-prod-config.json"
export PORT="${PORT:-3000}"
export RPC_URL_EVM_1="$RPC_URL_1"
export RPC_URL_EVM_56="$RPC_URL_56"
export SIGNER_PRIVATE_KEY_EVM_1="$SIGNER_KEY"
export SIGNER_PRIVATE_KEY_EVM_56="$SIGNER_KEY"
export SIGNER_PRIVATE_KEY_EVM_4114="$SIGNER_KEY"
export FEE_RECEIVER_ADDRESS_EVM_1="$SIGNER_ADDRESS"
export FEE_RECEIVER_ADDRESS_EVM_56="$SIGNER_ADDRESS"
export FEE_RECEIVER_ADDRESS_EVM_4114="$SIGNER_ADDRESS"
# Default 2.5s read timeout is too short for RelaySwaps.execute simulation.
export RPC_TIMEOUT_MS="${RPC_TIMEOUT_MS:-30000}"

echo "relayer signer (chains 1 + 56 + 4114): $SIGNER_ADDRESS"
echo "config: $CONFIG_PATH  port: $PORT"

cd ../relayer/relayer
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  pnpm build
fi
exec node dist/main
