#!/usr/bin/env bash
# Happy-path scenario: deposits → ASP wait → transfers → withdraws → ragequit.
# No keystore registration or rotation — assumes Bob and Alice are already
# registered and both wallets hold enough Sepolia ETH (~11 deposits of AMOUNT
# plus gas; 0.15 ETH covers the default 0.01).
#
# Note budget — every spending flow consumes one ASP-approved (ACTIVE) Bob
# note of AMOUNT:
#   transfers: toEVMAddress, withPublicViewingKey, blind, cold  -> 4
#   withdraws: full, selfSubmit                                  -> 2
#   partialWithdraw (needs value > amount, so it spends AMOUNT/2)-> 1
#   ragequit                                                     -> 1
#   total: 8
# Only plain check:deposit feeds Bob's pool; the three depositFor variants
# create notes for other identities (they still verify the deposit flows).
# Hence 8 plain deposits, then one wait for the ASP to flip them ACTIVE.
#
# Usage: ./checks/run-scenario.sh [amountEth]   (default 0.01)
set -euo pipefail
cd "$(dirname "$0")/.."

AMOUNT="${1:-0.01}"
HALF=$(awk -v a="$AMOUNT" 'BEGIN { printf "%g", a / 2 }')
NOTES_NEEDED=8
ASP_WAIT_TIMEOUT_MIN="${ASP_WAIT_TIMEOUT_MIN:-30}"

step() {
    echo
    echo "=== $* ==="
    local start=$SECONDS
    pnpm run "$@"
    echo "    (took $((SECONDS - start))s)"
}

echo "Scenario: amount=$AMOUNT ETH, partial withdraw=$HALF ETH, notes needed=$NOTES_NEEDED"

# Phase 1 — deposits (8 Bob notes + 3 depositFor flow checks)
for i in $(seq 1 $NOTES_NEEDED); do
    echo
    echo "=== check:deposit ($i/$NOTES_NEEDED) ==="
    pnpm run check:deposit "$AMOUNT"
done
step check:depositForColdStart "$AMOUNT"
step check:depositForEVMPublish "$AMOUNT"
step check:depositForPublicKeyPublish "$AMOUNT"

# Phase 2 — wait for the ASP to approve the deposited notes
step check:waitForActiveNotes "$NOTES_NEEDED" "$AMOUNT" "$ASP_WAIT_TIMEOUT_MIN"

# Phase 3 — transfers (4 notes)
step check:transferToEVMAddress "$AMOUNT"
step check:transferWithPublicViewingKey "$AMOUNT"
step check:transferBlind "$AMOUNT"
step check:coldTransfer "$AMOUNT"

# Phase 4 — withdraws (3 notes)
step check:withdraw "$AMOUNT"
step check:selfSubmitWithdraw "$AMOUNT"
step check:partialWithdraw "$HALF"

# Phase 5 — ragequit (1 note, run last: it permanently exits the note)
step check:ragequit

echo
echo "=== scenario complete ==="
