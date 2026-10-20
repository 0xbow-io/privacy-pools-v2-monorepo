/** Base error class for all StellarRPCInteractor errors. */
export class StellarRPCInteractorBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "StellarRPCInteractorBaseError";
    }
}

/**
 * Thrown when `simulateTransaction` reports a simulation error (contract panic, resource-budget
 * exceeded, invalid arguments, etc.) — covers both read-only simulation and the simulation step
 * of a write's build-simulate-assemble pipeline.
 */
export class StellarSimulationFailed extends StellarRPCInteractorBaseError {
    /** @param reason - The simulation error message returned by the RPC. */
    constructor(reason: string) {
        super(`Simulation failed: ${reason}`);
        this.name = "StellarSimulationFailed";
    }
}

/** Thrown when `sendTransaction` reports an immediate send failure (status `"ERROR"`). */
export class StellarTransactionSendFailed extends StellarRPCInteractorBaseError {
    /** @param reason - The send error detail returned by the RPC. */
    constructor(reason: string) {
        super(`Transaction send failed: ${reason}`);
        this.name = "StellarTransactionSendFailed";
    }
}

/** Thrown when a submitted transaction lands on-chain with status `"FAILED"`. */
export class StellarTransactionFailed extends StellarRPCInteractorBaseError {
    /** @param reason - The failure detail (result XDR or similar) returned by the RPC. */
    constructor(reason: string) {
        super(`Transaction failed: ${reason}`);
        this.name = "StellarTransactionFailed";
    }
}

/** Thrown when polling for a transaction's confirmation exceeds the configured timeout. */
export class StellarTransactionTimedOut extends StellarRPCInteractorBaseError {
    /** @param txHash - The hash being polled. @param timeoutMs - The timeout that elapsed. */
    constructor(txHash: string, timeoutMs: number) {
        super(`Transaction ${txHash} timed out after ${timeoutMs}ms`);
        this.name = "StellarTransactionTimedOut";
    }
}

/**
 * Thrown when `getEvents`'s requested `startLedger`/cursor falls outside the RPC node's
 * retention window — the caller must resume from a more recent cursor or ledger.
 */
export class StellarEventRetentionWindowExceeded extends StellarRPCInteractorBaseError {
    /** @param reason - The underlying RPC error message. */
    constructor(reason: string) {
        super(
            `getEvents: requested range is outside the RPC retention window — resume from a ` +
                `recent cursor or a more recent ledger (${reason})`,
        );
        this.name = "StellarEventRetentionWindowExceeded";
    }
}

/** Thrown when a single RPC call (e.g. `getEvents`, `getLatestLedger`) exceeds its own timeout. */
export class StellarRPCCallTimedOut extends StellarRPCInteractorBaseError {
    /** @param method - The RPC method that timed out. @param timeoutMs - The timeout that elapsed. */
    constructor(method: string, timeoutMs: number) {
        super(`RPC call "${method}" timed out after ${timeoutMs}ms`);
        this.name = "StellarRPCCallTimedOut";
    }
}
