import type {
    Address,
    EstimateReshieldCrosschainParams,
    PrepareDepositResult,
    PreparedReshieldCrosschainQuote,
    PreparedTransaction,
    PrepareReshieldCrosschainQuoteParams,
    PrepareReshieldTransferCrosschainDepositParams,
    ReshieldCrosschainEstimate,
    ReshieldTransferCrosschainParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates cross-chain reshield-and-transfer (withdraw source chain + swap + deposit
 * destination chain on behalf of a recipient) via a relayer, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and raw receipt-log type `TLog`,
 * including opt-in stealth dust rescue for the destination-chain leftover. Output always lands
 * as a configured yield share on the destination chain — there is no plain-ERC20 output for this
 * feature (see `PoolSessionReshieldTransferCrosschainConfig.destinationYieldDepositTargets`,
 * which is required).
 *
 * Composes the existing {@link IPoolSessionReshieldCrosschain}: its estimate/quote/relay steps
 * are already fully recipient-agnostic, so only the deposit-building step is new here.
 */
export interface IPoolSessionReshieldTransferCrosschain<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * Estimates the destination-chain deposit amount for a reshield-and-transfer-crosschain.
     * Same shape as `IPoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount`, plus a
     * pre-flight that `outputToken` resolves to a configured yield-share target on the
     * destination chain.
     *
     * @param params - The estimation parameters (relayer, tokens, amount, destination chain).
     * @returns Deposit estimation with noteValue, totalDepositCost, and fee breakdown.
     * @throws {PoolSessionTransactBaseError}
     */
    estimateReshieldTransferCrosschainAmount(
        params: EstimateReshieldCrosschainParams<TAddress>,
    ): Promise<ReshieldCrosschainEstimate<TAddress>>;

    /**
     * Prepares the yield-share deposit-for proof against the **destination** chain's
     * Entrypoint, owned by the given recipient instead of this session. Accepts the same blind
     * `noteAddressHash` / `discoveryData` forms as `IPoolSessionDeposit.prepareDepositFor` —
     * resolved against the destination chain's keystore (see
     * `PoolSessionReshieldTransferCrosschainConfig.destinationYieldDepositTargets`).
     *
     * @param params - The output token, budget (`ReshieldCrosschainEstimate.totalDepositCost`), and recipient identity.
     * @returns The prepared deposit result — pass to `prepareReshieldTransferCrosschainQuote` as `depositResult`.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldTransferCrosschainDeposit(
        params: PrepareReshieldTransferCrosschainDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>>;

    /**
     * Prepares the full reshield-and-transfer-crosschain quote. Identical to
     * `IPoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote` — already
     * recipient-agnostic, no change needed. Accepts the same `dustRescue` opt-in.
     *
     * @param params - The quote parameters including `depositResult` from `prepareReshieldTransferCrosschainDeposit()`.
     * @returns A prepared quote with swap calldata and signed relayer commitment.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldTransferCrosschainQuote(
        params: PrepareReshieldCrosschainQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldCrosschainQuote<TAddress>>;

    /**
     * Submits a reshield-and-transfer-crosschain to a relayer for on-chain execution. Identical
     * to `IPoolSessionReshieldCrosschain.relayReshieldCrosschain`, except
     * `ReshieldTransferCrosschainParams` never carries a `depositNote` — the sender must never
     * persist a note it doesn't own.
     *
     * When `params.dustRescue` is present, note that `recipientIdentifier` identifies **the
     * originator** (the withdrawer who initiated this operation), not the deposit recipient —
     * the two are different people for this feature, unlike plain reshield where they are
     * always the same account. The rescue mechanism itself is unchanged: the relayer
     * separately watches the destination chain and, at its own discretion, generates and
     * submits an additional shielded deposit for the leftover, owned by a stealth address
     * derived from the supplied identifier.
     *
     * @param params - The reshield-and-transfer-crosschain parameters.
     * @returns The on-chain transaction receipt for the source-chain leg.
     * @throws {PoolSessionTransactBaseError}
     */
    relayReshieldTransferCrosschain(
        params: ReshieldTransferCrosschainParams<TAddress>,
    ): Promise<TxReceipt<TLog>>;
}
