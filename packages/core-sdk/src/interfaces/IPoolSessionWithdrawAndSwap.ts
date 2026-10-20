import type {
    Address,
    ExecuteWithdrawAndSwapRelayerParams,
    PreparedSwapQuote,
    PrepareSwapQuoteParams,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates withdraw-and-swap operations via a relayer, generic over the chain's address type
 * `TAddress` and raw receipt-log type `TLog`.
 */
export interface IPoolSessionWithdrawAndSwap<TAddress = Address, TLog = TxLog> {
    /**
     * Orchestrates the full swap quoting flow: relayer fee quote, DEX swap quote,
     * and relayer commitment — returning everything needed for relayWithdrawAndSwap().
     *
     * Requires a swapQuoteProvider to be configured at construction time.
     *
     * @param params - The swap quote parameters (relayer, tokens, amount, recipient).
     * @returns A prepared quote with swap calldata, min output, and signed relayer commitment.
     * @throws {PoolSessionTransactBaseError}
     * @throws {SwapQuoteProviderBaseError}
     */
    prepareSwapQuote(params: PrepareSwapQuoteParams<TAddress>): Promise<PreparedSwapQuote<TAddress>>;

    /**
     * Submits a prepared withdraw-and-swap to a relayer for on-chain execution.
     *
     * The caller provides swap calldata externally; this method handles
     * proof generation, commitment validation, relayer submission, and receipt polling.
     *
     * @param params - The relay parameters including selected quote, proof inputs, and swap calldata.
     * @returns The on-chain transaction receipt.
     * @throws {PoolSessionTransactBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    relayWithdrawAndSwap(
        params: ExecuteWithdrawAndSwapRelayerParams<TAddress>,
    ): Promise<TxReceipt<TLog>>;
}
