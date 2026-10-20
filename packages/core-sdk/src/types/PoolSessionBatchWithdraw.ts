import type {
    Address,
    BatchPrepareResult,
    BatchWithdrawalRelayerQuote,
    IBatchWithdrawOrchestrator,
    ILogger,
    INoteManager,
    IRelayerInteractor,
    ITxReceiptWaiter,
    PreparedTransaction,
    RelayerInfo,
    TxLog,
} from "../internal.js";

/** Parameters for a full-balance batch withdrawal driven through a PoolSession, generic over the chain's address type `TAddress`. */
export interface BatchWithdrawSessionParams<TAddress = Address> {
    /** Token identifier for the asset whose full active balance is withdrawn. */
    tokenId: TAddress;
    /** Recipient address that receives the net amount of every batch item. */
    recipientAddress: TAddress;
}

/**
 * Configuration for PoolSessionBatchWithdraw construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and raw receipt-log type `TLog`. No
 * `TProof` — proof formatting is fully encapsulated inside the injected orchestrator/core, never
 * touched by this class directly.
 */
export interface PoolSessionBatchWithdrawConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /** Builds the per-item proofs bound to the relayer's signed fee split. */
    orchestrator: IBatchWithdrawOrchestrator<TTx, TAddress, TLog>;
    /** Note manager used to derive the per-item quote amounts (selection order). */
    noteManager: INoteManager<TAddress>;
    /** Relayer interactor for batch-withdrawal quote/submit endpoints. */
    relayerInteractor: IRelayerInteractor<TAddress>;
    /** RPC interactor to await the relayer-submitted batch receipt. */
    rpcInteractor: ITxReceiptWaiter<TLog>;
}

/** Optional dependencies for PoolSessionBatchWithdraw. */
export interface PoolSessionBatchWithdrawDependencies {
    logger?: ILogger;
}

/**
 * Result of preparing a batch withdrawal through a PoolSession, generic over the chain's address
 * type `TAddress`. Carries the orchestrator's {@link BatchPrepareResult} plus the selected
 * relayer and its signed quote, so {@link IPoolSessionBatchWithdraw.relayBatchWithdraw} can
 * submit the exact batch whose proofs are already bound to that quote.
 */
export type PrepareBatchWithdrawResult<TAddress = Address> = BatchPrepareResult<TAddress> & {
    /** The relayer selected to sign and submit this batch. */
    relayerInfo: RelayerInfo<TAddress>;
    /** The signed batch quote every item's proof context is bound to. */
    quote: BatchWithdrawalRelayerQuote;
};
