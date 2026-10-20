import { decodeAbiParameters, encodeAbiParameters } from "viem";
import type { Address, Hex } from "viem";
import { Bytes } from "./types";

// keccak256 of SwapRouting's EIP-712-style encodeType string, mirroring
// RelaySwaps.ROUTING_TYPEHASH() -- see that function's NatSpec (RelaySwaps.sol,
// packages/swaps/contracts) for the string this hashes, and RoutingLayout.t.sol
// (packages/swaps/contracts/test) for the test that keeps it honest against the
// struct's actual compiled shape. RoutingLayoutBootValidator reads the configured
// RelaySwaps' on-chain ROUTING_TYPEHASH() at boot and compares it against this
// constant, refusing to start if they disagree (RC-32). Independently maintained
// from the SDK's identically-named constant (packages/sdk/src/constant/
// PoolSessionTransact.ts) -- same reason relaySwapRoutingParams below duplicates
// the SDK's RELAY_SWAP_ROUTING_ABI rather than importing it (see
// swap_routing_abi.golden.spec.ts). Cross-checked there too.
export const RELAY_SWAP_ROUTING_TYPEHASH: Hex =
    "0xe11f9c010588c4c3c1b43d85f2825f9bb06ba076295d1e7b89d5e0a8b3ad1f7e";

// RC-10: opt-in cross-chain "dust rescue", carried inside SwapRouting purely so it
// inherits the struct's existing proof-context binding — RelaySwaps.sol itself never
// reads these fields. chainId === 0n means no dust rescue was requested. Mirrors the
// SDK's StealthRecipientIdentifier discriminated union flattened for ABI encoding:
// viewingPubKey is empty unless isCanonical is true.
export interface RoutingDustRescue {
    chainId: bigint;
    tokenId: Address;
    isCanonical: boolean;
    spendingPubKey: Bytes;
    viewingPubKey: Bytes;
}

export interface RelaySwapRouting {
    swapTarget: Address;
    approvalAddress: Address;
    outputToken: Address;
    recipient: Address;
    feeRecipient: Address;
    fallbackAddress: Address;
    dustRecipient: Address;
    feeAmount: bigint;
    minOutputAmount: bigint;
    nativeGas: bigint;
    // B2 — self-funded bridge msg.value (Mainnet-destination reshield). All three are 0 /
    // "0x" on every other path; see RelaySwaps.sol SwapRouting NatSpec.
    swapValue: bigint;
    gasSwapMaxInput: bigint;
    gasSwapCalldata: Bytes;
    swapCalldata: Bytes;
    dustRescue: RoutingDustRescue;
}

const dustRescueComponent = {
    name: "dustRescue",
    type: "tuple",
    components: [
        { name: "chainId", type: "uint256" },
        { name: "tokenId", type: "address" },
        { name: "isCanonical", type: "bool" },
        { name: "spendingPubKey", type: "bytes" },
        { name: "viewingPubKey", type: "bytes" },
    ],
} as const;

const relaySwapRoutingParams = [
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
            { name: "swapValue", type: "uint256" },
            { name: "gasSwapMaxInput", type: "uint256" },
            { name: "gasSwapCalldata", type: "bytes" },
            { name: "swapCalldata", type: "bytes" },
            dustRescueComponent,
        ],
    },
] as const;

export function encodeRelaySwapRouting(r: RelaySwapRouting): Bytes {
    return encodeAbiParameters(relaySwapRoutingParams, [r]);
}

export function decodeRelaySwapRouting(data: Bytes): RelaySwapRouting {
    return decodeAbiParameters(relaySwapRoutingParams, data)[0];
}
