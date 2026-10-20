/** Base error class for all PoolSessionDeposit errors. */
export class PoolSessionDepositBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionDepositBaseError";
    }
}

/** Thrown when the constructor config (ownerAddress, entrypointAddress) is invalid. */
export class InvalidPoolSessionConfig extends PoolSessionDepositBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid pool session config: ${reason}`);
        this.name = "InvalidPoolSessionConfig";
    }
}

/** Thrown when deposit parameters fail input validation. */
export class InvalidDepositParams extends PoolSessionDepositBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid deposit params: ${reason}`);
        this.name = "InvalidDepositParams";
    }
}

/** Thrown when the requested asset is not enabled in the Entrypoint config. */
export class AssetNotEnabled extends PoolSessionDepositBaseError {
    /** @param tokenId - The disabled asset address. */
    constructor(tokenId: string) {
        super(`Asset not enabled: ${tokenId}`);
        this.name = "AssetNotEnabled";
    }
}

/** Thrown when the deposit amount is below the configured minimum. */
export class BelowMinimumAmount extends PoolSessionDepositBaseError {
    /** @param reason - Details including value and minAmount. */
    constructor(reason: string) {
        super(`Below minimum amount: ${reason}`);
        this.name = "BelowMinimumAmount";
    }
}

/** Thrown when witness building fails. */
export class DepositWitnessFailed extends PoolSessionDepositBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Deposit witness failed: ${reason}`);
        this.name = "DepositWitnessFailed";
    }
}

/** Thrown when proof generation fails. */
export class DepositProofFailed extends PoolSessionDepositBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Deposit proof failed: ${reason}`);
        this.name = "DepositProofFailed";
    }
}

/** Thrown when the ERC-20 allowance check fails due to an RPC or contract error. */
export class AllowanceCheckFailed extends PoolSessionDepositBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Allowance check failed: ${reason}`);
        this.name = "AllowanceCheckFailed";
    }
}

/**
 * Thrown when a `depositFor` EVM-publish flow targets an account whose
 * on-chain viewing key is the zero sentinel. Encrypting `noteData` to the
 * all-zero X25519 public key yields a constant SHA-256(0) symmetric key —
 * the resulting ciphertext is publicly decryptable and the intended recipient
 * cannot derive the shared secret. The caller must register a viewing key for
 * the recipient first, or use the out-of-band deposit path.
 */
export class DepositRecipientViewingKeyUnregistered extends PoolSessionDepositBaseError {
    constructor(recipient: string) {
        super(
            `Recipient ${recipient} has no on-chain viewing key — refuse to encrypt to the zero sentinel`,
        );
        this.name = "DepositRecipientViewingKeyUnregistered";
    }
}
