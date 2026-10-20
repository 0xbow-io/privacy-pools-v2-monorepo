import type { YieldEarned, YieldEarnedInput } from "../internal.js";

/**
 * Yield earned on one share position: what the wallet's shares are worth now plus what it took
 * out, minus what it put in, in the share's underlying.
 *
 * Flow accounting, not lot accounting: shares are fungible and value is linear in shares, so
 * FIFO versus proportional does not arise. Own deposits enter at their exact deposit-fact basis,
 * received notes at the rate when they arrived, exits at the rate when they happened, and what
 * is still held at the live rate. See {@link computeYieldEarned} for the arithmetic.
 *
 * The only request `compute` makes is the no-argument `exchangeRate()`. The feeds it works from
 * are passed in already fetched (see {@link IYieldFeedProvider}) so that nothing here can put a
 * request on the wire whose timing or argument depends on the wallet's notes.
 */
export interface IPoolSessionYieldEarned {
    /**
     * Computes the position's earned figure from the wallet's notes of this share, the pool
     * events, the two public feeds and the live exchange rate.
     *
     * Fails closed: any note whose origin, time or exit cannot be established from the inputs
     * makes the whole result `{ status: "unavailable" }`. Never a number in that case.
     *
     * @param input - The already-fetched feed data and pool events.
     * @returns The earned figure, or why none can be given.
     * @throws {ContractInteractorBaseError} When the live `exchangeRate()` read fails.
     */
    compute(input: YieldEarnedInput): Promise<YieldEarned>;
}
