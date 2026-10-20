#!/usr/bin/env bash
# One-shot LOCAL yield wrapper e2e — NO Sepolia RPC required.
#
# Starts a local anvil node, deploys a ppUSDC (PPYieldToken) wrapper over a MOCK Aave pool, then runs
# the SDK's PPYieldTokenInteractor against the real deployed contract. Tears anvil down at the end.
#
# Usage:  bash packages/evm-sdk/scripts/yield-e2e/run-wrapper-local.sh
# Env:    YIELD_CONTRACTS_DIR  (default: this monorepo's packages/contracts)
#         PATH must include `anvil`/`forge` (Foundry).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SDK_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
YIELD_CONTRACTS_DIR="${YIELD_CONTRACTS_DIR:-$(cd "$SCRIPT_DIR/../../../contracts" && pwd)}"
RPC_URL="${RPC_URL:-http://localhost:8545}"
# anvil default account 0 (well-known dev key — local only).
ANVIL_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

echo "==> contracts: $YIELD_CONTRACTS_DIR"
command -v anvil >/dev/null || { echo "anvil not on PATH (install Foundry)"; exit 1; }

echo "==> starting anvil"
anvil --silent > /tmp/anvil-yield-e2e.log 2>&1 &
ANVIL_PID=$!
cleanup() { kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT
# wait for anvil
for _ in $(seq 1 30); do cast block-number --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.3; done

echo "==> deploying ppUSDC wrapper over mock Aave"
DEPLOY_OUT="$(cd "$YIELD_CONTRACTS_DIR" && PRIVATE_KEY="$ANVIL_KEY" \
  forge script script/DeployLocalYield.s.sol --rpc-url "$RPC_URL" --broadcast 2>&1)"
PPUSDC="$(echo "$DEPLOY_OUT" | grep -Eo 'PPYIELDTOKEN 0x[0-9a-fA-F]{40}' | awk '{print $2}' | head -1)"
[ -n "$PPUSDC" ] || { echo "deploy failed:"; echo "$DEPLOY_OUT" | tail -20; exit 1; }
echo "==> ppUSDC deployed at $PPUSDC"

echo "==> running SDK wrapper e2e against the live node"
cd "$SDK_DIR"
YIELD_LOCAL_PPUSDC="$PPUSDC" RPC_URL="$RPC_URL" \
  npx vitest run test/services/yield-wrapper-local.integration.test.ts
