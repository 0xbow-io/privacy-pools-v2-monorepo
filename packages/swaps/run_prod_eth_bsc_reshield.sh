#!/usr/bin/env bash
# Runs the PROD cross-chain reshield test (mainnet -> BSC on the V2 PRODUCTION
# stack: prod contracts, prod ASP https://api-v2.0xbow.io, prod relayer by
# default). See the header of
# test/mainnet-prod-crosschain-reshield-ethereum-to-bsc.integration.test.ts.
#
# Moves REAL funds on prod. Default route: DEPOSIT_AMOUNT USDC (12 USDC) from
# the depositor wallet -> ppUSDC share note on the mainnet prod pool -> wait
# for the prod ASP -> reshield into a ppUSDT share note on the BSC prod pool.
#
# Prereqs (depositor = DEPOSITOR_KEY_VAR, default FAT_WALLET_PRIVATE_0 = 0x0967):
#   - >= DEPOSIT_AMOUNT of the source underlying (USDC) + ETH for ~1M gas on mainnet
#   - a little BNB on BSC (keystore registration)
#   - the prod ASP must actually vet this wallet; otherwise the note stays
#     PENDING and the test times out at the ASP wait (note still recoverable).
#
# Usage:
#   ./run_prod_eth_bsc_reshield.sh                          # prod relayer, ppUSDC -> ppUSDT
#   RELAYER_URL=http://localhost:3000 ./run_prod_eth_bsc_reshield.sh   # local relayer (run_prod_relayer_local.sh)
#   SOURCE_TOKEN=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE DEST_TOKEN=0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE \
#     DEPOSIT_AMOUNT=6000000000000000 ./run_prod_eth_bsc_reshield.sh   # ETH -> BNB (0.006 ETH)
#   REUSE_COMMITMENT=0x... ./run_prod_eth_bsc_reshield.sh   # spend an ACTIVE prod note from a prior run
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck disable=SC2046
eval "$(awk '/^set -gx /{printf "export %s=%s\n", $3, $4}' .envirgo)"

DEPOSITOR_KEY_VAR="${DEPOSITOR_KEY_VAR:-FAT_WALLET_PRIVATE_0}"
export PRIVATE_KEY="${!DEPOSITOR_KEY_VAR}"
export ETH_RPC_URL="$RPC_URL_1"
export BSC_RPC_URL="$RPC_URL_56"
export RELAYER_URL="${RELAYER_URL:-https://relayer-v2-prod-149184580131.us-east1.run.app}"
export PROD_ASP_URL="${PROD_ASP_URL:-https://api-v2.0xbow.io}"
export DEPOSIT_AMOUNT="${DEPOSIT_AMOUNT:-12000000}"

if ! curl -sf --max-time 10 "$RELAYER_URL/v1/details" >/dev/null 2>&1; then
  echo "No relayer answering at $RELAYER_URL/v1/details" >&2
  exit 1
fi

echo "depositor: $(cast wallet address --private-key "$PRIVATE_KEY")  relayer: $RELAYER_URL  asp: $PROD_ASP_URL"
echo "source: ${SOURCE_TOKEN:-ppUSDC (default)}  dest: ${DEST_TOKEN:-ppUSDT (default)}  deposit: $DEPOSIT_AMOUNT (source underlying units)"
echo "mainnet gas price: $(cast gas-price --rpc-url "$ETH_RPC_URL") wei"
exec npx vitest run --config vitest.mainnet.config.ts \
  mainnet-prod-crosschain-reshield-ethereum-to-bsc.integration.test.ts
