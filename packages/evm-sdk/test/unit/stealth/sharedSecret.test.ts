import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    MetaAddress,
    Scalar32,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthSharedSecret,
    generateEphemeralKeyPair,
    recoverStealthSharedSecret,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    StealthAddressSchemeMismatchError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const newCanonicalRecipient = (): {
    metaAddress: CanonicalMetaAddress;
    spendingPriv: Scalar32;
    viewingPriv: Scalar32;
    spendingPub: CompressedPubKey;
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
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
        viewingPriv: bytesToHex(viewingPriv) as Scalar32,
        spendingPub: bytesToHex(spendingPub) as CompressedPubKey,
    };
};

const newFluidKeyRecipient = (): {
    metaAddress: MetaAddress;
    spendingPriv: Scalar32;
} => {
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

describe("deriveStealthSharedSecret / recoverStealthSharedSecret", () => {
    it("agree on the same shared secret for the canonical scheme (round-trip)", () => {
        const { metaAddress, viewingPriv, spendingPub } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);

        const senderSecret = deriveStealthSharedSecret(metaAddress, ephemeral, SCHEME_CANONICAL);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_CANONICAL);

        const recipientSecret = recoverStealthSharedSecret(announcement, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPublicKey: spendingPub,
        });

        expect(bytesToHex(recipientSecret)).toBe(bytesToHex(senderSecret));
    });

    it("agree on the same shared secret for the FluidKey scheme (round-trip)", () => {
        const { metaAddress, spendingPriv } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const senderSecret = deriveStealthSharedSecret(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        const recipientSecret = recoverStealthSharedSecret(announcement, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: spendingPriv,
        });

        expect(bytesToHex(recipientSecret)).toBe(bytesToHex(senderSecret));
    });

    it("produce different secrets across independent derivations (sanity — not a fixed/degenerate value)", () => {
        const { metaAddress } = newFluidKeyRecipient();
        const ephemeralA = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const ephemeralB = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const secretA = deriveStealthSharedSecret(metaAddress, ephemeralA, SCHEME_FLUIDKEY);
        const secretB = deriveStealthSharedSecret(metaAddress, ephemeralB, SCHEME_FLUIDKEY);

        expect(bytesToHex(secretA)).not.toBe(bytesToHex(secretB));
    });

    it("throw StealthAddressSchemeMismatchError when schemeId does not match metaAddress.scheme", () => {
        const { metaAddress } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        expect(() => deriveStealthSharedSecret(metaAddress, ephemeral, SCHEME_CANONICAL)).toThrow(
            StealthAddressSchemeMismatchError,
        );
    });

    it("throw StealthAddressSchemeMismatchError when recovering with mismatched credentials.scheme", () => {
        const { metaAddress } = newFluidKeyRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        expect(() =>
            recoverStealthSharedSecret(announcement, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: "0x00" as Scalar32,
                spendingPublicKey: "0x00" as CompressedPubKey,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });
});
