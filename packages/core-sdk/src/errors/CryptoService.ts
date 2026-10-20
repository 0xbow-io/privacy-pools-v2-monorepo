/** Base error class for all CryptoService-related errors. */
export class CryptoServiceBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "CryptoServiceBaseError";
    }
}

/** Thrown when a secret value does not meet the required hex format (even length, at least 2 chars). */
export class InvalidSecret extends CryptoServiceBaseError {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(`Invalid secret: ${reason}`);
        this.name = "InvalidSecret";
    }
}

/** Thrown when ciphertext hex is malformed or too short to contain nonce and Poly1305 tag. */
export class InvalidCipherText extends CryptoServiceBaseError {
    /** @param reason - Short description (e.g. "too short (missing nonce or tag)"). */
    constructor(reason: string) {
        super(`Invalid ciphertext: ${reason}`);
        this.name = "InvalidCipherText";
    }
}

/** Thrown when a private key does not meet format requirements for ECDH. */
export class InvalidPrivateKey extends CryptoServiceBaseError {
    /** @param reason - Short description (e.g. "value out of valid range"). */
    constructor(reason: string) {
        super(`Invalid private key: ${reason}`);
        this.name = "InvalidPrivateKey";
    }
}

/** Thrown when a public key format is invalid or cannot be parsed for ECDH. */
export class InvalidPublicKey extends CryptoServiceBaseError {
    /** @param reason - Short description (e.g. "point not on curve"). */
    constructor(reason: string) {
        super(`Invalid public key: ${reason}`);
        this.name = "InvalidPublicKey";
    }
}

/** Thrown when ECDH computation fails (e.g., point at infinity, invalid multiplication). */
export class ECDHComputationError extends CryptoServiceBaseError {
    /** @param reason - Short description (e.g. "result is point at infinity"). */
    constructor(reason: string) {
        super(`ECDH computation failed: ${reason}`);
        this.name = "ECDHComputationError";
    }
}
