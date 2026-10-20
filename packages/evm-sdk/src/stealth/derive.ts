import { secp256k1 } from "@noble/curves/secp256k1.js";

import type { EphemeralKeyPair, MetaAddress, SchemeId, StealthDerivation } from "./types.js";
import { computeCanonicalSharedHash, deriveStealthAddressCanonical } from "./derive-canonical.js";
import { computeFluidKeySharedHash, deriveStealthAddressFluidKey } from "./derive-fluidkey.js";
import {
    StealthAddressSchemeMismatchError,
    StealthAddressUnsupportedSchemeError,
} from "./errors.js";
import {
    asCompressedPubKey,
    asScalar32,
    asUncompressedPubKey,
    bytesToBigInt,
    bytesToHex,
} from "./internal/codec.js";
import { csprngBytes } from "./internal/entropy.js";
import { assertNever, SCHEME_CANONICAL, SCHEME_FLUIDKEY } from "./types.js";

const SECP256K1_ORDER = secp256k1.Point.CURVE().n;

/**
 * STLTH-13: ephemeral keypairs MUST come from a CSPRNG, never from a deterministic
 * derivation. The function signature takes the target scheme but NO seed argument
 * so [DEV-13] (no seed parameter) holds at the type level.
 *
 * Public-key format differs per scheme: canonical scheme 1 uses 33-byte
 * compressed; FluidKey uses 65-byte uncompressed. The scheme-aware generator
 * returns the right format for the recipient's variant.
 */
export const generateEphemeralKeyPair = (scheme: SchemeId): EphemeralKeyPair => {
    // Rejection-sample over [1, n) to avoid modular bias.
     
    while (true) {
        const priv = csprngBytes(32);
        const scalar = bytesToBigInt(priv);
        if (scalar > 0n && scalar < SECP256K1_ORDER) {
            switch (scheme) {
                case SCHEME_CANONICAL: {
                    const pub = secp256k1.getPublicKey(priv, /* compressed */ true);
                    return {
                        privateKey: asScalar32(bytesToHex(priv)),
                        publicKey: asCompressedPubKey(bytesToHex(pub)),
                    };
                }
                case SCHEME_FLUIDKEY: {
                    const pub = secp256k1.getPublicKey(priv, /* compressed */ false);
                    return {
                        privateKey: asScalar32(bytesToHex(priv)),
                        publicKey: asUncompressedPubKey(bytesToHex(pub)),
                    };
                }
                default:
                    return assertNever(scheme);
            }
        }
        // 2^-128-ish odds; loop until we get a valid scalar.
    }
};

/**
 * Dispatch boundary (STLTH-19). Reads the meta-address's declared scheme and
 * routes to the per-scheme derive function. The `schemeId` argument is a
 * caller-asserted defensive check; a mismatch between `metaAddress.scheme`
 * and `schemeId` hard-errors before any cryptography happens.
 *
 * Canonical scheme 1: see `derive-canonical.ts`.
 * FluidKey variant:   see `derive-fluidkey.ts`.
 */
export const deriveStealthAddress = (
    metaAddress: MetaAddress,
    ephemeral: EphemeralKeyPair,
    schemeId: number,
): StealthDerivation => {
    if (schemeId !== SCHEME_CANONICAL && schemeId !== SCHEME_FLUIDKEY) {
        throw new StealthAddressUnsupportedSchemeError(schemeId);
    }
    if (metaAddress.scheme !== schemeId) {
        throw new StealthAddressSchemeMismatchError(metaAddress.scheme, schemeId);
    }
    switch (metaAddress.scheme) {
        case SCHEME_CANONICAL:
            return deriveStealthAddressCanonical(metaAddress, ephemeral);
        case SCHEME_FLUIDKEY:
            return deriveStealthAddressFluidKey(metaAddress, ephemeral);
        default:
            return assertNever(metaAddress);
    }
};

/**
 * Sender-side ECDH shared-secret hash for `metaAddress`/`ephemeral` — the same value
 * `deriveStealthAddress` computes internally as an intermediate (`h`) but does not expose,
 * since STLTH-14 keeps its return surface to `{stealthAddress, announcement}` only. Exposed
 * here as a separate, explicit function for callers that need a symmetric key only the
 * sender and the eventual recipient (via `ECDH(recipient_priv, eph_pub)`, same commutative
 * property) can derive, without inventing a new key-exchange primitive — e.g. encrypting an
 * arbitrary payload for delivery alongside a stealth address, outside the fixed-size ERC-5564
 * `metadata` field.
 *
 * Not sensitive to expose to the sender: the caller already holds `ephemeral.privateKey` and
 * could recompute this value unassisted — this just saves it re-deriving the ECDH itself.
 *
 * @throws {StealthAddressUnsupportedSchemeError} If `schemeId` is not a recognized scheme.
 * @throws {StealthAddressSchemeMismatchError} If `schemeId` does not match `metaAddress.scheme`.
 */
export const deriveStealthSharedSecret = (
    metaAddress: MetaAddress,
    ephemeral: EphemeralKeyPair,
    schemeId: number,
): Uint8Array => {
    if (schemeId !== SCHEME_CANONICAL && schemeId !== SCHEME_FLUIDKEY) {
        throw new StealthAddressUnsupportedSchemeError(schemeId);
    }
    if (metaAddress.scheme !== schemeId) {
        throw new StealthAddressSchemeMismatchError(metaAddress.scheme, schemeId);
    }
    switch (metaAddress.scheme) {
        case SCHEME_CANONICAL:
            return computeCanonicalSharedHash(ephemeral.privateKey, metaAddress.viewingPubKey);
        case SCHEME_FLUIDKEY:
            return computeFluidKeySharedHash(ephemeral.privateKey, metaAddress.spendingPubKey);
        default:
            return assertNever(metaAddress);
    }
};
