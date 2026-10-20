/** Base error class for all PoolSessionSwapDeposit errors. */
export class PoolSessionSwapDepositBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "PoolSessionSwapDepositBaseError";
    }
}

/** Thrown when swap-and-deposit parameters fail input validation. */
export class InvalidSwapAndDepositParams extends PoolSessionSwapDepositBaseError {
    /** @param reason - Validation failure detail. */
    constructor(reason: string) {
        super(`Invalid swap-and-deposit params: ${reason}`);
        this.name = "InvalidSwapAndDepositParams";
    }
}

/** Thrown when the LiFi contract-calls quote fails. */
export class SwapAndDepositQuoteFailed extends PoolSessionSwapDepositBaseError {
    /** @param reason - Underlying error detail. */
    constructor(reason: string) {
        super(`Swap-and-deposit quote failed: ${reason}`);
        this.name = "SwapAndDepositQuoteFailed";
    }
}
