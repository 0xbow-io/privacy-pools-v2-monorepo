import { bytesToHex, hexToBytes } from "@noble/ciphers/utils.js";
import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    NotePayload,
    PaymentRequestNotePayload,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import {
    decodeHexListRlp,
    encodeHexListRlp,
    NoteComputationService,
    PayloadDecodeError,
} from "../../../src/internal.js";

// ── Mock hash service ──────────────────────────────────────────────────────

function createMockHashService(): IHashService {
    return {
        hash: vi.fn((inputs: Hex[]): Hex => {
            const combined = inputs.map((i) => i.slice(2, 10)).join("");
            return `0x${combined.padEnd(64, "0")}` as Hex;
        }),
    };
}

// ── Mock crypto service ────────────────────────────────────────────────────

const MOCK_EPHEMERAL_PRIVATE_KEY =
    "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_EPHEMERAL_PUBLIC_KEY =
    "0x031111111111111111111111111111111111111111111111111111111111111111" as PublicKey;
const MOCK_SHARED_SECRET =
    "0x2222222222222222222222222222222222222222222222222222222222222222" as Secret;
const MOCK_ENCRYPTED = "0xdeadbeefcafebabe" as Hex;

function createMockCryptoService(): ICryptoService {
    return {
        generateEphemeralKeyPair: vi.fn(() => ({
            privateKey: MOCK_EPHEMERAL_PRIVATE_KEY,
            publicKey: MOCK_EPHEMERAL_PUBLIC_KEY,
        })),
        ecdh: vi.fn(() => MOCK_SHARED_SECRET),
        encrypt: vi.fn(() => MOCK_ENCRYPTED),
        decrypt: vi.fn(),
        generateSecret: vi.fn(),
        deriveKeysFromSignature: vi.fn(),
        derivePaymentRequestKeyPair: vi.fn(),
    };
}

// ── Constants ──────────────────────────────────────────────────────────────

const OWNER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const NOTE_SECRET = `0x${"aa".repeat(32)}` as Secret;
const TOKEN_ID = `0x${"ee".repeat(20)}` as Address;
const VALUE = `0x${"00".repeat(31)}64` as Hex;
const LABEL = `0x${"dd".repeat(32)}` as Hex;
const DEPOSIT_SECRET = `0x${"bb".repeat(32)}` as Secret;
const RECIPIENT_VIEWING_PUB_KEY =
    "0x033333333333333333333333333333333333333333333333333333333333333333" as PublicKey;

const VALID_PAYLOAD: NotePayload = {
    noteSecret: NOTE_SECRET,
    value: VALUE,
    tokenId: TOKEN_ID,
    label: LABEL,
};

const NOTE_ADDRESS_HASH = `0x${"ab".repeat(32)}` as Hash;
const VALID_PR_PAYLOAD: PaymentRequestNotePayload = {
    noteAddressHash: NOTE_ADDRESS_HASH,
    value: VALUE,
    tokenId: TOKEN_ID,
    label: LABEL,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe("NoteComputationService", () => {
    describe("hash chain computations", () => {
        it("compute noteAddressHash by hashing [ownerAddress, noteSecret]", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            service.computeNoteAddressHash(OWNER_ADDRESS, NOTE_SECRET);

            expect(hashService.hash).toHaveBeenCalledWith([OWNER_ADDRESS, NOTE_SECRET]);
        });

        it("compute precommitment by hashing [noteAddressHash, tokenId, value, METADATA_STANDARD]", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            const noteAddressHash = "0x1111" as Hex;
            service.computePrecommitment(noteAddressHash, TOKEN_ID, VALUE);

            expect(hashService.hash).toHaveBeenCalledWith([
                noteAddressHash,
                TOKEN_ID,
                VALUE,
                "0x0",
            ]);
        });

        it("compute label by hashing [precommitment, depositSecret]", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            const precommitment = "0x2222" as Hex;
            service.computeLabel(precommitment, DEPOSIT_SECRET);

            expect(hashService.hash).toHaveBeenCalledWith([precommitment, DEPOSIT_SECRET]);
        });

        it("compute fullCommitment by chaining precommitment and commitment", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            const noteAddressHash = "0x1111" as Hex;
            service.computeFullCommitment({
                noteAddressHash,
                tokenId: TOKEN_ID,
                value: VALUE,
                label: LABEL,
            });

            // First call: precommitment
            expect(hashService.hash).toHaveBeenCalledWith([
                noteAddressHash,
                TOKEN_ID,
                VALUE,
                "0x0",
            ]);
            // Second call: commitment (using result of first)
            expect(hashService.hash).toHaveBeenCalledTimes(2);
        });

        it("compute authDigest by hashing [AUTH_TYPE_DIRECT_KEY, privateRevocableKey]", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            service.computeAuthDigest(NOTE_SECRET);

            expect(hashService.hash).toHaveBeenCalledWith(["0x0", NOTE_SECRET]);
        });
    });

    describe("generateNoteData", () => {
        it("return NoteData with random non-zero hint and concatenated ephemeralPubKey + encrypted data when no hint is supplied", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            const result = service.generateNoteData(VALID_PAYLOAD, RECIPIENT_VIEWING_PUB_KEY);

            // Hint must be 32 bytes and must not be the all-zero sentinel —
            // a fixed zero hint would let observers cluster anonymous notes.
            expect(result.hint).toMatch(/^0x[0-9a-f]{64}$/);
            expect(result.hint).not.toBe(`0x${"00".repeat(32)}`);
            const expectedData =
                "0x" + MOCK_EPHEMERAL_PUBLIC_KEY.slice(2) + MOCK_ENCRYPTED.slice(2);
            expect(result.data).toBe(expectedData);
        });

        it("uses caller-provided hint verbatim when supplied", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });
            const explicitHint = `0x${"ab".repeat(32)}` as `0x${string}`;

            const result = service.generateNoteData(
                VALID_PAYLOAD,
                RECIPIENT_VIEWING_PUB_KEY,
                explicitHint,
            );

            expect(result.hint).toBe(explicitHint);
        });

        it("generate ephemeral key pair via cryptoService", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            service.generateNoteData(VALID_PAYLOAD, RECIPIENT_VIEWING_PUB_KEY);

            expect(cryptoService.generateEphemeralKeyPair).toHaveBeenCalledOnce();
        });

        it("derive shared secret via ECDH with ephemeral private key and recipient viewing key", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            service.generateNoteData(VALID_PAYLOAD, RECIPIENT_VIEWING_PUB_KEY);

            expect(cryptoService.ecdh).toHaveBeenCalledWith(
                MOCK_EPHEMERAL_PRIVATE_KEY,
                RECIPIENT_VIEWING_PUB_KEY,
            );
        });

        it("encrypt the encoded payload with the shared secret", () => {
            const hashService = createMockHashService();
            const cryptoService = createMockCryptoService();
            const service = new NoteComputationService({ hashService, cryptoService });

            service.generateNoteData(VALID_PAYLOAD, RECIPIENT_VIEWING_PUB_KEY);

            expect(cryptoService.encrypt).toHaveBeenCalledOnce();
            const encryptCall = vi.mocked(cryptoService.encrypt).mock.calls[0];
            expect(encryptCall[1]).toBe(MOCK_SHARED_SECRET);
        });
    });

    describe("encodeNotePayload", () => {
        it("produce smaller output than fixed-width when value is short", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const smallValuePayload: NotePayload = {
                ...VALID_PAYLOAD,
                value: "0x64" as Hex,
            };
            const encoded = service.encodeNotePayload(smallValuePayload);

            // RLP with 1-byte value (~91 bytes) vs fixed-width (117 bytes)
            expect(encoded.byteLength).toBeLessThan(117);
        });

        it("round-trip encode then decode to original payload", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const encoded = service.encodeNotePayload(VALID_PAYLOAD);
            const decoded = service.decodeNotePayload(encoded);

            expect(decoded).toEqual(VALID_PAYLOAD);
        });

        it("round-trip with small value without padding", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const payload: NotePayload = {
                ...VALID_PAYLOAD,
                value: "0x64" as Hex,
            };

            const encoded = service.encodeNotePayload(payload);
            const decoded = service.decodeNotePayload(encoded);

            expect(decoded.value).toBe("0x64");
        });

        it("round-trip with max uint256 value", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const maxValue = `0x${"ff".repeat(32)}` as Hex;
            const payload: NotePayload = {
                ...VALID_PAYLOAD,
                value: maxValue,
            };

            const encoded = service.encodeNotePayload(payload);
            const decoded = service.decodeNotePayload(encoded);

            expect(decoded.value).toBe(maxValue);
        });

        it("preserve 32-byte noteSecret through round-trip", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const encoded = service.encodeNotePayload(VALID_PAYLOAD);
            const decoded = service.decodeNotePayload(encoded);

            expect(decoded.noteSecret).toBe(VALID_PAYLOAD.noteSecret);
        });

        it("preserve 20-byte tokenId through round-trip", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const encoded = service.encodeNotePayload(VALID_PAYLOAD);
            const decoded = service.decodeNotePayload(encoded);

            expect(decoded.tokenId).toBe(VALID_PAYLOAD.tokenId);
        });
    });

    describe("decodeNotePayload", () => {
        it("reject invalid RLP bytes", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            expect(() => service.decodeNotePayload(new Uint8Array([0xff]))).toThrow(
                PayloadDecodeError,
            );
        });

        it("reject unknown version", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const rlpHex = encodeHexListRlp([
                "0x99",
                "0x01",
                `0x${"aa".repeat(32)}`,
                "0x64",
                `0x${"ee".repeat(20)}`,
                `0x${"dd".repeat(32)}`,
            ]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodeNotePayload(bytes)).toThrow(PayloadDecodeError);
            expect(() => service.decodeNotePayload(bytes)).toThrow(
                /unsupported NotePayload version/,
            );
        });

        it("decode a legacy v1 payload (backward compatibility)", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            // v1 wire (no kind byte): RLP([0x01, noteSecret, value, tokenId, label]).
            const rlpHex = encodeHexListRlp([
                "0x01",
                VALID_PAYLOAD.noteSecret,
                VALID_PAYLOAD.value,
                VALID_PAYLOAD.tokenId,
                VALID_PAYLOAD.label,
            ]);
            const bytes = hexToBytes(rlpHex.slice(2));

            const decoded = service.decodeNotePayload(bytes);

            expect(decoded).toEqual(VALID_PAYLOAD);
        });

        it("reject a legacy v1 payload with wrong field count", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            const rlpHex = encodeHexListRlp(["0x01", "0xaa", "0xbb"]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodeNotePayload(bytes)).toThrow(PayloadDecodeError);
            expect(() => service.decodeNotePayload(bytes)).toThrow(/v1 expects 4 fields/);
        });

        it("reject a payload whose tokenId is not a 20-byte address", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            // A short tokenId (RLP strips leading zeros) must be rejected at decode, not cast
            // through to a later addNote failure that stalls the discovery cursor (audit #42).
            const rlpHex = encodeHexListRlp([
                "0x01",
                VALID_PAYLOAD.noteSecret,
                VALID_PAYLOAD.value,
                "0x00",
                VALID_PAYLOAD.label,
            ]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodeNotePayload(bytes)).toThrow(PayloadDecodeError);
            expect(() => service.decodeNotePayload(bytes)).toThrow(/invalid tokenId/);
        });

        it("reject an unknown kind via the full decoder", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            // Valid version (0x02) but an unknown kind byte (0x99).
            const rlpHex = encodeHexListRlp([
                "0x02",
                "0x99",
                `0x${"aa".repeat(32)}`,
                "0x64",
                `0x${"ee".repeat(20)}`,
                `0x${"dd".repeat(32)}`,
            ]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodeNotePayload(bytes)).toThrow(PayloadDecodeError);
            expect(() => service.decodeNotePayload(bytes)).toThrow(/expected kind 1 \(full\)/);
        });

        it("reject a full-kind payload with wrong field count", () => {
            const hashService = createMockHashService();
            const service = new NoteComputationService({
                hashService,
                cryptoService: createMockCryptoService(),
            });

            // Version OK, kind=full, but only 2 trailing fields instead of 4.
            const rlpHex = encodeHexListRlp(["0x02", "0x01", "0xaa", "0xbb"]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodeNotePayload(bytes)).toThrow(PayloadDecodeError);
            expect(() => service.decodeNotePayload(bytes)).toThrow(/full kind expects 4 fields/);
        });
    });

    describe("payment-request note payload (blind kind)", () => {
        function makeService(): NoteComputationService {
            return new NoteComputationService({
                hashService: createMockHashService(),
                cryptoService: createMockCryptoService(),
            });
        }

        it("round-trip a blind-kind payload carrying noteAddressHash and no secret", () => {
            const service = makeService();

            const encoded = service.encodePaymentRequestNotePayload(VALID_PR_PAYLOAD);
            const decoded = service.decodePaymentRequestNotePayload(encoded);

            expect(decoded).toEqual(VALID_PR_PAYLOAD);
        });

        it("encode version 0x02 and kind 0x02 (blind)", () => {
            const service = makeService();

            const encoded = service.encodePaymentRequestNotePayload(VALID_PR_PAYLOAD);
            const items = decodeHexListRlp(`0x${bytesToHex(encoded)}` as Hex);

            expect(Number(items[0])).toBe(2);
            expect(Number(items[1])).toBe(2);
        });

        it("reject a full-kind payload via the blind decoder", () => {
            const service = makeService();

            const fullBytes = service.encodeNotePayload(VALID_PAYLOAD);

            expect(() => service.decodePaymentRequestNotePayload(fullBytes)).toThrow(
                PayloadDecodeError,
            );
            expect(() => service.decodePaymentRequestNotePayload(fullBytes)).toThrow(
                /expected kind 2 \(blind\)/,
            );
        });

        it("reject a blind-kind payload with wrong field count", () => {
            const service = makeService();

            // Version OK, kind=blind, but only 2 trailing fields instead of 4.
            const rlpHex = encodeHexListRlp(["0x02", "0x02", "0xaa", "0xbb"]);
            const bytes = hexToBytes(rlpHex.slice(2));

            expect(() => service.decodePaymentRequestNotePayload(bytes)).toThrow(
                /blind kind expects 4 fields/,
            );
        });

        it("reject a blind-kind payload via the full decoder", () => {
            const service = makeService();

            const blindBytes = service.encodePaymentRequestNotePayload(VALID_PR_PAYLOAD);

            expect(() => service.decodeNotePayload(blindBytes)).toThrow(/expected kind 1 \(full\)/);
        });
    });
});
