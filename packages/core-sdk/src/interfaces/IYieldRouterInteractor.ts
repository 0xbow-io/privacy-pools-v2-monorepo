import type { Address, YieldQuote } from "../internal.js";

/**
 * Read-only interactions with a yield router — the contract that wraps underlying into shares and
 * shields them in one call, and is the transact processor that unwraps shares on the way out.
 */
export interface IYieldRouterInteractor<TAddress = Address> {
    /**
     * Returns the router contract address this interactor is bound to.
     */
    getAddress(): TAddress;
    /**
     * Sizes a deposit: the underlying needed to mint `value` shares plus the pool's vetting-fee
     * shares on top.
     *
     * @param value - Target shares (the note value), raw integer.
     * @returns `{ underlyingNeeded, total }`, raw integers.
     * @throws {ContractInteractorBaseError}
     */
    quote(value: bigint): Promise<YieldQuote>;
    /**
     * Sizes a withdrawal: the underlying redeemable for `shares`.
     *
     * @param shares - Shares to withdraw, raw integer.
     * @returns The underlying out, raw integer.
     * @throws {ContractInteractorBaseError}
     */
    quoteWithdraw(shares: bigint): Promise<bigint>;
    /**
     * The fixed underlying an exact-shares mint pays on top of its principal, so the venue
     * credits at least what was asked despite its own rounding (EVM: the zap's constant 2 units;
     * Stellar: Blend's `floor(b_rate) + 1`, which moves with the reserve).
     *
     * @returns The buffer in underlying units, raw integer.
     * @throws {ContractInteractorBaseError}
     */
    supplyBufferUnits(): Promise<bigint>;
}
