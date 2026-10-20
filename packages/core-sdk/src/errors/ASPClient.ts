/** Base error class for all ASP client errors. */
export class ASPClientBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "ASPClientBaseError";
    }
}

/** Thrown when the ASP client configuration is invalid. */
export class InvalidASPClientConfig extends ASPClientBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid ASP client config: ${reason}`);
        this.name = "InvalidASPClientConfig";
    }
}

/** Thrown when all ASP data providers fail. */
export class ASPUnavailable extends ASPClientBaseError {
    /** @param reason - Description of failure. */
    constructor(reason: string) {
        super(`ASP unavailable: ${reason}`);
        this.name = "ASPUnavailable";
    }
}

/** Thrown when a label is not found in the association set. */
export class LabelNotInSet extends ASPClientBaseError {
    /** @param reason - Description of the missing label. */
    constructor(reason: string) {
        super(`Label not in set: ${reason}`);
        this.name = "LabelNotInSet";
    }
}

/** Thrown when an ASP proof verification fails. */
export class InvalidASPProof extends ASPClientBaseError {
    /** @param reason - Description of the proof failure. */
    constructor(reason: string) {
        super(`Invalid ASP proof: ${reason}`);
        this.name = "InvalidASPProof";
    }
}

/** Thrown when an IPFS fetch operation fails. */
export class IPFSFetchFailed extends ASPClientBaseError {
    /** @param reason - Description of the IPFS failure. */
    constructor(reason: string) {
        super(`IPFS fetch failed: ${reason}`);
        this.name = "IPFSFetchFailed";
    }
}

/**
 * Thrown when an AEAD-decrypted ASP ciphertext payload fails structural
 * validation against {@link ASPCipherTextPayloadSchema}. Surfaces encode/
 * decode version skew or post-decrypt garbage as a typed error at the
 * boundary instead of `undefined` propagating downstream.
 */
export class InvalidASPCipherText extends ASPClientBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid ASP ciphertext payload: ${reason}`);
        this.name = "InvalidASPCipherText";
    }
}

/**
 * Thrown when the on-chain IPFS CID for the association set is malformed or
 * uses an unsupported multihash. Subclass of {@link ASPUnavailable} so the
 * existing `tryProviders` fallback advances to the next provider.
 */
export class InvalidASPCID extends ASPUnavailable {
    constructor(reason: string) {
        super(`Invalid ASP CID: ${reason}`);
        this.name = "InvalidASPCID";
    }
}

/**
 * Thrown when the LeanIMT root computed over leaves returned by an ASP
 * provider does not match the on-chain `latestASPRoot`. Subclass of
 * {@link ASPUnavailable} so the existing `tryProviders` fallback advances
 * to the next provider on mismatch.
 */
export class ASPLeavesRootMismatch extends ASPUnavailable {
    constructor(reason: string) {
        super(`ASP leaves root mismatch: ${reason}`);
        this.name = "ASPLeavesRootMismatch";
    }
}
