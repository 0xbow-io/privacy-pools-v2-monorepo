/** Base error class for all StellarWalletInteractor errors. */
export class StellarWalletInteractorBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "StellarWalletInteractorBaseError";
    }
}

/** Thrown when signing an unsigned transaction XDR fails (wallet error, user rejection, etc.). */
export class StellarWalletSignTransactionFailed extends StellarWalletInteractorBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Sign transaction failed: ${reason}`);
        this.name = "StellarWalletSignTransactionFailed";
    }
}

/** Thrown when the wallet provider returns no accounts. */
export class StellarWalletNoAccountsError extends StellarWalletInteractorBaseError {
    constructor() {
        super("No accounts available from Stellar wallet provider");
        this.name = "StellarWalletNoAccountsError";
    }
}

/** Thrown when a browser-extension wallet (e.g. Freighter) is not installed/available. */
export class StellarWalletNotAvailable extends StellarWalletInteractorBaseError {
    /** @param reason - Short description of what's unavailable. */
    constructor(reason: string) {
        super(`Wallet not available: ${reason}`);
        this.name = "StellarWalletNotAvailable";
    }
}

/**
 * Thrown when the connected wallet's active network passphrase does not match the session's
 * configured network — same M-3-style guard as EVM's `getChainId` verification, preventing a
 * state-changing call from going out on the wrong network.
 */
export class StellarWalletNetworkMismatch extends StellarWalletInteractorBaseError {
    /** @param expected - The session's configured network passphrase. @param actual - The wallet's active one. */
    constructor(expected: string, actual: string) {
        super(`Wallet network mismatch: expected "${expected}", wallet is on "${actual}"`);
        this.name = "StellarWalletNetworkMismatch";
    }
}
