import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type { Hex } from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    encodeViewTagAsMetadata,
    generateEphemeralKeyPair,
    resolveRecipient,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    toStealthAnnouncementFields,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): Hex => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s as unknown as Hex;
};

// G-1: the public bridge from a StealthDerivation to the relayer's StealthAnnouncementFields, so the
// atomic relayed stealth flow is reachable without hand-assembly.
describe("toStealthAnnouncementFields (G-1 relay bridge)", () => {
    it("canonical: maps schemeId 0x0001, the stealth address, the compressed ephemeral, and the view-tag metadata", () => {
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), /* compressed */ true);
        const viewingPub = secp256k1.getPublicKey(randomBytes(32), true);
        const meta = resolveRecipient({
            kind: "canonical",
            spendingPubKey: bytesToHex(spendingPub),
            viewingPubKey: bytesToHex(viewingPub),
        });
        const derivation = deriveStealthAddress(
            meta,
            generateEphemeralKeyPair(SCHEME_CANONICAL),
            SCHEME_CANONICAL,
        );

        const fields = toStealthAnnouncementFields(derivation);

        expect(BigInt(fields.schemeId)).toBe(BigInt(SCHEME_CANONICAL));
        expect(fields.stealthAddress).toBe(derivation.stealthAddress);
        expect(fields.ephemeralPubKey).toBe(derivation.announcement.ephemeralPubKey);
        // Canonical ephemeral is compressed (33 bytes).
        expect((fields.ephemeralPubKey as string).length).toBe(2 + 33 * 2);
        expect(fields.metadata).toBe(encodeViewTagAsMetadata(derivation.announcement.viewTag));
        // View tag is exactly 1 byte.
        expect((fields.metadata as string).length).toBe(2 + 2);
    });

    it("FluidKey: maps schemeId 0xfffe and the 65-byte uncompressed ephemeral", () => {
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), /* compressed */ false);
        const meta = resolveRecipient({ kind: "raw", spendingPubKey: bytesToHex(spendingPub) });
        const derivation = deriveStealthAddress(
            meta,
            generateEphemeralKeyPair(SCHEME_FLUIDKEY),
            SCHEME_FLUIDKEY,
        );

        const fields = toStealthAnnouncementFields(derivation);

        expect(BigInt(fields.schemeId)).toBe(BigInt(SCHEME_FLUIDKEY));
        // FluidKey ephemeral is uncompressed (65 bytes).
        expect((fields.ephemeralPubKey as string).length).toBe(2 + 65 * 2);
        expect(fields.stealthAddress).toBe(derivation.stealthAddress);
    });
});
