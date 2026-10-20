// NOTE (core-sdk split): the original packages/sdk/test/unit/services/NoteDiscoveryService.test.ts
// also covered `scanStealthDeposits` (a `describe` block plus stealth-fixture helpers, using the
// real stealth module's crypto). Dropped here since that method moved to evm-sdk's own
// NoteDiscoveryService subclass — the sdk original stays as reference for extracting that
// coverage into evm-sdk's test suite, not yet done.
import { hexToBytes } from "@noble/ciphers/utils.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Contact,
    Hash,
    Hex,
    IAddressFieldConverter,
    ICryptoService,
    IHashService,
    INoteComputationService,
    NoteEvent,
    NotePayload,
    PaymentRequestNotePayload,
    PaymentRequestRecord,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import {
    CATCH_ALL_TAG,
    DecryptionError,
    encodeHexListRlp,
    NoteDiscoveryService,
    PayloadDecodeError,
    PayloadParseError,
} from "../../../src/internal.js";

/**
 * Identity `IAddressFieldConverter<Address>` fixture — mirrors evm-sdk's
 * `EvmAddressFieldConverter` (an EVM address is already a valid BN254 field element, so no real
 * transformation is needed), kept local since the concrete EVM class lives in evm-sdk, not here.
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

const VIEWING_PRIV_KEY =
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Secret;

const OWNER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;

const CONTACT_A_PUB_KEY =
    "0x02bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as PublicKey;
const CONTACT_A_ADDRESS = "0x1111111111111111111111111111111111111111" as Address;

const CONTACT_B_PUB_KEY =
    "0x03cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as PublicKey;
const CONTACT_B_ADDRESS = "0x2222222222222222222222222222222222222222" as Address;

const VALID_NOTE_PAYLOAD: NotePayload = {
    noteSecret: `0x${"aa".repeat(32)}` as Secret,
    value: `0x${"00".repeat(31)}64` as Hex,
    tokenId: `0x${"ee".repeat(20)}` as Address,
    label: `0x${"dd".repeat(32)}` as Hex,
};

/** v2 payment-request payload. `noteAddressHash` matches the mock `computeNoteAddressHash` output. */
const VALID_PR_NOTE_PAYLOAD: PaymentRequestNotePayload = {
    noteAddressHash: `0x${"ab".repeat(32)}` as Hash,
    value: VALID_NOTE_PAYLOAD.value,
    tokenId: VALID_NOTE_PAYLOAD.tokenId,
    label: VALID_NOTE_PAYLOAD.label,
};

/** RLP encoding of VALID_NOTE_PAYLOAD: RLP([version, noteSecret, value, tokenId, label]). */
function buildRlpPayloadBytes(): Uint8Array {
    // Unified wire: RLP([NOTE_PAYLOAD_VERSION, KIND_FULL, noteSecret, value, tokenId, label]).
    const rlpHex = encodeHexListRlp([
        "0x02",
        "0x01",
        VALID_NOTE_PAYLOAD.noteSecret,
        VALID_NOTE_PAYLOAD.value,
        VALID_NOTE_PAYLOAD.tokenId,
        VALID_NOTE_PAYLOAD.label,
    ]);
    return hexToBytes(rlpHex.slice(2));
}

const VALID_PAYLOAD_BYTES = buildRlpPayloadBytes();

const EPH_PUB_KEY = ("0x02" + "00".repeat(32)) as PublicKey;

const MOCK_TX_HASH = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash;

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockCryptoService(): ICryptoService {
    return {
        ecdh: vi.fn((privateKey: Secret, publicKey: string): Secret => {
            const privPart = privateKey.slice(2, 10);
            const pubPart = publicKey.slice(2, 10);
            return `0x${pubPart}${privPart}${"00".repeat(24)}` as Secret;
        }),
        encrypt: vi.fn((_data: Uint8Array, _secret: Secret): Hex => {
            return "0x00" as Hex;
        }),
        decrypt: vi.fn((_ciphertext: Hex, _secret: Secret): Uint8Array => {
            return VALID_PAYLOAD_BYTES;
        }),
        generateSecret: vi.fn((): Secret => {
            return ("0x" + "ff".repeat(32)) as Secret;
        }),
        generateEphemeralKeyPair: vi.fn(() => ({
            privateKey: ("0x" + "aa".repeat(32)) as Secret,
            publicKey: ("0x02" + "bb".repeat(32)) as PublicKey,
        })),
        deriveKeysFromSignature: vi.fn(),
        derivePaymentRequestKeyPair: vi.fn(),
    };
}

function createMockHashService(): IHashService {
    return {
        hash: vi.fn((inputs: Hex[]): Hex => {
            const combined = inputs.map((i) => i.slice(2, 10)).join("");
            return `0x${combined.padEnd(64, "0")}` as Hex;
        }),
    };
}

function createMockNoteComputationService(): INoteComputationService {
    return {
        computeNoteAddressHash: vi.fn((_ownerAddress: Address, _noteSecret: Secret): Hex => {
            return ("0x" + "ab".repeat(32)) as Hex;
        }),
        computePrecommitment: vi.fn((): Hex => ("0x" + "cd".repeat(32)) as Hex),
        computeLabel: vi.fn((): Hex => ("0x" + "ef".repeat(32)) as Hex),
        computeFullCommitment: vi.fn((): Hex => ("0x" + "02".repeat(32)) as Hex),
        computeNullifier: vi.fn((): Hex => ("0x" + "03".repeat(32)) as Hex),
        computeAuthDigest: vi.fn((): Hex => ("0x" + "05".repeat(32)) as Hex),
        computeLabelHash: vi.fn((): Hex => ("0x" + "08".repeat(32)) as Hex),
        encodeNotePayload: vi.fn((_payload: NotePayload): Uint8Array => {
            return VALID_PAYLOAD_BYTES;
        }),
        decodeNotePayload: vi.fn((_bytes: Uint8Array): NotePayload => {
            return { ...VALID_NOTE_PAYLOAD };
        }),
        generateNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: "0x" as Hex,
        })),
        encodePaymentRequestNotePayload: vi.fn(
            (_payload: PaymentRequestNotePayload): Uint8Array => VALID_PAYLOAD_BYTES,
        ),
        decodePaymentRequestNotePayload: vi.fn((_bytes: Uint8Array): PaymentRequestNotePayload => {
            return { ...VALID_PR_NOTE_PAYLOAD };
        }),
        generatePaymentRequestNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: "0x" as Hex,
        })),
    };
}

// ── Factories ────────────────────────────────────────────────────────────────

function makeContact(overrides?: Partial<Contact>): Contact {
    return {
        address: CONTACT_A_ADDRESS,
        viewingPublicKey: CONTACT_A_PUB_KEY,
        label: "Alice",
        ...overrides,
    };
}

function makeNoteEvent(overrides?: Partial<NoteEvent>): NoteEvent {
    return {
        blockNumber: "0x1" as Hex,
        txHash: MOCK_TX_HASH,
        hint: CATCH_ALL_TAG,
        ephemeralPubKey: EPH_PUB_KEY,
        encryptedPayload: ("0x" + "ff".repeat(50)) as Hex,
        ...overrides,
    };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("NoteDiscoveryService", () => {
    let service: NoteDiscoveryService;
    let cryptoService: ICryptoService;
    let hashService: IHashService;
    let noteComputationService: INoteComputationService;

    beforeEach(() => {
        cryptoService = createMockCryptoService();
        hashService = createMockHashService();
        noteComputationService = createMockNoteComputationService();
        service = new NoteDiscoveryService({
            cryptoService,
            hashService,
            noteComputationService,
            addressFieldConverter: new TestAddressFieldConverter(),
        });
    });

    describe("constructor", () => {
        it("initialize without errors with valid config", () => {
            expect(
                () =>
                    new NoteDiscoveryService({
                        cryptoService,
                        hashService,
                        noteComputationService,
                        addressFieldConverter: new TestAddressFieldConverter(),
                    }),
            ).not.toThrow();
        });

        it("initialize with optional logger", () => {
            const logger = {
                child: vi.fn().mockReturnThis(),
                level: "debug",
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
                fatal: vi.fn(),
            };

            expect(
                () =>
                    new NoteDiscoveryService(
                        {
                            cryptoService,
                            hashService,
                            noteComputationService,
                            addressFieldConverter: new TestAddressFieldConverter(),
                        },
                        { logger },
                    ),
            ).not.toThrow();
            expect(logger.debug).toHaveBeenCalledWith("NoteDiscoveryService initialized");
        });
    });

    describe("scanTargeted", () => {
        it("return empty array when events is empty", () => {
            const contacts = [makeContact()];
            const result = service.scanTargeted([], contacts, VIEWING_PRIV_KEY, OWNER_ADDRESS);
            expect(result).toEqual([]);
        });

        it("return empty array when contacts is empty", () => {
            const events = [makeNoteEvent()];
            const result = service.scanTargeted(events, [], VIEWING_PRIV_KEY, OWNER_ADDRESS);
            expect(result).toEqual([]);
        });

        it("compute ECDH shared secret for each contact", () => {
            const contactA = makeContact();
            const contactB = makeContact({
                address: CONTACT_B_ADDRESS,
                viewingPublicKey: CONTACT_B_PUB_KEY,
                label: "Bob",
            });

            service.scanTargeted(
                [makeNoteEvent()],
                [contactA, contactB],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );

            expect(cryptoService.ecdh).toHaveBeenCalledWith(VIEWING_PRIV_KEY, CONTACT_A_PUB_KEY);
            expect(cryptoService.ecdh).toHaveBeenCalledWith(VIEWING_PRIV_KEY, CONTACT_B_PUB_KEY);
        });

        it("derive tag from each shared secret using hashService", () => {
            const contact = makeContact();

            service.scanTargeted([makeNoteEvent()], [contact], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            const expectedSecret = cryptoService.ecdh(VIEWING_PRIV_KEY, CONTACT_A_PUB_KEY);
            expect(hashService.hash).toHaveBeenCalledWith([expectedSecret, "0x0"]);
        });

        it("discover note when event tag matches a contact's tag", () => {
            const contact = makeContact();

            const sharedSecret = cryptoService.ecdh(VIEWING_PRIV_KEY, contact.viewingPublicKey);
            const tag = hashService.hash([sharedSecret, "0x0"]);

            const event = makeNoteEvent({ hint: tag });

            vi.clearAllMocks();

            const result = service.scanTargeted(
                [event],
                [contact],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );

            expect(result).toHaveLength(1);
            expect(result[0].contact).toEqual(contact);
            expect(result[0].blockNumber).toBe(event.blockNumber);
            expect(result[0].txHash).toBe(event.txHash);
        });

        it("return DiscoveredNote with correct payload fields from targeted scan", () => {
            const contact = makeContact();
            const sharedSecret = cryptoService.ecdh(VIEWING_PRIV_KEY, contact.viewingPublicKey);
            const tag = hashService.hash([sharedSecret, "0x0"]);

            const event = makeNoteEvent({ hint: tag });
            vi.clearAllMocks();

            const result = service.scanTargeted(
                [event],
                [contact],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );

            expect(result[0]).toEqual(expect.objectContaining(VALID_NOTE_PAYLOAD));
        });

        it("skip events with no matching tag", () => {
            const contact = makeContact();
            const nonMatchingTag = ("0x" + "ff".repeat(32)) as Hex;
            const event = makeNoteEvent({ hint: nonMatchingTag });

            const result = service.scanTargeted(
                [event],
                [contact],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );

            expect(result).toHaveLength(0);
        });

        it("discover multiple notes from different contacts", () => {
            const contactA = makeContact();
            const contactB = makeContact({
                address: CONTACT_B_ADDRESS,
                viewingPublicKey: CONTACT_B_PUB_KEY,
                label: "Bob",
            });

            const sharedA = cryptoService.ecdh(VIEWING_PRIV_KEY, contactA.viewingPublicKey);
            const tagA = hashService.hash([sharedA, "0x0"]);

            const sharedB = cryptoService.ecdh(VIEWING_PRIV_KEY, contactB.viewingPublicKey);
            const tagB = hashService.hash([sharedB, "0x0"]);

            const eventA = makeNoteEvent({ hint: tagA, blockNumber: "0xa" as Hex });
            const eventB = makeNoteEvent({ hint: tagB, blockNumber: "0xb" as Hex });

            vi.clearAllMocks();

            const result = service.scanTargeted(
                [eventA, eventB],
                [contactA, contactB],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );

            expect(result).toHaveLength(2);
            expect(result[0].contact).toEqual(contactA);
            expect(result[1].contact).toEqual(contactB);
        });

        it("skip event silently when decryption fails on matched tag (tag collision)", () => {
            const contact = makeContact();

            const sharedSecret = cryptoService.ecdh(VIEWING_PRIV_KEY, contact.viewingPublicKey);
            const tag = hashService.hash([sharedSecret, "0x0"]);

            const event = makeNoteEvent({ hint: tag });

            vi.clearAllMocks();

            (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw new Error("AEAD auth failed");
            });

            const result = service.scanTargeted(
                [event],
                [contact],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );
            expect(result).toEqual([]);
        });

        it("skip event silently when payload parse fails on matched tag", () => {
            const contact = makeContact();

            const sharedSecret = cryptoService.ecdh(VIEWING_PRIV_KEY, contact.viewingPublicKey);
            const tag = hashService.hash([sharedSecret, "0x0"]);

            const event = makeNoteEvent({ hint: tag });

            vi.clearAllMocks();

            (
                noteComputationService.decodeNotePayload as ReturnType<typeof vi.fn>
            ).mockImplementation(() => {
                throw new Error("bad payload bytes");
            });

            const result = service.scanTargeted(
                [event],
                [contact],
                VIEWING_PRIV_KEY,
                OWNER_ADDRESS,
            );
            expect(result).toEqual([]);
        });
    });

    describe("decryptNotePayload", () => {
        it("decrypt and decode valid binary payload into NotePayload", () => {
            const ciphertext = ("0x" + "ab".repeat(50)) as Hex;
            const sharedSecret = ("0x" + "cd".repeat(32)) as Secret;

            const result = service.decryptNotePayload(ciphertext, sharedSecret);

            expect(result).toEqual(VALID_NOTE_PAYLOAD);
        });

        it("call cryptoService.decrypt with correct arguments", () => {
            const ciphertext = ("0x" + "ab".repeat(50)) as Hex;
            const sharedSecret = ("0x" + "cd".repeat(32)) as Secret;

            service.decryptNotePayload(ciphertext, sharedSecret);

            expect(cryptoService.decrypt).toHaveBeenCalledWith(ciphertext, sharedSecret);
        });

        it("throw DecryptionError when cryptoService.decrypt throws", () => {
            (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw new Error("invalid ciphertext");
            });

            expect(() => service.decryptNotePayload("0xbad" as Hex, "0xkey" as Secret)).toThrow(
                DecryptionError,
            );
        });

        it("throw PayloadParseError when decrypted bytes fail binary decoding", () => {
            (
                noteComputationService.decodeNotePayload as ReturnType<typeof vi.fn>
            ).mockImplementation(() => {
                throw new PayloadDecodeError("expected 117 bytes, got 15");
            });

            expect(() => service.decryptNotePayload("0xaa" as Hex, "0xbb" as Secret)).toThrow(
                PayloadParseError,
            );
        });

        it("throw PayloadParseError when version byte is unknown", () => {
            (
                noteComputationService.decodeNotePayload as ReturnType<typeof vi.fn>
            ).mockImplementation(() => {
                throw new PayloadDecodeError("unsupported NotePayload version 255");
            });

            expect(() => service.decryptNotePayload("0xaa" as Hex, "0xbb" as Secret)).toThrow(
                PayloadParseError,
            );
        });
    });

    describe("scanCatchAll", () => {
        it("return empty array when events is empty", () => {
            const result = service.scanCatchAll([], VIEWING_PRIV_KEY, OWNER_ADDRESS);
            expect(result).toEqual([]);
        });

        it("discover note when ECDH + decrypt succeeds for catch-all event", () => {
            const event = makeNoteEvent({ hint: CATCH_ALL_TAG });

            const result = service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result).toHaveLength(1);
            expect(result[0].commitment).toBeDefined();
            expect(result[0].contact).toBeNull();
            expect(result[0].blockNumber).toBe(event.blockNumber);
            expect(result[0].txHash).toBe(event.txHash);
        });

        it("return DiscoveredNote with correct payload fields", () => {
            const event = makeNoteEvent({ hint: CATCH_ALL_TAG });

            const result = service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result[0]).toEqual(expect.objectContaining(VALID_NOTE_PAYLOAD));
        });

        it("set contact to null on discovered notes", () => {
            const event = makeNoteEvent({ hint: CATCH_ALL_TAG });

            const result = service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result[0].contact).toBeNull();
        });

        it("compute ECDH with ephemeralPubKey from each event", () => {
            const ephKey1 = ("0x02" + "aa".repeat(32)) as PublicKey;
            const ephKey2 = ("0x03" + "bb".repeat(32)) as PublicKey;

            const event1 = makeNoteEvent({ hint: CATCH_ALL_TAG, ephemeralPubKey: ephKey1 });
            const event2 = makeNoteEvent({ hint: CATCH_ALL_TAG, ephemeralPubKey: ephKey2 });

            service.scanCatchAll([event1, event2], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(cryptoService.ecdh).toHaveBeenCalledWith(VIEWING_PRIV_KEY, ephKey1);
            expect(cryptoService.ecdh).toHaveBeenCalledWith(VIEWING_PRIV_KEY, ephKey2);
        });

        it("silently skip events where decryption fails", () => {
            let callCount = 0;
            (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockImplementation(() => {
                callCount++;
                if (callCount === 1) throw new Error("AEAD auth failed");
                return VALID_PAYLOAD_BYTES;
            });

            const event1 = makeNoteEvent({ hint: CATCH_ALL_TAG });
            const event2 = makeNoteEvent({ hint: CATCH_ALL_TAG });

            const result = service.scanCatchAll([event1, event2], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result).toHaveLength(1);
        });

        it("silently skip events where binary decoding fails", () => {
            (
                noteComputationService.decodeNotePayload as ReturnType<typeof vi.fn>
            ).mockImplementationOnce(() => {
                throw new PayloadDecodeError("expected 117 bytes, got 42");
            });

            const event = makeNoteEvent({ hint: CATCH_ALL_TAG });

            const result = service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result).toHaveLength(0);
        });

        it("trial-decrypt events with random (non-zero) hints — anonymous-discovery deposits", () => {
            // Regression: deposits emit a fresh random hint per event for
            // unlinkability (NoteComputationService, 2026-05-15). The catch-all
            // scanner used to short-circuit on `hint !== CATCH_ALL_TAG`, which
            // silently dropped every new deposit. The scanner MUST trial-decrypt
            // every event regardless of hint — ECDH + AEAD-auth is the only
            // valid rejection criterion.
            const randomHint = ("0x" + "ab".repeat(32)) as Hex;
            const event = makeNoteEvent({ hint: randomHint });

            const result = service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result).toHaveLength(1);
            expect(cryptoService.ecdh).toHaveBeenCalledWith(
                VIEWING_PRIV_KEY,
                event.ephemeralPubKey,
            );
        });

        it("handle multiple events with catch-all tags", () => {
            const event1 = makeNoteEvent({ hint: CATCH_ALL_TAG, blockNumber: "0xa" as Hex });
            const event2 = makeNoteEvent({ hint: CATCH_ALL_TAG, blockNumber: "0xb" as Hex });

            const result = service.scanCatchAll([event1, event2], VIEWING_PRIV_KEY, OWNER_ADDRESS);

            expect(result).toHaveLength(2);
            expect(result[0].blockNumber).toBe("0xa");
            expect(result[1].blockNumber).toBe("0xb");
        });

        it("not throw when ECDH fails", () => {
            (cryptoService.ecdh as ReturnType<typeof vi.fn>).mockImplementation(() => {
                throw new Error("invalid public key");
            });

            const event = makeNoteEvent({ hint: CATCH_ALL_TAG });

            expect(() =>
                service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS),
            ).not.toThrow();
            expect(service.scanCatchAll([event], VIEWING_PRIV_KEY, OWNER_ADDRESS)).toEqual([]);
        });
    });

    describe("scanPaymentRequests", () => {
        const REQUEST_TAG = ("0x" + "11".repeat(32)) as Hex;
        const REQUEST_PRIV_KEY = ("0x" + "22".repeat(32)) as Secret;
        const REQUEST_PUB_KEY = ("0x" + "33".repeat(32)) as PublicKey;
        const PAYMENT_ID = ("0x" + "44".repeat(32)) as Hex;
        // Must match what computeNoteAddressHash returns from the mock so the
        // sanity check inside scanPaymentRequests passes.
        const SLOT_ADDRESS_HASH = ("0x" + "ab".repeat(32)) as Hash;

        function makeRequestRecord(
            overrides?: Partial<PaymentRequestRecord>,
        ): PaymentRequestRecord {
            return {
                paymentId: PAYMENT_ID,
                noteAddressHashes: [SLOT_ADDRESS_HASH],
                noteSecretsMap: new Map<Hash, Secret>([
                    [SLOT_ADDRESS_HASH, VALID_NOTE_PAYLOAD.noteSecret],
                ]),
                amount: "0x100" as Hex,
                tokenId: VALID_NOTE_PAYLOAD.tokenId,
                tag: REQUEST_TAG,
                paymentPubKey: REQUEST_PUB_KEY,
                paymentPrivKey: REQUEST_PRIV_KEY,
                recipientAddress: OWNER_ADDRESS,
                status: "OPEN",
                createdAt: "0x1" as Hex,
                fulfilledByCommitments: [],
                consumedSlots: [],
                ...overrides,
            };
        }

        it("return empty array when events is empty", () => {
            const result = service.scanPaymentRequests([], [makeRequestRecord()]);
            expect(result).toEqual([]);
        });

        it("return empty array when requests is empty", () => {
            const event = makeNoteEvent({ hint: REQUEST_TAG });
            const result = service.scanPaymentRequests([event], []);
            expect(result).toEqual([]);
        });

        it("discover note matching the request tag and decrypt with paymentPrivKey", () => {
            const event = makeNoteEvent({ hint: REQUEST_TAG });
            const result = service.scanPaymentRequests([event], [makeRequestRecord()]);

            expect(result).toHaveLength(1);
            expect(result[0].paymentId).toBe(PAYMENT_ID);
            expect(result[0].contact).toBeNull();
            // ECDH must use the request's paymentPrivKey, not the user's viewing key.
            expect(cryptoService.ecdh).toHaveBeenCalledWith(
                REQUEST_PRIV_KEY,
                event.ephemeralPubKey,
            );
        });

        it("skip events whose tag does not match any request", () => {
            const event = makeNoteEvent({ hint: ("0x" + "ff".repeat(32)) as Hex });
            const result = service.scanPaymentRequests([event], [makeRequestRecord()]);
            expect(result).toEqual([]);
            expect(cryptoService.ecdh).not.toHaveBeenCalled();
        });

        it("silently skip events whose decoded noteAddressHash is not in the request slot map", () => {
            // Decode a payload whose noteAddressHash is NOT one of the request's slots.
            (
                noteComputationService.decodePaymentRequestNotePayload as ReturnType<typeof vi.fn>
            ).mockReturnValueOnce({
                ...VALID_PR_NOTE_PAYLOAD,
                noteAddressHash: ("0x" + "99".repeat(32)) as Hash,
            });

            const event = makeNoteEvent({ hint: REQUEST_TAG });
            const result = service.scanPaymentRequests([event], [makeRequestRecord()]);
            expect(result).toEqual([]);
        });

        it("inject the recipient-local noteSecret into the discovered note", () => {
            const event = makeNoteEvent({ hint: REQUEST_TAG });
            const result = service.scanPaymentRequests([event], [makeRequestRecord()]);

            expect(result).toHaveLength(1);
            // The secret comes from the local map, never from the on-chain payload.
            expect(result[0].noteSecret).toBe(VALID_NOTE_PAYLOAD.noteSecret);
            expect(result[0].value).toBe(VALID_PR_NOTE_PAYLOAD.value);
            expect(result[0].label).toBe(VALID_PR_NOTE_PAYLOAD.label);
        });

        it("silently skip events where decryption fails (tag collision)", () => {
            (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
                throw new DecryptionError("AEAD auth failed");
            });

            const event = makeNoteEvent({ hint: REQUEST_TAG });
            const result = service.scanPaymentRequests([event], [makeRequestRecord()]);
            expect(result).toEqual([]);
        });

        it("emit one DiscoveredNote per matching event for the same request", () => {
            // A single payment request can yield ≥1 events when the sender's transfer
            // creates multiple recipient outputs against different slots.
            const event1 = makeNoteEvent({ hint: REQUEST_TAG, blockNumber: "0xa" as Hex });
            const event2 = makeNoteEvent({ hint: REQUEST_TAG, blockNumber: "0xb" as Hex });

            const result = service.scanPaymentRequests([event1, event2], [makeRequestRecord()]);

            expect(result).toHaveLength(2);
            expect(result.every((r) => r.paymentId === PAYMENT_ID)).toBe(true);
        });
    });
});
