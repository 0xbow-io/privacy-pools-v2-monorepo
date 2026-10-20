import { BN254_SCALAR_MODULUS } from "../constant/KeyDerivation.js";
import { CryptoServiceBaseError } from "../errors/CryptoService.js";
import { Secret } from "../types/Secret.js";
import { bigintToHex } from "./BigInt.js";

/** Interpret a big-endian byte array as an unsigned integer. */
export function bytesToBigIntBE(bytes: Uint8Array): bigint {
    let result = 0n;
    for (const byte of bytes) {
        result = (result << 8n) | BigInt(byte);
    }
    return result;
}

/** Encode a non-negative integer n as an 8-byte big-endian unsigned integer (u64 BE). */
export function u64beCounter(n: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    let val = n;
    for (let i = 7; i >= 0; i--) {
        bytes[i] = Number(val & 0xffn);
        val >>= 8n;
    }
    return bytes;
}

/**
 * Reduce a big-endian byte array modulo the BN254 scalar field modulus p, returning a
 * 0x-prefixed 32-byte hex Secret. Per RFC 9380 §5.1, 48-byte
 * inputs give statistical distance from uniform ≤ 2^-128. A zero result is accepted.
 */
export function reduceToBN254Scalar(bytes: Uint8Array): Secret {
    const reduced = bytesToBigIntBE(bytes) % BN254_SCALAR_MODULUS;
    return bigintToHex(reduced) as Secret;
}

/**
 * Apply the RFC 7748 Curve25519 clamping procedure to a 32-byte input, returning a
 * 0x-prefixed 32-byte hex Secret usable as an X25519 private scalar. Clamping forces
 * (a) the scalar to be a multiple of the cofactor 8 (clear the three lowest bits),
 * (b) below 2^255 (clear the highest bit), and (c) ≥ 2^254 (set the second-highest bit).
 * The third operation guarantees a non-zero scalar by construction; no zero check is needed.
 *
 * @throws {CryptoServiceBaseError} If `bytes.length !== 32`.
 */
export function clampToCurve25519(bytes: Uint8Array): Secret {
    if (bytes.length !== 32) {
        throw new CryptoServiceBaseError(`clampToCurve25519 expects 32 bytes, got ${bytes.length}`);
    }
    const clamped = new Uint8Array(bytes);
    clamped[0] &= 0xf8;
    clamped[31] &= 0x7f;
    clamped[31] |= 0x40;
    const result = bigintToHex(bytesToBigIntBE(clamped)) as Secret;
    clamped.fill(0);
    return result;
}
