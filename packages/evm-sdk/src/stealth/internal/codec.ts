import { keccak_256 } from "@noble/hashes/sha3.js";

import type { CompressedPubKey, EvmAddress, Hex, Scalar32, UncompressedPubKey } from "../types.js";
import { StealthAddressDeriveError } from "../errors.js";

const HEX_BODY_REGEX = /^[0-9a-fA-F]*$/;

/**
 * Strict hex decoder. Rejects malformed input rather than silently producing
 * NaN-coerced bytes. Audit-rubric CODEC-02 caught the v2 implementation
 * accepting `'0x1g'` -> `[0x01]` because `Number.parseInt('1g', 16)` returns
 * 1, not NaN. We now regex-validate before parseInt.
 */
export const hexToBytes = (hex: string): Uint8Array => {
    if (typeof hex !== "string") {
        throw new StealthAddressDeriveError(`expected hex string, got ${typeof hex}`);
    }
    // Only strip lowercase `0x`. v3 audit CODEC-05 flagged the inconsistency
    // with the brand validators (which were prefix-strict only on `0x`); we
    // canonicalize on `0x` everywhere.
    const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
    if (stripped.length === 0 || stripped.length % 2 !== 0) {
        throw new StealthAddressDeriveError(`hex length must be even and non-zero: "${hex}"`);
    }
    if (!HEX_BODY_REGEX.test(stripped)) {
        throw new StealthAddressDeriveError(`invalid hex character in "${hex}"`);
    }
    const out = new Uint8Array(stripped.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
};

export const bytesToHex = (bytes: Uint8Array): Hex => {
    let s = "0x";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s as Hex;
};

export const bytesToBigInt = (bytes: Uint8Array): bigint => {
    let n = 0n;
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    return n;
};

export const bigIntToBytes = (value: bigint, width: number): Uint8Array => {
    if (value < 0n) {
        throw new StealthAddressDeriveError("bigIntToBytes: negative not supported");
    }
    const out = new Uint8Array(width);
    let n = value;
    for (let i = width - 1; i >= 0; i--) {
        out[i] = Number(n & 0xffn);
        n >>= 8n;
    }
    if (n !== 0n) {
        throw new StealthAddressDeriveError(`bigIntToBytes: value overflows ${width} bytes`);
    }
    return out;
};

/**
 * Typed brand-application helpers. Each helper enforces, at runtime:
 *   1. the input is `0x`-prefixed (v3 audit CODEC-04: validators must NOT
 *      accept unprefixed hex, since the brand JSDoc says "0x-prefixed");
 *   2. the body is hex characters only (v3 audit CODEC-03: validators must
 *      reject e.g. `'0x04' + 'zz'.repeat(64)` rather than passing garbage
 *      down to viem-emitted calldata);
 *   3. the byte width matches the brand;
 *   4. the well-known curve prefix byte matches (compressed: 0x02/0x03,
 *      uncompressed: 0x04).
 *
 * Replaces the v2 `asBranded` (which was type-system-only) and the v3
 * intermediate (width + prefix but no hex-body check).
 */
const assertBranded = (hex: Hex, expectedByteCount: number, brandName: string): string => {
    if (!hex.startsWith("0x")) {
        throw new StealthAddressDeriveError(
            `${brandName} must be 0x-prefixed lowercase hex, got "${hex}"`,
        );
    }
    const body = hex.slice(2);
    if (body.length !== expectedByteCount * 2) {
        throw new StealthAddressDeriveError(
            `${brandName} must be ${expectedByteCount} bytes, got ${body.length / 2}`,
        );
    }
    if (!HEX_BODY_REGEX.test(body)) {
        throw new StealthAddressDeriveError(
            `${brandName} body must be hex characters only, got "${hex}"`,
        );
    }
    return body;
};

export const asScalar32 = (hex: Hex): Scalar32 => {
    assertBranded(hex, 32, "Scalar32");
    return hex.toLowerCase() as unknown as Scalar32;
};

export const asEvmAddress = (hex: Hex): EvmAddress => {
    assertBranded(hex, 20, "EvmAddress");
    return hex.toLowerCase() as unknown as EvmAddress;
};

export const asCompressedPubKey = (hex: Hex): CompressedPubKey => {
    const body = assertBranded(hex, 33, "CompressedPubKey");
    const firstByte = body.slice(0, 2).toLowerCase();
    if (firstByte !== "02" && firstByte !== "03") {
        throw new StealthAddressDeriveError(
            `CompressedPubKey must begin with 0x02 or 0x03, got 0x${firstByte}`,
        );
    }
    return hex.toLowerCase() as unknown as CompressedPubKey;
};

export const asUncompressedPubKey = (hex: Hex): UncompressedPubKey => {
    const body = assertBranded(hex, 65, "UncompressedPubKey");
    const firstByte = body.slice(0, 2).toLowerCase();
    if (firstByte !== "04") {
        throw new StealthAddressDeriveError(
            `UncompressedPubKey must begin with 0x04, got 0x${firstByte}`,
        );
    }
    return hex.toLowerCase() as unknown as UncompressedPubKey;
};

/**
 * Standard EVM-address derivation from a 65-byte uncompressed secp256k1 public
 * key: keccak256 over the 64-byte X||Y body (0x04 prefix stripped), last 20
 * bytes. Shared by both stealth schemes — the canonical and FluidKey address
 * recipes are byte-identical here; only their upstream point derivation differs.
 * Preserves the per-scheme length/prefix validation the callers used to run.
 *
 * @internal
 */
export const uncompressedPubKeyToEvmAddress = (bytes: Uint8Array): EvmAddress => {
    if (bytes.length !== 65 || bytes[0] !== 0x04) {
        throw new StealthAddressDeriveError(
            `expected 65-byte uncompressed public key with 0x04 prefix, got len=${bytes.length}`,
        );
    }
    const hash = keccak_256(bytes.slice(1));
    return asEvmAddress(bytesToHex(hash.slice(12)));
};
