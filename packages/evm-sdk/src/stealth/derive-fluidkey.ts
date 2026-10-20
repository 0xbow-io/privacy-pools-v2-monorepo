import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

import type {
    EphemeralKeyPair,
    FluidKeyAnnouncement,
    FluidKeyMetaAddress,
    Scalar32,
    StealthDerivation,
    UncompressedPubKey,
} from "./types.js";
import { StealthAddressDeriveError } from "./errors.js";
import { bytesToBigInt, hexToBytes, uncompressedPubKeyToEvmAddress } from "./internal/codec.js";
import { SCHEME_FLUIDKEY } from "./types.js";
import { computeViewTag } from "./viewTag.js";

const SECP256K1_ORDER = secp256k1.Point.CURVE().n;

/**
 * Compute the FluidKey-recipe ECDH shared-secret hash from one side of the pair.
 *
 * FluidKey recipe (verified against `@fluidkey/stealth-account-kit`):
 *   shared = ECDH(privA, pubB) returned as 65-byte UNCOMPRESSED point (0x04 || X || Y)
 *   hash   = keccak256(shared.slice(1))    // hash the full X||Y (64 bytes), NOT just X
 *
 * Both sender (privA = eph_priv, pubB = spending_pub) and recipient
 * (privA = spending_priv, pubB = eph_pub) compute the same hash by ECDH
 * commutativity. The recipient's viewing_priv is NOT involved here per
 * STLTH-17 (FluidKey-variant scanner needs spending_priv, not viewing).
 *
 * @internal Shared between derive-fluidkey.ts and scan-fluidkey.ts.
 */
export const computeFluidKeySharedHash = (
    privateKey: Scalar32,
    otherPubKey: UncompressedPubKey,
): Uint8Array => {
    const privBytes = hexToBytes(privateKey);
    const pubBytes = hexToBytes(otherPubKey);
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
    // FluidKey hashes the 64-byte X||Y, NOT the full 65 bytes including the 0x04
    // prefix. This is the recipe byte that distinguishes FluidKey from canonical
    // scheme 1, which hashes the full 65-byte buffer.
    return keccak_256(sharedUncompressed.slice(1));
};

/**
 * Sender-side derivation for the FluidKey variant per STLTH-01 / STLTH-19.
 *
 * Recipe (DESIGN.md §3.3b, verified against FluidKey fixtures):
 *   shared = eph_priv * spending_pub          // ECDH, full 65-byte uncompressed
 *   hash   = keccak256(shared.X || shared.Y)  // 64 bytes hashed (NOT 65)
 *   P      = spending_pub * BigInt(hash)      // point multiplication
 *   addr   = keccak256(P.X || P.Y)[-20:]
 *   tag    = hash[0]
 *
 * @internal Dispatched-to from `deriveStealthAddress` in `derive.ts`.
 */
export const deriveStealthAddressFluidKey = (
    metaAddress: FluidKeyMetaAddress,
    ephemeral: EphemeralKeyPair,
): StealthDerivation => {
    // FluidKey scheme uses uncompressed ephemeral pubkey (65 bytes).
    const ephPubBytes = hexToBytes(ephemeral.publicKey);
    if (ephPubBytes.length !== 65 || ephPubBytes[0] !== 0x04) {
        throw new StealthAddressDeriveError(
            `FluidKey ephemeral pubkey must be 65-byte uncompressed, got len=${ephPubBytes.length}`,
        );
    }

    const sharedHash = computeFluidKeySharedHash(ephemeral.privateKey, metaAddress.spendingPubKey);

    const scalar = bytesToBigInt(sharedHash) % SECP256K1_ORDER;
    if (scalar === 0n) {
        throw new StealthAddressDeriveError("FluidKey: derived scalar is zero");
    }

    const spendingPoint = secp256k1.Point.fromBytes(hexToBytes(metaAddress.spendingPubKey));
    const stealthPoint = spendingPoint.multiply(scalar);
    stealthPoint.assertValidity();

    const stealthAddress = uncompressedPubKeyToEvmAddress(stealthPoint.toBytes(false));
    const viewTag = computeViewTag(sharedHash);

    const announcement: FluidKeyAnnouncement = {
        schemeId: SCHEME_FLUIDKEY,
        stealthAddress,
        ephemeralPubKey: ephemeral.publicKey as UncompressedPubKey,
        viewTag,
    };

    // STLTH-14: metaAddress dropped on return.
    return { stealthAddress, announcement };
};
