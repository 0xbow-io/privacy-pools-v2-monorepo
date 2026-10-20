# !/usr/bin/env bash
. ./.env
export ARB_RPC_URL=$RPC_URL_42161
export ETH_RPC_URL=$RPC_URL_1
export OP_RPC_URL=$RPC_URL_10
export BASE_RPC_URL=$RPC_URL_8453
export BSC_RPC_URL=$RPC_URL_56
export PRIVATE_KEY=$SIGNER_PRIVATE_KEY_42161

TESTS=(
    mainnet-deposit.integration.test.ts
    mainnet-recover-snapshots.integration.test.ts
    mainnet-relay-swaps.integration.test.ts
    mainnet-real-relay-swaps-withdraw.integration.test.ts
    mainnet-real-relay-swaps-reshield.integration.test.ts
    mainnet-real-relay-swaps-reshield-optimism.integration.test.ts
    mainnet-swap-deposit-optimism.integration.test.ts
    mainnet-crosschain-swap-deposit-to-optimism.integration.test.ts
    mainnet-crosschain-relay-swaps-deposit-from-ethereum.integration.test.ts
    mainnet-crosschain-relay-swaps-withdraw-to-optimism.integration.test.ts
    mainnet-crosschain-relay-swaps-reshield-to-base.integration.test.ts
    mainnet-crosschain-relay-swaps-reshield-to-bsc.integration.test.ts
    mainnet-crosschain-relay-swaps-reshield-to-optimism.integration.test.ts
    mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue.integration.test.ts
    mainnet-crosschain-relay-swaps-reshield-to-base-usdt-dust-rescue.integration.test.ts
    mainnet-recover-dust-rescue-notes.integration.test.ts
    mainnet-recover-base-reshield-notes.integration.test.ts
    mainnet-mass-ragequit.integration.test.ts
)

_test () {
    local test_name="${1}"
    DEPOSIT_AMOUNT=10000000 npx vitest run --config vitest.mainnet.config.ts "${test_name}"
}

_pick_test_index () {
    local choice
    if [[ -n "$1" ]]; then
        choice="$1"
    else
        echo "Select a test to run:" >&2
        for i in "${!TESTS[@]}"; do
            echo "  $(( i + 1 ))) ${TESTS[$i]}" >&2
        done
        echo "" >&2
        read -r -p "Enter number [1-${#TESTS[@]}]: " choice
    fi

    local index=$(( choice - 1 ))
    if [[ $index -lt 0 || $index -ge ${#TESTS[@]} ]]; then
        echo "Error: selection must be between 1 and ${#TESTS[@]}" >&2
        return 1
    fi

    echo "$index"
}

index=$(_pick_test_index "$1") && _test "${TESTS[$index]}"
