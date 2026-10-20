import type {
    Address,
    EstimateReshieldCrosschainParams,
    PreparedReshieldCrosschainQuote,
    PrepareReshieldCrosschainQuoteParams,
    PreparedTransaction,
    ReshieldCrosschainEstimate,
    ReshieldCrosschainParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates cross-chain reshield (withdraw source chain + swap + deposit
 * destination chain) operations via a relayer, including an opt-in stealth dust
 * rescue for the destination-chain leftover (EVM-only today, see
 * {@link DustRescueOptIn}). Generic over the chain's prepared-transaction type `TTx`,
 * address type `TAddress`, and raw receipt-log type `TLog`.
 */
export interface IPoolSessionReshieldCrosschain<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * Estimates the destination-chain deposit amount for a cross-chain
     * reshield by querying relayer fees and a DEX swap quote. Returns
     * noteValue and totalDepositCost needed to call a destination-chain-scoped
     * `PoolSession.prepareDeposit()` before `prepareReshieldCrosschainQuote()`.
     *
     * Requires a swapQuoteProvider to be configured at construction time.
     *
     * @param params - The estimation parameters (relayer, tokens, amount, destination chain).
     * @returns Deposit estimation with noteValue, totalDepositCost, and fee breakdown.
     * @throws {PoolSessionTransactBaseError}
     */
    estimateReshieldCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>>;

    /**
     * Prepares the full cross-chain reshield quote after the caller has
     * generated a deposit proof against the **destination** chain's
     * Entrypoint. Fetches a cross-chain contractCalls quote (bridge +
     * swap + destination deposit) and commits with the relayer.
     *
     * Requires a swapAndDepositQuoteProvider to be configured at construction time.
     *
     * @param params - The quote parameters including a destination-chain-scoped depositResult.
     * @returns A prepared quote with swap calldata and signed relayer commitment.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>>;

    /**
     * Submits a cross-chain reshield to a relayer for on-chain execution.
     *
     * Withdraws shielded Token A on the source chain, bridges + swaps to
     * Token B via the aggregator, and deposits into the destination chain's pool via an
     * aggregator-mediated destination contract call. Output-sufficiency on the
     * destination leg is enforced by that chain's `Entrypoint.deposit()`
     * reverting — there is no protocol-owned destination verifier yet (see
     * `docs/tech-design/future-ideas/cross-chain-destination-verifier.md`), so
     * a failed destination deposit falls back to `fallbackAddress` on the
     * destination chain per the aggregator's standard cross-chain failure handling.
     *
     * When `params.dustRescue` (echoed from the prepared quote) is present,
     * the relayer separately watches the destination chain after this
     * transaction confirms and — at its own discretion, once it clears its
     * own worth-it threshold — generates and submits an additional shielded
     * deposit for the leftover, owned by an identity derived from the
     * supplied recipient identifier. See `docs/tech-design/sdk/withdraw-and-swap.md`
     * §Cross-Chain Reshield for the accepted trust extension this implies:
     * unlike every other relayer action in this SDK, the rescue deposit's
     * amount and timing are not bound by any client-supplied proof or
     * signature — only detectable after the fact via public on-chain data.
     *
     * @param params - The reshield-crosschain parameters including selected quote, proof inputs, and swap calldata.
     * @returns The on-chain transaction receipt for the source-chain leg.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    relayReshieldCrosschain(params: ReshieldCrosschainParams<TAddress>): Promise<TxReceipt<TLog>>;
}
