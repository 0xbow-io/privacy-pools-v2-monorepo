import { beforeAll, describe, expect, it, vi } from "vitest";

import type {
    Address,
    EventSnapshot,
    Hash,
    Hex,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    INoteManager,
    IPaymentRequestStorageAdapter,
    IPoolVaultInteractor,
    KeyPair,
    Note,
    NoteEvent,
    PaymentRequestNotePayload,
    PaymentRequestServiceState,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import {
    CryptoService,
    decodeNoteData,
    EvmAddressFieldConverter,
    NoteComputationService,
    NoteDiscoveryService,
    NoteNotFoundError,
    NoteStatus,
    PaymentRequestService,
    PoolSessionNoteDiscovery,
    PoseidonHashService,
} from "../../../src/internal.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regression — FINDING-600 (Medium)
//
// Ported from the confirmed PoC (PaymentRequestTerminalFlipPoC), inverted so it
// now asserts the FIX: a payment request's FULFILLED display status must NOT gate
// discovery, so an attacker's cheap dust phantom can flip the request to FULFILLED
// yet the genuine sender's later payment note is STILL discovered.
//
// The judge is the REAL, post-fix discovery + state machine:
//   - PaymentRequestService  (generate / getScannableRequests / markFulfilled / archive)
//   - NoteDiscoveryService   (scanPaymentRequests / processPaymentRequestEvent)
//   - PoolSessionNoteDiscovery (the scan loop — now gated on getScannableRequests())
//   - NoteComputationService + CryptoService + PoseidonHashService (real crypto/codec)
//
// Only the environment is mocked. No production behavior is stubbed. The attacker
// crafts its Note event through the SAME production encryption path an honest
// sender uses, fed ONLY the public request fields.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const TOKEN_ID = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const AMOUNT = "0x100" as Hex;

const HONEST_LABEL = ("0x" + "00".repeat(31) + "2a") as Hex; // 42
const ATTACKER_LABEL = ("0x" + "00".repeat(31) + "07") as Hex; // 7

const HONEST_VALUE = "0x64" as Hex; // 100 — a genuine payment
const ATTACKER_VALUE = "0x01" as Hex; // 1 wei dust — a throwaway phantom

const CURRENT_BLOCK = "0x1000" as Hex;
const SCAN_FROM = "0x1" as Hex;
const NONZERO_TIMESTAMP = "0x68000000" as Hex;

/** The by-design PUBLIC, shareable payload (what an attacker holds from a QR/link). */
interface PublicPaymentRequest {
    tag: Hex;
    paymentPubKey: PublicKey;
    noteAddressHashes: Hash[];
    tokenId: Address;
}

let cryptoService: CryptoService;
let hashService: PoseidonHashService;
let noteComputationService: NoteComputationService;
let recipientViewingKeyPair: KeyPair;
let nullifyingKey: Secret;

beforeAll(async () => {
    cryptoService = new CryptoService();
    hashService = await PoseidonHashService.create();
    noteComputationService = new NoteComputationService({ hashService, cryptoService });
    recipientViewingKeyPair = cryptoService.generateEphemeralKeyPair();
    nullifyingKey = cryptoService.generateSecret();
});

function createInMemoryStorageAdapter(): IPaymentRequestStorageAdapter {
    let state: PaymentRequestServiceState | null = null;
    return {
        getState: vi.fn(async () => state),
        saveState: vi.fn(async (s: PaymentRequestServiceState) => {
            state = s;
        }),
        clearState: vi.fn(async () => {
            state = null;
        }),
    };
}

function createKeystoreManager(): IKeystoreManager {
    return {
        getViewingKeyPair: vi.fn(() => recipientViewingKeyPair),
        getPrivateNullifyingKey: vi.fn(() => nullifyingKey),
        getPrivateRevocableKey: vi.fn(() => nullifyingKey),
        getRevocableKeyIndex: vi.fn(() => "0x0" as Hex),
        applyRotation: vi.fn(),
        isRegistered: vi.fn(),
        markRegistered: vi.fn(),
    };
}

function createInMemoryNoteManager(): INoteManager & { store: Map<Hex, Note> } {
    const store = new Map<Hex, Note>();
    let cursor = "0x0" as Hex;
    const manager = {
        store,
        addNote: vi.fn((note: Note) => {
            store.set(note.commitment, note);
        }),
        getNote: vi.fn((commitment: Hex): Note => {
            const n = store.get(commitment);
            if (!n) throw new NoteNotFoundError(commitment);
            return n;
        }),
        getNotes: vi.fn((filter?: { status?: NoteStatus }): Note[] => {
            const all = Array.from(store.values());
            if (!filter?.status) return all;
            return all.filter((n) => n.status === filter.status);
        }),
        updateNoteStatus: vi.fn((commitment: Hex, status: NoteStatus, block?: Hex) => {
            const n = store.get(commitment);
            if (n) store.set(commitment, { ...n, status, spentAtBlock: block ?? n.spentAtBlock });
        }),
        deleteNote: vi.fn((commitment: Hex) => {
            store.delete(commitment);
        }),
        getSyncCursor: vi.fn(() => cursor),
        setSyncCursor: vi.fn((c: Hex) => {
            cursor = c;
        }),
        flush: vi.fn(async () => undefined),
        updateNote: vi.fn(),
        getNoteLineage: vi.fn(),
        getAllLineages: vi.fn(() => []),
        computeAggregates: vi.fn(),
        exportState: vi.fn(),
        importState: vi.fn(),
        loadFromStorage: vi.fn(async () => undefined),
    };
    return manager as unknown as INoteManager & { store: Map<Hex, Note> };
}

function createPoolVaultInteractor(): IPoolVaultInteractor {
    return {
        getAddress: vi.fn(() => "0x0000000000000000000000000000000000000000" as Address),
        getCurrentCursor: vi.fn(async () => CURRENT_BLOCK),
        resolveTokenId: vi.fn(async (fieldValue) => fieldValue as unknown as Address),
        getCommitmentTimestamp: vi.fn(async () => NONZERO_TIMESTAMP),
        // "0x0" = unspent. The #501 recovery guard reads this authoritatively before restoring a
        // rejected note to ACTIVE, so a bare vi.fn() (resolving undefined) would make every
        // nullifier classify as spent via the fail-closed catch — passing for the wrong reason.
        getNullifierTimestamp: vi.fn(async () => "0x0" as Hash),
        isKnownRoot: vi.fn(),
        getStateLeaves: vi.fn(async () => []),
        getNoteEvents: vi.fn(async () => []),
        getTransactedEvents: vi.fn(async () => []),
        getDepositedEvents: vi.fn(async () => []),
        getRagequitEvents: vi.fn(async () => []),
        encodeRagequit: vi.fn(),
        encodeTransact: vi.fn(),
        submitTransaction: vi.fn(),
    } as unknown as IPoolVaultInteractor;
}

function createASPDataProvider(): IASPDataProvider {
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
        getLabelStatus: vi.fn(async () => {
            throw new Error("ASP offline (test)");
        }),
        getASPPublicKey: vi.fn(),
        getEventSnapshot: vi.fn(async () => emptySnapshot),
        getNoteEvents: vi.fn(async () => ({ events: [], lastSyncedBlock: "0x0" as Hex })),
    };
}

function buildHarness(): {
    paymentRequestService: PaymentRequestService;
    noteDiscoveryService: NoteDiscoveryService;
    discovery: PoolSessionNoteDiscovery;
    noteManager: INoteManager & { store: Map<Hex, Note> };
    poolVaultInteractor: IPoolVaultInteractor;
} {
    const storageAdapter = createInMemoryStorageAdapter();
    const keystoreManager = createKeystoreManager();
    const noteManager = createInMemoryNoteManager();
    const poolVaultInteractor = createPoolVaultInteractor();
    const aspDataProvider = createASPDataProvider();
    // Root-verifying client used for #540 rejection corroboration (not the raw provider).
    const aspClient = {
        getAssociationSetRoot: async () => "0x0" as Hash,
        getAssociationSetLeaves: async () => [],
        getMerkleProof: vi.fn(),
        getLabelStatus: vi.fn(),
        getASPPublicKey: vi.fn(),
    } as unknown as IASPClient;

    const paymentRequestService = new PaymentRequestService({
        ownerAddress: OWNER_ADDRESS,
        cryptoService,
        hashService,
        noteComputationService,
        keystoreManager,
        storageAdapter,
    });

    const noteDiscoveryService = new NoteDiscoveryService({
        cryptoService,
        hashService,
        noteComputationService,
        addressFieldConverter: new EvmAddressFieldConverter(),
    });

    const discovery = new PoolSessionNoteDiscovery({
        ownerAddress: OWNER_ADDRESS,
        noteDiscoveryService,
        noteManager,
        keystoreManager,
        poolVaultInteractor,
        noteComputationService,
        aspDataProvider,
        aspClient,
        addressFieldConverter: new EvmAddressFieldConverter(),
        paymentRequestService,
    });

    return {
        paymentRequestService,
        noteDiscoveryService,
        discovery,
        noteManager,
        poolVaultInteractor,
    };
}

function craftPaymentNoteEvent(
    pub: PublicPaymentRequest,
    slotIndex: number,
    value: Hex,
    label: Hex,
    blockNumber: Hex,
    txHash: Hash,
): NoteEvent {
    const payload: PaymentRequestNotePayload = {
        noteAddressHash: pub.noteAddressHashes[slotIndex],
        value,
        tokenId: pub.tokenId,
        label,
    };
    const noteData = noteComputationService.generatePaymentRequestNoteData(
        payload,
        pub.paymentPubKey,
        pub.tag,
    );
    const { ephemeralPubKey, encryptedPayload } = decodeNoteData(noteData.data);
    return { blockNumber, txHash, hint: noteData.hint, ephemeralPubKey, encryptedPayload };
}

describe("PaymentRequest terminal-flip discovery suppression fixed (FINDING-600)", () => {
    it("discover the genuine payment note when the request has NOT been pre-flipped (honest control)", async () => {
        const { paymentRequestService, discovery, noteManager, poolVaultInteractor } =
            buildHarness();

        const record = await paymentRequestService.generate({
            amount: AMOUNT,
            tokenId: TOKEN_ID,
            slots: 2,
        });
        expect(record.status).toBe("OPEN");

        const pub: PublicPaymentRequest = {
            tag: record.tag,
            paymentPubKey: record.paymentPubKey,
            noteAddressHashes: record.noteAddressHashes,
            tokenId: record.tokenId,
        };

        const genuineEvent = craftPaymentNoteEvent(
            pub,
            0,
            HONEST_VALUE,
            HONEST_LABEL,
            "0x10" as Hex,
            ("0x" + "a1".repeat(32)) as Hash,
        );
        (poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            genuineEvent,
        ]);

        const discovered = await discovery.discoverNotes({ fromBlock: SCAN_FROM });

        expect(discovered).toHaveLength(1);
        expect(discovered[0].value).toBe(HONEST_VALUE);
        expect(noteManager.store.size).toBe(1);
        const stored = Array.from(noteManager.store.values())[0];
        expect(stored.value).toBe(HONEST_VALUE);
        expect(stored.status).toBe(NoteStatus.PENDING);
    });

    it("STILL discover the genuine payment note after an attacker dust phantom flips the request to FULFILLED", async () => {
        const {
            paymentRequestService,
            noteDiscoveryService,
            discovery,
            noteManager,
            poolVaultInteractor,
        } = buildHarness();

        const record = await paymentRequestService.generate({
            amount: AMOUNT,
            tokenId: TOKEN_ID,
            slots: 2,
        });
        expect(record.status).toBe("OPEN");
        expect(await paymentRequestService.getScannableRequests()).toHaveLength(1);

        const pub: PublicPaymentRequest = {
            tag: record.tag,
            paymentPubKey: record.paymentPubKey,
            noteAddressHashes: record.noteAddressHashes,
            tokenId: record.tokenId,
        };

        const scanSpy = vi.spyOn(noteDiscoveryService, "scanPaymentRequests");

        // ── Attack: attacker crafts a dust phantom against slot 0 from public data alone. ──
        const attackerEvent = craftPaymentNoteEvent(
            pub,
            0,
            ATTACKER_VALUE,
            ATTACKER_LABEL,
            "0x11" as Hex,
            ("0x" + "de".repeat(32)) as Hash,
        );
        (poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            attackerEvent,
        ]);

        const attackDiscovered = await discovery.discoverNotes({ fromBlock: SCAN_FROM });

        // A phantom note was stored, and the request flipped to the FULFILLED DISPLAY state.
        expect(attackDiscovered).toHaveLength(1);
        const phantomCommitment = attackDiscovered[0].commitment;
        const fulfilled = await paymentRequestService.list({ status: "FULFILLED" });
        expect(fulfilled).toHaveLength(1);
        expect(fulfilled[0].paymentId).toBe(record.paymentId);

        // THE FIX: a FULFILLED request stays in the scan set — it is bounded only by
        // archive + expiry, never by an attacker-craftable flip.
        expect(await paymentRequestService.getScannableRequests()).toHaveLength(1);

        // ── Genuine sender pays a different slot in a later scan window. ──
        scanSpy.mockClear();
        const genuineEvent = craftPaymentNoteEvent(
            pub,
            1,
            HONEST_VALUE,
            HONEST_LABEL,
            "0x900" as Hex,
            ("0x" + "a2".repeat(32)) as Hash,
        );
        (poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            genuineEvent,
        ]);

        const laterDiscovered = await discovery.discoverNotes({ fromBlock: SCAN_FROM });

        // 1. scanPaymentRequests is now invoked WITH the (still-scannable) request — the
        //    genuine event is inspected against the payment-request matcher.
        expect(scanSpy).toHaveBeenCalledTimes(1);
        const [scannedEvents, scannedRequests] = scanSpy.mock.calls[0];
        expect(scannedEvents).toEqual([genuineEvent]);
        expect(scannedRequests).toHaveLength(1);
        expect(scannedRequests[0].paymentId).toBe(record.paymentId);

        // 2. The genuine note IS discovered and stored.
        const genuineCommitment = noteComputationService.computeFullCommitment({
            noteAddressHash: pub.noteAddressHashes[1],
            tokenId: pub.tokenId,
            value: HONEST_VALUE,
            label: HONEST_LABEL,
        });
        expect(laterDiscovered).toHaveLength(1);
        expect(laterDiscovered[0].value).toBe(HONEST_VALUE);
        expect(noteManager.store.has(genuineCommitment)).toBe(true);

        // Local state now holds BOTH the phantom and the genuine note.
        expect(noteManager.store.size).toBe(2);
        expect(noteManager.store.has(phantomCommitment)).toBe(true);
    });

    it("stop scanning a request once the recipient archives it", async () => {
        const { paymentRequestService, discovery, noteManager, poolVaultInteractor } =
            buildHarness();

        const record = await paymentRequestService.generate({
            amount: AMOUNT,
            tokenId: TOKEN_ID,
            slots: 2,
        });

        // Recipient explicitly archives — the ONLY user-driven terminal transition.
        await paymentRequestService.archive(record.paymentId);
        expect(await paymentRequestService.getScannableRequests()).toHaveLength(0);

        const pub: PublicPaymentRequest = {
            tag: record.tag,
            paymentPubKey: record.paymentPubKey,
            noteAddressHashes: record.noteAddressHashes,
            tokenId: record.tokenId,
        };
        const event = craftPaymentNoteEvent(
            pub,
            0,
            HONEST_VALUE,
            HONEST_LABEL,
            "0x10" as Hex,
            ("0x" + "a1".repeat(32)) as Hash,
        );
        (poolVaultInteractor.getNoteEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
            event,
        ]);

        const discovered = await discovery.discoverNotes({ fromBlock: SCAN_FROM });

        // Archived request is excluded from the payment-request scan; nothing is discovered.
        expect(discovered).toHaveLength(0);
        expect(noteManager.store.size).toBe(0);
    });
});
