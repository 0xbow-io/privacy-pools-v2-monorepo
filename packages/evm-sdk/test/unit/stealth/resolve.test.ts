import { randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { describe, expect, it } from "vitest";

import type { Hex } from "../../../src/stealth/index.js";
import {
    resolveRecipient,
    SCHEME_CANONICAL,
    SCHEME_FLUIDKEY,
    StealthAddressDeriveError,
} from "../../../src/stealth/index.js";

const bytesToHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};

describe("resolve.ts (STLTH-05, raw mode)", () => {
    it("raw mode: returns a MetaAddress for a valid uncompressed spending pub key", () => {
        const spendingPriv = randomBytes(32);
        const pub = secp256k1.getPublicKey(spendingPriv, /* compressed */ false);
        const meta = resolveRecipient({
            kind: "raw",
            spendingPubKey: bytesToHex(pub) as Hex,
        });
        expect(meta.spendingPubKey.toLowerCase()).toBe(bytesToHex(pub).toLowerCase());
    });

    it("raw mode: rejects unprefixed input", () => {
        const pub = secp256k1.getPublicKey(randomBytes(32), false);
        const noPrefix = bytesToHex(pub).slice(2) as Hex; // strip 0x
        expect(() => resolveRecipient({ kind: "raw", spendingPubKey: noPrefix })).toThrow(
            StealthAddressDeriveError,
        );
    });

    it("raw mode: rejects wrong-length input", () => {
        const compressed = secp256k1.getPublicKey(randomBytes(32), true); // 33 bytes
        expect(() =>
            resolveRecipient({ kind: "raw", spendingPubKey: bytesToHex(compressed) as Hex }),
        ).toThrow(StealthAddressDeriveError);
    });

    it("raw mode: rejects non-hex characters", () => {
        const bad = ("0x04" + "zz".repeat(64)) as Hex;
        expect(() => resolveRecipient({ kind: "raw", spendingPubKey: bad })).toThrow(
            StealthAddressDeriveError,
        );
    });

    it("raw mode: rejects off-curve points (CRYPTO-09 echo)", () => {
        // Valid hex + correct length + 0x04 prefix, but coordinates don't lie on
        // the curve. resolveRecipient performs the curve-membership check.
        const offCurve = ("0x04" + "01".repeat(32) + "02".repeat(32)) as Hex;
        expect(() => resolveRecipient({ kind: "raw", spendingPubKey: offCurve })).toThrow(
            StealthAddressDeriveError,
        );
    });

    // M-2: canonical EIP-5564 (0x0001) reachable through the resolver.
    it("raw mode returns the FluidKey scheme (0xfffe)", () => {
        const pub = secp256k1.getPublicKey(randomBytes(32), false);
        const meta = resolveRecipient({ kind: "raw", spendingPubKey: bytesToHex(pub) as Hex });
        expect(meta.scheme).toBe(SCHEME_FLUIDKEY);
    });

    it("canonical mode: returns a CanonicalMetaAddress with the canonical scheme (0x0001)", () => {
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), /* compressed */ true);
        const viewingPub = secp256k1.getPublicKey(randomBytes(32), true);
        const meta = resolveRecipient({
            kind: "canonical",
            spendingPubKey: bytesToHex(spendingPub) as Hex,
            viewingPubKey: bytesToHex(viewingPub) as Hex,
        });
        expect(meta.scheme).toBe(SCHEME_CANONICAL);
        expect(meta.spendingPubKey.toLowerCase()).toBe(bytesToHex(spendingPub).toLowerCase());
        if (meta.scheme === SCHEME_CANONICAL) {
            expect(meta.viewingPubKey.toLowerCase()).toBe(bytesToHex(viewingPub).toLowerCase());
        }
    });

    it("canonical mode: rejects an uncompressed (65-byte) spending key", () => {
        const spendingUncompressed = secp256k1.getPublicKey(randomBytes(32), false);
        const viewingPub = secp256k1.getPublicKey(randomBytes(32), true);
        expect(() =>
            resolveRecipient({
                kind: "canonical",
                spendingPubKey: bytesToHex(spendingUncompressed) as Hex,
                viewingPubKey: bytesToHex(viewingPub) as Hex,
            }),
        ).toThrow(StealthAddressDeriveError);
    });

    it("canonical mode: rejects a malformed viewing key (both keys are validated)", () => {
        // A valid spending key but a wrong-length viewing key — proves resolveRecipient runs the
        // compressed-key validator over the VIEWING key too, not just the spending key.
        const spendingPub = secp256k1.getPublicKey(randomBytes(32), true);
        const shortViewing = ("0x02" + "01".repeat(16)) as Hex; // 17 bytes, not 33
        expect(() =>
            resolveRecipient({
                kind: "canonical",
                spendingPubKey: bytesToHex(spendingPub) as Hex,
                viewingPubKey: shortViewing,
            }),
        ).toThrow(StealthAddressDeriveError);
    });
});
