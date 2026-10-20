import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { describe, expect, it } from "vitest";

import type {
    CanonicalMetaAddress,
    CompressedPubKey,
    EphemeralKeyPair,
    Hex,
    Scalar32,
} from "../../../src/stealth/index.js";
import {
    deriveStealthAddress,
    deriveStealthPrivateKey,
    SCHEME_CANONICAL,
} from "../../../src/stealth/index.js";

/**
 * TG-1: an INDEPENDENT second implementation of the EIP-5564 canonical (scheme 1) recipe, following the
 * spec directly with @noble primitives and NOT calling the module's `derive-canonical.ts`. It is a
 * drift/regression guard on the canonical scheme (the scheme standard ERC-5564 wallets scan): if either
 * this reference or `deriveStealthAddress` diverges from the spec, the byte-for-byte assertions fail.
 *
 * NOTE — this is an independent re-derivation of the spec, NOT a captured vector from an external
 * running SDK. True external byte-for-byte agreement with ScopeLift's SDK remains INTEROP-CANONICAL-02
 * (see `test/fixtures/scopelift/v6-internal-vectors.json`); this guards recipe correctness offline.
 *
 * Recipe: shared = ECDH(eph_priv, viewing_pub) as 65-byte uncompressed; h = keccak256(shared);
 *   P = spending_pub + (h mod n)·G; addr = keccak256(P.X||P.Y)[-20:]; viewTag = h[0];
 *   recipient: stealth_priv = (spending_priv + (h mod n)) mod n.
 */

const N = secp256k1.Point.CURVE().n;

const toHex = (bytes: Uint8Array): string => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
};
const fromHex = (hex: string): Uint8Array => {
    const body = hex.slice(2);
    const out = new Uint8Array(body.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
    return out;
};
const bytesToBig = (bytes: Uint8Array): bigint => {
    let v = 0n;
    for (const b of bytes) v = (v << 8n) | BigInt(b);
    return v;
};

/** Independent reference: sender-side canonical derivation. Returns the expected stealth address + tag. */
function referenceDerive(
    spendPriv: string,
    viewPriv: string,
    ephPriv: string,
): {
    spendingPub: string;
    viewingPub: string;
    ephPub: string;
    stealthAddress: string;
    viewTag: number;
    stealthPriv: Hex;
} {
    const spendingPub = secp256k1.getPublicKey(fromHex(spendPriv), /* compressed */ true);
    const viewingPub = secp256k1.getPublicKey(fromHex(viewPriv), true);
    const ephPub = secp256k1.getPublicKey(fromHex(ephPriv), true);

    const shared = secp256k1.getSharedSecret(
        fromHex(ephPriv),
        viewingPub,
        /* isCompressed */ false,
    );
    const h = keccak_256(shared);
    const hScalar = bytesToBig(h) % N;

    const stealthPoint = secp256k1.Point.fromBytes(spendingPub).add(
        secp256k1.Point.BASE.multiply(hScalar),
    );
    const uncompressed = stealthPoint.toBytes(false);
    const stealthAddress = toHex(keccak_256(uncompressed.slice(1)).slice(12));
    const stealthPriv = (bytesToBig(fromHex(spendPriv)) + hScalar) % N;

    return {
        spendingPub: toHex(spendingPub),
        viewingPub: toHex(viewingPub),
        ephPub: toHex(ephPub),
        stealthAddress,
        viewTag: h[0]!,
        stealthPriv: ("0x" + stealthPriv.toString(16).padStart(64, "0")) as Hex,
    };
}

// Fixed vectors (deterministic private keys as the test input).
const VECTORS = [
    {
        spendPriv: "0x596b90994791623a08f25c2ea709ad0a35b865893e9508fb450698acd47472fa",
        viewPriv: "0x74a08ee7e9097ee3da4124a5c340a35b9da698654bdd5b7b0135816e995aeca6",
        ephPriv: "0x1111111111111111111111111111111111111111111111111111111111111111",
    },
    {
        spendPriv: "0x2222222222222222222222222222222222222222222222222222222222222222",
        viewPriv: "0x3333333333333333333333333333333333333333333333333333333333333333",
        ephPriv: "0x4444444444444444444444444444444444444444444444444444444444444444",
    },
    {
        spendPriv: "0x00000000000000000000000000000000000000000000000000000000000000a1",
        viewPriv: "0x00000000000000000000000000000000000000000000000000000000000000b2",
        ephPriv: "0x00000000000000000000000000000000000000000000000000000000000000c3",
    },
];

describe("canonical EIP-5564 — independent recipe cross-check (TG-1)", () => {
    for (const [i, v] of VECTORS.entries()) {
        it(`vector ${i}: deriveStealthAddress matches the independent reference`, () => {
            const ref = referenceDerive(v.spendPriv, v.viewPriv, v.ephPriv);

            const metaAddress: CanonicalMetaAddress = {
                scheme: SCHEME_CANONICAL,
                spendingPubKey: ref.spendingPub as unknown as CompressedPubKey,
                viewingPubKey: ref.viewingPub as unknown as CompressedPubKey,
            };
            const ephemeral: EphemeralKeyPair = {
                privateKey: v.ephPriv as unknown as Scalar32,
                publicKey: ref.ephPub as unknown as CompressedPubKey,
            };

            const { stealthAddress, announcement } = deriveStealthAddress(
                metaAddress,
                ephemeral,
                SCHEME_CANONICAL,
            );

            expect(stealthAddress.toLowerCase()).toBe(ref.stealthAddress.toLowerCase());
            expect(announcement.viewTag).toBe(ref.viewTag);
            expect(announcement.schemeId).toBe(SCHEME_CANONICAL);
        });

        it(`vector ${i}: recipient recovers the reference stealth private key controlling the address`, () => {
            const ref = referenceDerive(v.spendPriv, v.viewPriv, v.ephPriv);

            // The module's recovery must yield the SAME stealth private key the independent recipe gives,
            // and that key's address must equal the derived stealth address (self-consistency + spec match).
            const recovered = deriveStealthPrivateKey(
                {
                    schemeId: SCHEME_CANONICAL,
                    stealthAddress:
                        ref.stealthAddress as unknown as import("../../../src/stealth/index.js").EvmAddress,
                    ephemeralPubKey: ref.ephPub as unknown as CompressedPubKey,
                    viewTag: ref.viewTag,
                },
                {
                    scheme: SCHEME_CANONICAL,
                    spendingPrivateKey: v.spendPriv as unknown as Scalar32,
                    viewingPrivateKey: v.viewPriv as unknown as Scalar32,
                },
            );

            expect(BigInt(recovered)).toBe(BigInt(ref.stealthPriv));
            const addrFromRecovered = toHex(
                keccak_256(secp256k1.getPublicKey(fromHex(recovered), false).slice(1)).slice(12),
            );
            expect(addrFromRecovered.toLowerCase()).toBe(ref.stealthAddress.toLowerCase());
        });
    }
});
