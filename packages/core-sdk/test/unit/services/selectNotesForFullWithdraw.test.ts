import { describe, expect, it } from "vitest";

import type { Address, Hash, Hex, Label, Note, Secret } from "../../../src/internal.js";
import {
    EmptyBatchSelection,
    NoteStatus,
    selectNotesForFullWithdraw,
} from "../../../src/internal.js";

const TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

function makeNote(overrides: Partial<Note> & { commitment: Hash; value: Hex; label: Label }): Note {
    return {
        noteAddressHash: "0x00" as Hash,
        tokenId: TOKEN,
        status: NoteStatus.ACTIVE,
        ownerAddress: "0x0000000000000000000000000000000000000001" as Address,
        noteSecret: "0x01" as Secret,
        isOwned: true,
        createdAtBlock: "0x1" as Hex,
        spentAtBlock: null,
        txHash: "0xab" as Hash,
        ...overrides,
    } as Note;
}

describe("selectNotesForFullWithdraw", () => {
    it("throw EmptyBatchSelection when there are no active notes", () => {
        const spent = makeNote({
            commitment: "0x1" as Hash,
            value: "0x64" as Hex,
            label: "0xaa" as Label,
            status: NoteStatus.SPENT,
        });
        expect(() =>
            selectNotesForFullWithdraw({ notes: [spent], tokenId: TOKEN, maxInputs: 5 }),
        ).toThrow(EmptyBatchSelection);
    });

    it("ignore zero-value and non-active notes", () => {
        const notes = [
            makeNote({ commitment: "0x1" as Hash, value: "0x0" as Hex, label: "0xaa" as Label }),
            makeNote({
                commitment: "0x2" as Hash,
                value: "0x64" as Hex,
                label: "0xaa" as Label,
                status: NoteStatus.PENDING,
            }),
            makeNote({ commitment: "0x3" as Hash, value: "0x64" as Hex, label: "0xaa" as Label }),
        ];
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(1);
        expect(groups[0].inputCommitments).toEqual(["0x3"]);
        expect(groups[0].amountOut).toBe(100n);
    });

    it("place all same-label notes into one group when within the input cap", () => {
        const notes = [
            makeNote({ commitment: "0x1" as Hash, value: "0x0a" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x2" as Hash, value: "0x14" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x3" as Hash, value: "0x1e" as Hex, label: "0xaa" as Label }),
        ];
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(1);
        expect(groups[0].label).toBe("0xaa");
        expect(groups[0].inputCommitments).toEqual(["0x1", "0x2", "0x3"]);
        expect(groups[0].amountOut).toBe(0x0an + 0x14n + 0x1en);
    });

    it("chunk a single lineage that exceeds maxInputs into multiple groups", () => {
        const notes = Array.from({ length: 6 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: "0xaa" as Label,
            }),
        );
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(2);
        expect(groups[0].inputCommitments).toHaveLength(5);
        expect(groups[1].inputCommitments).toHaveLength(1);
        expect(groups[0].amountOut).toBe(50n);
        expect(groups[1].amountOut).toBe(10n);
    });

    it("place exactly maxInputs same-label notes into a single full group", () => {
        // GAP-3: the exact-maxInputs boundary (5 notes -> 1 group, zero remainder);
        // existing tests bracket it (3 and 6) but skip the exact fill.
        const notes = Array.from({ length: 5 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: "0xaa" as Label,
            }),
        );
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(1);
        expect(groups[0].inputCommitments).toHaveLength(5);
        expect(groups[0].amountOut).toBe(50n);
    });

    it("partition 50 same-label notes into exactly MAX_BATCH (10) full groups", () => {
        // GAP-2 pass side: 50 notes @ maxInputs=5 -> exactly 10 groups of 5, the
        // largest selection the orchestrator/relayBatch accept (MAX_BATCH = 10).
        const notes = Array.from({ length: 50 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: "0xaa" as Label,
            }),
        );
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(10);
        for (const group of groups) {
            expect(group.inputCommitments).toHaveLength(5);
        }
    });

    it("chunk 51 same-label notes into 11 groups (one past MAX_BATCH)", () => {
        // GAP-2 chunk-overflow: selection itself never caps — it yields 11 groups
        // (10 full + 1 remainder). The MAX_BATCH rejection is the orchestrator's job
        // (BatchWithdrawOrchestrator: groups.length > MAX_BATCH -> BatchTooLarge),
        // exercised distinctly from the 11-distinct-label case.
        const notes = Array.from({ length: 51 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: "0xaa" as Label,
            }),
        );
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(11);
        expect(groups[10].inputCommitments).toHaveLength(1);
    });

    it("keep notes from different labels in separate groups", () => {
        const notes = [
            makeNote({ commitment: "0x1" as Hash, value: "0x0a" as Hex, label: "0xbb" as Label }),
            makeNote({ commitment: "0x2" as Hash, value: "0x14" as Hex, label: "0xaa" as Label }),
        ];
        const groups = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        expect(groups).toHaveLength(2);
        // Labels sorted ascending: 0xaa before 0xbb
        expect(groups[0].label).toBe("0xaa");
        expect(groups[1].label).toBe("0xbb");
    });

    it("produce a deterministic partition for the same balance", () => {
        const notes = [
            makeNote({ commitment: "0x03" as Hash, value: "0x0a" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x01" as Hash, value: "0x0a" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x02" as Hash, value: "0x0a" as Hex, label: "0xaa" as Label }),
        ];
        const a = selectNotesForFullWithdraw({ notes, tokenId: TOKEN, maxInputs: 5 });
        const b = selectNotesForFullWithdraw({
            notes: [...notes].reverse(),
            tokenId: TOKEN,
            maxInputs: 5,
        });
        expect(a).toEqual(b);
        expect(a[0].inputCommitments).toEqual(["0x01", "0x02", "0x03"]);
    });
});
