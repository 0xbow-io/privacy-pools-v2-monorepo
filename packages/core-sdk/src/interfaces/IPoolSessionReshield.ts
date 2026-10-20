import type {
    Address,
    EstimateReshieldParams,
    PreparedReshieldQuote,
    PrepareReshieldQuoteParams,
    PreparedTransaction,
    ReshieldEstimate,
    ReshieldParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates reshield (withdraw + swap + deposit) operations via a relayer, generic over the
 * chain's prepared-transaction type `TTx`, address type `TAddress`, and raw receipt-log type
 * `TLog`.
 */
export interface IPoolSessionReshield<TTx = PreparedTransaction, TAddress = Address, TLog = TxLog> {
    /**
     * Estimates the deposit amount for a reshield by querying relayer fees
     * and a DEX swap quote. Returns noteValue and totalDepositCost needed
     * to call session.prepareDeposit() before prepareReshieldQuote().
     *
     * Requires a swapQuoteProvider to be configured at construction time.
     *
     * @param params - The estimation parameters (relayer, tokens, amount). The vetting fee is read on-chain.
     * @returns Deposit estimation with noteValue, totalDepositCost, and fee breakdown.
     * @throws {PoolSessionTransactBaseError}
     */
    estimateReshieldAmount(params: EstimateReshieldParams<TAddress>): Promise<ReshieldEstimate<TAddress>>;

    /**
     * Prepares the full reshield quote after the caller has generated a deposit proof.
     * Fetches an aggregator contractCalls quote (swap + deposit) and commits with the relayer.
     *
     * Requires a swapAndDepositQuoteProvider to be configured at construction time.
     *
     * When `params.dustRescue` is present, the relayer separately watches this same chain
     * after the transaction confirms and — at its own discretion, once it clears its own
     * worth-it threshold — generates and submits an additional shielded deposit for the
     * **swap-input portion** of the leftover swept to `dustRecipient` (the amount forwarded
     * via `dust1ForwardTxHash`), owned by a stealth address derived from the supplied
     * recipient identifier. Output-token and native-ETH leftover from the same sweep are not
     * rescued by this opt-in and remain with the relayer — same mechanism
     * `PoolSessionReshieldCrosschain` uses for its destination-chain leftover, but narrower on
     * same-chain since only the swap-input pool has a forwarding path into the rescue wallet;
     * see `docs/tech-design/sdk/withdraw-and-swap.md` §Cross-Chain Reshield for the accepted
     * trust extension this implies (the rescue deposit's amount and timing are not bound by any
     * client-supplied proof or signature — only detectable after the fact via public on-chain
     * data).
     *
     * @param params - The quote parameters including depositResult from prepareDeposit().
     * @returns A prepared quote with swap calldata and signed relayer commitment.
     * @throws {PoolSessionTransactBaseError}
     */
    prepareReshieldQuote(
        params: PrepareReshieldQuoteParams<TTx, TAddress>,
    ): Promise<PreparedReshieldQuote<TAddress>>;

    /**
     * Submits a reshield to a relayer for on-chain execution.
     *
     * Atomically withdraws shielded Token A, swaps to Token B via a DEX aggregator,
     * and deposits Token B back into the pool. Same-chain only.
     *
     * @param params - The reshield parameters including selected quote, proof inputs, and swap calldata.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    relayReshield(params: ReshieldParams<TAddress>): Promise<TxReceipt<TLog>>;
}
