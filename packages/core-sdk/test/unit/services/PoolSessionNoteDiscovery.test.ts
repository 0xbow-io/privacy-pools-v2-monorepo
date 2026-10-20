import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Contact,
    DiscoveredNote,
    EventSnapshot,
    FinalizedBlockResult,
    Hash,
    Hex,
    IAddressFieldConverter,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteDiscoveryService,
    INoteManager,
    IPaymentRequestService,
    IPoolVaultInteractor,
    IRPCInteractor,
    Note,
    NoteEvent,
    PublicKey,
    RagequitEvent,
    Secret,
    ViewingKeyPair,
} from "../../../src/internal.js";
import {
    bigintToHex,
    CATCH_ALL_TAG,
    InvalidStatusTransitionError,
    NoteDiscoveryScanFailed,
    NoteNotFoundError,
    NoteStatus,
    PoolSessionNoteDiscovery,
    StateInvariantViolation,
} from "../../../src/internal.js";

/**
 * Identity `IAddressFieldConverter<Address>` fixture — see the same one in
 * `NoteDiscoveryService.test.ts` for why this isn't the real (evm-sdk-owned) EvmAddressFieldConverter.
 */
class TestAddressFieldConverter implements IAddressFieldConverter<Address> {
    toField(address: Address): Hex {
        return address;
    }

    toTokenIdField(tokenId: Address): Hex {
        return tokenId;
    }
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;

const MOCK_VIEWING_PRIVATE_KEY =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret;
const MOCK_VIEWING_PUBLIC_KEY =
    "0x02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as PublicKey;

const MOCK_COMMITMENT_1 =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Hash;
const MOCK_COMMITMENT_2 =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Hash;

const MOCK_TX_HASH = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash;

const MOCK_NOTE_SECRET = `0x${"aa".repeat(32)}` as Secret;
const MOCK_VALUE = `0x${"00".repeat(31)}64` as Hex;
const MOCK_TOKEN_ID = `0x${"ee".repeat(20)}` as Address;
const MOCK_LABEL = `0x${"dd".repeat(32)}` as Hash;

const MOCK_VIEWING_KEY_PAIR: ViewingKeyPair = {
    privateKey: MOCK_VIEWING_PRIVATE_KEY,
    publicKey: MOCK_VIEWING_PUBLIC_KEY,
};

const MOCK_CONTACT: Contact = {
    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
    viewingPublicKey:
        "0x03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as PublicKey,
    label: "Alice",
};

const MOCK_DISCOVERED_NOTE: DiscoveredNote = {
    commitment: MOCK_COMMITMENT_1,
    noteSecret: MOCK_NOTE_SECRET,
    value: MOCK_VALUE,
    tokenId: MOCK_TOKEN_ID,
    label: MOCK_LABEL,
    contact: null,
    blockNumber: "0xa" as Hex,
    txHash: MOCK_TX_HASH,
};

const MOCK_CURRENT_BLOCK = "0x64" as Hex;

// ── Mock factories ──────────────────────────────────────────────────────────

function createMockNoteDiscoveryService(): INoteDiscoveryService {
    return {
        scanTargeted: vi.fn(() => []),
        scanCatchAll: vi.fn(() => []),
        scanPaymentRequests: vi.fn(() => []),
        scanStealthDeposits: vi.fn(() => []),
        decryptNotePayload: vi.fn(),
    };
}

function createMockPaymentRequestService(): IPaymentRequestService {
    return {
        generate: vi.fn(),
        list: vi.fn(async () => []),
        getOpenRequests: vi.fn(async () => []),
        getScannableRequests: vi.fn(async () => []),
        markScanRetired: vi.fn(async () => undefined),
        markFulfilled: vi.fn(async () => undefined),
        archive: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
        loadFromStorage: vi.fn(async () => undefined),
        exportState: vi.fn(() => []),
        importState: vi.fn(async () => undefined),
    };
}

function createMockNoteManager(): INoteManager {
    return {
        addNote: vi.fn(),
        updateNoteStatus: vi.fn(),
        deleteNote: vi.fn(),
        updateNote: vi.fn(),
        getNotes: vi.fn(() => []),
        getNote: vi.fn(() => {
            throw new NoteNotFoundError("not found");
        }),
        getNoteLineage: vi.fn(),
        getAllLineages: vi.fn(() => []),
        computeAggregates: vi.fn(),
        exportState: vi.fn(),
        importState: vi.fn(),
        getSyncCursor: vi.fn(() => "0x0" as Hex),
        setSyncCursor: vi.fn(),
        flush: vi.fn(),
        loadFromStorage: vi.fn(async () => undefined),
    };
}

function createMockKeystoreManager(): IKeystoreManager {
    return {
        getPrivateNullifyingKey: vi.fn(() => MOCK_VIEWING_PRIVATE_KEY),
        getPrivateRevocableKey: vi.fn(() => MOCK_VIEWING_PRIVATE_KEY),
        getViewingKeyPair: vi.fn(() => MOCK_VIEWING_KEY_PAIR),
        applyRotation: vi.fn(),
        getRevocableKeyIndex: vi.fn().mockReturnValue("0x0"),
        isRegistered: vi.fn(),
        markRegistered: vi.fn(),
    };
}

const MOCK_TIMESTAMP = "0x68000000" as Hex; // plausible unix timestamp in hex

function createMockPoolVaultInteractor(): IPoolVaultInteractor {
    return {
        getAddress: vi.fn(() => "0x0000000000000000000000000000000000000000" as Address),
        getCurrentCursor: vi.fn(async () => MOCK_CURRENT_BLOCK),
        resolveTokenId: vi.fn(async (fieldValue) => fieldValue as unknown as Address),
        getCommitmentTimestamp: vi.fn(async () => MOCK_TIMESTAMP),
        // "0x0" = unspent. The #501 recovery guard reads this authoritatively before
        // restoring a rejected note to ACTIVE, so it must default to a real value.
        getNullifierTimestamp: vi.fn(async () => "0x0" as Hash),
        isKnownRoot: vi.fn(),
        getStateLeaves: vi.fn(async () => []),
        exportLeafCache: vi.fn(() => undefined),
        getNoteEvents: vi.fn(async () => []),
        getTransactedEvents: vi.fn(async () => []),
        extractSpentNullifiers: vi.fn(() => []),
        getDepositedEvents: vi.fn(async () => []),
        getRagequitEvents: vi.fn(async () => []),
        encodeRagequit: vi.fn(),
        encodeTransact: vi.fn(),
        submitTransaction: vi.fn().mockResolvedValue("0x1234" as Hex),
    };
}

function createMockASPDataProvider(): IASPDataProvider {
    const emptySnapshot: EventSnapshot = {
        chainId: "0x1" as Hex,
        snapshotBlockNumber: "0x0" as Hex,
        generatedAt: "1970-01-01T00:00:00.000Z",
        deposits: [],
        transacts: [],
        ragequits: [],
        leaves: [],
        keystoreLeaves: [],
    };
    return {
        getRoot: vi.fn(async () => "0x0" as Hash),
        getLeaves: vi.fn(async () => []),
        getLabelStatus: vi.fn(),
        getASPPublicKey: vi.fn(),
        getEventSnapshot: vi.fn(async () => emptySnapshot),
        getNoteEvents: vi.fn(async () => ({ events: [], lastSyncedBlock: "0x0" as Hex })),
    };
}

/**
 * Root-verifying ASP client (#540). Distinct from the raw data provider: rejection
 * corroboration goes through this, so the leaf set is checked against the on-chain root.
 */
function createMockASPClient(): IASPClient {
    return {
        getAssociationSetRoot: vi.fn(async () => "0x0" as Hash),
        getAssociationSetLeaves: vi.fn(async () => []),
        getMerkleProof: vi.fn(),
        getLabelStatus: vi.fn(),
        getASPPublicKey: vi.fn(),
    } as unknown as IASPClient;
}

function createMockLogger(): ILogger {
    return {
        child: vi.fn(),
        level: "debug",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    };
}

function createMockNoteComputationService(): INoteComputationService {
    return {
        computeNoteAddressHash: vi.fn(() => MOCK_COMMITMENT_1),
        computePrecommitment: vi.fn(() => MOCK_COMMITMENT_1),
        computeLabel: vi.fn(() => MOCK_LABEL),
        computeFullCommitment: vi.fn(() => MOCK_COMMITMENT_1),
        computeNullifier: vi.fn(() => MOCK_COMMITMENT_1),
        computeAuthDigest: vi.fn(() => MOCK_COMMITMENT_1),
        computeLabelHash: vi.fn(() => MOCK_COMMITMENT_1),
        encodeNotePayload: vi.fn(() => new Uint8Array(117)),
        decodeNotePayload: vi.fn(() => ({
            noteSecret: MOCK_NOTE_SECRET,
            value: MOCK_VALUE,
            tokenId: MOCK_TOKEN_ID as Address,
            label: MOCK_LABEL,
        })),
        generateNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: "0x" as Hex,
        })),
        encodePaymentRequestNotePayload: vi.fn(() => new Uint8Array()),
        decodePaymentRequestNotePayload: vi.fn(),
        generatePaymentRequestNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: "0x" as Hex,
        })),
    };
}

function createMockRPCInteractor(): IRPCInteractor {
    return {
        readContract: vi.fn(),
        getBlockNumber: vi.fn(async () => MOCK_CURRENT_BLOCK),
        // Default: everything in the mocked range is settled, so tests that are not
        // about finality behave as they did before the status head existed.
        getFinalizedBlockNumber: vi.fn(
            async () =>
                ({ status: "finalized", blockNumber: MOCK_CURRENT_BLOCK }) as FinalizedBlockResult,
        ),
        waitForTransactionReceipt: vi.fn(),
        getLogs: vi.fn(async () => []),
        getLogsPaginated: vi.fn(async () => []),
    };
}

function makeNoteEvent(overrides?: Partial<NoteEvent>): NoteEvent {
    return {
        blockNumber: "0xa" as Hex,
        txHash: MOCK_TX_HASH,
        hint: CATCH_ALL_TAG,
        ephemeralPubKey: ("0x02" + "00".repeat(32)) as PublicKey,
        encryptedPayload: ("0x" + "ff".repeat(50)) as Hex,
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PoolSessionNoteDiscovery", () => {
    let noteDiscoveryService: INoteDiscoveryService;
    let noteManager: INoteManager;
    let keystoreManager: IKeystoreManager;
    let poolVaultInteractor: IPoolVaultInteractor;
    let noteComputationService: INoteComputationService;
    let aspDataProvider: IASPDataProvider;
    let paymentRequestService: IPaymentRequestService;
    let rpcInteractor: IRPCInteractor;
    let aspClient: IASPClient;
    let session: PoolSessionNoteDiscovery;

    beforeEach(() => {
        noteDiscoveryService = createMockNoteDiscoveryService();
        noteManager = createMockNoteManager();
        keystoreManager = createMockKeystoreManager();
        poolVaultInteractor = createMockPoolVaultInteractor();
        noteComputationService = createMockNoteComputationService();
        aspDataProvider = createMockASPDataProvider();
        aspClient = createMockASPClient();
        paymentRequestService = createMockPaymentRequestService();
        rpcInteractor = createMockRPCInteractor();
        session = new PoolSessionNoteDiscovery({
            ownerAddress: VALID_OWNER,
            noteDiscoveryService,
            noteManager,
            keystoreManager,
            poolVaultInteractor,
            noteComputationService,
            aspDataProvider,
            aspClient,
            addressFieldConverter: new TestAddressFieldConverter(),
            paymentRequestService,
            rpcInteractor,
        });
    });

    describe("constructor", () => {
        it("initialize without errors with valid config", () => {
            expect(
                () =>
                    new PoolSessionNoteDiscovery({
                        ownerAddress: VALID_OWNER,
                        noteDiscoveryService,
                        noteManager,
                        keystoreManager,
                        poolVaultInteractor,
                        noteComputationService,
                        aspDataProvider,
                        aspClient,
                        addressFieldConverter: new TestAddressFieldConverter(),
                        paymentRequestService,
                        rpcInteractor,
                    }),
            ).not.toThrow();
        });
    });

    describe("discoverNotes", () => {
        describe("catch-all mode (no contacts)", () => {
            it("fetch events from ASP using sync cursor as fromBlock", async () => {
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0x5" as Hex,
                );

                await session.discoverNotes();

                expect(aspDataProvider.getNoteEvents).toHaveBeenCalledWith("0x5", "0x64");
            });

            it("call scanCatchAll when no contacts are provided", async () => {
                const events = [makeNoteEvent()];
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce(events);

                await session.discoverNotes();

                expect(noteDiscoveryService.scanCatchAll).toHaveBeenCalledOnce();
                expect(noteDiscoveryService.scanCatchAll).toHaveBeenCalledWith(
                    events,
                    MOCK_VIEWING_PRIVATE_KEY,
                    VALID_OWNER,
                );
                expect(noteDiscoveryService.scanTargeted).not.toHaveBeenCalled();
            });

            it("retrieve viewing private key from keystoreManager", async () => {
                await session.discoverNotes();

                expect(keystoreManager.getViewingKeyPair).toHaveBeenCalledOnce();
            });

            it("return empty array when no notes are discovered", async () => {
                const result = await session.discoverNotes();
                expect(result).toEqual([]);
            });

            it("add discovered notes to NoteManager with PENDING status", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [MOCK_DISCOVERED_NOTE],
                );

                const result = await session.discoverNotes();

                expect(noteManager.addNote).toHaveBeenCalledOnce();
                expect(noteManager.addNote).toHaveBeenCalledWith(
                    expect.objectContaining({
                        commitment: MOCK_COMMITMENT_1,
                        status: NoteStatus.PENDING,
                        ownerAddress: VALID_OWNER,
                        noteSecret: MOCK_NOTE_SECRET,
                        isOwned: true,
                        value: MOCK_VALUE,
                        tokenId: MOCK_TOKEN_ID,
                        label: MOCK_LABEL,
                        createdAtBlock: MOCK_TIMESTAMP,
                        spentAtBlock: null,
                        txHash: MOCK_TX_HASH,
                    }),
                );

                expect(result).toHaveLength(1);
                expect(result[0].status).toBe(NoteStatus.PENDING);
            });

            it("add multiple discovered notes to NoteManager", async () => {
                const discoveredNote2: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    commitment: MOCK_COMMITMENT_2,
                    blockNumber: "0xb" as Hex,
                };

                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [MOCK_DISCOVERED_NOTE, discoveredNote2],
                );

                const result = await session.discoverNotes();

                expect(noteManager.addNote).toHaveBeenCalledTimes(2);
                expect(result).toHaveLength(2);
                expect(result[0].commitment).toBe(MOCK_COMMITMENT_1);
                expect(result[1].commitment).toBe(MOCK_COMMITMENT_2);
            });

            it("set isOwned to true on discovered notes", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [MOCK_DISCOVERED_NOTE],
                );

                const result = await session.discoverNotes();

                expect(result[0].isOwned).toBe(true);
            });

            it("advance sync cursor after successful discovery", async () => {
                await session.discoverNotes();

                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
            });

            it("flush discovered notes before marking their payment request fulfilled", async () => {
                // markFulfilled is a separate durable write. Running it before the note is flushed
                // would, on a crash in between, leave a fulfilled request with no note (audit #84).
                const prNote: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    paymentId: ("0x" + "cd".repeat(32)) as Hex,
                };
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [],
                );
                (
                    noteDiscoveryService.scanPaymentRequests as ReturnType<typeof vi.fn>
                ).mockReturnValueOnce([prNote]);

                await session.discoverNotes();

                expect(paymentRequestService.markFulfilled).toHaveBeenCalledWith(prNote.paymentId, {
                    commitment: prNote.commitment,
                    // computeNoteAddressHash is mocked to return MOCK_COMMITMENT_1.
                    noteAddressHash: MOCK_COMMITMENT_1,
                    value: prNote.value,
                });
                const firstFlush = (noteManager.flush as ReturnType<typeof vi.fn>).mock
                    .invocationCallOrder[0];
                const markCall = (paymentRequestService.markFulfilled as ReturnType<typeof vi.fn>)
                    .mock.invocationCallOrder[0];
                expect(firstFlush).toBeLessThan(markCall);
            });

            it("return empty array when already synced (fromBlock > toBlock)", async () => {
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0xff" as Hex,
                );

                const result = await session.discoverNotes();

                expect(result).toEqual([]);
                expect(poolVaultInteractor.getNoteEvents).not.toHaveBeenCalled();
            });
        });

        describe("targeted mode (with contacts)", () => {
            it("call scanTargeted when contacts are provided", async () => {
                const events = [makeNoteEvent()];
                const contacts = [MOCK_CONTACT];

                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce(events);

                await session.discoverNotes({ contacts });

                expect(noteDiscoveryService.scanTargeted).toHaveBeenCalledOnce();
                expect(noteDiscoveryService.scanTargeted).toHaveBeenCalledWith(
                    events,
                    contacts,
                    MOCK_VIEWING_PRIVATE_KEY,
                    VALID_OWNER,
                );
                expect(noteDiscoveryService.scanCatchAll).not.toHaveBeenCalled();
            });

            it("add targeted discovered notes to NoteManager", async () => {
                const targetedNote: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    contact: MOCK_CONTACT,
                };

                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanTargeted as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [targetedNote],
                );

                const result = await session.discoverNotes({
                    contacts: [MOCK_CONTACT],
                });

                expect(noteManager.addNote).toHaveBeenCalledOnce();
                expect(result).toHaveLength(1);
                expect(result[0].status).toBe(NoteStatus.PENDING);
            });

            it("not advance the shared sync cursor in targeted mode", async () => {
                // A targeted scan covers one range for specific contacts. Advancing the cursor
                // would make a later catch-all scan skip that range and miss notes (audit #86).
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);

                await session.discoverNotes({ contacts: [MOCK_CONTACT] });

                expect(noteManager.setSyncCursor).not.toHaveBeenCalled();
            });

            it("treat an empty contacts array as catch-all, not targeted", async () => {
                // `[]` is truthy; the old code ran a (fruitless) targeted scan and still advanced
                // the cursor. It must instead run catch-all and own the cursor (audit #86).
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);

                await session.discoverNotes({ contacts: [] });

                expect(noteDiscoveryService.scanTargeted).not.toHaveBeenCalled();
                expect(noteDiscoveryService.scanCatchAll).toHaveBeenCalledOnce();
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
            });
        });

        describe("fromBlock override", () => {
            it("use provided fromBlock instead of sync cursor", async () => {
                await session.discoverNotes({ fromBlock: "0x10" as Hex });

                expect(aspDataProvider.getNoteEvents).toHaveBeenCalledWith("0x10", "0x64");
                expect(noteManager.getSyncCursor).not.toHaveBeenCalled();
            });
        });

        describe("duplicate handling", () => {
            it("skip notes that already exist in NoteManager", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [MOCK_DISCOVERED_NOTE],
                );

                // Make getNote NOT throw (meaning note already exists)
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValueOnce({
                    commitment: MOCK_COMMITMENT_1,
                });

                const result = await session.discoverNotes();

                expect(noteManager.addNote).not.toHaveBeenCalled();
                expect(result).toHaveLength(0);
            });
        });

        describe("error handling", () => {
            it("wrap event fetch errors in NoteDiscoveryScanFailed", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockRejectedValueOnce(new Error("RPC timeout"));

                await expect(session.discoverNotes()).rejects.toThrow(NoteDiscoveryScanFailed);
            });

            it("wrap scan errors in NoteDiscoveryScanFailed", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockImplementation(
                    () => {
                        throw new Error("ECDH computation failed");
                    },
                );

                await expect(session.discoverNotes()).rejects.toThrow(NoteDiscoveryScanFailed);
            });

            it("wrap NoteManager errors in NoteDiscoveryScanFailed", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [MOCK_DISCOVERED_NOTE],
                );
                (noteManager.addNote as ReturnType<typeof vi.fn>).mockImplementation(() => {
                    throw new Error("Duplicate note root");
                });

                await expect(session.discoverNotes()).rejects.toThrow(NoteDiscoveryScanFailed);
            });

            it("include original error message in NoteDiscoveryScanFailed", async () => {
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockRejectedValueOnce(new Error("invalid public key"));

                await expect(session.discoverNotes()).rejects.toThrow(/invalid public key/);
            });

            it("hold the cursor at the unresolved block when a timestamp cannot be resolved", async () => {
                // No on-chain timestamp means a reorg/RPC race. The note is not persisted (never a
                // sentinel createdAtBlock), and the cursor is held at that note's block so the next
                // scan retries it — it must not advance past it (which would lose the note) (#73).
                // Within UNRESOLVED_TIMESTAMP_HOLD_BLOCKS of head: the hold applies to a
                // recent event, which is the reorg/RPC-race case this covers.
                const recent: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    blockNumber: "0x30" as Hex,
                };
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [recent],
                );
                (
                    poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
                ).mockRejectedValue(new Error("chain read reverted"));

                const result = await session.discoverNotes();

                expect(result).toEqual([]);
                expect(noteManager.addNote).not.toHaveBeenCalled();
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(recent.blockNumber);
                expect(noteManager.setSyncCursor).not.toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
            });

            it("hold the cursor when a commitment timestamp persistently resolves to zero", async () => {
                // `getCommitmentTimestamp` returns `0x0` when the commitment is absent from contract
                // storage. If every retry still returns `0x0`, skip the note and hold the cursor —
                // never persist an invalid leaf timestamp, never advance past the missing note.
                vi.spyOn(poolVaultInteractor, "getNoteEvents").mockResolvedValueOnce([
                    makeNoteEvent(),
                ]);
                // Recent enough to still hold the cursor — see the depth bound below.
                const recent: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    blockNumber: "0x30" as Hex,
                };
                vi.spyOn(noteDiscoveryService, "scanCatchAll").mockReturnValueOnce([recent]);

                vi.spyOn(poolVaultInteractor, "getCommitmentTimestamp").mockResolvedValue(
                    "0x0" as Hash,
                );

                const result = await session.discoverNotes();

                expect(result).toEqual([]);
                expect(noteManager.addNote).not.toHaveBeenCalled();
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(recent.blockNumber);
            });

            it("advance the cursor past a commitment that stays absent far below head", async () => {
                // A note payload names a commitment; nothing forces that commitment to be one
                // the pool ever accepted. A one-wei deposit carrying a payload for a commitment
                // that never enters contract storage would otherwise hold the cursor at its
                // block forever, and every note in a later block would stop being discovered.
                // Past UNRESOLVED_TIMESTAMP_HOLD_BLOCKS the absence is settled, not transient.
                const stale: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    blockNumber: "0xa" as Hex, // 0x64 - 0xa = 90 blocks below head
                };
                vi.spyOn(poolVaultInteractor, "getNoteEvents").mockResolvedValueOnce([
                    makeNoteEvent(),
                ]);
                vi.spyOn(noteDiscoveryService, "scanCatchAll").mockReturnValueOnce([stale]);
                vi.spyOn(poolVaultInteractor, "getCommitmentTimestamp").mockResolvedValue(
                    "0x0" as Hash,
                );

                const result = await session.discoverNotes();

                // The note is still not persisted — only the cursor moves on.
                expect(result).toEqual([]);
                expect(noteManager.addNote).not.toHaveBeenCalled();
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
                expect(noteManager.setSyncCursor).not.toHaveBeenCalledWith(stale.blockNumber);
            });

            it("hold the cursor for a far-below-head commitment whose lookup never answered", async () => {
                // Artem, #433: a flaky RPC during a catch-up sync is not evidence the note is
                // absent. Only a clean 0x0 read settles it; a lookup that only threw keeps the
                // hold, or the cursor moves past a real note and that block is never rescanned.
                const deep: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    blockNumber: "0xa" as Hex, // 90 blocks below head
                };
                vi.spyOn(poolVaultInteractor, "getNoteEvents").mockResolvedValueOnce([
                    makeNoteEvent(),
                ]);
                vi.spyOn(noteDiscoveryService, "scanCatchAll").mockReturnValueOnce([deep]);
                vi.spyOn(poolVaultInteractor, "getCommitmentTimestamp").mockRejectedValue(
                    new Error("RPC down"),
                );

                const result = await session.discoverNotes();

                expect(result).toEqual([]);
                expect(noteManager.addNote).not.toHaveBeenCalled();
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(deep.blockNumber);
                expect(noteManager.setSyncCursor).not.toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
            });

            it("persist resolved notes and hold the cursor when only some commitments resolve", async () => {
                // Ace review: one lagging commitment must not discard the whole batch. The note that
                // resolves is persisted; the unresolved one holds the cursor at its (earlier) block
                // for retry — the resolved note is re-seen next scan and deduped.
                const ready: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    commitment: MOCK_COMMITMENT_1,
                    blockNumber: "0x40" as Hex,
                };
                const lagging: DiscoveredNote = {
                    ...MOCK_DISCOVERED_NOTE,
                    commitment: MOCK_COMMITMENT_2,
                    // Within the hold depth of head, so the lag still holds the cursor.
                    blockNumber: "0x30" as Hex,
                };
                (
                    poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([makeNoteEvent(), makeNoteEvent()]);
                (noteDiscoveryService.scanCatchAll as ReturnType<typeof vi.fn>).mockReturnValueOnce(
                    [ready, lagging],
                );
                (
                    poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
                ).mockImplementation(async (commitment: Hash) =>
                    commitment === lagging.commitment ? ("0x0" as Hash) : MOCK_TIMESTAMP,
                );

                const result = await session.discoverNotes();

                expect(result).toHaveLength(1);
                expect(result[0].commitment).toBe(ready.commitment);
                expect(noteManager.addNote).toHaveBeenCalledTimes(1);
                // Cursor held at the earliest unresolved block, not advanced to current.
                expect(noteManager.setSyncCursor).toHaveBeenCalledWith(lagging.blockNumber);
                expect(noteManager.setSyncCursor).not.toHaveBeenCalledWith(MOCK_CURRENT_BLOCK);
            });

            it("dedupe commitments within a single scan batch", async () => {
                // `eth_getLogs` can return the same log twice during reorg
                // windows. Two discoveries with the same commitment in one
                // scan must produce exactly one addNote call.
                vi.spyOn(poolVaultInteractor, "getNoteEvents").mockResolvedValueOnce([
                    makeNoteEvent(),
                    makeNoteEvent(),
                ]);
                vi.spyOn(noteDiscoveryService, "scanCatchAll").mockReturnValueOnce([
                    MOCK_DISCOVERED_NOTE,
                    { ...MOCK_DISCOVERED_NOTE },
                ]);

                await expect(session.discoverNotes()).resolves.toHaveLength(1);
                expect(noteManager.addNote).toHaveBeenCalledTimes(1);
            });

            it("throw StateInvariantViolation when ragequit event targets a SPENT note", async () => {
                // Chain disallows publishing a nullifier twice (same guard
                // in transact and ragequit), so SPENT -> EXITED can never
                // originate from a valid chain state. Surface, don't swallow.
                const ragequitCommitment = MOCK_COMMITMENT_1;
                const spent = {
                    commitment: ragequitCommitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.SPENT,
                } as Note;
                vi.spyOn(noteManager, "getNotes").mockReturnValue([spent]);
                vi.spyOn(noteManager, "getNote").mockReturnValue(spent);
                vi.spyOn(poolVaultInteractor, "getRagequitEvents").mockResolvedValueOnce([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: ragequitCommitment,
                        // A genuine chain event for this note carries this note's
                        // nullifier (computeNullifier -> MOCK_COMMITMENT_1). The
                        // invariant only fires for an event actually bound to the note;
                        // an unbound row is dropped, not raised.
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                vi.spyOn(noteManager, "updateNoteStatus").mockImplementation(() => {
                    throw new InvalidStatusTransitionError(NoteStatus.SPENT, NoteStatus.EXITED);
                });

                const caught = await session.discoverNotes().catch((e: unknown) => e);
                expect(caught).toBeInstanceOf(StateInvariantViolation);
                expect((caught as Error).message).toMatch(/SPENT/);
                expect(noteManager.setSyncCursor).not.toHaveBeenCalled();
            });

            it("settle a pending exit to EXITED once its block is final and still shows the ragequit", async () => {
                // EXIT_PENDING is what this client writes after its OWN ragequit is
                // mined, because a receipt is not finality. This is the confirming
                // half: the block settled, the chain still shows the exit, so it
                // becomes terminal.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.EXIT_PENDING,
                    spentAtBlock: "0x10" as Hex,
                } as Note;
                // Present in both views, as in production: the unfiltered read builds the
                // nullifier map, the filtered one drives the settle pass.
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (f?: { status?: NoteStatus }) =>
                        f?.status === undefined || f.status === NoteStatus.EXIT_PENDING
                            ? [note]
                            : [],
                );
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);

                await session.discoverNotes();

                const calls = (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls;
                // Settled terminal, and never restored. Which pass got there first is
                // not the property under test.
                expect(
                    calls.filter(([c, t]) => c === exited && t === NoteStatus.EXITED).length,
                ).toBeGreaterThan(0);
                expect(
                    calls.filter(([c, t]) => c === exited && t === NoteStatus.ACTIVE),
                ).toHaveLength(0);
            });

            it("restore a pending exit to ACTIVE when its now-final block does not contain it", async () => {
                // The reorg path, and the reason EXIT_PENDING is not terminal. The
                // transaction was mined and the receipt succeeded, but the block was
                // reorged out — so the note is still the user's. Writing EXITED from
                // the receipt would have stranded it permanently.
                const commitment = MOCK_COMMITMENT_1;
                const note = {
                    commitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.EXIT_PENDING,
                    spentAtBlock: "0x10" as Hex,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (f?: { status?: NoteStatus }) =>
                        f?.status === NoteStatus.EXIT_PENDING ? [note] : [],
                );
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                // Block is final and carries no ragequit at all.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([]);

                await session.discoverNotes();

                const calls = (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls;
                expect(calls.filter(([, t]) => t === NoteStatus.EXITED)).toHaveLength(0);
                expect(
                    calls.filter(([c, t]) => c === commitment && t === NoteStatus.ACTIVE),
                ).toHaveLength(1);
            });

            it("not restore a pending exit that a reorg moved to a block still unsettled", async () => {
                // The ordering trap. A reorg drops the ragequit from block A and
                // re-includes it at B. A is final; B is not. The chain pass sees the
                // bound event at B and defers it, then the settle pass queries A,
                // finds it empty, and would restore the note to ACTIVE — making it
                // spendable while its nullifier is already consumed on the canonical
                // head, so the spend builds and reverts. Absence at A is only evidence
                // when the exit is not demonstrably somewhere else.
                const commitment = MOCK_COMMITMENT_1;
                const note = {
                    commitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.EXIT_PENDING,
                    spentAtBlock: "0x10" as Hex, // A, final
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (f?: { status?: NoteStatus }) =>
                        f?.status === undefined || f.status === NoteStatus.EXIT_PENDING
                            ? [note]
                            : [],
                );
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                // The range scan finds it at B (0x60); the single-block read of A is
                // empty. Same mock serves both, keyed on the range it is asked for.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockImplementation(async (from: Hex, to: Hex) =>
                    from === to && BigInt(from) === 0x10n
                        ? []
                        : [
                              {
                                  blockNumber: "0x60" as Hex,
                                  txHash: MOCK_TX_HASH,
                                  commitment,
                                  nullifierHash: MOCK_COMMITMENT_1,
                              } as RagequitEvent,
                          ],
                );
                // Final at 0x40: A (0x10) is settled, B (0x60) is not.
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "finalized", blockNumber: "0x40" as Hex });

                await session.discoverNotes();

                const calls = (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls;
                // Neither restored nor settled: it stays pending until B is final.
                expect(
                    calls.filter(([c, t]) => c === commitment && t === NoteStatus.ACTIVE),
                ).toHaveLength(0);
                expect(
                    calls.filter(([c, t]) => c === commitment && t === NoteStatus.EXITED),
                ).toHaveLength(0);
            });

            it("leave a pending exit alone while its block is still unsettled", async () => {
                // Absence is only evidence once the block can no longer change. Below
                // the finality boundary a missing event means nothing, so the note
                // must be neither confirmed nor restored.
                const commitment = MOCK_COMMITMENT_1;
                const note = {
                    commitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.EXIT_PENDING,
                    spentAtBlock: "0x60" as Hex,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (f?: { status?: NoteStatus }) =>
                        f?.status === NoteStatus.EXIT_PENDING ? [note] : [],
                );
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([]);
                // Finalized well below the exit's block.
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "finalized", blockNumber: "0x10" as Hex });

                await session.discoverNotes();

                const calls = (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls;
                expect(calls.filter(([c]) => c === commitment)).toHaveLength(0);
            });

            it("defer a terminal EXITED until the ragequit's block is settled", async () => {
                // EXITED has no reverse edge, so writing it from a head log records an
                // exit the canonical chain may never contain, in the direction that
                // hides a note the user still owns. Matching more fields cannot help:
                // an orphaned log names a REAL commitment/nullifier pair, so a replay of
                // it after the reorg passes every check. Only settledness separates a
                // log that was true from one that still is.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x60" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                // Finalized well below the event's block: still reorgable.
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "finalized", blockNumber: "0x10" as Hex });

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("hold the sync cursor below a ragequit it deferred, so the block is read again", async () => {
                // The gate is only a delay if the block gets rescanned. Chain events are
                // read by RANGE, so a cursor that advances past a deferred ragequit means
                // that block is never scanned again and the note stays non-EXITED
                // forever: the safety gate would quietly become permanent staleness, and
                // the balance would keep counting a note that is gone.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x60" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "finalized", blockNumber: "0x10" as Hex });

                await session.discoverNotes();

                // Not advanced to the scanned head (0x64) — parked at or below the
                // deferred block so the next pass re-reads it.
                const cursorCalls = (noteManager.setSyncCursor as ReturnType<typeof vi.fn>).mock
                    .calls;
                expect(cursorCalls.length).toBeGreaterThan(0);
                const cursor = cursorCalls[cursorCalls.length - 1]![0] as Hex;
                expect(BigInt(cursor)).toBeLessThanOrEqual(BigInt("0x60"));
            });

            it("apply the terminal EXITED once the chain has finalized that block", async () => {
                // The other half: deferring must cost one sync, not the status forever.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x60" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "finalized", blockNumber: "0x60" as Hex });

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(1);
                expect(exitedCalls[0]?.[0]).toBe(exited);
            });

            it("fall back to a confirmation depth when the provider serves no finalized block", async () => {
                // Refusing outright on a provider that cannot answer would mean those
                // users never record an exit and keep counting notes that are gone. A
                // depth is weaker than the tag and still far better than the head.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "unsupported" });

                // Head is 0x64 (100), depth 64 -> anything at or below block 36 counts.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x60" as Hex, // 96: far too recent
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                await session.discoverNotes();
                expect(
                    (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
                        ([, target]) => target === NoteStatus.EXITED,
                    ),
                ).toHaveLength(0);

                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex, // 16: deep enough
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                await session.discoverNotes();
                expect(
                    (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mock.calls.filter(
                        ([, target]) => target === NoteStatus.EXITED,
                    ),
                ).toHaveLength(1);
            });

            it("defer rather than relax the rule when the finality read merely fails", async () => {
                // The distinction that keeps the gate meaningful. "Unsupported" is a
                // permanent property of the provider and earns the weaker
                // confirmation-depth rule; a timeout or rate limit is momentary and
                // earns nothing. Collapsing the two would let anyone able to induce one
                // failed request choose which rule applies — here the event is deep
                // enough (block 16 against head 100) that the depth fallback WOULD have
                // admitted it, so this fails if the two are treated alike.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockResolvedValue({ status: "unavailable", reason: "request timed out" });

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("defer when an interactor throws instead of reporting a finality result", async () => {
                // A custom interactor that throws made a failed read, not a statement
                // that the provider has no finality.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                (
                    rpcInteractor.getFinalizedBlockNumber as ReturnType<typeof vi.fn>
                ).mockRejectedValue(new Error("boom"));

                await expect(session.discoverNotes()).resolves.toBeDefined();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("refuse to mark EXITED from a chain-tail ragequit row that does not bind to the note", async () => {
                // The way around the corroboration, if the chain path is left unbound.
                // A snapshot that lags or fails forces this chain-tail scan, and the row
                // it scans used to be applied on the public commitment alone — so a
                // fabricated log naming a held note retired it without ever meeting the
                // ASP-path checks. The note's own nullifier is what ties an event to it.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                // Snapshot unavailable -> the whole range is scanned from chain logs.
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("snapshot unavailable"),
                );
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: targeted,
                        // Not this note's nullifier (computeNullifier -> MOCK_COMMITMENT_1).
                        nullifierHash: MOCK_COMMITMENT_2,
                    } as RagequitEvent,
                ]);

                await expect(session.discoverNotes()).resolves.toBeDefined();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("refuse to mark EXITED from an ASP snapshot row the chain does not corroborate", async () => {
                // THE FINDING. A row in the provider's snapshot named a note the
                // user still holds and marked it EXITED. EXITED is terminal, it
                // makes prepareRageQuit refuse, and the note's value leaves the
                // recoverable total — all on an unauthenticated claim about a
                // commitment that is public on chain. The note must stay
                // spendable when the chain does not back the claim up.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                // The chain shows no ragequit at the claimed block: it never happened.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([]);

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("corroborate an ASP ragequit row without ever querying the note's nullifier", async () => {
                // The privacy half of the same finding, and a ratchet rather than a
                // nicety. The obvious corroboration is to derive the note's nullifier
                // and ask `spentNullifiers(n)` — but for a note that was never exited
                // that nullifier has never appeared on chain, so the query hands the RPC
                // provider a value only the owner could compute. Worse, the ASP picks
                // the moment: a fabricated row naming any commitment would make this
                // client disclose that note's nullifier on demand, which is a
                // commitment -> nullifier oracle for anyone who sees both feeds.
                // Corroboration must therefore be keyed on the block number alone.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([]);

                await session.discoverNotes();

                expect(poolVaultInteractor.getNullifierTimestamp).not.toHaveBeenCalled();
                expect(poolVaultInteractor.getRagequitEvents).toHaveBeenCalledWith("0x10", "0x10");
            });

            it("mark EXITED from an ASP snapshot row once the chain's own ragequit event matches it", async () => {
                // The same row, for a ragequit that really happened — the user exited on
                // another device. Reading the chain's Ragequit event back proves the
                // event TYPE, which the nullifier mapping cannot: an ordinary transact
                // consumes the same nullifier, so `spentNullifiers` agrees just as
                // readily with a snapshot that drops the real Transact row and
                // substitutes a ragequit.
                const exited = MOCK_COMMITMENT_1;
                const note = {
                    commitment: exited,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([note]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(note);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: exited,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                // `computeNullifier` is mocked to MOCK_COMMITMENT_1, so that is this
                // note's derived nullifier and what the chain event must carry.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: exited,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(1);
                expect(exitedCalls[0]?.[0]).toBe(exited);
                // The height comes off the MATCHED CHAIN EVENT, and only an event at the
                // queried block can match, so the two agree by construction here.
                expect(exitedCalls[0]?.[2]).toBe("0x10");
                // The claim was actually corroborated, and by the block-keyed query —
                // never the nullifier mapping.
                expect(poolVaultInteractor.getRagequitEvents).toHaveBeenCalledWith("0x10", "0x10");
                expect(poolVaultInteractor.getNullifierTimestamp).not.toHaveBeenCalled();
            });

            it("ignore a returned ragequit event that is not at the block it queried", async () => {
                // The query asks about one block and the block is the part of the claim
                // being verified. An event from elsewhere means the source answered a
                // different question, and accepting it would let the source choose the
                // height the exit is recorded at.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        // Everything matches except the block that was asked about.
                        blockNumber: "0x99" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: targeted,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("leave the note spendable when a chain ragequit at that block belongs to someone else", async () => {
                // Ragequit events are public. Matching only the commitment would let a
                // provider point a row at an unrelated real ragequit in the same block
                // and have it count as proof. The nullifier binds the event to THIS
                // note, and is compared locally against a value the chain already
                // published — derived, never transmitted.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: targeted,
                        // Not this note's nullifier (computeNullifier -> MOCK_COMMITMENT_1).
                        nullifierHash: MOCK_COMMITMENT_2,
                    } as RagequitEvent,
                ]);

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("leave the note spendable when the chain cannot be read to corroborate the claim", async () => {
                // The fail-safe direction. An unreadable chain is not evidence, and here
                // "assume spent" is the destructive answer: it would retire the note on
                // the provider's unverified word, which is this finding inverted. An RPC
                // outage must cost nothing but a retry on the next sync.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockRejectedValue(new Error("rpc down"));

                await expect(session.discoverNotes()).resolves.toBeDefined();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("spend one read per note, not one per row, when a provider names the same note at many blocks", async () => {
                // Grouping by block alone bounds nothing: one owned commitment claimed at
                // N distinct blocks would buy N reads. Claims collapse to one per
                // commitment first, and two different blocks for a note that can only be
                // ragequit once are contradictory — no evidence, not weak evidence.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: Array.from({ length: 50 }, (_, i) => ({
                        blockNumber: `0x${(i + 1).toString(16)}` as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: targeted,
                        nullifierHash: MOCK_COMMITMENT_2,
                    })),
                    leaves: [],
                    keystoreLeaves: [],
                });
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([]);

                await session.discoverNotes();

                // Contradictory rows are dropped before any read is issued.
                expect(poolVaultInteractor.getRagequitEvents).not.toHaveBeenCalled();
                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
            });

            it("leave the note spendable when the claimed row carries no block to look in", async () => {
                // A row with no block number has nowhere to be corroborated. The old
                // path fell back to the sync cursor and wrote EXITED anyway; now it is
                // simply not corroborable, and nothing is read.
                const targeted = MOCK_COMMITMENT_1;
                const victim = {
                    commitment: targeted,
                    label: MOCK_LABEL,
                    status: NoteStatus.ACTIVE,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([victim]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(victim);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: null,
                            txHash: MOCK_TX_HASH,
                            commitment: targeted,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });

                await session.discoverNotes();

                const exitedCalls = (
                    noteManager.updateNoteStatus as ReturnType<typeof vi.fn>
                ).mock.calls.filter(([, target]) => target === NoteStatus.EXITED);
                expect(exitedCalls).toHaveLength(0);
                expect(poolVaultInteractor.getNullifierTimestamp).not.toHaveBeenCalled();
            });

            it("survive an ASP snapshot row aimed at a SPENT note instead of aborting every sync", async () => {
                // SPENT -> EXITED is the one forbidden transition, and spent
                // commitments are just as public as unspent ones. Raising on
                // one killed the whole discovery pass on every subsequent
                // sync — no new notes, no status updates, balance frozen
                // stale — for the price of one array element. A corrupt row
                // must cost the row, never the sync.
                const spentCommitment = MOCK_COMMITMENT_1;
                const spent = {
                    commitment: spentCommitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.SPENT,
                } as Note;
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([spent]);
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(spent);
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            commitment: spentCommitment,
                            nullifierHash: MOCK_COMMITMENT_2,
                        },
                    ],
                    leaves: [],
                    keystoreLeaves: [],
                });
                // Even with the chain's own ragequit event corroborating the row, the
                // transition is illegal — and must be dropped rather than thrown.
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValue([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: spentCommitment,
                        nullifierHash: MOCK_COMMITMENT_1,
                    } as RagequitEvent,
                ]);
                (noteManager.updateNoteStatus as ReturnType<typeof vi.fn>).mockImplementation(
                    (_c: Hex, target: NoteStatus) => {
                        if (target === NoteStatus.EXITED) {
                            throw new InvalidStatusTransitionError(
                                NoteStatus.SPENT,
                                NoteStatus.EXITED,
                            );
                        }
                    },
                );

                await expect(session.discoverNotes()).resolves.toBeDefined();
            });

            it("tolerate ragequit replays for notes already EXITED", async () => {
                // A prior discover call marked the note EXITED. Now the ASP
                // snapshot still carries the same ragequit event; we must not
                // throw when the transition would be a no-op.
                const ragequitCommitment = MOCK_COMMITMENT_1;
                const existing = {
                    commitment: ragequitCommitment,
                    label: MOCK_LABEL,
                    status: NoteStatus.EXITED,
                };
                // Filter-aware, as the real NoteManager is: an EXITED note must not also be
                // served as ACTIVE, or the status pass would act on a terminal note.
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (filter?: { status: NoteStatus }) =>
                        filter?.status === undefined || filter.status === NoteStatus.EXITED
                            ? [existing]
                            : [],
                );
                (noteManager.getNote as ReturnType<typeof vi.fn>).mockReturnValue(existing);
                (
                    poolVaultInteractor.getRagequitEvents as ReturnType<typeof vi.fn>
                ).mockResolvedValueOnce([
                    {
                        blockNumber: "0x10" as Hex,
                        txHash: MOCK_TX_HASH,
                        commitment: ragequitCommitment,
                        nullifier: MOCK_COMMITMENT_2,
                    },
                ]);
                const updateNoteStatusMock = noteManager.updateNoteStatus as ReturnType<
                    typeof vi.fn
                >;
                updateNoteStatusMock.mockImplementation(() => {
                    throw new Error("Invalid status transition: EXITED -> EXITED");
                });

                await expect(session.discoverNotes()).resolves.toHaveLength(0);
                // Short-circuit path: updateNoteStatus must never be invoked with
                // EXITED as target for a note already EXITED. Asserting the call
                // didn't happen (rather than relying on the try/catch to swallow
                // it) proves the early-return guard is doing the work.
                const exitedCalls = updateNoteStatusMock.mock.calls.filter(
                    ([, target]) => target === NoteStatus.EXITED,
                );
                expect(exitedCalls).toHaveLength(0);
            });
        });

        describe("status sync resilience", () => {
            function makeOwnedNote(commitment: Hash, label: Hash, status: NoteStatus): Note {
                return {
                    noteAddressHash: MOCK_COMMITMENT_1,
                    commitment,
                    value: MOCK_VALUE,
                    tokenId: MOCK_TOKEN_ID,
                    label,
                    status,
                    ownerAddress: VALID_OWNER,
                    noteSecret: MOCK_NOTE_SECRET,
                    isOwned: true,
                    createdAtBlock: MOCK_TIMESTAMP,
                    spentAtBlock: null,
                    txHash: MOCK_TX_HASH,
                };
            }

            it("apply status from the bulk association set, never a per-label request", async () => {
                // Label status is answered from the association set the ASP already publishes in
                // bulk. A per-label request would name one of the caller's own labels, and a
                // sweep over a wallet's notes would name every deposit those notes descend from.
                const pendingNote = makeOwnedNote(
                    ("0x" + "a1".repeat(32)) as Hash,
                    ("0x" + "b1".repeat(32)) as Hash,
                    NoteStatus.PENDING,
                );
                const activeNote = makeOwnedNote(
                    ("0x" + "a2".repeat(32)) as Hash,
                    ("0x" + "b2".repeat(32)) as Hash,
                    NoteStatus.ACTIVE,
                );
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (filter?: { status: NoteStatus }) => {
                        if (filter?.status === NoteStatus.PENDING) return [pendingNote];
                        if (filter?.status === NoteStatus.ACTIVE) return [activeNote];
                        return [];
                    },
                );
                (
                    noteComputationService.computeLabelHash as ReturnType<typeof vi.fn>
                ).mockImplementation((label: Hex) => label);
                // The pending note's label is in the set; the active note's is not.
                (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                    pendingNote.label,
                ]);
                // This test is about where status comes from, not about promotion evidence,
                // so give the pending note the on-chain evidence promotion also requires -
                // without it the note would stay PENDING for the right reason and this test
                // would pass for the wrong one.
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0xffffffff" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [
                        {
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            outputCommitment: pendingNote.commitment,
                        },
                    ],
                    transacts: [],
                    ragequits: [],
                    leaves: [],
                    keystoreLeaves: [],
                });

                await expect(session.discoverNotes()).resolves.toBeDefined();

                expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                    pendingNote.commitment,
                    NoteStatus.ACTIVE,
                );
                expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                    activeNote.commitment,
                    NoteStatus.REJECTED,
                );
                expect(aspDataProvider.getLabelStatus).not.toHaveBeenCalled();
            });

            it("leave every note's status untouched when the association set is unavailable", async () => {
                // Nothing is known this pass, so nothing moves. Acting on the absence of an
                // answer would demote spendable notes on an ASP outage.
                const pendingNote = makeOwnedNote(
                    ("0x" + "a3".repeat(32)) as Hash,
                    ("0x" + "b3".repeat(32)) as Hash,
                    NoteStatus.PENDING,
                );
                const activeNote = makeOwnedNote(
                    ("0x" + "a4".repeat(32)) as Hash,
                    ("0x" + "b4".repeat(32)) as Hash,
                    NoteStatus.ACTIVE,
                );
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (filter?: { status: NoteStatus }) => {
                        if (filter?.status === NoteStatus.PENDING) return [pendingNote];
                        if (filter?.status === NoteStatus.ACTIVE) return [activeNote];
                        return [];
                    },
                );
                (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("ASP down"),
                );

                await expect(session.discoverNotes()).resolves.toBeDefined();

                expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                    pendingNote.commitment,
                    NoteStatus.ACTIVE,
                );
                expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                    activeNote.commitment,
                    NoteStatus.REJECTED,
                );
            });

            describe("promotion needs on-chain evidence (audit F-01)", () => {
                const PENDING_COMMITMENT = ("0x" + "c1".repeat(32)) as Hash;
                const PENDING_LABEL = ("0x" + "d1".repeat(32)) as Hash;

                /**
                 * One PENDING note whose label is in the association set the ASP publishes
                 * in bulk, which is what vets the deposit. Evidence is what each test varies.
                 */
                function vettedPendingNote(): Note {
                    const note = makeOwnedNote(
                        PENDING_COMMITMENT,
                        PENDING_LABEL,
                        NoteStatus.PENDING,
                    );
                    (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                        (filter?: { status: NoteStatus }) =>
                            filter?.status === NoteStatus.PENDING ? [note] : [],
                    );
                    (
                        noteComputationService.computeLabelHash as ReturnType<typeof vi.fn>
                    ).mockImplementation((label: Hex) => label);
                    (
                        aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>
                    ).mockResolvedValue([PENDING_LABEL]);
                    return note;
                }

                /** A snapshot at `snapshotBlockNumber` whose deposits carry `commitments`. */
                function snapshotWith(
                    commitments: Hash[],
                    snapshotBlockNumber: Hex,
                ): EventSnapshot {
                    return {
                        chainId: "0x1" as Hex,
                        snapshotBlockNumber,
                        generatedAt: "1970-01-01T00:00:00.000Z",
                        deposits: commitments.map((outputCommitment) => ({
                            blockNumber: "0x10" as Hex,
                            txHash: MOCK_TX_HASH,
                            outputCommitment,
                        })) as never,
                        transacts: [],
                        ragequits: [],
                        leaves: [],
                        keystoreLeaves: [],
                    };
                }

                it("a vetted note the chain never saw stays PENDING", async () => {
                    // The attack: a note built from the recipient's own address and a real
                    // vetted label is internally consistent, so nothing before this point
                    // rejects it. A vetted label alone must not make it ACTIVE.
                    const note = vettedPendingNote();
                    (
                        aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>
                    ).mockResolvedValue(snapshotWith([], "0xffffffff" as Hex));

                    await session.discoverNotes();

                    expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                        note.commitment,
                        NoteStatus.ACTIVE,
                    );
                    // And the evidence came from bulk reads only — asking the chain about
                    // THIS commitment would name the note to the RPC.
                    expect(poolVaultInteractor.getCommitmentTimestamp).not.toHaveBeenCalledWith(
                        note.commitment,
                    );
                });

                it("the same note is promoted once the snapshot carries its deposit", async () => {
                    const note = vettedPendingNote();
                    (
                        aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>
                    ).mockResolvedValue(snapshotWith([PENDING_COMMITMENT], "0xffffffff" as Hex));

                    await session.discoverNotes();

                    expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                        note.commitment,
                        NoteStatus.ACTIVE,
                    );
                });

                it("a deposit newer than the snapshot is found in the chain tail", async () => {
                    const note = vettedPendingNote();
                    (
                        aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>
                    ).mockResolvedValue(snapshotWith([], "0x10" as Hex));
                    (
                        poolVaultInteractor.getDepositedEvents as ReturnType<typeof vi.fn>
                    ).mockResolvedValue([
                        { outputCommitment: PENDING_COMMITMENT, blockNumber: "0x20" as Hex },
                    ] as never);

                    await session.discoverNotes();

                    expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                        note.commitment,
                        NoteStatus.ACTIVE,
                    );
                });

                it("an unreadable chain tail keeps the note PENDING rather than trusting the set", async () => {
                    // Fail closed: an RPC outage must not become a promotion.
                    const note = vettedPendingNote();
                    (
                        aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>
                    ).mockResolvedValue(snapshotWith([], "0x10" as Hex));
                    (
                        poolVaultInteractor.getDepositedEvents as ReturnType<typeof vi.fn>
                    ).mockRejectedValue(new Error("rpc down"));

                    await session.discoverNotes();

                    expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                        note.commitment,
                        NoteStatus.ACTIVE,
                    );
                });
            });

            function makeSnapshot(overrides?: Partial<EventSnapshot>): EventSnapshot {
                return {
                    chainId: "0x1" as Hex,
                    snapshotBlockNumber: "0x0" as Hex,
                    generatedAt: "1970-01-01T00:00:00.000Z",
                    deposits: [],
                    transacts: [],
                    ragequits: [],
                    leaves: [],
                    keystoreLeaves: [],
                    ...overrides,
                };
            }

            /** Session wired to a logger, so fallback announcements can be asserted. */
            function sessionWithLogger(logger: ILogger): PoolSessionNoteDiscovery {
                return new PoolSessionNoteDiscovery(
                    {
                        ownerAddress: VALID_OWNER,
                        noteDiscoveryService,
                        noteManager,
                        keystoreManager,
                        poolVaultInteractor,
                        noteComputationService,
                        aspDataProvider,
                        aspClient,
                        addressFieldConverter: new TestAddressFieldConverter(),
                        paymentRequestService,
                    },
                    { logger },
                );
            }

            it("scan the chain tail from the snapshot block, bounded at the discovery head", async () => {
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({ snapshotBlockNumber: "0x20" as Hex }),
                );

                await session.discoverNotes();

                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    bigintToHex(0x20n),
                    MOCK_CURRENT_BLOCK,
                );
                expect(poolVaultInteractor.getRagequitEvents).toHaveBeenCalledWith(
                    bigintToHex(0x20n),
                    MOCK_CURRENT_BLOCK,
                );
            });

            it("warn when a failed snapshot turns status sync into a whole-range chain scan", async () => {
                // The silent version of this path restarts the scan at the caller's
                // fromBlock — on a first sync, every block since deployment — and looked
                // exactly like a healthy sync from the outside.
                const logger = createMockLogger();
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0x5" as Hex,
                );
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValue(
                    new Error("ASP down"),
                );

                await sessionWithLogger(logger).discoverNotes();

                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    "0x5",
                    MOCK_CURRENT_BLOCK,
                );
                const warnings = vi.mocked(logger.warn).mock.calls.map(([message]) => message);
                expect(warnings).toContainEqual(
                    expect.stringContaining("ASP event snapshot unavailable"),
                );
                expect(warnings).toContainEqual(expect.stringContaining("contributed no coverage"));
            });

            it("pull status coverage back to the earliest dropped snapshot row", async () => {
                // Dropped row at 0x30 => the snapshot is only trusted through 0x2f, so the
                // chain scan re-reads the range the lost row belonged to.
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        drops: {
                            transacts: { dropped: 1, earliestDroppedBlock: "0x30" as Hex },
                        },
                    }),
                );

                await session.discoverNotes();

                // Canonical padded hex — the value can land on `Note.spentAtBlock`.
                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    bigintToHex(0x2fn),
                    MOCK_CURRENT_BLOCK,
                );
            });

            it("mark a note SPENT from a snapshot row that carries no block number", async () => {
                // The end of the chain this fix protects: nullifier match -> SPENT, with
                // the scan's fromBlock standing in for the missing stamp. Drop the row
                // instead and the note stays ACTIVE and gets offered up for a second spend.
                const active = makeOwnedNote(MOCK_COMMITMENT_2, MOCK_LABEL, NoteStatus.ACTIVE);
                (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                    (filter?: { status: NoteStatus }) =>
                        filter?.status === undefined ? [active] : [],
                );
                // buildNullifierMap runs computeNullifier over the owned notes; the mock
                // returns MOCK_COMMITMENT_1 for any input, so that is the note's nullifier.
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        transacts: [
                            {
                                outputCommitments: [],
                                nullifierHashes: [MOCK_COMMITMENT_1],
                                blockNumber: null,
                            },
                        ] as unknown as EventSnapshot["transacts"],
                    }),
                );
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0x30" as Hex,
                );

                await session.discoverNotes();

                expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                    MOCK_COMMITMENT_2,
                    NoteStatus.SPENT,
                    "0x30",
                );
            });

            it("hold the scan floor at the sync cursor when a dropped row predates it", async () => {
                // A row the ASP keeps serving malformed at an old block must not drag every
                // later sync back to it: blocks below the cursor were reconciled already.
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0x40" as Hex,
                );
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        drops: {
                            transacts: { dropped: 1, earliestDroppedBlock: "0x10" as Hex },
                        },
                    }),
                );

                await session.discoverNotes();

                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    "0x40",
                    MOCK_CURRENT_BLOCK,
                );
            });

            it("scan the whole requested range when a dropped row's block is unknown", async () => {
                (noteManager.getSyncCursor as ReturnType<typeof vi.fn>).mockReturnValue(
                    "0x5" as Hex,
                );
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        drops: { ragequits: { dropped: 1, earliestDroppedBlock: null } },
                    }),
                );

                await session.discoverNotes();

                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    "0x5",
                    MOCK_CURRENT_BLOCK,
                );
            });

            it("not warn about narrowed coverage when nothing narrowed", async () => {
                // Persistent leaf-schema drift would otherwise warn on every single pass,
                // claiming a narrowing that never happened.
                const logger = createMockLogger();
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        drops: { leaves: { dropped: 2, earliestDroppedBlock: "0x10" as Hex } },
                    }),
                );

                await sessionWithLogger(logger).discoverNotes();

                const warnings = vi.mocked(logger.warn).mock.calls.map(([message]) => message);
                expect(warnings).not.toContainEqual(expect.stringContaining("coverage narrowed"));
            });

            it("keep full status coverage when drops miss the arrays status sync reads", async () => {
                // `leaves` / `keystoreLeaves` / `deposits` say nothing about whether an
                // owned note was spent, so losing one of those rows must not cost the
                // client the snapshot's transact and ragequit coverage.
                (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(
                    makeSnapshot({
                        snapshotBlockNumber: "0x50" as Hex,
                        drops: {
                            keystoreLeaves: { dropped: 3, earliestDroppedBlock: "0x10" as Hex },
                        },
                    }),
                );

                await session.discoverNotes();

                expect(poolVaultInteractor.getTransactedEvents).toHaveBeenCalledWith(
                    bigintToHex(0x50n),
                    MOCK_CURRENT_BLOCK,
                );
            });
        });
    });

    // RC-04 (#501 + #540): ASP label-status is reversible, so a note demoted to
    // REJECTED must be recoverable, and a lone unverified "rejected" response must
    // not strand a spendable note. Recovery reconciles on-chain spend state FIRST
    // so an already-spent note can never be double-counted back into the balance.
    describe("ASP rejection recovery (RC-04)", () => {
        const REJECTED_COMMITMENT = ("0x" + "c1".repeat(32)) as Hash;
        const REJECTED_LABEL = ("0x" + "d1".repeat(32)) as Hash;
        const SPENT_NULLIFIER = ("0x" + "e1".repeat(32)) as Hash;

        function makeOwnedNote(commitment: Hash, label: Hash, status: NoteStatus): Note {
            return {
                noteAddressHash: MOCK_COMMITMENT_1,
                commitment,
                value: MOCK_VALUE,
                tokenId: MOCK_TOKEN_ID,
                label,
                status,
                ownerAddress: VALID_OWNER,
                noteSecret: MOCK_NOTE_SECRET,
                isOwned: true,
                createdAtBlock: MOCK_TIMESTAMP,
                spentAtBlock: null,
                txHash: MOCK_TX_HASH,
            };
        }

        // Routes getNotes(): unfiltered returns all; filtered returns by status.
        function stubNotes(notes: Note[]): void {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockImplementation(
                (filter?: { status: NoteStatus }) =>
                    filter?.status === undefined
                        ? notes
                        : notes.filter((n) => n.status === filter.status),
            );
        }

        beforeEach(() => {
            // Identity label-hash so association-set membership is testable directly.
            (
                noteComputationService.computeLabelHash as ReturnType<typeof vi.fn>
            ).mockImplementation((label: Hex) => label);
        });

        it("recover a rejected note to active when its label is re-approved and it is unspent on-chain", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.REJECTED);
            stubNotes([note]);
            // Label back in the association set; no on-chain spend of this note.
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.ACTIVE,
            );
        });

        it("keep a rejected-but-spent note out of active, moving it to spent (the double-count guard)", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.REJECTED);
            stubNotes([note]);
            // This note's nullifier is spent on-chain.
            (noteComputationService.computeNullifier as ReturnType<typeof vi.fn>).mockReturnValue(
                SPENT_NULLIFIER,
            );
            (poolVaultInteractor.getTransactedEvents as ReturnType<typeof vi.fn>).mockResolvedValue(
                [
                    {
                        nullifierHashes: [SPENT_NULLIFIER],
                        outputCommitments: [],
                        blockNumber: "0x50" as Hex,
                        txHash: MOCK_TX_HASH,
                    },
                ],
            );
            // Label back in the set — recovery must STILL refuse to re-activate.
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);

            await session.discoverNotes();

            // On-chain spend reconciliation demotes the rejected note to SPENT...
            expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.SPENT,
                "0x50",
            );
            // ...and it is NEVER restored to ACTIVE (double-count guard).
            expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.ACTIVE,
            );
        });

        // #540. The corroborating read MUST go through the root-verifying client. The ASP is
        // trusted, but its status and leaves endpoints are separate reads that can disagree —
        // a lagging replica or a snapshot served mid-rebuild. Corroborating against an
        // unverified leaf set from the same service just confirms a stale view of itself;
        // checking the reconstructed root against the chain is what makes it real evidence.
        it("read membership through the root-verified client, never the raw provider", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.ACTIVE);
            stubNotes([note]);
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            await session.discoverNotes();

            expect(aspClient.getAssociationSetLeaves).toHaveBeenCalled();
            expect(aspDataProvider.getLeaves).not.toHaveBeenCalled();
        });

        // #501. The reconciled `spentNullifiers` set is only as complete as the event feed it is
        // built from: a snapshot that lags the chain can omit a recent spend, and when the
        // snapshot fetch fails the chain scan resumes from the sync cursor, so older spends are
        // invisible. The authoritative PoolVault.spentNullifiers read closes the double-count.
        it("not recover a note whose nullifier is spent on-chain but missing from the event set", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.REJECTED);
            stubNotes([note]);
            (noteComputationService.computeNullifier as ReturnType<typeof vi.fn>).mockReturnValue(
                SPENT_NULLIFIER,
            );
            // The event feed shows NO spend — this is the dishonest/incomplete-snapshot case.
            (poolVaultInteractor.getTransactedEvents as ReturnType<typeof vi.fn>).mockResolvedValue(
                [],
            );
            // ...but the authoritative on-chain mapping says the nullifier was consumed.
            (
                poolVaultInteractor.getNullifierTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValue("0x68000000" as Hash);
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.ACTIVE,
            );
        });

        // #501. The authoritative read fails CLOSED — an RPC error must be read as "spent" so
        // recovery is skipped, not as "unspent" so it proceeds. Skipping is safe and reversible
        // (the note stays REJECTED and is retried next scan); re-activating on an unanswered
        // question double-counts a possibly-spent note into the spendable balance. Only a test
        // pins which way the catch falls: a `return true` flipped to `return false` is a
        // one-character change that no other assertion here would notice.
        it("not recover a rejected note when the on-chain spend check itself fails", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.REJECTED);
            stubNotes([note]);
            // Label is approved and the event feed shows no spend, so every cheap filter says
            // "recover" — the authoritative read is the only thing standing in the way, and it
            // cannot answer.
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);
            (poolVaultInteractor.getTransactedEvents as ReturnType<typeof vi.fn>).mockResolvedValue(
                [],
            );
            (
                poolVaultInteractor.getNullifierTimestamp as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("RPC unavailable"));

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.ACTIVE,
            );
        });

        // #501. The mass-recovery case the batching exists for is also the case an unbounded
        // fan-out breaks: an ASP outage or over-broad revocation leaves hundreds of notes
        // REJECTED at once, and hundreds of simultaneous eth_calls is what providers throttle.
        // Because every rejection is mapped to fail-closed, a throttled burst recovers NOTHING —
        // so the cap is what keeps the feature working at scale, not a micro-optimisation. Two
        // properties have to hold together: the cap is real, and nothing is dropped from the
        // sweep. Asserting only the cap would pass for an implementation that checks the first
        // batch and forgets the rest.
        it("check every candidate while keeping the on-chain spend reads under the concurrency cap", async () => {
            const CANDIDATES = 20; // > the cap, so at least three batches
            const notes = Array.from({ length: CANDIDATES }, (_, i) =>
                makeOwnedNote(
                    ("0x" + i.toString(16).padStart(2, "0").repeat(32)) as Hash,
                    REJECTED_LABEL,
                    NoteStatus.REJECTED,
                ),
            );
            stubNotes(notes);
            (
                noteComputationService.computeNullifier as ReturnType<typeof vi.fn>
            ).mockImplementation((_key: Hex, commitment: Hash) => commitment);
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);
            (poolVaultInteractor.getTransactedEvents as ReturnType<typeof vi.fn>).mockResolvedValue(
                [],
            );

            let inFlight = 0;
            let peakInFlight = 0;
            (
                poolVaultInteractor.getNullifierTimestamp as ReturnType<typeof vi.fn>
            ).mockImplementation(async () => {
                inFlight++;
                peakInFlight = Math.max(peakInFlight, inFlight);
                // Yield so overlapping calls actually observe each other; a synchronous resolve
                // would show a peak of 1 no matter how the reads were issued.
                await Promise.resolve();
                inFlight--;
                return "0x0" as Hash;
            });

            await session.discoverNotes();

            expect(poolVaultInteractor.getNullifierTimestamp).toHaveBeenCalledTimes(CANDIDATES);
            expect(peakInFlight).toBeGreaterThan(1); // genuinely batched, not serialized
            expect(peakInFlight).toBeLessThanOrEqual(8); // NULLIFIER_SPEND_CHECK_CONCURRENCY
            // ...and every one of them is still recovered, so the cap costs no coverage.
            for (const note of notes) {
                expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                    note.commitment,
                    NoteStatus.ACTIVE,
                );
            }
        });

        it("keep an active note whose label is still in the association set", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.ACTIVE);
            stubNotes([note]);
            // Present in the root-verified association set the ASP proves against. Membership
            // is read through aspClient (root-checked against the on-chain latestASPRoot),
            // never the raw provider's unverified getLeaves (#540).
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([
                REJECTED_LABEL,
            ]);

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.REJECTED,
            );
        });

        it("demote an active note when its label is absent from the association set", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.ACTIVE);
            stubNotes([note]);
            // The label was in the set (that is what made the note ACTIVE) and is no longer.
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockResolvedValue([]);

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.REJECTED,
            );
        });

        it("defer demotion when the association set is unavailable", async () => {
            const note = makeOwnedNote(REJECTED_COMMITMENT, REJECTED_LABEL, NoteStatus.ACTIVE);
            stubNotes([note]);
            (aspClient.getAssociationSetLeaves as ReturnType<typeof vi.fn>).mockRejectedValue(
                new Error("ASP down"),
            );

            await session.discoverNotes();

            expect(noteManager.updateNoteStatus).not.toHaveBeenCalledWith(
                REJECTED_COMMITMENT,
                NoteStatus.REJECTED,
            );
        });
    });

    describe("purgePhantomNotes", () => {
        const PHANTOM_COMMITMENT =
            "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as Hash;
        const REAL_DEPOSIT_COMMITMENT = MOCK_COMMITMENT_1;
        const REAL_TRANSACT_COMMITMENT = MOCK_COMMITMENT_2;
        const TAIL_DEPOSIT_COMMITMENT =
            "0xcafecafecafecafecafecafecafecafecafecafecafecafecafecafecafecafe" as Hash;
        const TAIL_TRANSACT_COMMITMENT =
            "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as Hash;

        function makeStoredNote(commitment: Hash): Note {
            return {
                commitment,
                label: MOCK_LABEL,
                value: MOCK_VALUE,
                tokenId: MOCK_TOKEN_ID,
                status: NoteStatus.ACTIVE,
                ownerAddress: VALID_OWNER,
                noteSecret: MOCK_NOTE_SECRET,
                noteAddressHash: MOCK_COMMITMENT_1,
                isOwned: true,
                createdAtBlock: "0x68000000" as Hex,
                spentAtBlock: null,
                txHash: MOCK_TX_HASH,
            };
        }

        it("return empty array when there are no local notes", async () => {
            const result = await session.purgePhantomNotes();
            expect(result).toEqual([]);
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("delete a note whose commitment is not on-chain", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce("0x0" as Hash);

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([PHANTOM_COMMITMENT]);
            expect(poolVaultInteractor.getCommitmentTimestamp).toHaveBeenCalledWith(
                PHANTOM_COMMITMENT,
            );
            expect(noteManager.deleteNote).toHaveBeenCalledWith(PHANTOM_COMMITMENT);
            expect(noteManager.flush).toHaveBeenCalledOnce();
        });

        it("keep a note whose commitment appears in snapshot.deposits", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(REAL_DEPOSIT_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: MOCK_CURRENT_BLOCK,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [
                    {
                        outputCommitment: REAL_DEPOSIT_COMMITMENT,
                        txHash: MOCK_TX_HASH,
                        logIndex: 0,
                        depositAddress: VALID_OWNER,
                        depositedValue: MOCK_VALUE,
                        fee: "0x0",
                        blockNumber: "0xa",
                        blockTimestamp: "1970-01-01T00:00:00.000Z",
                        asset: MOCK_TOKEN_ID,
                    },
                ],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
            });

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("keep a note whose commitment appears in snapshot.transacts.outputCommitments", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(REAL_TRANSACT_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: MOCK_CURRENT_BLOCK,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [
                    {
                        outputCommitments: [REAL_TRANSACT_COMMITMENT],
                        nullifierHashes: [],
                        caller: VALID_OWNER,
                        withdrawnValue: "0x0",
                        encryptedPayload: null,
                        blockNumber: "0xa",
                        blockTimestamp: "1970-01-01T00:00:00.000Z",
                        asset: MOCK_TOKEN_ID,
                        txHash: MOCK_TX_HASH,
                        logIndex: 0,
                    },
                ],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
            });

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
        });

        it("keep a note whose commitment appears only in tail Deposited events", async () => {
            // Snapshot is empty at block 0; tail catch-up runs 0x1..currentBlock.
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(TAIL_DEPOSIT_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getDepositedEvents as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce([
                {
                    blockNumber: "0x10" as Hex,
                    txHash: MOCK_TX_HASH,
                    outputCommitment: TAIL_DEPOSIT_COMMITMENT,
                    asset: MOCK_TOKEN_ID,
                    depositedValue: MOCK_VALUE,
                    caller: VALID_OWNER,
                },
            ]);

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(poolVaultInteractor.getDepositedEvents).toHaveBeenCalledWith(
                "0x1" as Hex,
                MOCK_CURRENT_BLOCK,
            );
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
        });

        it("keep a note whose commitment appears only in tail Transacted outputs", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(TAIL_TRANSACT_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getTransactedEvents as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce([
                {
                    blockNumber: "0x10" as Hex,
                    txHash: MOCK_TX_HASH,
                    outputCommitments: [TAIL_TRANSACT_COMMITMENT],
                    nullifierHashes: [],
                    asset: MOCK_TOKEN_ID,
                    withdrawnValue: "0x0",
                    caller: VALID_OWNER,
                },
            ]);

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
        });

        it("skip tail scan when snapshot is at or past chain head", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: MOCK_CURRENT_BLOCK,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
            });
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce("0x0" as Hash);

            await session.purgePhantomNotes();

            expect(poolVaultInteractor.getDepositedEvents).not.toHaveBeenCalled();
            expect(poolVaultInteractor.getTransactedEvents).not.toHaveBeenCalled();
            expect(noteManager.deleteNote).toHaveBeenCalledWith(PHANTOM_COMMITMENT);
        });

        it("fall back to full chain scan when ASP snapshot is unavailable", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(TAIL_DEPOSIT_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error("ASP unreachable"),
            );
            (
                poolVaultInteractor.getDepositedEvents as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce([
                {
                    blockNumber: "0x10" as Hex,
                    txHash: MOCK_TX_HASH,
                    outputCommitment: TAIL_DEPOSIT_COMMITMENT,
                    asset: MOCK_TOKEN_ID,
                    depositedValue: MOCK_VALUE,
                    caller: VALID_OWNER,
                },
            ]);

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(poolVaultInteractor.getDepositedEvents).toHaveBeenCalledWith(
                "0x0" as Hex,
                MOCK_CURRENT_BLOCK,
            );
        });

        it("widen the tail scan to the earliest dropped snapshot row", async () => {
            // A dropped `deposits`/`transacts` row is a commitment missing from the
            // on-chain set the purge compares against — i.e. a real note that now looks
            // like a phantom. The scan must reach back over it.
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(TAIL_DEPOSIT_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: "0x50" as Hex,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
                drops: { deposits: { dropped: 1, earliestDroppedBlock: "0x30" as Hex } },
            });

            await session.purgePhantomNotes();

            expect(poolVaultInteractor.getDepositedEvents).toHaveBeenCalledWith(
                "0x30" as Hex,
                MOCK_CURRENT_BLOCK,
            );
        });

        it("fall back to full chain scan when a dropped snapshot row's block is unknown", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(TAIL_DEPOSIT_COMMITMENT),
            ]);
            (aspDataProvider.getEventSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: "0x50" as Hex,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
                drops: { transacts: { dropped: 1, earliestDroppedBlock: null } },
            });

            await session.purgePhantomNotes();

            expect(poolVaultInteractor.getDepositedEvents).toHaveBeenCalledWith(
                "0x0" as Hex,
                MOCK_CURRENT_BLOCK,
            );
        });

        it("keep a candidate when on-chain getCommitmentTimestamp returns non-zero", async () => {
            // ASP+tail miss the commitment, but the chain itself says it exists.
            // Defense against ASP indexing gaps — must not delete on uncertainty.
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce("0x68000000" as Hash);

            const result = await session.purgePhantomNotes();

            expect(result).toEqual([]);
            expect(poolVaultInteractor.getCommitmentTimestamp).toHaveBeenCalledWith(
                PHANTOM_COMMITMENT,
            );
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("return would-purge set without mutating state when dryRun is true", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce("0x0" as Hash);

            const result = await session.purgePhantomNotes({ dryRun: true });

            expect(result).toEqual([PHANTOM_COMMITMENT]);
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("run the full pipeline including on-chain double-check in dryRun mode", async () => {
            // Dry-run must produce the same set the destructive run would —
            // including the on-chain confirmation step. A candidate that
            // would be spared in a real run must also be spared here.
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockResolvedValueOnce("0x68000000" as Hash);

            const result = await session.purgePhantomNotes({ dryRun: true });

            expect(result).toEqual([]);
            expect(poolVaultInteractor.getCommitmentTimestamp).toHaveBeenCalledWith(
                PHANTOM_COMMITMENT,
            );
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
        });

        it("abort entire purge when getCommitmentTimestamp throws", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (
                poolVaultInteractor.getCommitmentTimestamp as ReturnType<typeof vi.fn>
            ).mockRejectedValueOnce(new Error("rpc flaked"));

            await expect(session.purgePhantomNotes()).rejects.toBeInstanceOf(
                NoteDiscoveryScanFailed,
            );
            expect(noteManager.deleteNote).not.toHaveBeenCalled();
            expect(noteManager.flush).not.toHaveBeenCalled();
        });

        it("wrap underlying failures as NoteDiscoveryScanFailed", async () => {
            (noteManager.getNotes as ReturnType<typeof vi.fn>).mockReturnValue([
                makeStoredNote(PHANTOM_COMMITMENT),
            ]);
            (poolVaultInteractor.getCurrentCursor as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
                new Error("rpc dead"),
            );

            await expect(session.purgePhantomNotes()).rejects.toBeInstanceOf(
                NoteDiscoveryScanFailed,
            );
        });
    });
});
