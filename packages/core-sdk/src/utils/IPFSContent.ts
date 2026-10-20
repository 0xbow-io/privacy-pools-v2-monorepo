import { bytesToHex } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CID } from "multiformats/cid";

import type { ParsedCID } from "../internal.js";
import { CIDDigestMismatch, InvalidCIDFormat, MULTIHASH_SHA2_256_CODE } from "../internal.js";

/**
 * Parses an IPFS CID string and returns its multihash digest bytes. Accepts
 * CIDv0 (`Qm…`) and CIDv1 (`bafy…`) — `CID.parse` from `multiformats` handles
 * both. Rejects CIDs whose multihash is not SHA-256 since the SDK has no
 * other algorithm wired in: a CID we cannot verify is no better than no CID.
 *
 * @throws {InvalidCIDFormat} On parse failure or unsupported multihash algorithm.
 */
export function parseCID(cidString: string): ParsedCID {
    try {
        const cid = CID.parse(cidString);

        if (cid.multihash.code !== MULTIHASH_SHA2_256_CODE) {
            throw new InvalidCIDFormat(
                `CID "${cidString}" uses unsupported multihash code 0x${cid.multihash.code.toString(
                    16,
                )} (only SHA-256 / 0x12 is supported)`,
            );
        }
        return { cidString, codec: cid.code, digest: cid.multihash.digest };
    } catch (error) {
        if (error instanceof InvalidCIDFormat) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new InvalidCIDFormat(`Failed to parse CID "${cidString}": ${message}`);
    }
}

/**
 * Verifies that SHA-256 of `bytes` matches the multihash digest embedded in
 * `cidString`. This is the cryptographic content-addressing check IPFS CIDs
 * exist to enable: any byte-level tampering by a compromised gateway flips
 * the digest, and we refuse the bytes.
 *
 * @throws {InvalidCIDFormat} If the CID cannot be parsed or uses an unsupported multihash.
 * @throws {CIDDigestMismatch} If the SHA-256 of `bytes` does not match the embedded digest.
 */
export function verifyBytesAgainstCID(bytes: Uint8Array, cidString: string): void {
    const parsed = parseCID(cidString);
    const actual = sha256(bytes);
    if (!constantTimeEqual(actual, parsed.digest)) {
        throw new CIDDigestMismatch(
            `SHA-256 mismatch for CID "${cidString}": expected ${bytesToHex(
                parsed.digest,
            )}, got ${bytesToHex(actual)}`,
        );
    }
}

/**
 * Constant-time byte-array equality. CID digests are content-addressing
 * metadata (not secrets), so timing leakage here doesn't expose anything an
 * attacker controls anyway — but using constant-time comparison matches the
 * convention used elsewhere in the SDK for digest comparisons and costs
 * nothing.
 */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) {
        diff |= a[i]! ^ b[i]!;
    }
    return diff === 0;
}
