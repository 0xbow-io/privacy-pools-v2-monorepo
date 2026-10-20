/**
 * Machine-readable amounts on the errors that carry them.
 *
 * Several SDK errors interpolate raw base-unit integers into their message:
 *
 *     Deposit value 4765396938345822042 is below the Entrypoint minimum 10000000000000000000
 *
 * An embedder cannot render that. It does not know the decimals from the string,
 * and it cannot tell WHICH asset the figures are in — a deposit minimum is sized
 * in the destination pool's token while a relay fee comes out of the one being
 * spent, so guessing prints the right number under the wrong ticker. Parsing the
 * message is the only option left, and it breaks the moment any wording changes.
 *
 * So the values travel as fields too, alongside a `code` that is stable
 * independently of the prose. Messages are unchanged: this is additive, and an
 * embedder that ignores the fields sees exactly what it saw before.
 */

/** Stable identifier for an error shape, safe to switch on. */
export type AmountErrorCode =
    /** A reshield note value is under the Entrypoint's minimum deposit. */
    | "depositBelowMinimum"
    /** A yield-deposit router quote no longer fits the sizing budget. */
    | "invalidYieldAmount"
    /** A fixed-input LiFi swap needs more than the net withdrawal funds. */
    | "lifiInputExceedsNet"
    /** The selected notes are worth less than the requested transact. */
    | "insufficientTransactValue"
    /** The change left after the outputs cannot pay the relayer fee. */
    | "insufficientChangeForFee"
    /** The relayer's fee is over the Entrypoint's `maxRelayFee` for the asset. */
    | "relayFeeExceedsMax"
    /** The relayer's fee is at or above the whole withdrawal. */
    | "relayFeeConsumesWithdrawal"
    /** A batch item's own fee is over the amount that item withdraws. */
    | "infeasibleBatchFee"
    /** An asset's `maxRelayFee` cap is below what the relay costs. */
    | "assetNotRelayable"
    /** The leftover swept to the dust recipient is over tolerance. */
    | "swapInputDust"
    /** The fee buffer leaves no swap input at this withdrawal size. */
    | "swapInputNonPositive"
    /** The net shares redeem to nothing, so there is no swap input. */
    | "yieldRedeemsToNothing"
    /** A yield-withdraw fee is over the amount being withdrawn. */
    | "yieldFeeExceedsAmountOut"
    /** A relayer-signed `amountSent` is not the figure the caller asked for. */
    | "commitmentAmountSentMismatch"
    /** A relayer-signed `feeAmount` is over the amount being withdrawn. */
    | "commitmentFeeExceedsAmountOut"
    /** The deposit budget cannot cover the rate headroom and the zap buffer. */
    | "yieldBudgetBelowFixedCosts";

/**
 * The figures an error is about, in base units.
 *
 * `side` says which asset they are denominated in, because that is not
 * recoverable from the numbers and getting it wrong is worse than showing the
 * raw integer:
 *   - `spent`: the asset leaving the caller (a note being withdrawn, an input token).
 *   - `received`: the asset arriving (a destination pool's token, a share).
 */
export interface ErrorAmounts {
    readonly code: AmountErrorCode;
    readonly side: "spent" | "received";
    readonly values: Readonly<Record<string, bigint>>;
}

/** Implemented by every error that carries amounts. */
export interface WithErrorAmounts {
    readonly amounts?: ErrorAmounts;
}

/**
 * True when an unknown error carries structured amounts. Narrow with this rather
 * than checking `name`, which is not stable across bundling.
 */
export function hasErrorAmounts(error: unknown): error is Error & Required<WithErrorAmounts> {
    if (!(error instanceof Error)) return false;
    const amounts = (error as Error & WithErrorAmounts).amounts;
    return (
        !!amounts &&
        typeof amounts.code === "string" &&
        (amounts.side === "spent" || amounts.side === "received") &&
        !!amounts.values &&
        typeof amounts.values === "object"
    );
}
