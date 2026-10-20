import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { beforeAll, describe, expect, it } from "vitest";

import type {
    Address,
    FinalizedBlockResult,
    Hash,
    Hex,
    IASPClient,
    IASPDataProvider,
    IKeystoreManager,
    IPaymentRequestService,
    IPoolVaultInteractor,
    IRPCInteractor,
    LabelStatus,
    NoteEvent,
    NotePayload,
    PendingNote,
    PublicKey,
    Secret,
} from "../../src/internal.js";
import {
    AddressSchema,
    CATCH_ALL_TAG,
    CryptoService,
    EvmAddressFieldConverter,
    NoteComputationService,
    NoteDiscoveryService,
    NoteManager,
    NoteStatus,
    PoolSessionNoteDiscovery,
    PoolSessionNoteManager,
    PoseidonHashService,
} from "../../src/internal.js";

/**
 * Integration tests for note discovery using real cryptographic services.
 *
 * Tests the full catch-all discovery pipeline:
 *   CryptoService (ECDH + XChaCha20-Poly1305) → NoteDiscoveryService → PoolSessionNoteDiscovery → NoteManager
 *
 * Simulates realistic scenarios: deposits, transfers, re-transfers, and
 * recovery of all notes via catch-all scanning.
 */

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generates a deterministic hex secret from an index (for test reproducibility). */
function deterministicSecret(index: number): Secret {
    // Encode the index in the low bytes (high bytes zero) so the value equals `index` and is
    // always a canonical BN254 field element (< p), keeping test secrets deterministic and in-field.
    return `0x${index.toString(16).padStart(64, "0")}` as Secret;
}

/** Generates a deterministic commitment hash from an index. */
function deterministicHash(index: number): Hash {
    return `0x${index.toString(16).padStart(64, "0")}` as Hash;
}

/**
 * Encrypts a NotePayload and returns a NoteEvent.
 * Uses ECDH between an ephemeral key pair and the recipient's viewing public key.
 */
function makeEncryptedEvent(
    crypto: CryptoService,
    noteComputation: NoteComputationService,
    recipientViewingPubKey: PublicKey,
    payload: NotePayload,
    ephemeralPrivKey: Secret,
    opts: { blockNumber: Hex; txHash: Hash; asset: Address },
): NoteEvent {
    const privKeyBytes = hexToBytes(ephemeralPrivKey.slice(2));
    const pubKeyBytes = x25519.getPublicKey(privKeyBytes);
    const ephemeralPubKey = `0x${bytesToHex(pubKeyBytes)}` as PublicKey;

    const sharedSecret = crypto.ecdh(ephemeralPrivKey, recipientViewingPubKey);
    const payloadBytes = noteComputation.encodeNotePayload(payload);
    const encryptedPayload = crypto.encrypt(payloadBytes, sharedSecret);

    return {
        blockNumber: opts.blockNumber,
        txHash: opts.txHash,
        hint: CATCH_ALL_TAG,
        ephemeralPubKey,
        encryptedPayload,
    };
}

/**
 * Creates multiple NoteEvents from multiple payloads (one event per output note).
 */
function makeMultiOutputEvents(
    crypto: CryptoService,
    noteComputation: NoteComputationService,
    recipientViewingPubKey: PublicKey,
    payloads: NotePayload[],
    ephemeralPrivKeys: Secret[],
    opts: { blockNumber: Hex; txHash: Hash; asset: Address },
): NoteEvent[] {
    return payloads.map((payload, i) =>
        makeEncryptedEvent(
            crypto,
            noteComputation,
            recipientViewingPubKey,
            payload,
            ephemeralPrivKeys[i],
            opts,
        ),
    );
}

/** Creates a mock IPoolVaultInteractor that returns the given events. The
 *  caller may override `getCommitmentTimestamp` to simulate the on-chain
 *  `commitments(commitment) -> uint256` lookup that discovery uses to populate
 *  Note.createdAtBlock. */
function createMockPoolVaultInteractor(
    events: NoteEvent[],
    overrides?: Partial<IPoolVaultInteractor>,
): IPoolVaultInteractor {
    return {
        getAddress: () => "0x0000000000000000000000000000000000000000" as Address,
        // Matches the default block number createMockRPCInteractor used to provide before
        // rpcInteractor was replaced by this cursor accessor.
        getCurrentCursor: () => Promise.resolve("0xff" as Hex),
        // Identity: EVM's toTokenIdField is the identity conversion, so the field value already
        // is the real address.
        resolveTokenId: (fieldValue) => Promise.resolve(fieldValue as unknown as Address),
        // Non-zero sentinel: PoolSessionNoteDiscovery rejects `0x0` as a
        // missing-commitment signal. Tests that care about the actual
        // timestamp override this via `overrides`.
        getCommitmentTimestamp: () => Promise.resolve("0x68000000" as Hash),
        getNullifierTimestamp: () => Promise.resolve("0x0" as Hash),
        isKnownRoot: () => Promise.resolve(false),
        getStateLeaves: () => Promise.resolve([]),
        exportLeafCache: () => undefined,
        getNoteEvents: () => Promise.resolve(events),
        getTransactedEvents: () => Promise.resolve([]),
        extractSpentNullifiers: () => [],
        getDepositedEvents: () => Promise.resolve([]),
        getRagequitEvents: () => Promise.resolve([]),
        submitTransaction: () => Promise.resolve("0x0" as Hex),
        encodeRagequit: () =>
            Promise.resolve({
                to: "0x0000000000000000000000000000000000000000" as Address,
                data: "0x" as Hex,
                value: "0x0" as Hex,
            }),
        encodeTransact: () =>
            Promise.resolve({
                to: "0x0000000000000000000000000000000000000000" as Address,
                data: "0x" as Hex,
                value: "0x0" as Hex,
            }),
        ...overrides,
    };
}

/** Creates a no-op IASPDataProvider that returns an empty event snapshot. */
function createMockPaymentRequestService(): IPaymentRequestService {
    return {
        generate: () => Promise.reject(new Error("not implemented in test mock")),
        list: () => Promise.resolve([]),
        getOpenRequests: () => Promise.resolve([]),
        getScannableRequests: () => Promise.resolve([]),
        markScanRetired: () => Promise.resolve(),
        markFulfilled: () => Promise.resolve(),
        archive: () => Promise.resolve(),
        clear: () => Promise.resolve(),
        loadFromStorage: () => Promise.resolve(),
        exportState: () => [],
        importState: () => Promise.resolve(),
    };
}

/**
 * Root-verifying ASP client (#540). Label status is answered from the association set this
 * serves rather than from a per-label request, so the leaf set is checked against the on-chain
 * association-set root. `leaves` are label HASHES, as the real set carries.
 */
function createMockASPClient(leaves: Hash[] = []): IASPClient {
    return {
        getAssociationSetRoot: () => Promise.resolve("0x0" as Hash),
        getAssociationSetLeaves: () => Promise.resolve(leaves),
        getMerkleProof: () => Promise.reject(new Error("not used")),
        getLabelStatus: () => Promise.resolve({ status: "approved" } as LabelStatus),
        getASPPublicKey: () => Promise.resolve(("0x" + "00".repeat(32)) as PublicKey),
    } as unknown as IASPClient;
}

function createMockASPDataProvider(): IASPDataProvider {
    return {
        getRoot: () => Promise.resolve("0x0" as Hash),
        getLeaves: () => Promise.resolve([]),
        getLabelStatus: () => Promise.resolve({ status: "approved" } as LabelStatus),
        getASPPublicKey: () => Promise.resolve(("0x" + "00".repeat(32)) as PublicKey),
        getEventSnapshot: () =>
            Promise.resolve({
                chainId: "0x1" as Hex,
                snapshotBlockNumber: "0x0" as Hex,
                generatedAt: "1970-01-01T00:00:00.000Z",
                deposits: [],
                transacts: [],
                ragequits: [],
                leaves: [],
                keystoreLeaves: [],
            }),
        getNoteEvents: () => Promise.resolve({ events: [], lastSyncedBlock: "0x0" as Hex }),
    };
}

/** Creates a keystoreManager stub for the given viewing key pair. */
function createKeystoreManager(viewingPrivKey: Secret, viewingPubKey: PublicKey): IKeystoreManager {
    return {
        getPrivateNullifyingKey: (): Secret => viewingPrivKey,
        getPrivateRevocableKey: (): Secret => viewingPrivKey,
        getViewingKeyPair: (): { privateKey: Secret; publicKey: PublicKey } => ({
            privateKey: viewingPrivKey,
            publicKey: viewingPubKey,
        }),
        applyRotation: (): void => { /* no-op */ },
        getRevocableKeyIndex: (): Hex => "0x0" as Hex,
        isRegistered: (): boolean => false,
        markRegistered: (): void => { /* no-op */ },
    };
}

/** Creates a mock IRPCInteractor that returns a fixed block number. */
function createMockRPCInteractor(blockNumber = "0xff" as Hex): IRPCInteractor {
    return {
        readContract: () => Promise.resolve(null),
        getBlockNumber: () => Promise.resolve(blockNumber),
        getFinalizedBlockNumber: async () => ({ status: "unsupported" }) as FinalizedBlockResult,
        waitForTransactionReceipt: () =>
            Promise.resolve({
                txHash: "0x0" as Hex,
                status: true,
                blockNumber: "0x0" as Hex,
                logs: [],
            }),
        getLogs: () => Promise.resolve([]),
        getLogsPaginated: () => Promise.resolve([]),
    };
}

// ── Test Suite ───────────────────────────────────────────────────────────────

describe("NoteDiscovery integration (real crypto)", () => {
    let crypto: CryptoService;
    let hashService: PoseidonHashService;
    let noteComputationService: NoteComputationService;
    let discoveryService: NoteDiscoveryService;

    // Recipient (Alice) keys — consistent across all tests
    let aliceViewingPrivKey: Secret;
    let aliceViewingPubKey: PublicKey;
    const aliceOwnerAddress = "0x742d35cc6634c0532925a3b844bc9e7fe0c0f392" as Address;

    // Bob keys — a different user
    let bobViewingPrivKey: Secret;
    let bobViewingPubKey: PublicKey;

    const TOKEN_A = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
    const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;

    beforeAll(async () => {
        crypto = new CryptoService();
        hashService = await PoseidonHashService.create();
        noteComputationService = new NoteComputationService({ hashService, cryptoService: crypto });
        discoveryService = new NoteDiscoveryService({
            cryptoService: crypto,
            hashService,
            noteComputationService,
            addressFieldConverter: new EvmAddressFieldConverter(),
        });

        // Generate real viewing key pairs using X25519
        aliceViewingPrivKey = crypto.generateSecret();
        const alicePubBytes = x25519.getPublicKey(hexToBytes(aliceViewingPrivKey.slice(2)));
        aliceViewingPubKey = `0x${bytesToHex(alicePubBytes)}` as PublicKey;

        bobViewingPrivKey = crypto.generateSecret();
        const bobPubBytes = x25519.getPublicKey(hexToBytes(bobViewingPrivKey.slice(2)));
        bobViewingPubKey = `0x${bytesToHex(bobPubBytes)}` as PublicKey;
    });

    // ── NoteDiscoveryService.scanCatchAll ────────────────────────────────────

    describe("scanCatchAll with real encryption", () => {
        it("discover a single encrypted note", () => {
            const ephPriv = crypto.generateSecret();
            const notePayload: NotePayload = {
                noteSecret: deterministicSecret(1),
                value: "0x64" as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(10) as `0x${string}`,
            };

            const event = makeEncryptedEvent(
                crypto,
                noteComputationService,
                aliceViewingPubKey,
                notePayload,
                ephPriv,
                {
                    blockNumber: "0x1" as Hex,
                    txHash: deterministicHash(100),
                    asset: TOKEN_A,
                },
            );

            const discovered = discoveryService.scanCatchAll(
                [event],
                aliceViewingPrivKey,
                aliceOwnerAddress,
            );

            expect(discovered).toHaveLength(1);
            expect(discovered[0].noteSecret).toBe(notePayload.noteSecret);
            expect(BigInt(discovered[0].value)).toBe(BigInt(notePayload.value));
            expect(discovered[0].tokenId).toBe(notePayload.tokenId);
            expect(discovered[0].label).toBe(notePayload.label);
            // Commitment is now computed, not passed — just verify it exists
            expect(discovered[0].commitment).toBeDefined();
            expect(discovered[0].contact).toBeNull();
        });

        it("not discover notes encrypted for a different recipient", () => {
            const ephPriv = crypto.generateSecret();
            const notePayload: NotePayload = {
                noteSecret: deterministicSecret(2),
                value: "0xc8" as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(20) as `0x${string}`,
            };

            // Encrypt for Bob, scan with Alice
            const event = makeEncryptedEvent(
                crypto,
                noteComputationService,
                bobViewingPubKey,
                notePayload,
                ephPriv,
                {
                    blockNumber: "0x2" as Hex,
                    txHash: deterministicHash(101),
                    asset: TOKEN_A,
                },
            );

            const discovered = discoveryService.scanCatchAll(
                [event],
                aliceViewingPrivKey,
                aliceOwnerAddress,
            );

            expect(discovered).toHaveLength(0);
        });

        it("discover multiple notes across multiple events", () => {
            const events: NoteEvent[] = [];

            for (let i = 0; i < 5; i++) {
                const ephPriv = crypto.generateSecret();
                const notePayload: NotePayload = {
                    noteSecret: deterministicSecret(10 + i),
                    value: `0x${((i + 1) * 100).toString(16)}` as Hex,
                    tokenId: TOKEN_A,
                    label: deterministicHash(30 + i) as `0x${string}`,
                };

                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        aliceViewingPubKey,
                        notePayload,
                        ephPriv,
                        {
                            blockNumber: `0x${(i + 1).toString(16)}` as Hex,
                            txHash: deterministicHash(110 + i),
                            asset: TOKEN_A,
                        },
                    ),
                );
            }

            const discovered = discoveryService.scanCatchAll(
                events,
                aliceViewingPrivKey,
                aliceOwnerAddress,
            );

            expect(discovered).toHaveLength(5);
            for (let i = 0; i < 5; i++) {
                expect(discovered[i].noteSecret).toBe(deterministicSecret(10 + i));
            }
        });

        it("decrypt own notes regardless of hint value (random-hint anonymous discovery)", () => {
            // Anonymous-discovery deposits emit a fresh random hint per event
            // for unlinkability (NoteComputationService, 2026-05-15). The
            // scanner must trial-decrypt every event — ECDH + AEAD-auth is the
            // only valid rejection criterion. A non-zero hint MUST NOT prevent
            // discovery of an event genuinely encrypted to the viewing key.
            const ephPriv = crypto.generateSecret();
            const notePayload: NotePayload = {
                noteSecret: deterministicSecret(3),
                value: "0x64" as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(40) as `0x${string}`,
            };

            const event = makeEncryptedEvent(
                crypto,
                noteComputationService,
                aliceViewingPubKey,
                notePayload,
                ephPriv,
                {
                    blockNumber: "0x3" as Hex,
                    txHash: deterministicHash(102),
                    asset: TOKEN_A,
                },
            );
            const randomHintEvent: NoteEvent = {
                ...event,
                hint: `0x${"ff".repeat(32)}` as Hex,
            };

            const discovered = discoveryService.scanCatchAll(
                [randomHintEvent],
                aliceViewingPrivKey,
                aliceOwnerAddress,
            );

            expect(discovered).toHaveLength(1);
            expect(discovered[0].noteSecret).toBe(notePayload.noteSecret);
        });

        it("discover own notes among mixed events (mine and others)", () => {
            const events: NoteEvent[] = [];

            // 3 notes for Alice
            for (let i = 0; i < 3; i++) {
                const ephPriv = crypto.generateSecret();
                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        aliceViewingPubKey,
                        {
                            noteSecret: deterministicSecret(50 + i),
                            value: `0x${(100 * (i + 1)).toString(16)}` as Hex,
                            tokenId: TOKEN_A,
                            label: deterministicHash(50 + i) as `0x${string}`,
                        },
                        ephPriv,
                        {
                            blockNumber: `0x${(i + 1).toString(16)}` as Hex,
                            txHash: deterministicHash(120 + i),
                            asset: TOKEN_A,
                        },
                    ),
                );
            }

            // 3 notes for Bob (should NOT be discovered by Alice)
            for (let i = 0; i < 3; i++) {
                const ephPriv = crypto.generateSecret();
                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        bobViewingPubKey,
                        {
                            noteSecret: deterministicSecret(60 + i),
                            value: `0x${(200 * (i + 1)).toString(16)}` as Hex,
                            tokenId: TOKEN_A,
                            label: deterministicHash(60 + i) as `0x${string}`,
                        },
                        ephPriv,
                        {
                            blockNumber: `0x${(i + 4).toString(16)}` as Hex,
                            txHash: deterministicHash(130 + i),
                            asset: TOKEN_A,
                        },
                    ),
                );
            }

            const discovered = discoveryService.scanCatchAll(
                events,
                aliceViewingPrivKey,
                aliceOwnerAddress,
            );

            expect(discovered).toHaveLength(3);
            for (let i = 0; i < 3; i++) {
                expect(discovered[i].noteSecret).toBe(deterministicSecret(50 + i));
            }
        });
    });

    // ── PoolSessionNoteDiscovery (full pipeline) ─────────────────────────────

    describe("PoolSessionNoteDiscovery full pipeline", () => {
        it("recover all notes from deposits, transfers, and re-transfers via catch-all", async () => {
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            const events: NoteEvent[] = [];
            const expectedPayloads: NotePayload[] = [];

            // ── Deposit 1: 1000 tokens ──
            const deposit1Payload: NotePayload = {
                noteSecret: deterministicSecret(1),
                value: `0x${(1000).toString(16)}` as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(501) as `0x${string}`,
            };
            events.push(
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    deposit1Payload,
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x1" as Hex,
                        txHash: deterministicHash(301),
                        asset: TOKEN_A,
                    },
                ),
            );
            expectedPayloads.push(deposit1Payload);

            // ── Deposit 2: 2000 tokens (different lineage) ──
            const deposit2Payload: NotePayload = {
                noteSecret: deterministicSecret(2),
                value: `0x${(2000).toString(16)}` as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(502) as `0x${string}`,
            };
            events.push(
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    deposit2Payload,
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x2" as Hex,
                        txHash: deterministicHash(302),
                        asset: TOKEN_A,
                    },
                ),
            );
            expectedPayloads.push(deposit2Payload);

            // ── Deposit 3: 500 tokens in TOKEN_B ──
            const deposit3Payload: NotePayload = {
                noteSecret: deterministicSecret(3),
                value: `0x${(500).toString(16)}` as Hex,
                tokenId: TOKEN_B,
                label: deterministicHash(503) as `0x${string}`,
            };
            events.push(
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    deposit3Payload,
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x3" as Hex,
                        txHash: deterministicHash(303),
                        asset: TOKEN_B,
                    },
                ),
            );
            expectedPayloads.push(deposit3Payload);

            // ── Transfer: someone sends Alice 2 outputs (recipient + change) ──
            const transfer1RecipientPayload: NotePayload = {
                noteSecret: deterministicSecret(4),
                value: `0x${(300).toString(16)}` as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(504) as `0x${string}`,
            };
            const transfer1ChangePayload: NotePayload = {
                noteSecret: deterministicSecret(5),
                value: `0x${(700).toString(16)}` as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(505) as `0x${string}`,
            };
            events.push(
                ...makeMultiOutputEvents(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    [transfer1RecipientPayload, transfer1ChangePayload],
                    [crypto.generateSecret(), crypto.generateSecret()],
                    {
                        blockNumber: "0x4" as Hex,
                        txHash: deterministicHash(304),
                        asset: TOKEN_A,
                    },
                ),
            );
            expectedPayloads.push(transfer1RecipientPayload, transfer1ChangePayload);

            // ── Re-transfer: a note is spent and a new output comes to Alice ──
            const reTransferPayload: NotePayload = {
                noteSecret: deterministicSecret(6),
                value: `0x${(150).toString(16)}` as Hex,
                tokenId: TOKEN_A,
                label: deterministicHash(506) as `0x${string}`,
            };
            events.push(
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    reTransferPayload,
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x5" as Hex,
                        txHash: deterministicHash(305),
                        asset: TOKEN_A,
                    },
                ),
            );
            expectedPayloads.push(reTransferPayload);

            // ── Noise: notes encrypted for Bob (should be ignored) ──
            for (let i = 0; i < 4; i++) {
                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        bobViewingPubKey,
                        {
                            noteSecret: deterministicSecret(70 + i),
                            value: `0x${(9999).toString(16)}` as Hex,
                            tokenId: TOKEN_A,
                            label: deterministicHash(70 + i) as `0x${string}`,
                        },
                        crypto.generateSecret(),
                        {
                            blockNumber: `0x${(6 + i).toString(16)}` as Hex,
                            txHash: deterministicHash(310 + i),
                            asset: TOKEN_A,
                        },
                    ),
                );
            }

            // ── Execute catch-all discovery ──
            // Every expected note exists on chain: promotion to ACTIVE needs the
            // commitment in the bulk Deposited/Transacted set, not only an approved label.
            const onChainDeposits = expectedPayloads.map((payload, i) => ({
                outputCommitment: noteComputationService.computeFullCommitment({
                    noteAddressHash: noteComputationService.computeNoteAddressHash(
                        aliceOwnerAddress,
                        payload.noteSecret,
                    ),
                    tokenId: payload.tokenId,
                    value: payload.value,
                    label: payload.label,
                }),
                blockNumber: `0x${(i + 1).toString(16)}` as Hex,
                txHash: deterministicHash(900 + i),
            }));
            const session = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor(events, {
                    getDepositedEvents: async () => onChainDeposits as never,
                }),
                rpcInteractor: createMockRPCInteractor(),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                // Every label Alice holds is in the association set, so every note promotes.
                aspClient: createMockASPClient(
                    expectedPayloads.map((p) => noteComputationService.computeLabelHash(p.label)),
                ),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const discoveredNotes = await session.discoverNotes();

            // ── Assertions: all Alice's notes recovered ──
            expect(discoveredNotes).toHaveLength(expectedPayloads.length);

            for (let i = 0; i < expectedPayloads.length; i++) {
                expect(discoveredNotes[i].noteSecret).toBe(expectedPayloads[i].noteSecret);
                expect(BigInt(discoveredNotes[i].value)).toBe(BigInt(expectedPayloads[i].value));
                expect(discoveredNotes[i].tokenId).toBe(expectedPayloads[i].tokenId);
                expect(discoveredNotes[i].label).toBe(expectedPayloads[i].label);
            }

            for (const note of discoveredNotes) {
                expect(note.status).toBe(NoteStatus.ACTIVE);
                expect(note.isOwned).toBe(true);
                expect(note.ownerAddress).toBe(aliceOwnerAddress);
                expect(note.spentAtBlock).toBeNull();
            }

            const allNotes = noteManager.getNotes();
            expect(allNotes).toHaveLength(expectedPayloads.length);

            for (const note of discoveredNotes) {
                const retrieved = noteManager.getNote(note.commitment);
                expect(retrieved.commitment).toBe(note.commitment);
                expect(retrieved.noteSecret).toBe(note.noteSecret);
            }
        });

        it("distinguish notes across different tokens", async () => {
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            const events: NoteEvent[] = [];

            for (let i = 0; i < 3; i++) {
                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        aliceViewingPubKey,
                        {
                            noteSecret: deterministicSecret(80 + i),
                            value: `0x${(100 * (i + 1)).toString(16)}` as Hex,
                            tokenId: TOKEN_A,
                            label: deterministicHash(80 + i) as `0x${string}`,
                        },
                        crypto.generateSecret(),
                        {
                            blockNumber: `0x${(i + 1).toString(16)}` as Hex,
                            txHash: deterministicHash(350 + i),
                            asset: TOKEN_A,
                        },
                    ),
                );
            }

            for (let i = 0; i < 2; i++) {
                events.push(
                    makeEncryptedEvent(
                        crypto,
                        noteComputationService,
                        aliceViewingPubKey,
                        {
                            noteSecret: deterministicSecret(90 + i),
                            value: `0x${(500 * (i + 1)).toString(16)}` as Hex,
                            tokenId: TOKEN_B,
                            label: deterministicHash(90 + i) as `0x${string}`,
                        },
                        crypto.generateSecret(),
                        {
                            blockNumber: `0x${(i + 4).toString(16)}` as Hex,
                            txHash: deterministicHash(360 + i),
                            asset: TOKEN_B,
                        },
                    ),
                );
            }

            const session = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor(events),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const discoveredNotes = await session.discoverNotes();

            expect(discoveredNotes).toHaveLength(5);

            const tokenANotes = noteManager.getNotes({ tokenId: TOKEN_A });
            const tokenBNotes = noteManager.getNotes({ tokenId: TOKEN_B });

            expect(tokenANotes).toHaveLength(3);
            expect(tokenBNotes).toHaveLength(2);
        });

        it("handle empty event list gracefully", async () => {
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            const session = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor([]),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const result = await session.discoverNotes();

            expect(result).toEqual([]);
            expect(noteManager.getNotes()).toEqual([]);
        });

        it("populate createdAtBlock from on-chain commitment timestamps", async () => {
            // `createdAtBlock` must carry block.timestamp (what the on-chain
            // state tree hashes), not the log's block number. Discovery is
            // expected to resolve it via PoolVault.commitments(commitment).
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            const blockNumbers = ["0xa", "0x14", "0x1e"] as Hex[];
            const events = blockNumbers.map((blockNumber, i) =>
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    {
                        noteSecret: deterministicSecret(100 + i),
                        value: "0x64" as Hex,
                        tokenId: TOKEN_A,
                        label: deterministicHash(100 + i) as `0x${string}`,
                    },
                    crypto.generateSecret(),
                    {
                        blockNumber,
                        txHash: deterministicHash(500 + i),
                        asset: TOKEN_A,
                    },
                ),
            );

            // Expected commitment -> timestamp mapping. Commitments are
            // deterministic from the payload, so we precompute them to set up
            // the mock.
            const expectedTimestamps: Record<string, Hex> = {};
            const commitments = events.map((e, i) => {
                const noteSecret = deterministicSecret(100 + i);
                const label = deterministicHash(100 + i) as `0x${string}`;
                const noteAddressHash = noteComputationService.computeNoteAddressHash(
                    aliceOwnerAddress,
                    noteSecret,
                );
                const commitment = noteComputationService.computeFullCommitment({
                    noteAddressHash,
                    tokenId: TOKEN_A,
                    value: "0x64" as Hex,
                    label,
                });
                expectedTimestamps[commitment.toLowerCase()] = ("0x" +
                    (0x68000000 + i).toString(16)) as Hex;
                void e;
                return commitment;
            });

            const session = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor(events, {
                    getCommitmentTimestamp: async (commitment) =>
                        (expectedTimestamps[commitment.toLowerCase()] ?? "0x0") as Hash,
                }),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const result = await session.discoverNotes();

            expect(result).toHaveLength(3);
            for (const [i, note] of result.entries()) {
                expect(note.createdAtBlock).toBe(expectedTimestamps[commitments[i].toLowerCase()]);
            }
        });

        it("not duplicate notes across successive discovery calls", async () => {
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            const events1 = [
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    {
                        noteSecret: deterministicSecret(110),
                        value: "0x64" as Hex,
                        tokenId: TOKEN_A,
                        label: deterministicHash(110) as `0x${string}`,
                    },
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x1" as Hex,
                        txHash: deterministicHash(700),
                        asset: TOKEN_A,
                    },
                ),
            ];

            const session1 = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor(events1),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const batch1 = await session1.discoverNotes();
            expect(batch1).toHaveLength(1);

            const events2 = [
                makeEncryptedEvent(
                    crypto,
                    noteComputationService,
                    aliceViewingPubKey,
                    {
                        noteSecret: deterministicSecret(111),
                        value: "0xc8" as Hex,
                        tokenId: TOKEN_A,
                        label: deterministicHash(111) as `0x${string}`,
                    },
                    crypto.generateSecret(),
                    {
                        blockNumber: "0x2" as Hex,
                        txHash: deterministicHash(701),
                        asset: TOKEN_A,
                    },
                ),
            ];

            const session2 = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                // Advance the chain head past the cursor set by session1 so the
                // second discovery call actually scans new blocks.
                poolVaultInteractor: createMockPoolVaultInteractor(events2, {
                    getCurrentCursor: () => Promise.resolve("0x1ff" as Hex),
                }),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient(),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });

            const batch2 = await session2.discoverNotes();
            expect(batch2).toHaveLength(1);

            const allNotes = noteManager.getNotes();
            expect(allNotes).toHaveLength(2);
        });
    });

    // ── PoolSessionNoteManager.addNote → discovery promotion ─────────────────

    describe("PoolSessionNoteManager.addNote + discovery handoff", () => {
        it("promote a PENDING note registered via addNote to ACTIVE on next discoverNotes", async () => {
            const noteManager = new NoteManager({});
            const keystoreManager = createKeystoreManager(aliceViewingPrivKey, aliceViewingPubKey);

            // Construct the note Alice's integrator broadcast externally.
            const noteSecret = deterministicSecret(200);
            const label = deterministicHash(600) as Hash;
            const value = `0x${(1234).toString(16)}` as Hex;
            const noteAddressHash = noteComputationService.computeNoteAddressHash(
                aliceOwnerAddress,
                noteSecret,
            );
            const commitment = noteComputationService.computeFullCommitment({
                noteAddressHash,
                tokenId: TOKEN_A,
                value,
                label,
            });

            const pendingNote: PendingNote = {
                noteAddressHash,
                commitment,
                value,
                tokenId: TOKEN_A,
                label,
                status: NoteStatus.PENDING,
                ownerAddress: aliceOwnerAddress,
                noteSecret,
                isOwned: true,
            };

            const TIMESTAMP = "0x68000042" as Hex;
            const poolVaultInteractor = createMockPoolVaultInteractor([], {
                getCommitmentTimestamp: async (c) =>
                    (c.toLowerCase() === commitment.toLowerCase() ? TIMESTAMP : "0x0") as Hash,
            });

            // Step 1: integrator calls addNote post-broadcast → PENDING in local state.
            const sessionNoteManager = new PoolSessionNoteManager({
                noteManager,
                poolVaultInteractor,
                addressSchema: AddressSchema,
            });
            await sessionNoteManager.addNotes([{ pendingNote, txHash: deterministicHash(700) }]);

            const persistedPending = noteManager.getNote(commitment);
            expect(persistedPending.status).toBe(NoteStatus.PENDING);
            expect(persistedPending.createdAtBlock).toBe(TIMESTAMP);
            expect(persistedPending.spentAtBlock).toBeNull();

            // Step 2: the discovery service observes the same commitment on-chain.
            const discoveryEvent = makeEncryptedEvent(
                crypto,
                noteComputationService,
                aliceViewingPubKey,
                { noteSecret, value, tokenId: TOKEN_A, label },
                crypto.generateSecret(),
                {
                    blockNumber: "0x1" as Hex,
                    txHash: deterministicHash(701),
                    asset: TOKEN_A,
                },
            );
            const discoverySession = new PoolSessionNoteDiscovery({
                ownerAddress: aliceOwnerAddress,
                noteDiscoveryService: discoveryService,
                noteManager,
                keystoreManager,
                poolVaultInteractor: createMockPoolVaultInteractor([discoveryEvent], {
                    getCommitmentTimestamp: async (c) =>
                        (c.toLowerCase() === commitment.toLowerCase() ? TIMESTAMP : "0x0") as Hash,
                    // The integrator's broadcast landed: the Deposited event is what lets the
                    // status sync promote the note, not the approved label alone.
                    getDepositedEvents: async () =>
                        [
                            {
                                outputCommitment: commitment,
                                blockNumber: "0x1" as Hex,
                                txHash: deterministicHash(700),
                            },
                        ] as never,
                }),
                noteComputationService,
                aspDataProvider: createMockASPDataProvider(),
                aspClient: createMockASPClient([noteComputationService.computeLabelHash(label)]),
                addressFieldConverter: new EvmAddressFieldConverter(),
                paymentRequestService: createMockPaymentRequestService(),
            });
            await discoverySession.discoverNotes();

            // Step 3: status promoted PENDING → ACTIVE; record otherwise intact.
            const persistedActive = noteManager.getNote(commitment);
            expect(persistedActive.status).toBe(NoteStatus.ACTIVE);
            expect(persistedActive.commitment).toBe(commitment);
            expect(persistedActive.value).toBe(value);
            expect(persistedActive.createdAtBlock).toBe(TIMESTAMP);
            expect(persistedActive.spentAtBlock).toBeNull();

            // Single tracked note across the whole flow (no duplicate).
            expect(noteManager.getNotes()).toHaveLength(1);
        });
    });
});
