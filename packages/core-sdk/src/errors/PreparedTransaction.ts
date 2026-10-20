/** Base error class for prepared-transaction validation failures. */
export class PreparedTransactionBaseError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = "PreparedTransactionBaseError";
    }
}

/**
 * Thrown when a prepared transaction about to be signed does not match the
 * expected contract address or function selector. Guards the prepare/execute
 * split: a `PrepareXResult` that crossed a trust boundary (server-prepared,
 * deep-linked, tampered in transit) could otherwise have the user's wallet
 * sign arbitrary calldata (e.g. an ERC-20 `approve` draining their tokens).
 */
export class UnexpectedTransactionTarget extends PreparedTransactionBaseError {
    constructor(reason: string) {
        super(`Unexpected transaction target: ${reason}`);
        this.name = "UnexpectedTransactionTarget";
    }
}
