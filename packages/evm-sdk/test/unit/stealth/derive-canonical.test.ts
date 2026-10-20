import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    EphemeralKeyPair,
    Scalar32,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthPrivateKey,
    generateEphemeralKeyPair,
    scanAnnouncement,
    SCHEME_CANONICAL,
    StealthAddressDeriveError,
    StealthAddressScanIntegrityError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const hexToBytes = (hex: string): Uint8Array => {
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

const newCanonicalRecipient = (): {
    metaAddress: CanonicalMetaAddress;
    spendingPriv: Scalar32;
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
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
        viewingPriv: bytesToHex(viewingPriv) as Scalar32,
    };
};

describe("canonical scheme 1 derivation (EIP-5564 point addition)", () => {
    it("DERIV-1-01: sender derives → recipient (viewing_priv + spending_pub) recovers (round-trip)", () => {
        const { metaAddress, spendingPriv, viewingPriv } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);

        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_CANONICAL,
        );
        expect(announcement.schemeId).toBe(SCHEME_CANONICAL);

        const recovered = scanAnnouncement(announcement, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPublicKey: metaAddress.spendingPubKey,
        });
        expect(recovered, "canonical scan must recover").toBe(stealthAddress);

        // Stealth private key derived via (spending_priv + hash) mod n.
        // Self-validated internally; this is a redundant safety check.
        const stealthPriv = deriveStealthPrivateKey(announcement, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: viewingPriv,
            spendingPrivateKey: spendingPriv,
        });
        const stealthPub = secp256k1.getPublicKey(hexToBytes(stealthPriv), false);
        const stealthAddrFromPriv = bytesToHex(keccak_256(stealthPub.slice(1)).slice(12));
        expect(stealthAddrFromPriv).toBe(stealthAddress);
    });

    it("DERIV-1-01: round-trip holds across 50 random (recipient, ephemeral) pairs", () => {
        for (let i = 0; i < 50; i++) {
            const { metaAddress, viewingPriv } = newCanonicalRecipient();
            const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
            const { stealthAddress, announcement } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_CANONICAL,
            );
            const recovered = scanAnnouncement(announcement, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: viewingPriv,
                spendingPublicKey: metaAddress.spendingPubKey,
            });
            expect(recovered, `iteration ${i}`).toBe(stealthAddress);
        }
    });

    it("canonical ephemeral pubkey is 33-byte compressed (EIP-5564 spec)", () => {
        const eph = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const pubBytes = hexToBytes(eph.publicKey);
        expect(pubBytes.length, "compressed pubkey is 33 bytes").toBe(33);
        expect(
            pubBytes[0] === 0x02 || pubBytes[0] === 0x03,
            `expected compressed prefix 0x02 or 0x03, got 0x${pubBytes[0]!.toString(16)}`,
        ).toBeTruthy();
    });

    it("SCAN: non-recipient returns null on canonical announcements", () => {
        const { metaAddress } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_CANONICAL);
        const attacker = newCanonicalRecipient();
        const recovered = scanAnnouncement(announcement, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: attacker.viewingPriv,
            spendingPublicKey: attacker.metaAddress.spendingPubKey,
        });
        expect(recovered).toBeNull();
    });

    it("SCAN: 100 unrelated canonical announcements, attacker never recovers", () => {
        const attacker = newCanonicalRecipient();
        let falsePositives = 0;
        for (let i = 0; i < 100; i++) {
            const { metaAddress } = newCanonicalRecipient();
            const eph = generateEphemeralKeyPair(SCHEME_CANONICAL);
            const { announcement } = deriveStealthAddress(metaAddress, eph, SCHEME_CANONICAL);
            const r = scanAnnouncement(announcement, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: attacker.viewingPriv,
                spendingPublicKey: attacker.metaAddress.spendingPubKey,
            });
            if (r !== null) falsePositives++;
        }
        expect(falsePositives).toBe(0);
    });

    it("INTEGRITY: canonical deriveStealthPrivateKey rejects a mangled announcement", () => {
        const { metaAddress, spendingPriv, viewingPriv } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_CANONICAL);
        const mangled = {
            ...announcement,
            stealthAddress:
                "0x0000000000000000000000000000000000000001" as typeof announcement.stealthAddress,
        };
        expect(() =>
            deriveStealthPrivateKey(mangled, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: viewingPriv,
                spendingPrivateKey: spendingPriv,
            }),
        ).toThrow(StealthAddressScanIntegrityError);
    });

    it("INTEGRITY: canonical derivation rejects a mismatched ephemeral keypair", () => {
        const { metaAddress } = newCanonicalRecipient();
        // Build an inconsistent pair: privateKey from one keypair, publicKey
        // (compressed) from an unrelated keypair. Derivation uses privateKey for
        // the shared secret but publishes publicKey verbatim, so a mismatch
        // would silently mis-derive the recipient's stealth address.
        const privA = randomBytes(32);
        const pubB = secp256k1.getPublicKey(randomBytes(32), /* compressed */ true);
        const mismatched: EphemeralKeyPair = {
            privateKey: bytesToHex(privA) as Scalar32,
            publicKey: bytesToHex(pubB) as CompressedPubKey,
        };
        expect(() => deriveStealthAddress(metaAddress, mismatched, SCHEME_CANONICAL)).toThrow(
            StealthAddressDeriveError,
        );
    });

    it("view tag is exactly 1 byte for canonical announcements", () => {
        const { metaAddress } = newCanonicalRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_CANONICAL);
        expect(announcement.viewTag >= 0 && announcement.viewTag < 256).toBeTruthy();
        expect(Number.isInteger(announcement.viewTag)).toBeTruthy();
    });
});
