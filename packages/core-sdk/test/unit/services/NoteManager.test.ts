import { beforeEach, describe, expect, it } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    Label,
    Note,
    NoteManagerExport,
    Secret,
} from "../../../src/internal.js";
import {
    InMemoryStorageService,
    InvalidLineageError,
    InvalidNoteError,
    InvalidStatusTransitionError,
    NoteConflictError,
    NoteManager,
    NoteNotFoundError,
    NoteStatus,
    NoteStorageAdapter,
} from "../../../src/internal.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const LABEL_A =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as unknown as Label;
const LABEL_B =
    "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as unknown as Label;
const TOKEN_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const TOKEN_DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F" as Address;
const OWNER = "0x5678567856785678567856785678567856785678" as Address;

const C_ROOT_A = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;
const C_CHILD_A1 = "0x2222222222222222222222222222222222222222222222222222222222222222" as Hash;
const C_CHILD_A2 = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hash;
const C_ROOT_B = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hash;
const C_PENDING = "0x5555555555555555555555555555555555555555555555555555555555555555" as Hash;
const C_INACTIVE = "0x6666666666666666666666666666666666666666666666666666666666666666" as Hash;
const C_SPENT = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hash;

// ── Factory — always returns a fresh object ────────────────────────────────────

function makeNote(overrides: Partial<Note> & Pick<Note, "commitment" | "label">): Note {
    return {
        value: "0x64" as Hex,
        noteAddressHash:
            "0xdefadefadefadefadefadefadefadefadefadefadefadefadefadefadefadefa" as Note["noteAddressHash"],
        tokenId: TOKEN_ETH,
        status: NoteStatus.ACTIVE,
        ownerAddress: OWNER,
        noteSecret: "0xabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcdabcd" as Secret,
        isOwned: true,
        createdAtBlock: "0x1" as Hex,
        spentAtBlock: null,
        txHash: "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash,
        ...overrides,
    };
}

// Fresh notes per describe block / test — prevents cross-test mutation
let noteRootA: Note;
let noteChildA1: Note;
let noteChildA2: Note;
let noteRootB: Note;
let notePending: Note;
let noteInactive: Note;
let noteSpent: Note;

function resetNotes(): void {
    noteRootA = makeNote({ commitment: C_ROOT_A, label: LABEL_A, value: "0x64" as Hex }); // 100
    noteChildA1 = makeNote({ commitment: C_CHILD_A1, label: LABEL_A, value: "0x32" as Hex }); // 50
    noteChildA2 = makeNote({ commitment: C_CHILD_A2, label: LABEL_A, value: "0x32" as Hex }); // 50
    noteRootB = makeNote({
        commitment: C_ROOT_B,
        label: LABEL_B,
        value: "0xc8" as Hex,
        tokenId: TOKEN_DAI,
    }); // 200
    notePending = makeNote({
        commitment: C_PENDING,
        label: LABEL_A,
        value: "0x14" as Hex,
        status: NoteStatus.PENDING,
    });
    noteInactive = makeNote({
        commitment: C_INACTIVE,
        label: LABEL_A,
        value: "0x0a" as Hex,
        status: NoteStatus.INACTIVE,
    });
    noteSpent = makeNote({
        commitment: C_SPENT,
        label: LABEL_A,
        value: "0x0a" as Hex,
        status: NoteStatus.SPENT,
        spentAtBlock: "0x5" as Hex,
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("NoteManager", () => {
    let nm: NoteManager;

    beforeEach(() => {
        resetNotes();
        nm = new NoteManager({});
    });

    // ── NoteManager constructor + loadFromStorage() ───────────────────────────

    describe("NoteManager constructor + loadFromStorage()", () => {
        it("return a NoteManager instance with empty state", () => {
            const nm2 = new NoteManager({});
            expect(nm2.getAllLineages()).toEqual([]);
        });

        it("accept optional dependencies without errors", async () => {
            const nm2 = new NoteManager({}, {});
            await expect(nm2.loadFromStorage()).resolves.toBeUndefined();
            expect(nm2).toBeInstanceOf(NoteManager);
        });
    });

    // ── addNote ───────────────────────────────────────────────────────────────

    describe("addNote", () => {
        it("create a new lineage when adding first note with a label", () => {
            nm.addNote(noteRootA);
            expect(nm.getAllLineages()).toHaveLength(1);
        });

        it("store note in the lineage", () => {
            nm.addNote(noteRootA);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.notes).toHaveLength(1);
            expect(lineage.notes[0].commitment).toBe(C_ROOT_A);
        });

        it("set lineage label and tokenId from note", () => {
            nm.addNote(noteRootA);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.label).toBe(LABEL_A);
            expect(lineage.tokenId).toBe(TOKEN_ETH);
        });

        it("add note to existing lineage with same label", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.notes).toHaveLength(2);
            expect(lineage.notes[1].commitment).toBe(C_CHILD_A1);
        });

        it("add multiple notes to the same lineage", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.addNote(noteChildA2);
            expect(nm.getAllLineages()[0].notes).toHaveLength(3);
        });

        it("maintain separate lineages for different labels", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);
            expect(nm.getAllLineages()).toHaveLength(2);
        });

        it("throw InvalidNoteError for invalid commitment (not hex)", () => {
            const bad = makeNote({ commitment: "not-hex" as Hash, label: LABEL_A });
            expect(() => nm.addNote(bad)).toThrow(InvalidNoteError);
        });

        it("throw InvalidNoteError for invalid tokenId (wrong length)", () => {
            const bad = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                tokenId: "0xabc" as Address,
            });
            expect(() => nm.addNote(bad)).toThrow(InvalidNoteError);
        });

        it("throw InvalidNoteError for invalid status", () => {
            const bad = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                status: "INVALID" as NoteStatus,
            });
            expect(() => nm.addNote(bad)).toThrow(InvalidNoteError);
        });

        it("throw InvalidNoteError for invalid isOwned (not boolean)", () => {
            const bad = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                isOwned: "yes" as unknown as boolean,
            });
            expect(() => nm.addNote(bad)).toThrow(InvalidNoteError);
        });

        it("throw InvalidNoteError for missing field", () => {
            const { value: _, ...incomplete } = makeNote({ commitment: C_ROOT_A, label: LABEL_A });
            expect(() => nm.addNote(incomplete as unknown as Note)).toThrow(InvalidNoteError);
        });

        it("surface the deposit-origin note's depositSecret on the new lineage", () => {
            const DEPOSIT_SECRET =
                "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed" as Secret;
            const depositOrigin = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                depositSecret: DEPOSIT_SECRET,
            });
            nm.addNote(depositOrigin);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.depositSecret).toBe(DEPOSIT_SECRET);
        });

        it("leave depositSecret undefined when no note in the lineage carries one", () => {
            // Received-only path: notes inherited via transfer/discovery never
            // carry depositSecret on the wallet that received them.
            nm.addNote(noteRootA);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.depositSecret).toBeUndefined();
        });

        it("treat re-adding an identical note as a no-op without double-counting value", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootA);
            const lineage = nm.getAllLineages()[0];
            expect(lineage.notes).toHaveLength(1);
            expect(lineage.totalValue).toBe("0x64"); // 100, not 200
        });

        it("keep the stored status when re-adding a SPENT note as ACTIVE", () => {
            nm.addNote(noteSpent);
            const resurrected = makeNote({
                commitment: C_SPENT,
                label: LABEL_A,
                value: "0x0a" as Hex,
                status: NoteStatus.ACTIVE,
            });
            nm.addNote(resurrected);
            expect(nm.getNote(C_SPENT).status).toBe(NoteStatus.SPENT);
        });

        it("throw NoteConflictError when a different note reuses a commitment", () => {
            nm.addNote(noteRootA);
            const conflicting = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                value: "0xc8" as Hex, // different value → different identity
            });
            expect(() => nm.addNote(conflicting)).toThrow(NoteConflictError);
        });
    });

    // ── computeAggregates ─────────────────────────────────────────────────────

    describe("computeAggregates", () => {
        it("include only ACTIVE notes in activeNotes", () => {
            nm.addNote(noteRootA); // ACTIVE
            nm.addNote(notePending); // PENDING — excluded
            nm.addNote(noteSpent); // SPENT — excluded
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(1);
            expect(nm.getAllLineages()[0].activeNotes[0].commitment).toBe(C_ROOT_A);
        });

        it("compute totalValue as sum of ACTIVE note values", () => {
            nm.addNote(noteRootA); // 100
            nm.addNote(noteChildA1); // 50  →  total 150 = 0x96
            expect(nm.getAllLineages()[0].totalValue).toBe("0x96");
        });

        it("return 0x0 when no ACTIVE notes", () => {
            nm.addNote(noteSpent);
            expect(nm.getAllLineages()[0].totalValue).toBe("0x0");
        });

        it("recompute after each addNote", () => {
            nm.addNote(noteRootA);
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(1);
            nm.addNote(noteChildA1);
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(2);
        });

        it("exclude PENDING and INACTIVE notes", () => {
            nm.addNote(notePending);
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(0);
            expect(nm.getAllLineages()[0].totalValue).toBe("0x0");
        });
    });

    // ── updateNoteStatus ──────────────────────────────────────────────────────

    describe("updateNoteStatus", () => {
        it("transition INACTIVE to PENDING", () => {
            nm.addNote(noteInactive);
            nm.updateNoteStatus(C_INACTIVE, NoteStatus.PENDING);
            expect(nm.getNote(C_INACTIVE).status).toBe(NoteStatus.PENDING);
        });

        it("transition PENDING to ACTIVE", () => {
            nm.addNote(notePending);
            nm.updateNoteStatus(C_PENDING, NoteStatus.ACTIVE);
            expect(nm.getNote(C_PENDING).status).toBe(NoteStatus.ACTIVE);
        });

        it("transition ACTIVE to SPENT", () => {
            nm.addNote(noteRootA);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.SPENT);
            expect(nm.getNote(C_ROOT_A).status).toBe(NoteStatus.SPENT);
        });

        it("transition ACTIVE to EXITED", () => {
            nm.addNote(noteRootA);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.EXITED);
            expect(nm.getNote(C_ROOT_A).status).toBe(NoteStatus.EXITED);
        });

        it("transition INACTIVE to EXITED", () => {
            nm.addNote(noteInactive);
            nm.updateNoteStatus(C_INACTIVE, NoteStatus.EXITED);
            expect(nm.getNote(C_INACTIVE).status).toBe(NoteStatus.EXITED);
        });

        it("transition PENDING to EXITED", () => {
            nm.addNote(notePending);
            nm.updateNoteStatus(C_PENDING, NoteStatus.EXITED);
            expect(nm.getNote(C_PENDING).status).toBe(NoteStatus.EXITED);
        });

        it("set spentAtBlock when transitioning INACTIVE to EXITED", () => {
            nm.addNote(noteInactive);
            nm.updateNoteStatus(C_INACTIVE, NoteStatus.EXITED);
            expect(nm.getNote(C_INACTIVE).spentAtBlock).not.toBeNull();
        });

        it("set spentAtBlock when transitioning PENDING to EXITED", () => {
            nm.addNote(notePending);
            nm.updateNoteStatus(C_PENDING, NoteStatus.EXITED);
            expect(nm.getNote(C_PENDING).spentAtBlock).not.toBeNull();
        });

        it("set spentAtBlock when transitioning to SPENT", () => {
            nm.addNote(noteRootA);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.SPENT);
            expect(nm.getNote(C_ROOT_A).spentAtBlock).not.toBeNull();
        });

        it("set spentAtBlock when transitioning to EXITED", () => {
            nm.addNote(noteRootA);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.EXITED);
            expect(nm.getNote(C_ROOT_A).spentAtBlock).not.toBeNull();
        });

        it("preserve pre-set spentAtBlock when transitioning to SPENT", () => {
            const preSetBlock = "0xabc" as Hex;
            const note = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                status: NoteStatus.ACTIVE,
                spentAtBlock: preSetBlock,
            });
            nm.addNote(note);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.SPENT);
            expect(nm.getNote(C_ROOT_A).spentAtBlock).toBe(preSetBlock);
        });

        it("recompute aggregates when ACTIVE note becomes SPENT", () => {
            nm.addNote(noteRootA); // ACTIVE
            nm.addNote(noteChildA1); // ACTIVE
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(2);
            nm.updateNoteStatus(C_ROOT_A, NoteStatus.SPENT);
            expect(nm.getAllLineages()[0].activeNotes).toHaveLength(1);
        });

        it("throw CommitmentHashNotFoundError for non-existent commitmentHash", () => {
            expect(() =>
                nm.updateNoteStatus(
                    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as Hash,
                    NoteStatus.ACTIVE,
                ),
            ).toThrow(NoteNotFoundError);
        });

        it("throw InvalidStatusTransitionError for INACTIVE to ACTIVE", () => {
            nm.addNote(noteInactive);
            expect(() => nm.updateNoteStatus(C_INACTIVE, NoteStatus.ACTIVE)).toThrow(
                InvalidStatusTransitionError,
            );
        });

        it("throw InvalidStatusTransitionError for SPENT to ACTIVE", () => {
            nm.addNote(noteSpent);
            expect(() => nm.updateNoteStatus(C_SPENT, NoteStatus.ACTIVE)).toThrow(
                InvalidStatusTransitionError,
            );
        });

        it("throw InvalidStatusTransitionError for ACTIVE to INACTIVE", () => {
            nm.addNote(noteRootA);
            expect(() => nm.updateNoteStatus(C_ROOT_A, NoteStatus.INACTIVE)).toThrow(
                InvalidStatusTransitionError,
            );
        });
    });

    // ── updateNote ────────────────────────────────────────────────────────────

    describe("updateNote", () => {
        const NEW_COMMITMENT =
            "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Hash;
        const NEW_VALUE = "0x50" as Hex; // 80

        it("update commitment and value of existing note", () => {
            nm.addNote(noteRootA);
            nm.updateNote(C_ROOT_A, NEW_COMMITMENT, NEW_VALUE);

            expect(() => nm.getNote(C_ROOT_A)).toThrow(NoteNotFoundError);
            const updated = nm.getNote(NEW_COMMITMENT);
            expect(updated.commitment).toBe(NEW_COMMITMENT);
            expect(updated.value).toBe(NEW_VALUE);
        });

        it("preserve non-updated fields", () => {
            nm.addNote(noteRootA);
            nm.updateNote(C_ROOT_A, NEW_COMMITMENT, NEW_VALUE);

            const updated = nm.getNote(NEW_COMMITMENT);
            expect(updated.label).toBe(LABEL_A);
            expect(updated.tokenId).toBe(TOKEN_ETH);
            expect(updated.status).toBe(NoteStatus.ACTIVE);
            expect(updated.ownerAddress).toBe(OWNER);
        });

        it("recompute lineage aggregates after update", () => {
            nm.addNote(noteRootA); // value = 0x64 (100)
            nm.updateNote(C_ROOT_A, NEW_COMMITMENT, NEW_VALUE); // value = 0x50 (80)

            const lineage = nm.getNoteLineage(LABEL_A);
            expect(BigInt(lineage.totalValue)).toBe(80n);
        });

        it("update note commitment in lineage", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.updateNote(C_ROOT_A, NEW_COMMITMENT, NEW_VALUE);

            const lineage = nm.getNoteLineage(LABEL_A);
            expect(lineage.notes.map((n) => n.commitment)).toContain(NEW_COMMITMENT);
            expect(lineage.notes.map((n) => n.commitment)).not.toContain(C_ROOT_A);
        });

        it("throw NoteNotFoundError for unknown commitment", () => {
            expect(() =>
                nm.updateNote(
                    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as Hash,
                    NEW_COMMITMENT,
                    NEW_VALUE,
                ),
            ).toThrow(NoteNotFoundError);
        });
    });

    // ── deleteNote ────────────────────────────────────────────────────────────

    describe("deleteNote", () => {
        it("remove the note from internal storage", () => {
            nm.addNote(noteRootA);
            nm.deleteNote(C_ROOT_A);
            expect(() => nm.getNote(C_ROOT_A)).toThrow(NoteNotFoundError);
        });

        it("remove the note from its lineage", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.deleteNote(C_ROOT_A);

            const lineage = nm.getNoteLineage(LABEL_A);
            expect(lineage.notes.map((n) => n.commitment)).not.toContain(C_ROOT_A);
            expect(lineage.notes.map((n) => n.commitment)).toContain(C_CHILD_A1);
        });

        it("drop the lineage entirely when its last note is deleted", () => {
            nm.addNote(noteRootA);
            nm.deleteNote(C_ROOT_A);

            expect(nm.getAllLineages()).toHaveLength(0);
        });

        it("recompute lineage aggregates after delete", () => {
            nm.addNote(noteRootA); // 100
            nm.addNote(noteChildA1); // 50
            nm.deleteNote(C_ROOT_A);

            const lineage = nm.getNoteLineage(LABEL_A);
            expect(BigInt(lineage.totalValue)).toBe(50n);
        });

        it("throw NoteNotFoundError for unknown commitment", () => {
            expect(() =>
                nm.deleteNote(
                    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as Hash,
                ),
            ).toThrow(NoteNotFoundError);
        });
    });

    // ── getNote ───────────────────────────────────────────────────────────────

    describe("getNote", () => {
        it("return the correct note by commitment", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);
            expect(nm.getNote(C_ROOT_A).commitment).toBe(C_ROOT_A);
        });

        it("return note added to existing lineage", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            expect(nm.getNote(C_CHILD_A1).commitment).toBe(C_CHILD_A1);
        });

        it("throw CommitmentHashNotFoundError for non-existent commitmentHash", () => {
            expect(() =>
                nm.getNote(
                    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as Hash,
                ),
            ).toThrow(NoteNotFoundError);
        });
    });

    // ── getNotes ──────────────────────────────────────────────────────────────

    describe("getNotes", () => {
        beforeEach(() => {
            nm.addNote(noteRootA); // ACTIVE, LABEL_A, TOKEN_ETH, 100
            nm.addNote(notePending); // PENDING, LABEL_A, TOKEN_ETH
            nm.addNote(noteRootB); // ACTIVE, LABEL_B, TOKEN_DAI
        });

        it("return all notes when no filters provided", () => {
            expect(nm.getNotes()).toHaveLength(3);
        });

        it("filter by status ACTIVE", () => {
            const active = nm.getNotes({ status: NoteStatus.ACTIVE });
            expect(active).toHaveLength(2);
            expect(active.every((n) => n.status === NoteStatus.ACTIVE)).toBe(true);
        });

        it("filter by status PENDING", () => {
            expect(nm.getNotes({ status: NoteStatus.PENDING })).toHaveLength(1);
        });

        it("filter by label", () => {
            const labelA = nm.getNotes({ label: LABEL_A });
            expect(labelA).toHaveLength(2);
            expect(labelA.every((n) => n.label === LABEL_A)).toBe(true);
        });

        it("filter by tokenId", () => {
            const dai = nm.getNotes({ tokenId: TOKEN_DAI });
            expect(dai).toHaveLength(1);
            expect(dai[0].commitment).toBe(C_ROOT_B);
        });

        it("apply AND logic for multiple filters", () => {
            const result = nm.getNotes({ status: NoteStatus.ACTIVE, label: LABEL_A });
            expect(result).toHaveLength(1);
            expect(result[0].commitment).toBe(C_ROOT_A);
        });

        it("return empty array when no notes match filters", () => {
            expect(nm.getNotes({ status: NoteStatus.EXITED })).toEqual([]);
        });
    });

    // ── getNoteLineage ────────────────────────────────────────────────────────

    describe("getNoteLineage", () => {
        it("return the correct lineage by label", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);
            const lineage = nm.getNoteLineage(LABEL_A);
            expect(lineage.label).toBe(LABEL_A);
            expect(lineage.notes[0].commitment).toBe(C_ROOT_A);
        });

        it("throw InvalidLineageError for non-existent label", () => {
            expect(() =>
                nm.getNoteLineage(
                    "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as unknown as Label,
                ),
            ).toThrow(InvalidLineageError);
        });
    });

    // ── getAllLineages ────────────────────────────────────────────────────────

    describe("getAllLineages", () => {
        it("return empty array when no lineages", () => {
            expect(nm.getAllLineages()).toEqual([]);
        });

        it("return all lineages", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);
            expect(nm.getAllLineages()).toHaveLength(2);
        });

        it("return lineage objects with correct labels", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);
            const labels = nm.getAllLineages().map((l) => l.label);
            expect(labels).toContain(LABEL_A);
            expect(labels).toContain(LABEL_B);
        });
    });

    // ── exportState ───────────────────────────────────────────────────────────

    describe("exportState", () => {
        it("export all notes", () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.addNote(noteRootB);
            expect(nm.exportState().notes).toHaveLength(3);
        });

        it("export syncCursor as 0x0 initially", () => {
            expect(nm.exportState().syncCursor).toBe("0x0");
        });

        it("return empty notes when no data", () => {
            const exported = nm.exportState();
            expect(exported.notes).toEqual([]);
        });
    });

    // ── importState ───────────────────────────────────────────────────────────

    describe("importState", () => {
        it("restore all notes after import", async () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.addNote(noteRootB);
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            expect(nm2.getNotes()).toHaveLength(3);
        });

        it("restore lineage structure", async () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            const lineage = nm2.getNoteLineage(LABEL_A);
            expect(lineage.notes).toHaveLength(2);
            expect(lineage.notes.map((n) => n.commitment)).toContain(C_ROOT_A);
            expect(lineage.notes.map((n) => n.commitment)).toContain(C_CHILD_A1);
        });

        it("clear previous state before importing", async () => {
            nm.addNote(noteRootA);
            nm.addNote(noteRootB);

            const nm2 = new NoteManager({});
            nm2.addNote(noteChildA1);
            await nm2.importState(nm.exportState());

            const labels = nm2.getAllLineages().map((l) => l.label);
            expect(labels).toContain(LABEL_A);
            expect(labels).toContain(LABEL_B);
            expect(nm2.getAllLineages()).toHaveLength(2);
        });

        it("restore syncCursor", async () => {
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            expect(nm2.exportState().syncCursor).toBe("0x0");
        });

        it("round-trip export → import → export produces identical output", async () => {
            nm.addNote(noteRootA);
            nm.addNote(noteChildA1);
            nm.addNote(noteRootB);
            const first = nm.exportState();

            const nm2 = new NoteManager({});
            await nm2.importState(first);
            const second = nm2.exportState();

            expect(second.notes).toHaveLength(first.notes.length);
            expect(second.syncCursor).toBe(first.syncCursor);
        });

        it("recompute aggregates after import", async () => {
            nm.addNote(noteRootA); // ACTIVE 100
            nm.addNote(noteChildA1); // ACTIVE 50
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            const lineage = nm2.getNoteLineage(LABEL_A);
            expect(lineage.activeNotes).toHaveLength(2);
            expect(lineage.totalValue).toBe("0x96"); // 150
        });

        it("preserve depositSecret on the lineage when one of the imported notes originated it", async () => {
            const DEPOSIT_SECRET =
                "0xfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeedfeed" as Secret;
            const depositOrigin = makeNote({
                commitment: C_ROOT_A,
                label: LABEL_A,
                depositSecret: DEPOSIT_SECRET,
            });
            nm.addNote(depositOrigin);
            nm.addNote(noteChildA1); // sibling without depositSecret
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            expect(nm2.getNoteLineage(LABEL_A).depositSecret).toBe(DEPOSIT_SECRET);
        });

        it("leave depositSecret undefined when no imported note in the lineage carries one", async () => {
            nm.addNote(noteRootA);
            const nm2 = new NoteManager({});
            await nm2.importState(nm.exportState());
            expect(nm2.getNoteLineage(LABEL_A).depositSecret).toBeUndefined();
        });

        it("reset both cursor and notes when legacy export is missing syncCursor", async () => {
            // syncCursor missing but notes present: cursor and notes are
            // coupled — a kept note with a reset cursor would leave scan
            // window excluding everything before its block. Full reset keeps
            // them consistent and lets catch-all discovery repopulate.
            const nm2 = new NoteManager({});
            const legacy = { notes: [noteRootA] } as unknown as NoteManagerExport;
            await expect(nm2.importState(legacy)).resolves.toBeUndefined();
            expect(nm2.getSyncCursor()).toBe("0x0");
            expect(nm2.getNotes()).toHaveLength(0);
        });

        it("reset cursor to 0 when legacy export has notes undefined", async () => {
            // Cursor present but notes missing: kept cursor would skip past
            // the window where the lost notes were created. Reset both.
            const nm2 = new NoteManager({});
            const legacy = {
                syncCursor: "0x10",
                notes: undefined,
            } as unknown as NoteManagerExport;
            await expect(nm2.importState(legacy)).resolves.toBeUndefined();
            expect(nm2.getSyncCursor()).toBe("0x0");
            expect(nm2.getNotes()).toHaveLength(0);
        });

        it("reject an import whose note fails schema validation", async () => {
            // A forged/corrupt export must not enter state — a malformed status would crash later
            // discovery (audit #48).
            const nm2 = new NoteManager({});
            const bad = {
                syncCursor: "0x10",
                notes: [{ ...noteRootA, status: "BOGUS" }],
            } as unknown as NoteManagerExport;
            await expect(nm2.importState(bad)).rejects.toThrow(InvalidNoteError);
        });

        it("reject an import whose syncCursor is not hex", async () => {
            const nm2 = new NoteManager({});
            const bad = { syncCursor: "not-hex", notes: [] } as unknown as NoteManagerExport;
            await expect(nm2.importState(bad)).rejects.toThrow(InvalidNoteError);
        });
    });

    // ── persistence ───────────────────────────────────────────────────────────

    describe("persistence", () => {
        it("load notes persisted by a previous instance on loadFromStorage()", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );
            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            nm1.addNote(noteRootA);
            await nm1.flush();

            const nm2 = new NoteManager({}, { storageAdapter: adapter });
            await nm2.loadFromStorage();
            expect(nm2.getNote(C_ROOT_A)).toMatchObject({ commitment: C_ROOT_A });
        });

        it("flush() writes state to the adapter immediately", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );
            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            nm1.addNote(noteRootA);
            await nm1.flush();

            const state = await adapter.getState();
            expect(state).not.toBeNull();
            expect(state!.notes.some((n) => n.commitment === C_ROOT_A)).toBe(true);
        });

        it("work with no adapter (InMemoryStorageService default — state not shared)", () => {
            const nm1 = new NoteManager({});
            nm1.addNote(noteRootA);

            const nm2 = new NoteManager({});
            expect(() => nm2.getNote(C_ROOT_A)).toThrow(NoteNotFoundError);
        });

        it("persist state through importState() with overwrite: true", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );

            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            nm1.addNote(noteRootA);
            const exported = nm1.exportState();

            const nm2 = new NoteManager({}, { storageAdapter: adapter });
            await nm2.loadFromStorage();
            await nm2.importState(exported, { overwrite: true });

            const nm3 = new NoteManager({}, { storageAdapter: adapter });
            await nm3.loadFromStorage();
            expect(nm3.getNote(C_ROOT_A)).toMatchObject({ commitment: C_ROOT_A });
        });

        it("not write to storage when importState() is called without overwrite flag", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );

            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            nm1.addNote(noteRootA);
            await nm1.flush();

            const nm2 = new NoteManager({}, { storageAdapter: adapter });
            await nm2.loadFromStorage();
            await nm2.importState({ notes: [], syncCursor: "0x0" as Hex });

            // Storage should still have the state written by nm1 (nm2 did not overwrite it)
            const nm3 = new NoteManager({}, { storageAdapter: adapter });
            await nm3.loadFromStorage();
            expect(nm3.getNote(C_ROOT_A)).toMatchObject({ commitment: C_ROOT_A });
        });

        it("persist syncCursor through importState() with overwrite: true", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );

            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            nm1.addNote(noteRootA);
            await nm1.importState(
                {
                    notes: [{ ...noteRootA }],
                    syncCursor: "0xabc" as Hex,
                },
                { overwrite: true },
            );

            const nm2 = new NoteManager({}, { storageAdapter: adapter });
            await nm2.loadFromStorage();
            expect(nm2.exportState().syncCursor).toBe("0xabc");
        });

        it("load syncCursor persisted by a previous instance on loadFromStorage()", async () => {
            const adapter = new NoteStorageAdapter(
                1,
                new InMemoryStorageService(),
                "0x0000000000000000000000000000000000000001",
            );

            const nm1 = new NoteManager({}, { storageAdapter: adapter });
            await nm1.loadFromStorage();
            await nm1.importState({ notes: [], syncCursor: "0x7b" as Hex }, { overwrite: true });

            const nm2 = new NoteManager({}, { storageAdapter: adapter });
            await nm2.loadFromStorage();
            expect(nm2.exportState().syncCursor).toBe("0x7b");
        });
    });
});
