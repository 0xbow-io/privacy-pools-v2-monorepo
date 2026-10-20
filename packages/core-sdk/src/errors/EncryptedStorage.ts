/** Base error class for all EncryptedStorageService / at-rest-sealing errors. */
export class EncryptedStorageBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "EncryptedStorageBaseError";
    }
}

/** Thrown when the supplied passphrase is empty (an empty passphrase provides no protection). */
export class InvalidAtRestPassphrase extends EncryptedStorageBaseError {
    constructor() {
        super("At-rest storage passphrase must be a non-empty string or byte array");
        this.name = "InvalidAtRestPassphrase";
    }
}

/**
 * Thrown when a persisted value (or sealed envelope) fails to decrypt: a wrong
 * passphrase, a tampered ciphertext, or a truncated record all surface here via
 * the Poly1305 authentication tag. Deliberately does NOT expose plaintext.
 */
export class AtRestDecryptionError extends EncryptedStorageBaseError {
    /** @param reason - Short description (e.g. "authentication failed"). */
    constructor(reason: string) {
        super(`At-rest decryption failed: ${reason}`);
        this.name = "AtRestDecryptionError";
    }
}

/**
 * Thrown when a value read from the inner store (or a supplied sealed envelope)
 * does not have the expected encrypted-record / header / envelope shape —
 * e.g. a plaintext value written by a non-encrypted backend, or a corrupted header.
 */
export class InvalidEncryptedRecord extends EncryptedStorageBaseError {
    /** @param reason - Short description of what was malformed. */
    constructor(reason: string) {
        super(`Invalid encrypted record: ${reason}`);
        this.name = "InvalidEncryptedRecord";
    }
}
