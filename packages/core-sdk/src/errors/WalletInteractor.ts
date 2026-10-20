/** Base error class for all WalletInteractor errors. */
export class WalletInteractorBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "WalletInteractorBaseError";
    }
}

/** Thrown when a wallet transaction send fails (e.g. user rejected, RPC error). */
export class WalletSendTransactionFailed extends WalletInteractorBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Send transaction failed: ${reason}`);
        this.name = "WalletSendTransactionFailed";
    }
}

/** Thrown when an EIP-712 typed-data signature fails (e.g. user rejected, RPC error). */
export class WalletSignTypedDataFailed extends WalletInteractorBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Sign typed data failed: ${reason}`);
        this.name = "WalletSignTypedDataFailed";
    }
}

/** Thrown when the wallet provider returns no accounts. */
export class WalletNoAccountsError extends WalletInteractorBaseError {
    constructor() {
        super("No accounts available from wallet provider");
        this.name = "WalletNoAccountsError";
    }
}

/**
 * Thrown when the wallet's active chain is not the chain the interactor was built for.
 * A contract address is the same string on every chain, so a transaction prepared for
 * one chain and sent after the wallet switched networks reaches whatever occupies that
 * address on the new chain.
 */
export class WalletChainMismatch extends WalletInteractorBaseError {
    /**
     * @param actualChainId - The chain the wallet is currently on.
     * @param expectedChainId - The chain this interactor is bound to.
     */
    constructor(actualChainId: number, expectedChainId: number) {
        super(
            `Wallet is on chain ${actualChainId}, but this session sends on chain ${expectedChainId}. Switch the wallet back before retrying.`,
        );
        this.name = "WalletChainMismatch";
    }
}
