import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    Hex,
    MetaAddress,
    Scalar32,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthSharedSecret,
    encodeStealthDepositPayload,
    generateEphemeralKeyPair,
    scanDepositNoteData,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    StealthAddressDeriveError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const newCanonicalRecipient = (): {
    metaAddress: CanonicalMetaAddress;
    spendingPub: CompressedPubKey;
    viewingPriv: Scalar32;
} => {
    const spendingPriv = randomBytes(32);
    const viewingPriv = randomBytes(32);
    const spendingPub = secp256k1.getPublicKey(spendingPriv, /* compressed */ true);
    const viewingPub = secp256k1.getPublicKey(viewingPriv, /* compressed */ true);
    return {
        metaAddress: {
            scheme: SCHEME_CANONICAL,
            spendingPubKey: bytesToHex(spendingPub) as CompressedPubKey,
            viewingPubKey: bytesToHex(viewingPub) as CompressedPubKey,
        },
        spendingPub: bytesToHex(spendingPub) as CompressedPubKey,
        viewingPriv: bytesToHex(viewingPriv) as Scalar32,
    };
};

const newFluidKeyRecipient = (): { metaAddress: MetaAddress; spendingPriv: Scalar32 } => {
    const spendingPriv = randomBytes(32);
    const spendingPub = secp256k1.getPublicKey(spendingPriv, /* compressed */ false);
    return {
        metaAddress: {
            scheme: SCHEME_FLUIDKEY,
            spendingPubKey: bytesToHex(spendingPub) as UncompressedPubKey,
        },
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
    };
};

const ENCRYPTED_NOTE_SECRET = "0xdeadbeefcafe" as Hex;

describe("encodeStealthDepositPayload / scanDepositNoteData", () => {
    it("recover the sender's stealth address and shared secret for the canonical scheme (round-trip)", () => {
        const { metaAddress, spendingPub, viewingPriv } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);

        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_CANONICAL,
        );
        const senderSecret = deriveStealthSharedSecret(metaAddress, ephemeral, SCHEME_CANONICAL);

        const data = encodeStealthDepositPayload({
            schemeId: SCHEME_CANONICAL,
            ephemeralPubKey: ephemeral.publicKey as CompressedPubKey,
            viewTag: announcement.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });

        const match = scanDepositNoteData(data, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPublicKey: spendingPub,
        });

        expect(match).not.toBeNull();
        expect(match?.stealthAddress).toBe(stealthAddress);
        expect(bytesToHex(match!.sharedSecret)).toBe(bytesToHex(senderSecret));
        expect(match?.encryptedNoteSecret).toBe(ENCRYPTED_NOTE_SECRET);
    });

    it("recover the sender's stealth address and shared secret for the FluidKey scheme (round-trip)", () => {
        const { metaAddress, spendingPriv } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_FLUIDKEY,
        );
        const senderSecret = deriveStealthSharedSecret(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        const data = encodeStealthDepositPayload({
            schemeId: SCHEME_FLUIDKEY,
            ephemeralPubKey: ephemeral.publicKey as UncompressedPubKey,
            viewTag: announcement.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });

        const match = scanDepositNoteData(data, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: spendingPriv,
        });

        expect(match).not.toBeNull();
        expect(match?.stealthAddress).toBe(stealthAddress);
        expect(bytesToHex(match!.sharedSecret)).toBe(bytesToHex(senderSecret));
    });

    it("return null for a scheme mismatch instead of throwing (sweeping unrelated deposits must not abort)", () => {
        const { metaAddress } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        const data = encodeStealthDepositPayload({
            schemeId: SCHEME_FLUIDKEY,
            ephemeralPubKey: ephemeral.publicKey as UncompressedPubKey,
            viewTag: announcement.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });

        const { spendingPub, viewingPriv } = newCanonicalRecipient();
        const match = scanDepositNoteData(data, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPublicKey: spendingPub,
        });

        expect(match).toBeNull();
    });

    it("return null for a view-tag miss against the wrong recipient's credentials", () => {
        const { metaAddress } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        const data = encodeStealthDepositPayload({
            schemeId: SCHEME_FLUIDKEY,
            ephemeralPubKey: ephemeral.publicKey as UncompressedPubKey,
            viewTag: announcement.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });

        const someoneElse = newFluidKeyRecipient();
        const match = scanDepositNoteData(data, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: someoneElse.spendingPriv,
        });

        expect(match).toBeNull();
    });

    it("return null for malformed / truncated noteData.data instead of throwing", () => {
        const { viewingPriv, spendingPub } = newCanonicalRecipient();
        const credentials = {
            scheme: SCHEME_CANONICAL as typeof SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPublicKey: spendingPub,
        };

        expect(scanDepositNoteData("0x" as Hex, credentials)).toBeNull();
        expect(scanDepositNoteData("0x0001" as Hex, credentials)).toBeNull();
        expect(scanDepositNoteData("0xffffff00" as Hex, credentials)).toBeNull();
        // An ordinary deposit's opaque discovery payload — not a stealth payload at all.
        expect(scanDepositNoteData(bytesToHex(randomBytes(48)) as Hex, credentials)).toBeNull();
    });

    it("produce different secrets across independent ephemeral keys (sanity — not a fixed/degenerate value)", () => {
        const { metaAddress, spendingPriv } = newFluidKeyRecipient();
        const ephemeralA = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const ephemeralB = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const { announcement: announcementA } = deriveStealthAddress(
            metaAddress,
            ephemeralA,
            SCHEME_FLUIDKEY,
        );
        const { announcement: announcementB } = deriveStealthAddress(
            metaAddress,
            ephemeralB,
            SCHEME_FLUIDKEY,
        );

        const dataA = encodeStealthDepositPayload({
            schemeId: SCHEME_FLUIDKEY,
            ephemeralPubKey: ephemeralA.publicKey as UncompressedPubKey,
            viewTag: announcementA.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });
        const dataB = encodeStealthDepositPayload({
            schemeId: SCHEME_FLUIDKEY,
            ephemeralPubKey: ephemeralB.publicKey as UncompressedPubKey,
            viewTag: announcementB.viewTag,
            encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
        });

        const credentials = {
            scheme: SCHEME_FLUIDKEY as typeof SCHEME_FLUIDKEY,
            spendingPrivateKey: spendingPriv,
        };
        const matchA = scanDepositNoteData(dataA, credentials);
        const matchB = scanDepositNoteData(dataB, credentials);

        expect(matchA).not.toBeNull();
        expect(matchB).not.toBeNull();
        expect(matchA?.stealthAddress).not.toBe(matchB?.stealthAddress);
        expect(bytesToHex(matchA!.sharedSecret)).not.toBe(bytesToHex(matchB!.sharedSecret));
    });

    it("throw StealthAddressDeriveError when viewTag is out of the single-byte range", () => {
        expect(() =>
            encodeStealthDepositPayload({
                schemeId: SCHEME_CANONICAL,
                ephemeralPubKey: "0x02".padEnd(68, "0") as CompressedPubKey,
                viewTag: 256,
                encryptedNoteSecret: ENCRYPTED_NOTE_SECRET,
            }),
        ).toThrow(StealthAddressDeriveError);
    });
});
