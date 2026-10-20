import type { Hex } from "./types.js";
import { StealthAddressDeriveError } from "./errors.js";

/**
 * STLTH-09 fixes the view tag at 1 byte (the ERC-5564 spec permits 0-4 bytes).
 *
 * 1 byte gives a 256x speedup on recipient scanning. False positives still
 * pass the tag filter at ~1/256 rate but the candidate-address check (a
 * cheap scalar mult + keccak) rejects them with no fund-recovery risk.
 */
export const VIEW_TAG_BYTES = 1 as const;

/**
 * Derive the 1-byte view tag from the keccak hash of the per-scheme ECDH
 * shared secret. The hash itself is computed once per scheme (`computeCanonicalSharedHash`
 * for canonical scheme 1, `computeFluidKeySharedHash` for the FluidKey variant);
 * both the view tag and the stealth-scalar reuse the same 32-byte output.
 *
 * @param sharedHash - 32-byte keccak256 output; the byte layout of the hash
 *                     input differs per scheme but the output width is fixed.
 */
export const computeViewTag = (sharedHash: Uint8Array): number => {
    if (sharedHash.length !== 32) {
        throw new StealthAddressDeriveError(
            `viewTag input must be 32 bytes (keccak256 output), got ${sharedHash.length}`,
        );
    }
    // STLTH-09: first byte, no masking, no concatenation.
    return sharedHash[0]!;
};

/**
 * Encode the view tag as a single-byte hex string (0x-prefixed, lowercase)
 * suitable for the ERC-5564 announcement `metadata` field. STLTH-12 forbids
 * any additional metadata bytes.
 */
export const encodeViewTagAsMetadata = (viewTag: number): Hex => {
    if (!Number.isInteger(viewTag) || viewTag < 0 || viewTag > 0xff) {
        throw new StealthAddressDeriveError(
            `viewTag must be an integer in [0, 256), got ${viewTag}`,
        );
    }
    return `0x${viewTag.toString(16).padStart(2, "0")}` as Hex;
};
