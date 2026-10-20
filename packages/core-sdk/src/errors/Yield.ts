import type { ErrorAmounts, WithErrorAmounts } from "./amounts.js";

/** Base error class for all yield (ppUSDC) session errors. */
export class YieldSessionBaseError extends Error {
    /** @param reason - Short description of the error. */
    constructor(reason: string) {
        super(reason);
        this.name = "YieldSessionBaseError";
    }
}

/**
 * Thrown when the base deposit session produced calldata that is not the expected
 * `Entrypoint.deposit(...)` call, so the yield path cannot lift out `(proof, noteData,
 * aspCiphertext)` to re-target at the router.
 */
export class UnexpectedDepositCalldata extends YieldSessionBaseError {
    /** @param reason - What was decoded instead. */
    constructor(reason: string) {
        super(`Unexpected deposit calldata: ${reason}`);
        this.name = "UnexpectedDepositCalldata";
    }
}

/**
 * Thrown when the base withdraw session produced calldata that is not the expected
 * `PoolVault.transact(...)` call, so the yield path cannot lift out `(proof, transactParams,
 * noteData)` to re-target at the router.
 */
export class UnexpectedWithdrawCalldata extends YieldSessionBaseError {
    /** @param reason - What was decoded instead. */
    constructor(reason: string) {
        super(`Unexpected withdraw calldata: ${reason}`);
        this.name = "UnexpectedWithdrawCalldata";
    }
}

/** Thrown when a yield amount (shares/underlying) fails input validation. */
export class InvalidYieldAmount extends YieldSessionBaseError implements WithErrorAmounts {
    /**
     * Set only where `reason` interpolates token amounts. It stays absent on the
     * bounds checks ("must be > 0", "is not a valid hex integer"), which echo the
     * caller's own input rather than a figure worth rendering as money.
     */
    readonly amounts?: ErrorAmounts;

    /**
     * @param reason - Validation failure detail.
     * @param amounts - The token figures inside `reason`, when it carries any.
     */
    constructor(reason: string, amounts?: ErrorAmounts) {
        super(`Invalid yield amount: ${reason}`);
        this.name = "InvalidYieldAmount";
        this.amounts = amounts;
    }
}

/**
 * Thrown when a yield operation is given the zero address for a party that must be non-zero — e.g.
 * the `redeem` receiver (a zero receiver would burn the redeemed aToken) or a withdrawal recipient.
 */
export class InvalidYieldAddress extends YieldSessionBaseError {
    /** @param reason - Which address was zero. */
    constructor(reason: string) {
        super(`Invalid yield address: ${reason}`);
        this.name = "InvalidYieldAddress";
    }
}

/** Two yield deployments in one session name the same share token. */
export class DuplicateYieldDeployment extends YieldSessionBaseError {
    override readonly name = "DuplicateYieldDeployment";
}
