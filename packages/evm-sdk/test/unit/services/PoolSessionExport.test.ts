import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    AccountExport,
    Address,
    Hash,
    Hex,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPaymentRequestService,
    Note,
    NoteManagerExport,
    SerializedPaymentRequestRecord,
} from "../../../src/internal.js";
import {
    AccountExportMismatch,
    AddressSchema,
    EvmAddressEqualityComparator,
    EvmAddressFieldConverter,
    InvalidNoteError,
    NoteStatus,
    PoolSessionExport,
} from "../../../src/internal.js";

// ── Constants ────────────────────────────────────────────────────────────────

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const CHAIN_ID = 11155111;

const RECEIVED_NOTE: Note = {
    noteAddressHash: "0xbbbb000000000000000000000000000000000000000000000000000000000000" as Hash,
    commitment: "0xaaaa000000000000000000000000000000000000000000000000000000000000" as Hash,
    value: "0x64" as Hex,
    tokenId: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
    label: "0xdddd000000000000000000000000000000000000000000000000000000000000" as Hash,
    status: NoteStatus.ACTIVE,
    ownerAddress: OWNER,
    noteSecret: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hex,
    isOwned: true,
    createdAtBlock: "0x1" as Hex,
    spentAtBlock: "0x5" as Hex,
    txHash: "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash,
};

const MOCK_NOTE_EXPORT: NoteManagerExport = {
    notes: [
        {
            noteAddressHash: "0x0" as Hash,
            commitment:
                "0xaaaa000000000000000000000000000000000000000000000000000000000000" as Hash,
            value: "0x64" as Hex,
            tokenId: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as `0x${string}`,
            label: "0xdddd000000000000000000000000000000000000000000000000000000000000" as Hash,
            status: NoteStatus.ACTIVE,
            ownerAddress: OWNER,
            noteSecret:
                "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as `0x${string}`,
            isOwned: true,
            createdAtBlock: "0x1" as Hex,
            spentAtBlock: null,
            txHash: "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash,
        },
    ],
    syncCursor: "0xa" as Hex,
};

const MOCK_PAYMENT_REQUESTS: SerializedPaymentRequestRecord[] = [
    {
        paymentId: "0xbbbb000000000000000000000000000000000000000000000000000000000000" as Hex,
        noteAddressHashes: [
            "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hash,
        ],
        amount: "0x64" as Hex,
        tokenId: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address,
        tag: "0xeeee000000000000000000000000000000000000000000000000000000000000" as Hex,
        paymentPubKey: "0xffff000000000000000000000000000000000000000000000000000000000000" as Hex,
        noteSecretsMap: [
            [
                "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hash,
                "0xdddd000000000000000000000000000000000000000000000000000000000000" as Hex,
            ],
        ],
        recipientAddress: OWNER,
        status: "OPEN",
        createdAt: "0x1" as Hex,
        fulfilledByCommitments: [],
        consumedSlots: [],
    },
];

// ── Mock factories ───────────────────────────────────────────────────────────

function createMockNoteManager(): INoteManager {
    return {
        addNote: vi.fn(),
        updateNoteStatus: vi.fn(),
        deleteNote: vi.fn(),
        updateNote: vi.fn(),
        getNotes: vi.fn(() => []),
        getNote: vi.fn(),
        getNoteLineage: vi.fn(),
        getAllLineages: vi.fn(() => []),
        computeAggregates: vi.fn(),
        exportState: vi.fn(() => MOCK_NOTE_EXPORT),
        importState: vi.fn(),
        getSyncCursor: vi.fn(() => "0x0"),
        setSyncCursor: vi.fn(),
        flush: vi.fn(),
        loadFromStorage: vi.fn(async () => undefined),
    };
}

// Defaults to returning the values that make RECEIVED_NOTE internally
// consistent. Individual tests override a return value to force a mismatch.
function createMockNoteComputationService(): INoteComputationService {
    return {
        computeNoteAddressHash: vi.fn(() => RECEIVED_NOTE.noteAddressHash),
        computeFullCommitment: vi.fn(() => RECEIVED_NOTE.commitment),
    } as unknown as INoteComputationService;
}

function createMockPaymentRequestService(): IPaymentRequestService {
    return {
        generate: vi.fn(),
        list: vi.fn(async () => []),
        getOpenRequests: vi.fn(async () => []),
        getScannableRequests: vi.fn(async () => []),
        markScanRetired: vi.fn(async () => undefined),
        markFulfilled: vi.fn(),
        archive: vi.fn(),
        clear: vi.fn(),
        loadFromStorage: vi.fn(async () => undefined),
        exportState: vi.fn(() => MOCK_PAYMENT_REQUESTS),
        importState: vi.fn(),
    };
}

function createMockLogger(): ILogger {
    return {
        child: vi.fn().mockReturnThis(),
        level: "debug",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    } as unknown as ILogger;
}

function createSession(
    noteManager: INoteManager,
    noteComputationService: INoteComputationService,
    paymentRequestService: IPaymentRequestService,
): PoolSessionExport {
    return new PoolSessionExport({
        noteManager,
        noteComputationService,
        addressFieldConverter: new EvmAddressFieldConverter(),
        addressEqualityComparator: new EvmAddressEqualityComparator(),
        paymentRequestService,
        ownerAddress: OWNER,
        chainId: CHAIN_ID,
        addressSchema: AddressSchema,
    });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PoolSessionExport", () => {
    let noteManager: INoteManager;
    let noteComputationService: INoteComputationService;
    let paymentRequestService: IPaymentRequestService;
    let session: PoolSessionExport;

    beforeEach(() => {
        noteManager = createMockNoteManager();
        noteComputationService = createMockNoteComputationService();
        paymentRequestService = createMockPaymentRequestService();
        session = createSession(noteManager, noteComputationService, paymentRequestService);
    });

    describe("constructor", () => {
        it("initialize without errors with valid config", () => {
            expect(() =>
                createSession(noteManager, noteComputationService, paymentRequestService),
            ).not.toThrow();
        });

        it("initialize with optional logger", () => {
            const logger = createMockLogger();
            expect(
                () =>
                    new PoolSessionExport(
                        {
                            noteManager,
                            noteComputationService,
                            addressFieldConverter: new EvmAddressFieldConverter(),
                            addressEqualityComparator: new EvmAddressEqualityComparator(),
                            paymentRequestService,
                            ownerAddress: OWNER,
                            chainId: CHAIN_ID,
                            addressSchema: AddressSchema,
                        },
                        { logger },
                    ),
            ).not.toThrow();
            expect(logger.debug).toHaveBeenCalledWith("PoolSessionExport initialized");
        });
    });

    describe("exportAccount", () => {
        it("call noteManager.exportState() and paymentRequestService.exportState()", async () => {
            await session.exportAccount();
            expect(noteManager.exportState).toHaveBeenCalledOnce();
            expect(paymentRequestService.exportState).toHaveBeenCalledOnce();
        });

        it("stamp owner, chainId, and payment requests onto the note state", async () => {
            const result = await session.exportAccount();
            expect(result).toEqual({
                ...MOCK_NOTE_EXPORT,
                owner: OWNER,
                chainId: CHAIN_ID,
                paymentRequests: MOCK_PAYMENT_REQUESTS,
            });
        });

        it("call logger.debug with note and payment-request counts on success", async () => {
            const logger = createMockLogger();
            const s = new PoolSessionExport(
                {
                    noteManager,
                    noteComputationService,
                    addressFieldConverter: new EvmAddressFieldConverter(),
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    paymentRequestService,
                    ownerAddress: OWNER,
                    chainId: CHAIN_ID,
                    addressSchema: AddressSchema,
                },
                { logger },
            );
            await s.exportAccount();
            expect(logger.debug).toHaveBeenCalledWith("Account exported", {
                noteCount: 1,
                paymentRequestCount: 1,
            });
        });
    });

    describe("importAccount", () => {
        function makeExport(overrides?: Partial<AccountExport>): AccountExport {
            return {
                ...MOCK_NOTE_EXPORT,
                owner: OWNER,
                chainId: CHAIN_ID,
                paymentRequests: MOCK_PAYMENT_REQUESTS,
                ...overrides,
            };
        }

        it("call noteManager.importState() with the provided data and overwrite: true", async () => {
            const data = makeExport();
            await session.importAccount(data);
            expect(noteManager.importState).toHaveBeenCalledOnce();
            expect(noteManager.importState).toHaveBeenCalledWith(data, { overwrite: true });
        });

        it("restore payment requests via paymentRequestService.importState()", async () => {
            await session.importAccount(makeExport());
            expect(paymentRequestService.importState).toHaveBeenCalledWith(MOCK_PAYMENT_REQUESTS);
        });

        it("skip payment-request restore for a legacy blob without the field", async () => {
            await session.importAccount(makeExport({ paymentRequests: undefined }));
            expect(noteManager.importState).toHaveBeenCalledOnce();
            expect(paymentRequestService.importState).not.toHaveBeenCalled();
        });

        it("import a legacy blob with no owner or chain metadata", async () => {
            await session.importAccount(makeExport({ owner: undefined, chainId: undefined }));
            expect(noteManager.importState).toHaveBeenCalledOnce();
        });

        it("reject an export from a different owner with AccountExportMismatch", async () => {
            const data = makeExport({
                owner: "0x2222222222222222222222222222222222222222" as Address,
            });
            await expect(session.importAccount(data)).rejects.toBeInstanceOf(AccountExportMismatch);
            expect(noteManager.importState).not.toHaveBeenCalled();
        });

        it("reject an export from a different chain with AccountExportMismatch", async () => {
            await expect(session.importAccount(makeExport({ chainId: 1 }))).rejects.toBeInstanceOf(
                AccountExportMismatch,
            );
            expect(noteManager.importState).not.toHaveBeenCalled();
        });

        it("accept an owner that differs only in case", async () => {
            const data = makeExport({ owner: OWNER.toUpperCase() as Address });
            await expect(session.importAccount(data)).resolves.toBeUndefined();
            expect(noteManager.importState).toHaveBeenCalledOnce();
        });

        it("call logger.debug with note and payment-request counts on success", async () => {
            const logger = createMockLogger();
            const s = new PoolSessionExport(
                {
                    noteManager,
                    noteComputationService,
                    addressFieldConverter: new EvmAddressFieldConverter(),
                    addressEqualityComparator: new EvmAddressEqualityComparator(),
                    paymentRequestService,
                    ownerAddress: OWNER,
                    chainId: CHAIN_ID,
                    addressSchema: AddressSchema,
                },
                { logger },
            );
            await s.importAccount(makeExport());
            expect(logger.debug).toHaveBeenCalledWith("Account imported", {
                noteCount: 1,
                paymentRequestCount: 1,
            });
        });

        it("propagate errors thrown by noteManager.importState()", async () => {
            const error = new Error("Invalid lineage structure");
            (noteManager.importState as ReturnType<typeof vi.fn>).mockRejectedValue(error);

            await expect(session.importAccount(makeExport())).rejects.toThrow(
                "Invalid lineage structure",
            );
        });
    });

    describe("importReceivedNote", () => {
        it("add a consistent note with PENDING status and reset spentAtBlock", async () => {
            await session.importReceivedNote(RECEIVED_NOTE);

            expect(noteManager.addNote).toHaveBeenCalledWith({
                ...RECEIVED_NOTE,
                status: NoteStatus.PENDING,
                spentAtBlock: null,
            });
            expect(noteManager.flush).toHaveBeenCalledOnce();
        });

        it("reject a note whose owner differs from the session owner", async () => {
            const foreign = {
                ...RECEIVED_NOTE,
                ownerAddress: "0x2222222222222222222222222222222222222222" as Address,
            };

            await expect(session.importReceivedNote(foreign)).rejects.toThrow(InvalidNoteError);
            expect(noteManager.addNote).not.toHaveBeenCalled();
        });

        it("reject a note whose noteAddressHash does not match owner and secret", async () => {
            (
                noteComputationService.computeNoteAddressHash as ReturnType<typeof vi.fn>
            ).mockReturnValue(
                "0xcccc000000000000000000000000000000000000000000000000000000000000" as Hash,
            );

            await expect(session.importReceivedNote(RECEIVED_NOTE)).rejects.toThrow(
                InvalidNoteError,
            );
            expect(noteManager.addNote).not.toHaveBeenCalled();
        });

        it("reject a note whose commitment does not bind its fields", async () => {
            (
                noteComputationService.computeFullCommitment as ReturnType<typeof vi.fn>
            ).mockReturnValue(
                "0xeeee000000000000000000000000000000000000000000000000000000000000" as Hash,
            );

            await expect(session.importReceivedNote(RECEIVED_NOTE)).rejects.toThrow(
                InvalidNoteError,
            );
            expect(noteManager.addNote).not.toHaveBeenCalled();
        });

        it("accept when supplied hashes are equal but differently hex-padded", async () => {
            // BigInt comparison must treat "0x0aaa..." and "0xaaa..." as equal.
            (
                noteComputationService.computeFullCommitment as ReturnType<typeof vi.fn>
            ).mockReturnValue(RECEIVED_NOTE.commitment.replace("0x", "0x0") as Hash);

            await expect(session.importReceivedNote(RECEIVED_NOTE)).resolves.toBeUndefined();
            expect(noteManager.addNote).toHaveBeenCalledOnce();
        });

        it("reject a malformed note with InvalidNoteError, not a raw BigInt error", async () => {
            // Shape validation runs before the BigInt comparisons. A non-hex
            // field must surface as InvalidNoteError rather than a SyntaxError
            // from BigInt("not-hex").
            const malformed = { ...RECEIVED_NOTE, ownerAddress: "not-hex" as Address };

            await expect(session.importReceivedNote(malformed)).rejects.toThrow(InvalidNoteError);
            expect(noteManager.addNote).not.toHaveBeenCalled();
        });
    });
});
