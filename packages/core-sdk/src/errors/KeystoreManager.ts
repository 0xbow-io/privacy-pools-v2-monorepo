/** Base error class for all KeystoreManager-related errors. */
export class KeystoreManagerError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "KeystoreManagerError";
    }
}

/** Thrown when the KeystoreManager config fails schema validation. */
export class InvalidKeystoreManagerConfig extends KeystoreManagerError {
    /** @param reason - Short description (e.g. "privateNullifyingKey: must be 32 bytes"). */
    constructor(reason: string) {
        super(`Invalid keystore manager config: ${reason}`);
        this.name = "InvalidKeystoreManagerConfig";
    }
}

/** Thrown when {@link IKeystoreManager.markRegistered} is called for a chain that is already registered. */
export class AlreadyRegistered extends KeystoreManagerError {
    /** @param chainId - The chain ID that was already registered. */
    constructor(chainId: number) {
        super(`Already registered on chain ${chainId}`);
        this.name = "AlreadyRegistered";
    }
}

/** Thrown when {@link IKeystoreManager.rotateRevocableKey} is given a rotation index that is not strictly greater than the current one. */
export class InvalidRotationIndex extends KeystoreManagerError {
    constructor(current: bigint, requested: bigint) {
        super(
            `New revocable key rotation index (${requested}) must be strictly greater than the current index (${current})`,
        );
        this.name = "InvalidRotationIndex";
    }
}
