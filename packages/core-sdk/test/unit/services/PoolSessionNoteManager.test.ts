import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AddNoteParams,
    Address,
    Hash,
    Hex,
    INoteManager,
    IPoolVaultInteractor,
    Label,
    MarkNoteExitedParams,
    MarkNoteSpentParams,
    Note,
    PendingNote,
    PoolSessionNoteManagerConfig,
    Secret,
} from "../../../src/internal.js";
import {
    AddressSchema,
    InvalidAddNoteParams,
    InvalidMarkNoteExitedParams,
    InvalidMarkNoteSpentParams,
    InvalidStatusTransitionError,
    NoteCommitmentNotMined,
    NoteNotFoundError,
    NoteStatus,
    PoolSessionNoteManager,
} from "../../../src/internal.js";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;
const COMMITMENT_A = "0x3333333333333333333333333333333333333333333333333333333333333333" as Hash;
const COMMITMENT_B = "0x4444444444444444444444444444444444444444444444444444444444444444" as Hash;
const NOTE_ADDRESS_HASH =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Hash;
const LABEL = "0x6666666666666666666666666666666666666666666666666666666666666666" as Label;
const NOTE_SECRET = "0x7777777777777777777777777777777777777777777777777777777777777777" as Secret;
const VALUE = "0x0de0b6b3a7640000" as Hex;
const TX_HASH_A = "0x8888888888888888888888888888888888888888888888888888888888888888" as Hash;
const TX_HASH_B = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash;
const CREATED_AT_BLOCK_A = "0x1234" as Hex;
const CREATED_AT_BLOCK_B = "0x5678" as Hex;
const SPENT_AT_BLOCK = "0xabcd" as Hex;
const EXITED_AT_BLOCK = "0xef01" as Hex;

function buildPendingNote(overrides: Partial<PendingNote> = {}): PendingNote {
    return {
        noteAddressHash: NOTE_ADDRESS_HASH,
        commitment: COMMITMENT_A,
        value: VALUE,
        tokenId: TOKEN,
        label: LABEL,
        status: NoteStatus.PENDING,
        ownerAddress: OWNER,
        noteSecret: NOTE_SECRET,
        isOwned: true,
        ...overrides,
    };
}

function buildActiveNote(overrides: Partial<Note> = {}): Note {
    return {
        ...buildPendingNote(),
        status: NoteStatus.ACTIVE,
        createdAtBlock: CREATED_AT_BLOCK_A,
        spentAtBlock: null,
        txHash: TX_HASH_A,
        ...overrides,
    };
}

function buildPoolVaultInteractorByCommitment(
    map: Record<string, Hex | null>,
): IPoolVaultInteractor {
    return {
        getCommitmentTimestamp: vi.fn(async (c: Hash) => {
            const value = map[c.toLowerCase()];
            return (value === null || value === undefined ? "0x0" : value) as Hex;
        }),
    } as unknown as IPoolVaultInteractor;
}

function buildNoteManager(overrides: Partial<INoteManager> = {}): INoteManager {
    return {
        addNote: vi.fn(),
        updateNoteStatus: vi.fn(),
        deleteNote: vi.fn(),
        updateNote: vi.fn(),
        getNotes: vi.fn(),
        getNote: vi.fn(),
        getNoteLineage: vi.fn(),
        getAllLineages: vi.fn(),
        computeAggregates: vi.fn(),
        getSyncCursor: vi.fn(),
        setSyncCursor: vi.fn(),
        exportState: vi.fn(),
        importState: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        loadFromStorage: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as unknown as INoteManager;
}

describe("PoolSessionNoteManager", () => {
    let noteManager: INoteManager;
    let poolVaultInteractor: IPoolVaultInteractor;
    let config: PoolSessionNoteManagerConfig;
    let service: PoolSessionNoteManager;

    beforeEach(() => {
        noteManager = buildNoteManager();
        poolVaultInteractor = buildPoolVaultInteractorByCommitment({
            [COMMITMENT_A.toLowerCase()]: CREATED_AT_BLOCK_A,
            [COMMITMENT_B.toLowerCase()]: CREATED_AT_BLOCK_B,
        });
        config = { noteManager, poolVaultInteractor, addressSchema: AddressSchema };
        service = new PoolSessionNoteManager(config);
    });

    describe("addNotes", () => {
        it("register a single pending note with resolved createdAtBlock and PENDING status", async () => {
            const pendingNote = buildPendingNote();
            const params: AddNoteParams[] = [{ pendingNote, txHash: TX_HASH_A }];

            await service.addNotes(params);

            expect(noteManager.addNote).toHaveBeenCalledTimes(1);
            expect(noteManager.addNote).toHaveBeenCalledWith({
                ...pendingNote,
                status: NoteStatus.PENDING,
                createdAtBlock: CREATED_AT_BLOCK_A,
                spentAtBlock: null,
                txHash: TX_HASH_A,
            });
            expect(noteManager.flush).toHaveBeenCalledTimes(1);
        });

        it("register multiple notes in a single batch with one flush", async () => {
            const params: AddNoteParams[] = [
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_A }), txHash: TX_HASH_A },
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_B }), txHash: TX_HASH_B },
            ];

            await service.addNotes(params);

            expect(noteManager.addNote).toHaveBeenCalledTimes(2);
            expect(noteManager.addNote).toHaveBeenNthCalledWith(1, {
                ...params[0].pendingNote,
                status: NoteStatus.PENDING,
                createdAtBlock: CREATED_AT_BLOCK_A,
                spentAtBlock: null,
                txHash: TX_HASH_A,
            });
            expect(noteManager.addNote).toHaveBeenNthCalledWith(2, {
                ...params[1].pendingNote,
                status: NoteStatus.PENDING,
                createdAtBlock: CREATED_AT_BLOCK_B,
                spentAtBlock: null,
                txHash: TX_HASH_B,
            });
            expect(noteManager.flush).toHaveBeenCalledTimes(1);
        });

        it("resolve commitment timestamps in parallel across the batch", async () => {
            const resolveOrder: string[] = [];
            poolVaultInteractor = {
                getCommitmentTimestamp: vi.fn(async (c: Hash) => {
                    resolveOrder.push(`start:${c}`);
                    await new Promise((r) => setTimeout(r, 10));
                    resolveOrder.push(`end:${c}`);
                    return (c === COMMITMENT_A ? CREATED_AT_BLOCK_A : CREATED_AT_BLOCK_B) as Hex;
                }),
            } as unknown as IPoolVaultInteractor;
            service = new PoolSessionNoteManager({ noteManager, poolVaultInteractor, addressSchema: AddressSchema });

            const params: AddNoteParams[] = [
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_A }), txHash: TX_HASH_A },
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_B }), txHash: TX_HASH_B },
            ];

            await service.addNotes(params);

            // Parallel: both starts emit before either end.
            expect(resolveOrder.slice(0, 2)).toEqual([
                `start:${COMMITMENT_A}`,
                `start:${COMMITMENT_B}`,
            ]);
        });

        it("no-op without flush on empty array", async () => {
            await service.addNotes([]);

            expect(noteManager.addNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("reject pendingNote with isOwned=false at the schema boundary", async () => {
            const params: AddNoteParams[] = [
                { pendingNote: buildPendingNote({ isOwned: false }), txHash: TX_HASH_A },
            ];

            await expect(service.addNotes(params)).rejects.toBeInstanceOf(InvalidAddNoteParams);
            expect(noteManager.addNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("throw InvalidAddNoteParams on first malformed entry without applying any mutation", async () => {
            const params = [
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_A }), txHash: TX_HASH_A },
                {
                    pendingNote: buildPendingNote({ commitment: COMMITMENT_B }),
                    txHash: "not-a-hex" as Hash,
                },
            ] as AddNoteParams[];

            await expect(service.addNotes(params)).rejects.toBeInstanceOf(InvalidAddNoteParams);
            expect(noteManager.addNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("throw NoteCommitmentNotMined when any commitment's timestamp cannot be resolved", async () => {
            poolVaultInteractor = buildPoolVaultInteractorByCommitment({
                [COMMITMENT_A.toLowerCase()]: CREATED_AT_BLOCK_A,
                [COMMITMENT_B.toLowerCase()]: null,
            });
            service = new PoolSessionNoteManager({ noteManager, poolVaultInteractor, addressSchema: AddressSchema });

            const params: AddNoteParams[] = [
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_A }), txHash: TX_HASH_A },
                { pendingNote: buildPendingNote({ commitment: COMMITMENT_B }), txHash: TX_HASH_B },
            ];

            await expect(service.addNotes(params)).rejects.toBeInstanceOf(NoteCommitmentNotMined);
            expect(noteManager.addNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("propagate downstream NoteManager errors without flushing", async () => {
            const downstream = new Error("downstream rejection");
            (noteManager.addNote as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw downstream;
            });

            const params: AddNoteParams[] = [
                { pendingNote: buildPendingNote(), txHash: TX_HASH_A },
            ];

            await expect(service.addNotes(params)).rejects.toBe(downstream);
            expect(noteManager.flush).not.toHaveBeenCalled();
        });
    });

    describe("markNotesSpent", () => {
        beforeEach(() => {
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) =>
                buildActiveNote({ commitment: c }),
            );
        });

        it("transition every batch entry to SPENT with its caller-supplied spentAtBlock", async () => {
            const params: MarkNoteSpentParams[] = [
                { commitment: COMMITMENT_A, spentAtBlock: SPENT_AT_BLOCK },
                { commitment: COMMITMENT_B, spentAtBlock: SPENT_AT_BLOCK },
            ];

            await service.markNotesSpent(params);

            expect(noteManager.updateNoteStatus).toHaveBeenCalledTimes(2);
            expect(noteManager.updateNoteStatus).toHaveBeenNthCalledWith(
                1,
                COMMITMENT_A,
                NoteStatus.SPENT,
                SPENT_AT_BLOCK,
            );
            expect(noteManager.updateNoteStatus).toHaveBeenNthCalledWith(
                2,
                COMMITMENT_B,
                NoteStatus.SPENT,
                SPENT_AT_BLOCK,
            );
            expect(noteManager.flush).toHaveBeenCalledTimes(1);
        });

        it("no-op without flush on empty array", async () => {
            await service.markNotesSpent([]);

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("throw InvalidMarkNoteSpentParams on malformed entry without mutation", async () => {
            const params = [
                { commitment: "not-a-hex" as Hash, spentAtBlock: SPENT_AT_BLOCK },
            ] as MarkNoteSpentParams[];

            await expect(service.markNotesSpent(params)).rejects.toBeInstanceOf(
                InvalidMarkNoteSpentParams,
            );
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("propagate NoteNotFoundError when any commitment is missing, no mutation", async () => {
            const missing = new NoteNotFoundError(COMMITMENT_B);
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) => {
                if (c === COMMITMENT_B) throw missing;
                return buildActiveNote({ commitment: c });
            });

            const params: MarkNoteSpentParams[] = [
                { commitment: COMMITMENT_A, spentAtBlock: SPENT_AT_BLOCK },
                { commitment: COMMITMENT_B, spentAtBlock: SPENT_AT_BLOCK },
            ];

            await expect(service.markNotesSpent(params)).rejects.toBe(missing);
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("reject when any note is not ACTIVE without mutating any", async () => {
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) =>
                c === COMMITMENT_B
                    ? buildActiveNote({ commitment: c, status: NoteStatus.PENDING })
                    : buildActiveNote({ commitment: c }),
            );

            const params: MarkNoteSpentParams[] = [
                { commitment: COMMITMENT_A, spentAtBlock: SPENT_AT_BLOCK },
                { commitment: COMMITMENT_B, spentAtBlock: SPENT_AT_BLOCK },
            ];

            await expect(service.markNotesSpent(params)).rejects.toBeInstanceOf(
                InvalidStatusTransitionError,
            );
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });
    });

    describe("markNotesExited", () => {
        beforeEach(() => {
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) =>
                buildActiveNote({ commitment: c }),
            );
        });

        // EXIT_PENDING, not EXITED: the caller supplies the block and the SDK cannot
        // verify it is settled, or that the exit happened at all. EXITED has no way
        // back, so accepting one on trust would let a caller irreversibly retire a
        // note the user still owns. Discovery promotes it once the chain shows the
        // ragequit at a final block.
        it("transition ACTIVE notes to EXIT_PENDING with the caller-supplied exitedAtBlock", async () => {
            const params: MarkNoteExitedParams[] = [
                { commitment: COMMITMENT_A, exitedAtBlock: EXITED_AT_BLOCK },
            ];

            await service.markNotesExited(params);

            expect(noteManager.updateNoteStatus).toHaveBeenCalledTimes(1);
            expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                COMMITMENT_A,
                NoteStatus.EXIT_PENDING,
                EXITED_AT_BLOCK,
            );
            expect(noteManager.flush).toHaveBeenCalledTimes(1);
        });

        it("transition REJECTED notes to EXIT_PENDING (ASP-rejected ragequit failsafe)", async () => {
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) =>
                buildActiveNote({ commitment: c, status: NoteStatus.REJECTED }),
            );

            const params: MarkNoteExitedParams[] = [
                { commitment: COMMITMENT_A, exitedAtBlock: EXITED_AT_BLOCK },
            ];

            await service.markNotesExited(params);

            expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                COMMITMENT_A,
                NoteStatus.EXIT_PENDING,
                EXITED_AT_BLOCK,
            );
            expect(noteManager.flush).toHaveBeenCalledTimes(1);
        });

        it("no-op without flush on empty array", async () => {
            await service.markNotesExited([]);

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("throw InvalidMarkNoteExitedParams on malformed entry without mutation", async () => {
            const params = [
                { commitment: COMMITMENT_A, exitedAtBlock: "not-a-hex" as Hex },
            ] as MarkNoteExitedParams[];

            await expect(service.markNotesExited(params)).rejects.toBeInstanceOf(
                InvalidMarkNoteExitedParams,
            );
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("reject PENDING source status (only ACTIVE | REJECTED → EXITED allowed)", async () => {
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation((c: Hash) =>
                buildActiveNote({ commitment: c, status: NoteStatus.PENDING }),
            );

            const params: MarkNoteExitedParams[] = [
                { commitment: COMMITMENT_A, exitedAtBlock: EXITED_AT_BLOCK },
            ];

            await expect(service.markNotesExited(params)).rejects.toBeInstanceOf(
                InvalidStatusTransitionError,
            );
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("propagate NoteNotFoundError when any commitment is missing, no mutation", async () => {
            const missing = new NoteNotFoundError(COMMITMENT_A);
            (noteManager.getNote as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw missing;
            });

            const params: MarkNoteExitedParams[] = [
                { commitment: COMMITMENT_A, exitedAtBlock: EXITED_AT_BLOCK },
            ];

            await expect(service.markNotesExited(params)).rejects.toBe(missing);
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });
    });
});
