import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import type { MetaAddress, Scalar32, UncompressedPubKey } from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthPrivateKey,
    generateEphemeralKeyPair,
    scanAnnouncement,
    SCHEME_FLUIDKEY,
    StealthAddressScanIntegrityError,
    StealthAddressSchemeMismatchError,
    StealthAddressUnsupportedSchemeError,
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

const newRecipient = (): {
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

describe("stealth address derivation (FluidKey variant, STLTH-01)", () => {
    it("DERIV-01: sender derives a stealth address the recipient can recover (round-trip)", () => {
        const { metaAddress, spendingPriv } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const { stealthAddress, announcement } = deriveStealthAddress(
            metaAddress,
            ephemeral,
            SCHEME_FLUIDKEY,
        );

        const recovered = scanAnnouncement(announcement, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: spendingPriv,
        });
        expect(recovered, "recipient should recover sender-derived address").toBe(stealthAddress);

        // The stealth private key must actually control the stealth address.
        // `deriveStealthPrivateKey` self-validates internally; if the assertion
        // here fails, the self-validation also did, so this is a redundant safety net.
        const stealthPriv = deriveStealthPrivateKey(announcement, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: spendingPriv,
        });
        const stealthPub = secp256k1.getPublicKey(hexToBytes(stealthPriv), false);
        const stealthEvmAddrFromPriv = bytesToHex(keccak_256(stealthPub.slice(1)).slice(12));
        expect(stealthEvmAddrFromPriv).toBe(stealthAddress);
    });

    it("DERIV-01: round-trip holds across 50 random (recipient, ephemeral) pairs", () => {
        for (let i = 0; i < 50; i++) {
            const { metaAddress, spendingPriv } = newRecipient();
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { stealthAddress, announcement } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_FLUIDKEY,
            );
            const recovered = scanAnnouncement(announcement, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: spendingPriv,
            });
            expect(recovered, `iteration ${i}`).toBe(stealthAddress);
        }
    });

    it("ENTROPY-02 (STLTH-13): two withdrawals to the same recipient produce different stealth addresses", () => {
        const { metaAddress } = newRecipient();
        const seen = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { stealthAddress } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_FLUIDKEY,
            );
            expect(!seen.has(stealthAddress), `collision at iteration ${i}`).toBeTruthy();
            seen.add(stealthAddress);
        }
        expect(seen.size).toBe(20);
    });

    it("VARIANT-01 (STLTH-01): unsupported scheme id rejected with typed error on derive", () => {
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        expect(() => deriveStealthAddress(metaAddress, ephemeral, 0x0002)).toThrow(
            StealthAddressUnsupportedSchemeError,
        );
    });

    it("VARIANT-01: unsupported scheme id rejected with typed error on scanAnnouncement", () => {
        const { metaAddress, spendingPriv } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        // Forge a bad scheme id by structural casting.
        const bad = { ...announcement, schemeId: 0x0003 } as unknown as typeof announcement;
        expect(() =>
            scanAnnouncement(bad, { scheme: SCHEME_FLUIDKEY, spendingPrivateKey: spendingPriv }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("VARIANT-01 (v6): scheme mismatch on deriveStealthPrivateKey rejected", () => {
        const { metaAddress, spendingPriv } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        const bad = { ...announcement, schemeId: 0x0003 } as unknown as typeof announcement;
        expect(() =>
            deriveStealthPrivateKey(bad, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: spendingPriv,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("SCAN: non-recipient returns null (sentinel, no throw)", () => {
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        const attacker = newRecipient();
        const recovered = scanAnnouncement(announcement, {
            scheme: SCHEME_FLUIDKEY,
            spendingPrivateKey: attacker.spendingPriv,
        });
        expect(recovered, "attacker must not recover; scanAnnouncement returns null").toBeNull();
    });

    it("SCAN: 100 unrelated announcements, attacker never recovers (statistical view-tag stress)", () => {
        const attacker = newRecipient();
        let falsePositives = 0;
        for (let i = 0; i < 100; i++) {
            const { metaAddress } = newRecipient();
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
            const result = scanAnnouncement(announcement, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: attacker.spendingPriv,
            });
            if (result !== null) falsePositives++;
        }
        // Expected ~100/256 to pass the view-tag filter, but candidate-address
        // check rejects them all. The assertion: zero confirmed recoveries.
        expect(
            falsePositives,
            "address-mismatch branch must reject all unrelated announcements",
        ).toBe(0);
    });

    it("INTEGRITY: deriveStealthPrivateKey rejects a mangled announcement (relayer substitution)", () => {
        const { metaAddress, spendingPriv } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        // Mangled: replace stealthAddress with a different valid-looking one.
        const mangled = {
            ...announcement,
            stealthAddress:
                "0x0000000000000000000000000000000000000001" as typeof announcement.stealthAddress,
        };
        expect(() =>
            deriveStealthPrivateKey(mangled, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: spendingPriv,
            }),
        ).toThrow(StealthAddressScanIntegrityError);
    });

    it("NEGATIVE-01 (STLTH-01): canonical-variant arithmetic (point addition) produces a DIFFERENT address", () => {
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const fluidkey = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        // Hand-compute the canonical-variant address as a smoke test.
        // Canonical: P = spending + keccak(shared.x) * G. Note "shared.x" (32B)
        // also differs from the FluidKey "shared.x||shared.y" (64B); we use the
        // canonical convention here.
        const ephPrivBytes = hexToBytes(ephemeral.privateKey);
        const spendingPubBytes = hexToBytes(metaAddress.spendingPubKey);
        const sharedCompressed = secp256k1.getSharedSecret(ephPrivBytes, spendingPubBytes, true);
        const sharedX = sharedCompressed.slice(1); // canonical hashes just X
        const h = keccak_256(sharedX);
        let hScalar = 0n;
        for (const b of h) hScalar = (hScalar << 8n) | BigInt(b);
        hScalar %= secp256k1.Point.CURVE().n;

        const spendingPoint = secp256k1.Point.fromBytes(spendingPubBytes);
        const canonicalPoint = spendingPoint.add(secp256k1.Point.BASE.multiply(hScalar));
        const canonicalUncompressed = canonicalPoint.toBytes(false);
        const canonicalAddr = bytesToHex(keccak_256(canonicalUncompressed.slice(1)).slice(12));

        expect(canonicalAddr).not.toBe(fluidkey.stealthAddress);
    });

    it("ECDH commutativity: spending_priv * eph_pub == eph_priv * spending_pub (sanity)", () => {
        const { metaAddress, spendingPriv } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);

        const sharedSender = secp256k1
            .getSharedSecret(
                hexToBytes(ephemeral.privateKey),
                hexToBytes(metaAddress.spendingPubKey),
                false,
            )
            .slice(1);
        const sharedRecipient = secp256k1
            .getSharedSecret(hexToBytes(spendingPriv), hexToBytes(ephemeral.publicKey), false)
            .slice(1);
        expect(sharedSender).toEqual(sharedRecipient);
    });
});
