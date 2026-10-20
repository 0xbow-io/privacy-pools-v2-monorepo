/** Base error class for all NoteDiscoveryService-related errors. */
export class NoteDiscoveryServiceBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "NoteDiscoveryServiceBaseError";
    }
}

/** Thrown when decryption of an encrypted note payload fails. */
export class DecryptionError extends NoteDiscoveryServiceBaseError {
    /** @param reason - Short description (e.g. "AEAD auth failed" or "ciphertext too short"). */
    constructor(reason: string) {
        super(`Decryption failed: ${reason}`);
        this.name = "DecryptionError";
    }
}

/** Thrown when decrypted payload is not valid JSON or fails NotePayload schema validation. */
export class PayloadParseError extends NoteDiscoveryServiceBaseError {
    /** @param reason - Short description (e.g. "invalid JSON" or "schema validation failed"). */
    constructor(reason: string) {
        super(`Payload parse failed: ${reason}`);
        this.name = "PayloadParseError";
    }
}
