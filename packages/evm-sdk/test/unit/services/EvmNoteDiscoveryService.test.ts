import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    ICryptoService,
    IHashService,
    INoteComputationService,
    NoteEvent,
    NotePayload,
    PaymentRequestNotePayload,
    PublicKey,
    Secret,
} from "../../../src/internal.js";
import { CATCH_ALL_TAG, EvmAddressFieldConverter, EvmNoteDiscoveryService } from "../../../src/internal.js";
// See INoteDiscoveryService.ts's own doc for why the stealth module is imported directly rather
// than through internal.js.
import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    Scalar32,
    Hex as StealthHex,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    encodeStealthDepositPayload,
    generateEphemeralKeyPair,
    SCHEME_CANONICAL,
} from "../../../src/stealth/index.js";

/**
 * `scanStealthDeposits` coverage for `EvmNoteDiscoveryService` — split out of core-sdk's
 * `NoteDiscoveryService.test.ts` (see that file's own NOTE comment) since the method itself
 * moved here: it's ERC-5564-specific (secp256k1 stealth-address derivation, a pinned Announcer
 * contract), not a generic chain capability. `scanTargeted`/`scanCatchAll`/`scanPaymentRequests`
 * stay covered against the base `NoteDiscoveryService` in core-sdk — this file only re-verifies
 * `decryptNotePayload`/`computeNoteCommitment` reuse works correctly through the subclass.
 */

const OWNER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678" as Address;

const VALID_NOTE_PAYLOAD: NotePayload = {
    noteSecret: `0x${"aa".repeat(32)}` as Secret,
    value: `0x${"00".repeat(31)}64` as Hex,
    tokenId: `0x${"ee".repeat(20)}` as Address,
    label: `0x${"dd".repeat(32)}` as Hex,
};

const VALID_PAYLOAD_BYTES = new Uint8Array([0x02, 0x01]);

const EPH_PUB_KEY = ("0x02" + "00".repeat(32)) as PublicKey;

const MOCK_TX_HASH = "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash;

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
            throw new Error("not used by scanStealthDeposits coverage");
        }),
        generatePaymentRequestNoteData: vi.fn(() => ({
            hint: `0x${"00".repeat(32)}` as Hex,
            data: "0x" as Hex,
        })),
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

const stealthBytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

/** Fresh canonical-scheme stealth recipient (mirrors stealth/sharedSecret.test.ts's helper). */
function newStealthRecipient(): {
    metaAddress: CanonicalMetaAddress;
    viewingPriv: Scalar32;
    spendingPub: CompressedPubKey;
} {
    const spendingPriv = randomBytes(32);
    const viewingPriv = randomBytes(32);
    const spendingPub = secp256k1.getPublicKey(spendingPriv, /* compressed */ true);
    const viewingPub = secp256k1.getPublicKey(viewingPriv, /* compressed */ true);
    return {
        metaAddress: {
            scheme: SCHEME_CANONICAL,
            spendingPubKey: stealthBytesToHex(spendingPub) as CompressedPubKey,
            viewingPubKey: stealthBytesToHex(viewingPub) as CompressedPubKey,
        },
        viewingPriv: stealthBytesToHex(viewingPriv) as Scalar32,
        spendingPub: stealthBytesToHex(spendingPub) as CompressedPubKey,
    };
}

/**
 * A real Note event whose `noteData.data` (reconstructed from ephemeralPubKey +
 * encryptedPayload, mirroring `decodeNoteData`'s split) carries a genuine stealth
 * payload for `recipient`, produced via the real stealth crypto — `cryptoService`/
 * `noteComputationService` stay mocked since decrypting the *note payload itself* is
 * generic and already covered by core-sdk's own NoteDiscoveryService.test.ts.
 */
function makeStealthDepositEvent(recipient: { metaAddress: CanonicalMetaAddress }): {
    event: NoteEvent;
    stealthAddress: Address;
} {
    const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
    const { stealthAddress, announcement } = deriveStealthAddress(
        recipient.metaAddress,
        ephemeral,
        SCHEME_CANONICAL,
    );
    const data = encodeStealthDepositPayload({
        schemeId: SCHEME_CANONICAL,
        ephemeralPubKey: ephemeral.publicKey as CompressedPubKey,
        viewTag: announcement.viewTag,
        encryptedNoteSecret: ("0x" + "12".repeat(20)) as StealthHex,
    });
    // Same split `decodeNoteData` applies to raw on-chain `data`: first 32 bytes as
    // ephemeralPubKey, remainder as encryptedPayload — reconstructed inside
    // tryDecryptStealthDepositEvent before parsing as a stealth payload.
    const ephemeralPubKeyField = data.slice(0, 66) as PublicKey;
    const encryptedPayloadField = ("0x" + data.slice(66)) as Hex;
    return {
        event: makeNoteEvent({
            ephemeralPubKey: ephemeralPubKeyField,
            encryptedPayload: encryptedPayloadField,
        }),
        stealthAddress: stealthAddress as unknown as Address,
    };
}

describe("EvmNoteDiscoveryService", () => {
    let service: EvmNoteDiscoveryService;
    let cryptoService: ICryptoService;
    let noteComputationService: INoteComputationService;

    beforeEach(() => {
        cryptoService = createMockCryptoService();
        const hashService = createMockHashService();
        noteComputationService = createMockNoteComputationService();
        service = new EvmNoteDiscoveryService({
            cryptoService,
            hashService,
            noteComputationService,
            addressFieldConverter: new EvmAddressFieldConverter(),
        });
    });

    describe("scanStealthDeposits", () => {
        it("return empty array when events is empty", () => {
            const recipient = newStealthRecipient();
            const result = service.scanStealthDeposits([], {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPriv,
                spendingPublicKey: recipient.spendingPub,
            });
            expect(result).toEqual([]);
        });

        it("discover a stealth-owned deposit and set ownerAddress to the derived stealth address", () => {
            const recipient = newStealthRecipient();
            const { event, stealthAddress } = makeStealthDepositEvent(recipient);

            const result = service.scanStealthDeposits([event], {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPriv,
                spendingPublicKey: recipient.spendingPub,
            });

            expect(result).toHaveLength(1);
            expect(result[0]?.ownerAddress).toBe(stealthAddress);
            expect(result[0]?.contact).toBeNull();
            expect(result[0]?.value).toBe(VALID_NOTE_PAYLOAD.value);
            expect(result[0]?.tokenId).toBe(VALID_NOTE_PAYLOAD.tokenId);
        });

        it("return empty array for an ordinary (non-stealth) deposit event", () => {
            const recipient = newStealthRecipient();
            const event = makeNoteEvent();

            const result = service.scanStealthDeposits([event], {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: recipient.viewingPriv,
                spendingPublicKey: recipient.spendingPub,
            });

            expect(result).toEqual([]);
        });

        it("return empty array when credentials belong to the wrong recipient", () => {
            const recipient = newStealthRecipient();
            const { event } = makeStealthDepositEvent(recipient);
            const someoneElse = newStealthRecipient();

            const result = service.scanStealthDeposits([event], {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: someoneElse.viewingPriv,
                spendingPublicKey: someoneElse.spendingPub,
            });

            expect(result).toEqual([]);
        });

        it("not throw and skip when decrypting the recovered payload fails", () => {
            (cryptoService.decrypt as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
                throw new Error("bad ciphertext");
            });
            const recipient = newStealthRecipient();
            const { event } = makeStealthDepositEvent(recipient);

            expect(() =>
                service.scanStealthDeposits([event], {
                    scheme: SCHEME_CANONICAL,
                    viewingPrivateKey: recipient.viewingPriv,
                    spendingPublicKey: recipient.spendingPub,
                }),
            ).not.toThrow();
        });
    });
});
