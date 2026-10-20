import type {
    DecodedEventLog,
    FinalizedBlockResult,
    GetLogsParams,
    Hex,
    ITxReceiptWaiter,
    ReadContractParams,
    TxLog,
} from "../internal.js";

/**
 * Abstraction for read-only contract calls, generic over the chain's raw log type `TLog`
 * (defaults to EVM's {@link TxLog}). Extends {@link ITxReceiptWaiter} for
 * `waitForTransactionReceipt` — the only method here that varies by chain this way;
 * `readContract`/`getLogsPaginated`/etc. stay EVM-shaped by design (an ABI, block-range
 * pagination). A Stellar RPC interactor is its own separate interface (`IStellarRPCInteractor`),
 * not a `TLog` instantiation of this one — but session orchestrators that only need the
 * receipt-waiting capability depend on `ITxReceiptWaiter<TLog>` directly instead of this wider
 * interface.
 */
export interface IRPCInteractor<TLog = TxLog> extends ITxReceiptWaiter<TLog> {
    /**
     * Executes a read-only contract call.
     *
     * @param params - The contract call parameters (address, abi, functionName, args).
     * @returns The decoded return value from the contract.
     * @throws {RPCInteractorBaseError} When params.address is not a valid Ethereum address.
     */
    readContract(params: ReadContractParams): Promise<unknown>;

    /**
     * Gets the current block number from the RPC provider.
     * @returns The latest block number as a hex string.
     * @throws {RPCInteractorBaseError}
     */
    getBlockNumber(): Promise<Hex>;

    /**
     * Highest block the chain considers final, via the `finalized` block tag.
     *
     * Separate from {@link getBlockNumber} because the two answer different
     * questions. The latest block is where to *look*; the finalized block is how far
     * it is safe to write something that cannot be taken back. A log at the head can
     * be reorged out, and a status like `EXITED` has no reverse edge — so acting on
     * an unfinalized log records a state the canonical chain never reached and never
     * will, with no way to correct it.
     *
     * The result is a three-way discriminated union, not a nullable block, because
     * the two failure modes need opposite handling and collapsing them is a silent
     * safety downgrade. `unsupported` is a permanent property of the provider, so a
     * caller must choose SOME weaker rule or that provider could never record an
     * exit. `unavailable` is a timeout, a rate limit, or a bad gateway — momentary,
     * and a caller should simply not make an irreversible write this pass rather
     * than relax the rule. If the two are merged, anyone who can make one request
     * fail can pick which rule applies.
     *
     * Never throws: a provider that cannot answer is an ordinary configuration, not
     * an error, and must not be able to fail the pass that asks.
     */
    getFinalizedBlockNumber(): Promise<FinalizedBlockResult>;

    /**
     * Fetches and decodes historical event logs from a contract.
     *
     * @param params - The log query parameters (address, events, fromBlock, toBlock).
     * @returns Array of decoded event log entries.
     * @throws {RPCInteractorBaseError} When the address is invalid or the RPC call fails.
     */
    getLogs(params: GetLogsParams): Promise<DecodedEventLog[]>;

    /**
     * Fetches event logs across a block range by splitting it into fixed-size
     * windows. On a window-level RPC failure caused by a provider response-size
     * or log-count cap, the failing window is bisected and retried; other error
     * classes propagate immediately. Sequential to avoid provider rate limits.
     *
     * If `params.toBlock` is omitted, the latest block is fetched once and used
     * as the upper bound. If `params.fromBlock` is omitted, scanning starts at
     * block 0.
     *
     * @param params - Same shape as {@link getLogs}. The implementation overrides
     *   `fromBlock` / `toBlock` per chunk.
     * @returns Concatenated logs in chronological order.
     * @throws {RPCInteractorBaseError} When the address is invalid or a chunk
     *   fails for a reason that bisection cannot resolve.
     */
    getLogsPaginated(params: GetLogsParams): Promise<DecodedEventLog[]>;
}
