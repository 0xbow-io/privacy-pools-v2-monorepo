import type {
    Address,
    BudgetSizedYieldDeposit,
    PreparedTransaction,
    PreparedYieldDeposit,
    YieldDepositForParams,
    YieldDepositParams,
} from "../internal.js";

/**
 * Deposit flow for a yield share: wrap the underlying into shares and shield them in one router
 * call.
 *
 * The session builds a STANDARD share-token deposit proof (tokenId = the share) and hands the
 * resulting transaction to the chain's {@link IYieldRouterCodec}, which lifts the proof and note
 * data out and re-encodes them as the router's exact-shares deposit. The router forwards the
 * identical arguments to the pool's deposit, so the proof context is unchanged and valid; it adds
 * the underlying->share wrap and a `maxUnderlyingIn` spend cap.
 */
export interface IPoolSessionYieldDeposit<TTx = PreparedTransaction, TAddress = Address> {
    /**
     * The shares a given underlying MINT PRINCIPAL buys: `previewDeposit(underlyingAmount)`,
     * exactly. No discount is taken off the shares: with an exact-shares deposit the shares are the
     * fixed leg, so a discount here would be an under-deposit, not a protection. The headroom for
     * the rate moving between quote and execution lives in the spend cap instead (see
     * {@link YieldDepositParams.maxUnderlyingIn} and `DEPOSIT_RATE_HEADROOM_PPM`).
     *
     * @param underlyingAmount - The underlying mint principal (before the vetting fee and the supply buffer), raw integer.
     * @returns The share amount to pass as {@link YieldDepositParams.value}.
     * @throws {YieldSessionBaseError | ContractInteractorBaseError}
     */
    sharesForUnderlying(underlyingAmount: bigint): Promise<bigint>;

    /**
     * Sizes a deposit from an ALL-IN underlying budget ("deposit 100 USDC"): the committed shares
     * and the cap to bind, such that the router's full price for them now (underlying for value +
     * vetting-fee shares, plus the router's supply buffer) fits inside the budget minus a
     * `DEPOSIT_RATE_HEADROOM_PPM` reserve, which is left for the rate to move before execution. Pass
     * `shares` as {@link YieldDepositParams.value} and `maxUnderlyingIn` (= the budget) as
     * {@link YieldDepositParams.maxUnderlyingIn}. Prefer this over {@link sharesForUnderlying} when
     * the input is what the wallet is willing to spend.
     *
     * The headroom starts being consumed at sizing: it must cover proof generation, the wallet
     * prompts, the approval confirmation and the deposit inclusion. {@link prepareYieldDeposit}
     * re-quotes after the proof and does not refresh it; if the budget no longer fits, size and
     * prepare again.
     *
     * @param budget - The underlying the wallet may spend in total, raw integer.
     * @returns The shares, the current quote, the cap and the reserved headroom.
     * @throws {YieldSessionBaseError | ContractInteractorBaseError}
     */
    sizeSharesForBudget(budget: bigint, headroomPpm?: bigint): Promise<BudgetSizedYieldDeposit>;

    /**
     * Prepares a yield deposit: builds the standard deposit proof, re-targets it at the router, binds
     * the spend cap (the caller's `maxUnderlyingIn`, else the router quote plus a ppm rate headroom),
     * and returns the approval + deposit transactions to submit in order.
     *
     * @param params - The exact shares to mint and shield, and optionally the spend cap.
     * @returns The prepared approval + deposit transactions, the note to persist, and the sizing.
     * @throws {YieldSessionBaseError | PoolSessionDepositBaseError | ContractInteractorBaseError}
     */
    prepareYieldDeposit(params: YieldDepositParams): Promise<PreparedYieldDeposit<TTx, TAddress>>;

    /**
     * Prepares a yield deposit on behalf of a recipient — the yield-share equivalent of
     * {@link IPoolSessionDeposit.prepareDepositFor}. Same base pipeline as
     * {@link prepareYieldDeposit} (standard deposit proof, re-targeted at the router, spend cap
     * bound), except the underlying deposit proof is built for the given recipient identity
     * instead of the calling session's own owner.
     *
     * Accepts one of three forms, identical to `prepareDepositFor`:
     * - Pre-computed `noteAddressHash` only — blind cold-start, no note announcement.
     * - `discoveryData` with `evmAddress` — SDK fetches the recipient's viewing key, generates a
     *   noteSecret when absent, and computes the noteAddressHash. An unregistered recipient
     *   throws by default; pass `allowOutOfBandFallback: true` to opt into the result carrying
     *   `noteSecret` instead (no on-chain announcement — caller must deliver it to the recipient
     *   themselves).
     * - `discoveryData` with `publicViewingKey` — caller supplies the viewing key,
     *   noteAddressHash, and noteSecret directly.
     *
     * @param params - The yield deposit-for parameters.
     * @returns The prepared approval + deposit transactions, the note to persist, the sizing, and
     *   `noteSecret` when the out-of-band fallback fired.
     * @throws {InvalidYieldAmount} When the share value is not positive, or `maxUnderlyingIn` is below
     *   the router's quoted `underlyingNeeded`.
     * @throws {YieldSessionBaseError | PoolSessionDepositBaseError | ContractInteractorBaseError}
     */
    prepareYieldDepositFor(params: YieldDepositForParams<TAddress>): Promise<PreparedYieldDeposit<TTx, TAddress>>;
}
