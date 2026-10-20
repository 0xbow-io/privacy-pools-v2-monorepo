import { encodeAbiParameters, keccak256 } from "viem";
import { describe, expect, it } from "vitest";

import type { Address, Hex, NoteData } from "../../../src/internal.js";
import { BN254_SCALAR_MODULUS, RELAY_SWAP_ROUTING_ABI } from "../../../src/internal.js";

/**
 * SDK-side mirror of the swap proof-binding property.
 *
 * IMPORTANT — honesty note: this is a CONTEXT-HASH-level test, NOT a real Groth16
 * proof test. It re-implements, in TypeScript, the exact context computation the
 * on-chain pool enforces (PoolVault.sol:147, mirrored by
 * TransactOrchestrator.computeTransactContext):
 *
 *     context = keccak256(abi.encode(TransactParams{processor,data}, NoteData[]))
 *               % SNARK_SCALAR_FIELD
 *
 * where `data = abi.encode(SwapRouting)` embeds all 11 routing fields (including
 * the LiFi swapCalldata). The real end-to-end tamper-rejection (through
 * RelaySwaps.execute against a context-enforcing pool) lives in the Solidity
 * suite `packages/swaps/contracts/test/RelaySwapsProofBinding.t.sol`, and the
 * real-Groth16 tamper is gated to the skipIf integration suite. This test closes
 * the per-field coverage gap at the hash layer only: it proves that mutating ANY
 * single routing field (or the note data) changes the proof-bound context, so a
 * proof generated over the honest routing would fail the pool's context check.
 */

const SNARK_SCALAR_FIELD = BN254_SCALAR_MODULUS;

const SWAP_TARGET = "0x1111111111111111111111111111111111111111" as Address;
const APPROVAL_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;
const OUTPUT_TOKEN = "0x3333333333333333333333333333333333333333" as Address;
const RECIPIENT = "0x4444444444444444444444444444444444444444" as Address;
const FEE_RECIPIENT = "0x5555555555555555555555555555555555555555" as Address;
const FALLBACK_ADDRESS = "0x6666666666666666666666666666666666666666" as Address;
const DUST_RECIPIENT = "0x7777777777777777777777777777777777777777" as Address;
const SWAP_CALLDATA = "0xdeadbeef" as Hex;
const OTHER_ADDRESS = "0x9999999999999999999999999999999999999999" as Address;

interface SwapRouting {
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
    swapValue: bigint;
    gasSwapMaxInput: bigint;
    gasSwapCalldata: Hex;
    swapCalldata: Hex;
    // RC-10: carried purely to inherit this struct's context binding — see
    // packages/swaps/contracts/test/RelaySwapsProofBinding.t.sol's
    // test_RevertWhen_DustRescueTampered for the real on-chain proof of this.
    dustRescue: {
        chainId: bigint;
        tokenId: Address;
        isCanonical: boolean;
        spendingPubKey: Hex;
        viewingPubKey: Hex;
    };
}

const PROCESSOR = "0x8888888888888888888888888888888888888888" as Address;

const TRANSACT_PARAMS_ABI = [
    {
        type: "tuple",
        components: [
            { name: "processor", type: "address" },
            { name: "data", type: "bytes" },
        ],
    },
    {
        type: "tuple[]",
        components: [
            { name: "hint", type: "bytes32" },
            { name: "data", type: "bytes" },
        ],
    },
] as const;

function honestRouting(): SwapRouting {
    return {
        swapTarget: SWAP_TARGET,
        approvalAddress: APPROVAL_ADDRESS,
        outputToken: OUTPUT_TOKEN,
        recipient: RECIPIENT,
        feeRecipient: FEE_RECIPIENT,
        fallbackAddress: FALLBACK_ADDRESS,
        dustRecipient: DUST_RECIPIENT,
        feeAmount: 10n,
        minOutputAmount: 1_000_000n,
        nativeGas: 0n,
        swapValue: 0n,
        gasSwapMaxInput: 0n,
        gasSwapCalldata: "0x" as Hex,
        swapCalldata: SWAP_CALLDATA,
        dustRescue: {
            chainId: 0n,
            tokenId: "0x0000000000000000000000000000000000000000" as Address,
            isCanonical: false,
            spendingPubKey: "0x" as Hex,
            viewingPubKey: "0x" as Hex,
        },
    };
}

/** Reduced context hash bound into the ZK proof — mirror of PoolVault.sol:147. */
function contextOf(routing: SwapRouting, noteData: NoteData[]): bigint {
    const data = encodeAbiParameters(RELAY_SWAP_ROUTING_ABI, [routing]);
    const encoded = encodeAbiParameters(TRANSACT_PARAMS_ABI, [
        { processor: PROCESSOR, data },
        noteData,
    ]);
    return BigInt(keccak256(encoded)) % SNARK_SCALAR_FIELD;
}

// Each mutator returns a routing with exactly one field changed from honest.
const FIELD_TAMPERS: { field: string; tamper: (r: SwapRouting) => SwapRouting }[] = [
    { field: "swapTarget", tamper: (r) => ({ ...r, swapTarget: OTHER_ADDRESS }) },
    { field: "approvalAddress", tamper: (r) => ({ ...r, approvalAddress: OTHER_ADDRESS }) },
    { field: "outputToken", tamper: (r) => ({ ...r, outputToken: OTHER_ADDRESS }) },
    { field: "recipient", tamper: (r) => ({ ...r, recipient: OTHER_ADDRESS }) },
    { field: "feeRecipient", tamper: (r) => ({ ...r, feeRecipient: OTHER_ADDRESS }) },
    { field: "fallbackAddress", tamper: (r) => ({ ...r, fallbackAddress: OTHER_ADDRESS }) },
    { field: "dustRecipient", tamper: (r) => ({ ...r, dustRecipient: OTHER_ADDRESS }) },
    { field: "feeAmount", tamper: (r) => ({ ...r, feeAmount: r.feeAmount + 1n }) },
    {
        field: "minOutputAmount",
        tamper: (r) => ({ ...r, minOutputAmount: r.minOutputAmount + 1n }),
    },
    { field: "nativeGas", tamper: (r) => ({ ...r, nativeGas: r.nativeGas + 1n }) },
    { field: "swapValue", tamper: (r) => ({ ...r, swapValue: r.swapValue + 1n }) },
    {
        field: "gasSwapMaxInput",
        tamper: (r) => ({ ...r, gasSwapMaxInput: r.gasSwapMaxInput + 1n }),
    },
    { field: "gasSwapCalldata", tamper: (r) => ({ ...r, gasSwapCalldata: "0xc0ffee" as Hex }) },
    { field: "swapCalldata", tamper: (r) => ({ ...r, swapCalldata: "0xdeadbeff" as Hex }) },
    // RC-10: dustRescue is carried purely to inherit this same context binding.
    {
        field: "dustRescue.chainId",
        tamper: (r) => ({ ...r, dustRescue: { ...r.dustRescue, chainId: 8453n } }),
    },
];

describe("RelaySwaps proof-binding (context-hash mirror)", () => {
    it("compute a stable context for identical routing + note data", () => {
        // Determinism sanity check so the tamper assertions below are meaningful.
        expect(contextOf(honestRouting(), [])).toBe(contextOf(honestRouting(), []));
    });

    it("keep the reduced context within the BN254 scalar field", () => {
        expect(contextOf(honestRouting(), [])).toBeLessThan(SNARK_SCALAR_FIELD);
    });

    const honestContext = contextOf(honestRouting(), []);

    for (const { field, tamper } of FIELD_TAMPERS) {
        it(`reject a tampered ${field}: context hash changes`, () => {
            const tamperedContext = contextOf(tamper(honestRouting()), []);
            expect(tamperedContext).not.toBe(honestContext);
        });
    }

    it("reject tampered note data: context hash changes", () => {
        const tamperedNotes: NoteData[] = [
            {
                hint: "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex,
                data: "0x" as Hex,
            },
        ];
        expect(contextOf(honestRouting(), tamperedNotes)).not.toBe(honestContext);
    });
});
