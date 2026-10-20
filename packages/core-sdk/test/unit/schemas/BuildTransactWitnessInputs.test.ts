import { describe, expect, it } from "vitest";

import type { Address, Hash, Hex, Note, PendingNote, Secret } from "../../../src/internal.js";
import {
    BuildTransactWitnessInputsSchema,
    EMPTY_ADDRESS,
    NoteStatus,
} from "../../../src/internal.js";

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const TOKEN_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" as Address;
const VALID_LABEL = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hash;
const VALUE = "0x0000000000000000000000000000000000000000000000000de0b6b3a7640000" as Hex;
const NOTE_ADDRESS_HASH =
    "0x6666666666666666666666666666666666666666666666666666666666666666" as Hash;
const NOTE_SECRET = "0xeeee111111111111111111111111111111111111111111111111111111111111" as Secret;
const COMMITMENT = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hash;
const PRIVATE_NULLIFYING_KEY =
    "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
const PRIVATE_REVOCABLE_KEY =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex;

const INPUT_NOTE: Note = {
    noteAddressHash: NOTE_ADDRESS_HASH,
    commitment: COMMITMENT,
    value: VALUE,
    tokenId: TOKEN_USDC,
    label: VALID_LABEL,
    status: NoteStatus.ACTIVE,
    ownerAddress: VALID_OWNER,
    noteSecret: NOTE_SECRET,
    isOwned: true,
    createdAtBlock: "0x100" as Hex,
    spentAtBlock: null,
    txHash: "0x0" as Hash,
};

const CHANGE_NOTE: PendingNote = {
    noteAddressHash: NOTE_ADDRESS_HASH,
    commitment: COMMITMENT,
    value: VALUE,
    tokenId: TOKEN_USDC,
    label: VALID_LABEL,
    status: NoteStatus.PENDING,
    ownerAddress: VALID_OWNER,
    noteSecret: NOTE_SECRET,
    isOwned: true,
};

function baseInputs(): Record<string, unknown> {
    return {
        inputNotes: [INPUT_NOTE],
        changeNotes: [CHANGE_NOTE],
        recipientNotes: [],
        ownerAddress: VALID_OWNER,
        privateNullifyingKey: PRIVATE_NULLIFYING_KEY,
        privateRevocableKey: PRIVATE_REVOCABLE_KEY,
        tokenId: TOKEN_USDC,
        amountOut: "0x0" as Hex,
        tokenIdOut: EMPTY_ADDRESS,
        context: "0x0" as Hex,
        stateLeaves: [COMMITMENT],
        keystoreLeaves: [COMMITMENT],
        aspLeaves: [VALID_LABEL],
    };
}

describe("BuildTransactWitnessInputsSchema — internal-transfer invariant", () => {
    it("accept amountOut=0 with tokenIdOut=address(0) (internal transfer)", () => {
        const result = BuildTransactWitnessInputsSchema.safeParse({
            ...baseInputs(),
            amountOut: "0x0",
            tokenIdOut: EMPTY_ADDRESS,
        });
        expect(result.success).toBe(true);
    });

    it("reject amountOut=0 with non-zero tokenIdOut (matches PoolVault revert)", () => {
        const result = BuildTransactWitnessInputsSchema.safeParse({
            ...baseInputs(),
            amountOut: "0x0",
            tokenIdOut: TOKEN_USDC,
        });
        expect(result.success).toBe(false);
        if (result.success) return;
        const issue = result.error.issues.find((i) => i.path[0] === "tokenIdOut");
        expect(issue?.message).toMatch(/tokenIdOut must be zero/i);
    });

    it("accept amountOut>0 with tokenIdOut=tokenId (withdraw path)", () => {
        const result = BuildTransactWitnessInputsSchema.safeParse({
            ...baseInputs(),
            amountOut: "0x100",
            tokenIdOut: TOKEN_USDC,
        });
        expect(result.success).toBe(true);
    });

    it("accept amountOut>0 with tokenIdOut=address(0) (degenerate but not invariant-violating)", () => {
        // Schema mirrors only the on-chain invariant; it does not assert that
        // tokenIdOut must match tokenId on the withdraw branch. PoolVault
        // dispatches by tokenIdOut directly — if a caller picks address(0)
        // with amountOut > 0 the contract attempts to transfer native ETH.
        const result = BuildTransactWitnessInputsSchema.safeParse({
            ...baseInputs(),
            amountOut: "0x100",
            tokenIdOut: EMPTY_ADDRESS,
        });
        expect(result.success).toBe(true);
    });
});
