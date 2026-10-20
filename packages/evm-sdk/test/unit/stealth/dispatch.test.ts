import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    Announcement,
    CanonicalMetaAddress,
    CompressedPubKey,
    FluidKeyMetaAddress,
    Scalar32,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthPrivateKey,
    generateEphemeralKeyPair,
    scanAnnouncement,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    StealthAddressSchemeMismatchError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

const newCanonical = (): {
    meta: CanonicalMetaAddress;
    spendingPriv: Scalar32;
    viewingPriv: Scalar32;
} => {
    const spendingPriv = randomBytes(32);
    const viewingPriv = randomBytes(32);
    return {
        meta: {
            scheme: SCHEME_CANONICAL,
            spendingPubKey: bytesToHex(
                secp256k1.getPublicKey(spendingPriv, true),
            ) as CompressedPubKey,
            viewingPubKey: bytesToHex(
                secp256k1.getPublicKey(viewingPriv, true),
            ) as CompressedPubKey,
        },
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
        viewingPriv: bytesToHex(viewingPriv) as Scalar32,
    };
};

const newFluidKey = (): {
    meta: FluidKeyMetaAddress;
    spendingPriv: Scalar32;
} => {
    const spendingPriv = randomBytes(32);
    return {
        meta: {
            scheme: SCHEME_FLUIDKEY,
            spendingPubKey: bytesToHex(
                secp256k1.getPublicKey(spendingPriv, false),
            ) as UncompressedPubKey,
        },
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
    };
};

describe("multi-scheme dispatch (STLTH-19)", () => {
    it("DISPATCH-01: schemeId arg disagreeing with meta.scheme hard-errors (deriveStealthAddress)", () => {
        const { meta } = newCanonical();
        const eph = generateEphemeralKeyPair(SCHEME_CANONICAL);
        expect(() => deriveStealthAddress(meta, eph, SCHEME_FLUIDKEY)).toThrow(
            StealthAddressSchemeMismatchError,
        );
    });

    it("DISPATCH-01: schemeId arg disagreeing with meta.scheme hard-errors (FluidKey direction)", () => {
        const { meta } = newFluidKey();
        const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        expect(() => deriveStealthAddress(meta, eph, SCHEME_CANONICAL)).toThrow(
            StealthAddressSchemeMismatchError,
        );
    });

    it("DISPATCH-01: scanAnnouncement requires credentials.scheme == announcement.schemeId", () => {
        const { meta, viewingPriv } = newCanonical();
        const eph = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement } = deriveStealthAddress(meta, eph, SCHEME_CANONICAL);
        // Try to scan a canonical announcement with FluidKey credentials.
        expect(() =>
            scanAnnouncement(announcement, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: viewingPriv,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("DISPATCH-03: canonical recipient scanning a FluidKey announcement gets null (no positive match)", () => {
        // Same recipient identity owns BOTH a canonical meta-address AND a
        // FluidKey meta-address (with different keys; this is a stress test).
        // A FluidKey-scheme announcement targeted at the FluidKey meta should
        // NOT positive-match the canonical scanner.
        const canonical = newCanonical();
        const fluidkey = newFluidKey();

        // Sender derives under FluidKey to fluidkey.meta.
        const ephFK = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement: fkAnn } = deriveStealthAddress(fluidkey.meta, ephFK, SCHEME_FLUIDKEY);

        // Recipient runs canonical scanner. Should not find anything because
        // the scheme tags differ; the dispatch refuses to even cross-scan.
        expect(() =>
            scanAnnouncement(fkAnn, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: canonical.viewingPriv,
                spendingPublicKey: canonical.meta.spendingPubKey,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("DISPATCH-03: FluidKey recipient scanning a canonical announcement gets a mismatch error", () => {
        const canonical = newCanonical();
        const fluidkey = newFluidKey();

        const ephCanon = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement: canonAnn } = deriveStealthAddress(
            canonical.meta,
            ephCanon,
            SCHEME_CANONICAL,
        );

        expect(() =>
            scanAnnouncement(canonAnn, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: fluidkey.spendingPriv,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("DISPATCH-03: deriveStealthPrivateKey enforces scheme match (FK announcement + canonical creds)", () => {
        const canonical = newCanonical();
        const fluidkey = newFluidKey();
        const ephFK = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement: fkAnn } = deriveStealthAddress(fluidkey.meta, ephFK, SCHEME_FLUIDKEY);

        expect(() =>
            deriveStealthPrivateKey(fkAnn, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: canonical.viewingPriv,
                spendingPrivateKey: canonical.spendingPriv,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("DISPATCH-03: deriveStealthPrivateKey enforces scheme match (canonical announcement + FK creds)", () => {
        const canonical = newCanonical();
        const fluidkey = newFluidKey();
        const ephC = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const { announcement: canonAnn } = deriveStealthAddress(
            canonical.meta,
            ephC,
            SCHEME_CANONICAL,
        );

        expect(() =>
            deriveStealthPrivateKey(canonAnn, {
                scheme: SCHEME_FLUIDKEY,
                spendingPrivateKey: fluidkey.spendingPriv,
            }),
        ).toThrow(StealthAddressSchemeMismatchError);
    });

    it("DISPATCH-04: SCHEME_CANONICAL value is 0x0001 (EIP-5564 registered scheme 1)", () => {
        // Sanity: the canonical scheme constant is the EIP-5564 registered
        // scheme 1. The FluidKey constant must NOT equal it; STLTH-21 partnership
        // work will eventually move SCHEME_FLUIDKEY to a registered value, at
        // which point a new placeholder-handling layer ships alongside it.
        expect(SCHEME_CANONICAL).toBe(0x0001);
        expect(SCHEME_FLUIDKEY).not.toBe(SCHEME_CANONICAL);
    });

    it("DISPATCH-05 / STLTH-21 cross-deployment DoS: Phase-1-tagged FluidKey announcement silently misses canonical scanner", () => {
        // Surfaces the DESIGN.md §3.2 + §10 + STLTH-21 cross-deployment caveat:
        // an external SDK still emitting Phase-1 `schemeId = 0x0001` for FluidKey
        // bytes (uncompressed eph_pub + FluidKey-recipe view tag + FluidKey-derived
        // stealth address) reaches the v2 SDK's canonical scanner because
        // schemeId == SCHEME_CANONICAL. The canonical scanner does its own ECDH
        // and computes its own view tag; with overwhelming probability that view
        // tag does not match the FluidKey-recipe view tag baked into the
        // announcement, so the candidate is rejected at the view-tag pre-filter
        // and `scanAnnouncement` returns null. No fund loss, no throw - the
        // announcement is silently dropped for that recipient.
        const recipient = newCanonical();
        const fluidkeySender = newFluidKey();
        const ephFK = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement: fkAnn } = deriveStealthAddress(
            fluidkeySender.meta,
            ephFK,
            SCHEME_FLUIDKEY,
        );
        // Spoof the Phase-1 wire shape: same bytes, schemeId rewritten to 0x0001.
        // We cast through `as unknown` because the runtime shape stays valid; the
        // brand on ephemeralPubKey loosens (CompressedPubKey vs UncompressedPubKey
        // is structural in TS but secp256k1.Point.fromBytes auto-detects on wire
        // by leading byte).
        const phase1Spoofed = {
            ...fkAnn,
            schemeId: SCHEME_CANONICAL,
        } as unknown as Announcement;

        const recovered = scanAnnouncement(phase1Spoofed, {
            scheme: SCHEME_CANONICAL,
            viewingPrivateKey: recipient.viewingPriv,
            spendingPublicKey: recipient.meta.spendingPubKey,
        });
        expect(
            recovered,
            "canonical scanner must silently miss a Phase-1-tagged FluidKey announcement",
        ).toBeNull();
    });

    it("DISPATCH-04: positive paths still work per scheme", () => {
        // Sanity: dispatch doesn't break the happy paths.
        const canonical = newCanonical();
        const fluidkey = newFluidKey();

        const ephC = generateEphemeralKeyPair(SCHEME_CANONICAL);
        const dC = deriveStealthAddress(canonical.meta, ephC, SCHEME_CANONICAL);
        expect(dC.announcement.schemeId).toBe(SCHEME_CANONICAL);

        const ephFK = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const dFK = deriveStealthAddress(fluidkey.meta, ephFK, SCHEME_FLUIDKEY);
        expect(dFK.announcement.schemeId).toBe(SCHEME_FLUIDKEY);

        // The two stealth addresses are different (different schemes, different
        // crypto recipes).
        expect(dC.stealthAddress).not.toBe(dFK.stealthAddress);
    });

    it("L-C: scanAnnouncement returns null (not throw) on a malformed/off-curve ephemeralPubKey", () => {
        // The Announcer is permissionlessly spammable, so a garbage announcement is a NON-MATCH, not an
        // error — a scanner sweeping many announcements must not abort on adversarial input.
        const canonical = newCanonical();
        const { announcement } = deriveStealthAddress(
            canonical.meta,
            generateEphemeralKeyPair(SCHEME_CANONICAL),
            SCHEME_CANONICAL,
        );
        // 33-byte compressed shape but an off-curve x (all-FF exceeds the field prime) -> ECDH parse
        // throws inside computeCanonicalSharedHash, before the view-tag filter.
        const malformed: Announcement = {
            ...(announcement as Extract<Announcement, { schemeId: typeof SCHEME_CANONICAL }>),
            ephemeralPubKey: ("0x02" + "ff".repeat(32)) as CompressedPubKey,
        };

        expect(
            scanAnnouncement(malformed, {
                scheme: SCHEME_CANONICAL,
                viewingPrivateKey: canonical.viewingPriv,
                spendingPublicKey: canonical.meta.spendingPubKey,
            }),
        ).toBeNull();
    });
});
