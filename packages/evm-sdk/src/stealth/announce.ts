import { secp256k1 } from "@noble/curves/secp256k1.js";
import { encodeFunctionData } from "viem";

import type { Announcement, EvmAddress, Hex } from "./types.js";
import { assertCanonicalAnnouncer } from "./constants.js";
import { StealthAddressDeriveError } from "./errors.js";
import { hexToBytes } from "./internal/codec.js";
import { encodeViewTagAsMetadata } from "./viewTag.js";

/**
 * ERC-5564 Announcer ABI - the single function we touch. Pinned here rather
 * than imported from a contracts package so that the SDK can produce calldata
 * without depending on the on-chain artifact bundle (which lives in PP's
 * monorepo, not here).
 */
export const ERC5564_ANNOUNCE_ABI = [
    {
        type: "function",
        name: "announce",
        stateMutability: "nonpayable",
        inputs: [
            { name: "schemeId", type: "uint256" },
            { name: "stealthAddress", type: "address" },
            { name: "ephemeralPubKey", type: "bytes" },
            { name: "metadata", type: "bytes" },
        ],
        outputs: [],
    },
] as const;

/**
 * A single on-chain call: target + ABI-encoded calldata. The relayer takes a
 * pair of these (`withdrawCall + announceCall`) and submits atomically
 * (STLTH-03).
 */
export interface EvmCall {
    readonly to: EvmAddress;
    readonly data: Hex;
}

/**
 * Build the calldata for ERC5564Announcer.announce(...) from an in-memory
 * Announcement. Encodes:
 *   - schemeId as uint256 (32 bytes)
 *   - stealthAddress as address (20 bytes, ABI-padded)
 *   - ephemeralPubKey as bytes (length-prefixed): the canonical scheme carries a
 *     33-byte compressed pubkey, the FluidKey variant a 65-byte uncompressed one
 *   - metadata as bytes (exactly 1 byte under STLTH-12: the view tag)
 *
 * The 1-byte STLTH-12 constraint is enforced upstream by `encodeViewTagAsMetadata`.
 */
export const buildAnnounceCalldata = (announcement: Announcement): Hex => {
    // v4 audit CRYPTO-09: refuse to ship calldata carrying an off-curve point.
    // A valid-hex but off-curve ephemeralPubKey would pass the brand validator
    // (which only checks width + prefix + hex body) and propagate downstream
    // to recipients, where their getSharedSecret call would throw, causing
    // discovery DoS for that announcement. Catching it here costs one curve
    // check per announcement and surfaces the misuse to the sender side.
    try {
        secp256k1.Point.fromBytes(hexToBytes(announcement.ephemeralPubKey)).assertValidity();
    } catch (e) {
        throw new StealthAddressDeriveError(
            `ephemeralPubKey is not a valid secp256k1 point: ${(e as Error).message}`,
        );
    }

    const metadata = encodeViewTagAsMetadata(announcement.viewTag);
    // Cast at the viem boundary: viem types hex as a template literal
    // `0x${string}`; our brands are nominal subtypes whose underlying value
    // matches the template literal at runtime but TS treats as opaque.
    const data = encodeFunctionData({
        abi: ERC5564_ANNOUNCE_ABI,
        functionName: "announce",
        args: [
            BigInt(announcement.schemeId),
            announcement.stealthAddress as `0x${string}`,
            announcement.ephemeralPubKey as `0x${string}`,
            metadata as `0x${string}`,
        ],
    });
    return data as Hex;
};

/**
 * Build the announce EvmCall (target + calldata) for a given announcer
 * deployment address. STLTH-20: the announcer must be the canonical EIP-5564
 * CREATE2 deployment; any other address is refused at this single chokepoint
 * so every code path that emits an announce call (bundle composer, direct
 * caller, future relayer-extension shims) gets the same enforcement.
 */
export const buildAnnounceCall = (
    announcement: Announcement,
    announcerAddress: EvmAddress,
): EvmCall => {
    assertCanonicalAnnouncer(announcerAddress);
    return {
        to: announcerAddress,
        data: buildAnnounceCalldata(announcement),
    };
};
