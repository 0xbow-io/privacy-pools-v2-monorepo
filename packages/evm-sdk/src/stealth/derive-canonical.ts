import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type {
    CanonicalAnnouncement,
    CanonicalMetaAddress,
    CompressedPubKey,
    EphemeralKeyPair,
    Scalar32,
    StealthDerivation,
} from "./types.js";
import { StealthAddressDeriveError } from "./errors.js";
import { bytesToBigInt, hexToBytes, uncompressedPubKeyToEvmAddress } from "./internal/codec.js";
import { SCHEME_CANONICAL } from "./types.js";
import { computeViewTag } from "./viewTag.js";

const SECP256K1_ORDER = secp256k1.Point.CURVE().n;

/**
 * Compute the canonical EIP-5564 scheme 1 shared-secret hash.
 *
 * Recipe (mirror of ScopeLift's `generateStealthAddress.ts`):
 *   shared = ECDH(privA, pubB) returned as 65-byte UNCOMPRESSED point
 *            (0x04 || X || Y), full buffer.
 *   hash   = keccak256(shared)                // hash ALL 65 bytes including 0x04
 *
 * This differs from FluidKey's recipe, which hashes only the 64-byte
 * X||Y body. The full-65-byte hash convention is what Scopelift's
 * `getSharedSecret(ephPriv, viewingPub)` call (default isCompressed=false in
 * @noble/secp256k1 v1) feeds straight into keccak256.
 *
 * Verification status: `test/fixtures/scopelift/v6-internal-vectors.json` is an
 * INTERNAL-CONSISTENCY fixture (self-generated per its own header) — it pins the
 * recipe against itself, guarding against silent recipe drift. An INDEPENDENT
 * re-derivation cross-check lives in
 * `test/unit/stealth/canonical-independent-vectors.test.ts`. True external
 * agreement with the ScopeLift SDK is INTEROP-CANONICAL-02 (deferred).
 *
 * Sender invokes with (eph_priv, viewing_pub); recipient with (viewing_priv,
 * eph_pub). ECDH commutativity yields the same shared point and thus the
 * same hash on both sides.
 *
 * @internal Shared between derive-canonical.ts and scan-canonical.ts.
 */
export const computeCanonicalSharedHash = (
    privateKey: Scalar32,
    otherPubKey: CompressedPubKey,
): Uint8Array => {
    const privBytes = hexToBytes(privateKey);
    const pubBytes = hexToBytes(otherPubKey);
    // Canonical scheme uses the recipient's VIEWING pub key (not spending) on
    // the sender side. Caller threads the right key through; this function is
    // generic over which side computes.
    //
    // @noble/curves v2 requires isCompressed=false to get the full 65-byte
    // uncompressed shared point.
    const sharedUncompressed = secp256k1.getSharedSecret(
        privBytes,
        pubBytes,
        /* isCompressed */ false,
    );
    if (sharedUncompressed.length !== 65 || sharedUncompressed[0] !== 0x04) {
        throw new StealthAddressDeriveError(
            `expected 65-byte uncompressed shared point with 0x04 prefix, got len=${sharedUncompressed.length}`,
        );
    }
    // Canonical scheme 1 hashes the WHOLE 65-byte buffer (including 0x04). This
    // is what ScopeLift's reference does by passing the raw return of
    // getSharedSecret directly to keccak256, no slicing.
    return keccak_256(sharedUncompressed);
};

/**
 * Sender-side derivation for canonical EIP-5564 scheme 1 (point addition).
 *
 * Recipe (DESIGN.md §3.3a):
 *   shared = ECDH(eph_priv, viewing_pub)            // 65-byte uncompressed
 *   hash   = keccak256(shared)                       // hash full 65 bytes
 *   P      = spending_pub + (hash_as_scalar * G)     // point addition
 *   addr   = keccak256(P.X || P.Y)[-20:]
 *   tag    = hash[0]
 *
 * @internal Dispatched-to from `deriveStealthAddress` in `derive.ts`.
 */
export const deriveStealthAddressCanonical = (
    metaAddress: CanonicalMetaAddress,
    ephemeral: EphemeralKeyPair,
): StealthDerivation => {
    // Canonical scheme uses compressed ephemeral pubkey (33 bytes) per
    // EIP-5564's specified announcement format.
    const ephPubBytes = hexToBytes(ephemeral.publicKey);
    if (ephPubBytes.length !== 33 || (ephPubBytes[0] !== 0x02 && ephPubBytes[0] !== 0x03)) {
        throw new StealthAddressDeriveError(
            `canonical ephemeral pubkey must be 33-byte compressed, got len=${ephPubBytes.length}`,
        );
    }

    // Derivation below consumes `ephemeral.privateKey` for the shared secret,
    // but the announcement publishes `ephemeral.publicKey` verbatim. If the
    // caller supplies a mismatched pair, the recipient (who scans using the
    // published publicKey) would compute a DIFFERENT shared secret and derive a
    // stealth address the sender never controls, mis-directing funds. Enforce
    // that publicKey is the compressed curve point of privateKey before use.
    const expectedEphPubBytes = secp256k1.getPublicKey(
        hexToBytes(ephemeral.privateKey),
        /* compressed */ true,
    );
    if (
        expectedEphPubBytes.length !== ephPubBytes.length ||
        !expectedEphPubBytes.every((b, i) => b === ephPubBytes[i])
    ) {
        throw new StealthAddressDeriveError(
            "canonical ephemeral keypair mismatch: publicKey is not derived from privateKey",
        );
    }

    const sharedHash = computeCanonicalSharedHash(ephemeral.privateKey, metaAddress.viewingPubKey);

    // Treat the hash as a scalar (mod n), multiply by G to get the point.
    // ScopeLift's reference uses `secp256k1.Point.fromPrivateKey(hash)`, which
    // is equivalent to BASE.multiply(hash mod n) with internal validation.
    const hashScalar = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (hashScalar === 0n) {
        throw new StealthAddressDeriveError("canonical: derived scalar is zero");
    }
    const hashPoint = secp256k1.Point.BASE.multiply(hashScalar);

    // P_stealth = spending_pub + hash*G (point addition).
    const spendingPoint = secp256k1.Point.fromBytes(hexToBytes(metaAddress.spendingPubKey));
    const stealthPoint = spendingPoint.add(hashPoint);
    stealthPoint.assertValidity();

    const stealthUncompressedBytes = stealthPoint.toBytes(false);
    const stealthAddress = uncompressedPubKeyToEvmAddress(stealthUncompressedBytes);
    const viewTag = computeViewTag(sharedHash);

    const announcement: CanonicalAnnouncement = {
        schemeId: SCHEME_CANONICAL,
        stealthAddress,
        ephemeralPubKey: ephemeral.publicKey as CompressedPubKey,
        viewTag,
    };

    // STLTH-14: metaAddress dropped on return.
    return { stealthAddress, announcement };
};

// Ephemeral key generation lives in the dispatch file `derive.ts`,
// scheme-aware. Canonical scheme returns a 33-byte compressed pubkey.
