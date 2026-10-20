import type { Hex } from "../internal.js";

/**
 * ABI type definition for the PayoutRouting struct encoded as processor data.
 * Must match `IPrivacyPoolRelay.PayoutRouting` field-for-field: PrivacyPoolRelay
 * decodes this tuple from `transactParams.data` and reverts if `msg.value`
 * does not equal `nativeGas`.
 */
export const PAYOUT_ROUTING_ABI = [
    {
        type: "tuple",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
        ],
    },
] as const;

/**
 * ABI type definition for the WHOLE batch of {@link PAYOUT_ROUTING_ABI} routings,
 * ABI-encoded as `PayoutRouting[]`. The relayer carries this array in the batch
 * fee commitment's `data`; the batch withdraw orchestrator decodes it to recover
 * each item's relayer-authoritative fee split before proof generation.
 */
export const PAYOUT_ROUTING_ARRAY_ABI = [
    {
        type: "tuple[]",
        components: [
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
        ],
    },
] as const;

/**
 * ABI type definition for the RelaySwaps.SwapRouting struct encoded as processor data.
 * Must match `RelaySwaps.SwapRouting` field-for-field: includes the full swapCalldata,
 * proof-bound to the ZK proof via the context hash over `transactParams.data`.
 */
export const RELAY_SWAP_ROUTING_ABI = [
    {
        type: "tuple",
        components: [
            { name: "swapTarget", type: "address" },
            { name: "approvalAddress", type: "address" },
            { name: "outputToken", type: "address" },
            { name: "recipient", type: "address" },
            { name: "feeRecipient", type: "address" },
            { name: "fallbackAddress", type: "address" },
            { name: "dustRecipient", type: "address" },
            { name: "feeAmount", type: "uint256" },
            { name: "minOutputAmount", type: "uint256" },
            { name: "nativeGas", type: "uint256" },
            // B2 — self-funded bridge msg.value (Mainnet-destination reshield). 0 / "0x"
            // on every other path; see RelaySwaps.sol SwapRouting NatSpec.
            { name: "swapValue", type: "uint256" },
            { name: "gasSwapMaxInput", type: "uint256" },
            { name: "gasSwapCalldata", type: "bytes" },
            { name: "swapCalldata", type: "bytes" },
            // RC-10: opt-in cross-chain "dust rescue", carried here purely to inherit this
            // struct's proof-context binding — RelaySwaps.sol never reads it. chainId === 0
            // means none was requested; viewingPubKey is empty unless isCanonical is true.
            {
                name: "dustRescue",
                type: "tuple",
                components: [
                    { name: "chainId", type: "uint256" },
                    { name: "tokenId", type: "address" },
                    { name: "isCanonical", type: "bool" },
                    { name: "spendingPubKey", type: "bytes" },
                    { name: "viewingPubKey", type: "bytes" },
                ],
            },
        ],
    },
] as const;

/**
 * keccak256 of SwapRouting's EIP-712-style encodeType string, mirroring
 * `RelaySwaps.ROUTING_TYPEHASH()` — see that function's NatSpec (RelaySwaps.sol) for the
 * string this hashes and RoutingLayout.t.sol (packages/swaps/contracts/test) for the test
 * that keeps it honest against the struct's actual compiled shape. Read the deployed
 * contract's `ROUTING_TYPEHASH()` and compare against this constant before proving — a
 * mismatch means this SDK build and that specific RelaySwaps deployment disagree on
 * SwapRouting's shape (RC-32).
 */
export const RELAY_SWAP_ROUTING_TYPEHASH: Hex =
    "0xe11f9c010588c4c3c1b43d85f2825f9bb06ba076295d1e7b89d5e0a8b3ad1f7e";
