/** Base error class for IPFS content-addressing failures. */
export class IPFSContentBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "IPFSContentBaseError";
    }
}

/**
 * Thrown when a CID string is malformed, uses an unsupported codec/multibase,
 * or pins a multihash algorithm the SDK does not implement (anything other
 * than SHA-256 today). Distinct from {@link CIDDigestMismatch} so callers
 * can translate to their own domain error hierarchy.
 */
export class InvalidCIDFormat extends IPFSContentBaseError {
    constructor(reason: string) {
        super(reason);
        this.name = "InvalidCIDFormat";
    }
}

/**
 * Thrown when SHA-256 of fetched bytes does not match the multihash digest
 * embedded in the supplied CID. Indicates either gateway tampering or
 * transport corruption; either way the bytes must not reach downstream
 * consumers (snarkjs proving keys, ASP leaves, etc.).
 */
export class CIDDigestMismatch extends IPFSContentBaseError {
    constructor(reason: string) {
        super(reason);
        this.name = "CIDDigestMismatch";
    }
}
