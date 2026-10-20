import { CryptoServiceBaseError } from "./CryptoService.js";

/** Base error class for all key derivation errors. Extends CryptoServiceBaseError so that
 *  ICryptoService callers can catch the documented base type. */
export class KeyDerivationBaseError extends CryptoServiceBaseError {
    constructor(reason: string) {
        super(reason);
        this.name = "KeyDerivationBaseError";
    }
}

/** Thrown when a wallet signature provided for appSecret derivation is malformed. */
export class InvalidSignature extends KeyDerivationBaseError {
    /** @param reason - Short description (e.g. "must be 65 bytes (130 hex chars)"). */
    constructor(reason: string) {
        super(`Invalid signature: ${reason}`);
        this.name = "InvalidSignature";
    }
}

/** Thrown when the signer address used in signature-based derivation fails format validation. */
export class InvalidAddress extends KeyDerivationBaseError {
    /** @param reason - Short description (e.g. "must be 20 bytes (40 hex chars)"). */
    constructor(reason: string) {
        super(`Invalid address: ${reason}`);
        this.name = "InvalidAddress";
    }
}

/**
 * Thrown when the EIP-712 payload's `message.addressHash` does not equal
 * `keccak256(signerAddress)`. Indicates the signed payload was constructed for a
 * different signer — potential phishing/replay attack or caller bug.
 */
export class PayloadAddressHashMismatch extends KeyDerivationBaseError {
    constructor(reason: string) {
        super(`Payload addressHash mismatch: ${reason}`);
        this.name = "PayloadAddressHashMismatch";
    }
}
