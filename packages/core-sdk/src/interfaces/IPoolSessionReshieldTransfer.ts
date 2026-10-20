import type {
    Address,
    EstimateReshieldParams,
    PrepareDepositResult,
    PreparedReshieldQuote,
    PreparedTransaction,
    PrepareReshieldQuoteParams,
    PrepareReshieldTransferDepositParams,
    ReshieldEstimate,
    ReshieldTransferParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates reshield-and-transfer (withdraw + swap + deposit on behalf of a recipient,
 * mirroring Internal Transfer's recipient resolution) via a relayer, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and raw receipt-log type `TLog`.
 * Same-chain only. The output lands as a configured yield share, or — when the session was built
 * with a `depositDelegate` (see `PoolSessionReshieldTransferConfig`) — as a plain pool asset
 * deposited for the recipient through `prepareDepositFor`. Without a delegate it is yield-share
 * only.
 *
 * Composes the existing {@link IPoolSessionReshield}: its estimate/quote/relay steps are already
 * fully recipient-agnostic (the deposit's `noteAddressHash` is chosen client-side before proof
 * generation, and the whole LiFi payload — deposit call included — is proof-bound), so only the
 * deposit-building step is new here.
 */
export interface IPoolSessionReshieldTransfer<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * Estimates the deposit amount for a reshield-and-transfer. Same shape as
     * `IPoolSessionReshield.estimateReshieldAmount`, plus a pre-flight that `outputToken` is
     * served — a configured yield-share target, or a plain asset when the session has a
     * `depositDelegate` — failing fast rather than silently estimating a deposit this session
     * cannot build.
     *
     * @param params - The estimation parameters (relayer, tokens, amount).
     * @returns Deposit estimation with noteValue, totalDepositCost, and fee breakdown.
     * @throws {PoolSessionTransactBaseError}
     */
    estimateReshieldTransferAmount(
        params: EstimateReshieldParams<TAddress>,
    ): Promise<ReshieldEstimate<TAddress>>;

    /**
     * Prepares the deposit-for proof, owned by the given recipient instead of this session.
     * Two output paths, chosen by `outputToken`:
     * - a configured yield share is sized from the budget (`totalDepositCost`) and built through
     *   its `YieldSwapDepositTarget`;
     * - otherwise, when the session has a `depositDelegate`, a plain pool asset is built with
     *   `depositDelegate.prepareDepositFor` for exactly `noteValue` (required on this path; the
     *   vetting fee rides on top and is already inside `totalDepositCost`).
     *
     * Accepts the same blind `noteAddressHash` / `discoveryData` forms as
     * `IPoolSessionDeposit.prepareDepositFor` — an unregistered `discoveryData.evmAddress`
     * recipient throws by default; pass `allowOutOfBandFallback: true` to opt into the result
     * carrying `noteSecret` instead (caller must then deliver it to the recipient themselves).
     *
     * @param params - The output token, budget (`ReshieldEstimate.totalDepositCost`), the estimate's
     *   `noteValue` (plain output), and recipient identity.
     * @returns The prepared deposit result — pass to `prepareReshieldTransferQuote` as `depositResult`.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldTransferDeposit(
        params: PrepareReshieldTransferDepositParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>>;

    /**
     * Prepares the full reshield-and-transfer quote. Identical to
     * `IPoolSessionReshield.prepareReshieldQuote` — already recipient-agnostic, no change needed.
     * Accepts the same `dustRescue` opt-in for recovering the **swap-input portion** of the
     * leftover swept to `dustRecipient` into a stealth-owned shielded deposit — see
     * `IPoolSessionReshield.prepareReshieldQuote`'s doc for the same-chain scope narrowing.
     *
     * @param params - The quote parameters including `depositResult` from `prepareReshieldTransferDeposit()`.
     * @returns A prepared quote with swap calldata and signed relayer commitment.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldTransferQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>>;

    /**
     * Submits a reshield-and-transfer to a relayer for on-chain execution. Identical to
     * `IPoolSessionReshield.relayReshield`, except `ReshieldTransferParams` never carries a
     * `depositNote` — the sender must never persist a note it doesn't own.
     *
     * When `params.dustRescue` is present, note that `recipientIdentifier` identifies **the
     * originator** (the withdrawer who initiated this operation), not the deposit recipient —
     * the two are different people for this feature, unlike plain reshield where they are
     * always the same account.
     *
     * @param params - The reshield-and-transfer parameters, including selected quote and swap calldata.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     */
    relayReshieldTransfer(params: ReshieldTransferParams<TAddress>): Promise<TxReceipt<TLog>>;
}
