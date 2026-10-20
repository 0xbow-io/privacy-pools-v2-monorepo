#!/bin/bash
# Start/stop a local Stellar standalone node for fast E2E testing.
#
# Usage:
#   ./scripts/local-stellar.sh start   # Start local node (default)
#   ./scripts/local-stellar.sh stop    # Stop and remove container
#   ./scripts/local-stellar.sh status  # Check if running
#
# Then run tests:
#   npm run test:e2e:local

set -e

CONTAINER_NAME="stellar-local"
PORT=8000

case "${1:-start}" in
  start)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Local Stellar node already running on port ${PORT}"
      exit 0
    fi

    # Clean up stopped container if it exists
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true

    echo "Starting local Stellar standalone node..."
    # Real mainnet/testnet post-SLP-0004 settings (verified Apr 2026):
    #   txMaxInstructions = 400_000_000
    #   ledgerMaxInstructions = 580_000_000
    #   feeRatePerInstructionsIncrement = 7
    #
    # stellar/quickstart image presets don't cleanly match those:
    #   --limits default    — pre-Soroban-launch, way too tight
    #   --limits testnet    — stale (2.5M/tx), does NOT match real testnet
    #   --limits unlimited  — 2^61, much laxer than mainnet
    #
    # We use `unlimited` and enforce the real 400M cap via test-side
    # assertion (see `e2e/helpers.ts` BUDGET_LOG + MAINNET_CAP guard).
    # This lets us keep tests moving while the image preset catches up,
    # without silently accepting txs that'd fail on mainnet.
    docker run -d --name "${CONTAINER_NAME}" \
      -p "${PORT}:8000" \
      stellar/quickstart:latest \
      --local \
      --enable-soroban-rpc \
      --limits unlimited

    echo "Waiting for node to be ready..."
    for i in $(seq 1 120); do
      if curl -s "http://localhost:${PORT}/health" 2>/dev/null | grep -q '"core_synced":true'; then
        echo "Local Stellar node ready at http://localhost:${PORT}"
        echo ""
        echo "Run tests with:"
        echo "  npm run test:e2e:local"
        exit 0
      fi
      sleep 1
    done
    echo "ERROR: Node did not become ready within 120s"
    exit 1
    ;;

  stop)
    echo "Stopping local Stellar node..."
    docker stop "${CONTAINER_NAME}" 2>/dev/null && docker rm "${CONTAINER_NAME}" 2>/dev/null
    echo "Done."
    ;;

  status)
    if docker ps --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
      echo "Running on port ${PORT}"
    else
      echo "Not running"
    fi
    ;;

  *)
    echo "Usage: $0 {start|stop|status}"
    exit 1
    ;;
esac
