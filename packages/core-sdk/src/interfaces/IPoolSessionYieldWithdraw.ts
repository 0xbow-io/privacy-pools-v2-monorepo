import type {
    Address,
    PreparedTransaction,
    PreparedYieldWithdraw,
    PreparedYieldWithdrawRelay,
    YieldWithdrawParams,
    YieldWithdrawRelayParams,
} from "../internal.js";

/**
 * Withdraw flow for a yield share: unshield shares and unwrap them to the underlying for a
 * recipient, in one router call.
 *
 * The session builds a STANDARD withdraw proof (the pool's transact) with the router bound as the
 * processor and a `PayoutRouting` payload; the chain's {@link IYieldRouterCodec} re-encodes that
 * transaction as the router's withdraw-to-underlying call, adding the unwrap and a
 * `minUnderlyingOut` slippage floor on the recipient leg.
 */
export interface IPoolSessionYieldWithdraw<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * Prepares a yield withdrawal: builds the standard transact proof against the router, sizes the
     * recipient slippage floor from `quoteWithdraw`, and returns the single router transaction.
     *
     * @param params - Input notes, released amount, shares out, recipient, and optional fee/gas/slippage.
     * @returns The prepared router withdraw transaction, change/spent notes, and sizing.
     * @throws {YieldSessionBaseError | ContractInteractorBaseError}
     */
    prepareYieldWithdraw(
        params: YieldWithdrawParams<TAddress>,
    ): Promise<PreparedYieldWithdraw<TTx, TAddress>>;

    /**
     * Prepares a RELAYED yield withdrawal: builds the same standard transact proof against the
     * router, but binds the proof context to the relayer's signed `PayoutRouting`
     * (`signedFeeCommitment.data`) and returns typed relayer params instead of a self-submit
     * transaction. The recipient slippage floor is sized from `quoteWithdraw` over the commitment's
     * `amountReceived`, and carried as `minUnderlyingOut`; `processorAddress` is set to the router so
     * the relayer routes the withdrawal through the router.
     *
     * @param params - Input notes, released amount, shares out, recipient, the signed fee commitment
     *   from the quote, whether the recipient gas top-up was requested (`extraGas`), and optional
     *   slippage.
     * @returns The typed relayer params plus change/spent notes and sizing.
     * @throws {YieldSessionBaseError | ContractInteractorBaseError}
     */
    prepareYieldWithdrawRelay(
        params: YieldWithdrawRelayParams<TAddress>,
    ): Promise<PreparedYieldWithdrawRelay<TAddress>>;
}
