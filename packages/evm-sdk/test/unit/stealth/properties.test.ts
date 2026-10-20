import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    EvmAddress,
    FluidKeyMetaAddress,
    MetaAddress,
    Scalar32,
    UncompressedPubKey,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
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

const newRecipient = (): {
    metaAddress: MetaAddress;
    spendingPriv: Scalar32;
} => {
    const spendingPriv = randomBytes(32);
    const spendingPub = secp256k1.getPublicKey(spendingPriv, false);
    return {
        metaAddress: {
            scheme: SCHEME_FLUIDKEY,
            spendingPubKey: bytesToHex(spendingPub) as UncompressedPubKey,
        },
        spendingPriv: bytesToHex(spendingPriv) as Scalar32,
    };
};

describe("properties (PROP-01/02/03, ENTROPY-02/03, NEGATIVE-13/14)", () => {
    it("ENTROPY-02 / NEGATIVE-13: generateEphemeralKeyPair takes only the scheme parameter (no seed)", () => {
        // Function.length is the count of declared parameters (excluding rest +
        // defaults). STLTH-13 requires there be no way to seed the CSPRNG; v6
        // added the `scheme` parameter (canonical vs FluidKey return different
        // pub-key formats), so length is now 1 — the scheme — never a seed.
        expect(generateEphemeralKeyPair.length).toBe(1);
    });

    it("ENTROPY-03: 1000 sequential CSPRNG-fresh ephemeral keypairs are all distinct", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const eph = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            expect(seen.has(eph.privateKey), `collision at iteration ${i}`).toBe(false);
            seen.add(eph.privateKey);
        }
        expect(seen.size).toBe(1000);
    });

    it("NEGATIVE-14 (STLTH-14): meta-address does not appear in any sender-side output", () => {
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const result = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);

        // Serialize the entire output graph and search for the meta-address hex.
        // It MUST NOT appear: only the stealth EVM address and the ephemeral
        // pubkey are sender-side outputs (STLTH-14).
        const serialized = JSON.stringify(result);
        const metaHexBody = metaAddress.spendingPubKey.slice(2).toLowerCase();
        expect(
            serialized.toLowerCase().includes(metaHexBody),
            `meta-address ${metaAddress.spendingPubKey} appeared in serialized derive output: ${serialized}`,
        ).toBe(false);
    });

    it("PROP-01: 1000 random (meta, eph) pairs produce 1000 distinct stealth addresses", () => {
        const seen = new Set<string>();
        for (let i = 0; i < 1000; i++) {
            const { metaAddress } = newRecipient();
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { stealthAddress } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_FLUIDKEY,
            );
            expect(seen.has(stealthAddress), `collision at iteration ${i}`).toBe(false);
            seen.add(stealthAddress);
        }
    });

    it("PROP-02: 200 random (meta, eph) pairs all round-trip (sender derive == recipient recover)", () => {
        for (let i = 0; i < 200; i++) {
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

    it("PROP-03: 5000 view tags are roughly uniform over [0, 256) (no severe bias)", () => {
        // Chi-square would be statistically correct but flaky in CI; we settle
        // for "every bucket has at least one hit and no bucket has >5x mean."
        const buckets = new Array<number>(256).fill(0);
        const N = 5000;
        for (let i = 0; i < N; i++) {
            const { metaAddress } = newRecipient();
            const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
            buckets[announcement.viewTag]!++;
        }
        const mean = N / 256;
        let zeroBuckets = 0;
        let maxBucket = 0;
        for (const b of buckets) {
            if (b === 0) zeroBuckets++;
            if (b > maxBucket) maxBucket = b;
        }
        // With N=5000 and 256 buckets, mean=~19.5. Pr(bucket=0) is essentially
        // zero in a true uniform; we tolerate up to 3 zeros for sample noise.
        expect(zeroBuckets, `${zeroBuckets} empty buckets`).toBeLessThanOrEqual(3);
        expect(maxBucket, `max bucket count ${maxBucket} too large (mean ${mean})`).toBeLessThan(
            mean * 5,
        );
    });

    it("STLTH-17: scanAnnouncement signature takes only the spending private key (no viewing arg)", () => {
        // The function takes (announcement, spendingPrivateKey) - exactly 2 args.
        // No third "viewingPrivateKey" parameter. This is the type-level
        // enforcement of STLTH-17.
        expect(scanAnnouncement.length).toBe(2);
    });

    it("public types: FluidKey MetaAddress has only scheme + spendingPubKey (STLTH-17)", () => {
        // FluidKey scheme: viewing key has no role in the third-party send flow,
        // so MetaAddress carries only the scheme tag + spendingPubKey.
        // (Canonical scheme adds viewingPubKey per EIP-5564; tested separately.)
        const { metaAddress } = newRecipient();
        const keys = Object.keys(metaAddress).sort();
        expect(keys).toEqual(["scheme", "spendingPubKey"]);
    });

    it("Announcement type has no `memo` or `note` field (STLTH-12 / NEGATIVE-12)", () => {
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        const keys = Object.keys(announcement).sort();
        expect(keys).toEqual(["ephemeralPubKey", "schemeId", "stealthAddress", "viewTag"]);
    });

    it("PROP-04: 10000 cross-scheme pairs - canonical scanner never recovers FluidKey announcement (and vice versa)", () => {
        // STLTH-19 dispatch isolation under stress: 5000 (canonical sender,
        // FluidKey attacker scans) + 5000 in the reverse direction. Both
        // directions must produce zero positive matches AND zero false-positive
        // returns from the dispatch boundary - mismatches throw
        // StealthAddressSchemeMismatchError, not silent nulls.
        const iters = 5000;
        let canonicalFalsePositives = 0;
        let fluidkeyFalsePositives = 0;
        let canonicalUnexpectedErrors = 0;
        let fluidkeyUnexpectedErrors = 0;

        for (let i = 0; i < iters; i++) {
            // Canonical sender -> canonical recipient. Attacker is a FluidKey holder.
            const canonSpend = randomBytes(32);
            const canonView = randomBytes(32);
            const canonMeta: CanonicalMetaAddress = {
                scheme: SCHEME_CANONICAL,
                spendingPubKey: bytesToHex(
                    secp256k1.getPublicKey(canonSpend, true),
                ) as CompressedPubKey,
                viewingPubKey: bytesToHex(
                    secp256k1.getPublicKey(canonView, true),
                ) as CompressedPubKey,
            };
            const ephC = generateEphemeralKeyPair(SCHEME_CANONICAL);
            const { announcement: canonAnn } = deriveStealthAddress(
                canonMeta,
                ephC,
                SCHEME_CANONICAL,
            );
            const attackerSpend = randomBytes(32);
            try {
                const result = scanAnnouncement(canonAnn, {
                    scheme: SCHEME_FLUIDKEY,
                    spendingPrivateKey: bytesToHex(attackerSpend) as Scalar32,
                });
                if (result !== null) canonicalFalsePositives++;
                canonicalUnexpectedErrors++;
            } catch (e) {
                if (!(e instanceof StealthAddressSchemeMismatchError)) {
                    canonicalUnexpectedErrors++;
                }
            }

            // FluidKey sender -> FluidKey recipient. Attacker is canonical holder.
            const fkSpend = randomBytes(32);
            const fkMeta: FluidKeyMetaAddress = {
                scheme: SCHEME_FLUIDKEY,
                spendingPubKey: bytesToHex(
                    secp256k1.getPublicKey(fkSpend, false),
                ) as UncompressedPubKey,
            };
            const ephFK = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
            const { announcement: fkAnn } = deriveStealthAddress(fkMeta, ephFK, SCHEME_FLUIDKEY);
            const attackerView = randomBytes(32);
            const attackerSpend2 = randomBytes(32);
            try {
                const result = scanAnnouncement(fkAnn, {
                    scheme: SCHEME_CANONICAL,
                    viewingPrivateKey: bytesToHex(attackerView) as Scalar32,
                    spendingPublicKey: bytesToHex(
                        secp256k1.getPublicKey(attackerSpend2, true),
                    ) as CompressedPubKey,
                });
                if (result !== null) fluidkeyFalsePositives++;
                fluidkeyUnexpectedErrors++;
            } catch (e) {
                if (!(e instanceof StealthAddressSchemeMismatchError)) {
                    fluidkeyUnexpectedErrors++;
                }
            }
        }

        expect(canonicalFalsePositives, "canonical false-positives").toBe(0);
        expect(fluidkeyFalsePositives, "fluidkey false-positives").toBe(0);
        expect(canonicalUnexpectedErrors, "canonical scans must all throw scheme-mismatch").toBe(0);
        expect(fluidkeyUnexpectedErrors, "fluidkey scans must all throw scheme-mismatch").toBe(0);
    });

    it("CRYPTO-09 (v5): announce composer rejects off-curve ephemeralPubKey", async () => {
        // Hand-craft an announcement whose ephemeralPubKey is valid hex + correct
        // length + 0x04 prefix, but the point is off-curve (Y coordinate doesn't
        // satisfy y^2 = x^3 + 7 mod p).
        const offCurve = "0x04" + "01".repeat(32) + "02".repeat(32);
        const { buildAnnounceCalldata } = await import("../../../src/stealth/announce.js");
        const { metaAddress } = newRecipient();
        const ephemeral = generateEphemeralKeyPair(SCHEME_FLUIDKEY);
        const { announcement } = deriveStealthAddress(metaAddress, ephemeral, SCHEME_FLUIDKEY);
        const mangled = { ...announcement, ephemeralPubKey: offCurve as EvmAddress as never };
        expect(() => buildAnnounceCalldata(mangled as typeof announcement)).toThrow();
    });
});
