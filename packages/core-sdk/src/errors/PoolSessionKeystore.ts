/** Base error class for all PoolSessionKeystore errors. */
export class PoolSessionKeystoreBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionKeystoreBaseError";
    }
}

/** Thrown when the constructor config fails schema validation. */
export class InvalidPoolSessionKeystoreConfig extends PoolSessionKeystoreBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid pool session keystore config: ${reason}`);
        this.name = "InvalidPoolSessionKeystoreConfig";
    }
}

/**
 * Thrown when a relayed-registration deadline is already in the past, so the resulting
 * signature would be rejected on-chain by `Keystore_SignatureExpired`.
 */
export class RegistrationDeadlineInPast extends PoolSessionKeystoreBaseError {
    /**
     * @param deadline - The requested unix-seconds deadline, as 0x-prefixed hex.
     * @param now - The current unix-seconds time used for the comparison.
     */
    constructor(deadline: string, now: number) {
        super(`Relayed-registration deadline ${deadline} is in the past (now ${now}s)`);
        this.name = "RegistrationDeadlineInPast";
    }
}

/** Thrown when the on-chain registration check fails due to an RPC or contract error. */
export class RegistrationCheckFailed extends PoolSessionKeystoreBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Registration check failed: ${reason}`);
        this.name = "RegistrationCheckFailed";
    }
}

/**
 * Thrown when a relayed registration is prepared for an account that is already registered
 * on-chain. `registerAndRelay` is idempotent for a matching key and reverts for a mismatching
 * one, so proceeding would burn proof-gen and relayer gas either way; the caller should use a
 * plain relayed withdrawal instead.
 */
export class KeystoreAlreadyRegistered extends PoolSessionKeystoreBaseError {
    /** @param ownerAddress - The account address. */
    constructor(ownerAddress: string) {
        super(
            `Keystore already registered for ${ownerAddress}; use a plain relayed withdrawal instead of relayed registration`,
        );
        this.name = "KeystoreAlreadyRegistered";
    }
}

/** Thrown when rotation is attempted on an account that has not been registered. */
export class KeystoreNotRegistered extends PoolSessionKeystoreBaseError {
    /** @param ownerAddress - The account address. */
    constructor(ownerAddress: string) {
        super(`Keystore not registered for ${ownerAddress}; call registerKeystore first`);
        this.name = "KeystoreNotRegistered";
    }
}

/** Thrown when the current authDigest leaf is not present in the keystore tree. */
export class CurrentLeafNotFound extends PoolSessionKeystoreBaseError {
    /** @param leaf - The expected leaf. */
    constructor(leaf: string) {
        super(`Current keystore leaf ${leaf} not found in on-chain tree; rotation cannot proceed`);
        this.name = "CurrentLeafNotFound";
    }
}

/**
 * Thrown when `newRevocableKey` in a rotation result does not hash to the new authDigest
 * inside its `keystoreCalldata`. Submitting anyway would install the calldata's digest
 * on-chain while `applyRotation` stores a key that can never match it, leaving the
 * account unable to authorize until index re-discovery.
 */
export class RotationKeyMismatch extends PoolSessionKeystoreBaseError {
    /**
     * @param calldataDigest - New authDigest decoded from the prepared calldata.
     * @param computedDigest - AuthDigest computed from `newRevocableKey`.
     */
    constructor(calldataDigest: string, computedDigest: string) {
        super(
            `newRevocableKey hashes to authDigest ${computedDigest}, but the prepared calldata installs ${calldataDigest}; rotation aborted`,
        );
        this.name = "RotationKeyMismatch";
    }
}

/** Thrown when revocable-key index discovery exhausts `gapLimit` without finding a match. */
export class RevocableKeyIndexNotFound extends PoolSessionKeystoreBaseError {
    /** @param gapLimit - Highest candidate index scanned (exclusive upper bound). */
    constructor(gapLimit: number) {
        super(
            `No matching revocable-key index found in [0, ${gapLimit}); on-chain authDigest does not match any candidate derived from the signature`,
        );
        this.name = "RevocableKeyIndexNotFound";
    }
}
