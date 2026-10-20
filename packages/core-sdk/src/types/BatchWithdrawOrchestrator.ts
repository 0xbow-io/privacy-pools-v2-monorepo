import type {
    Address,
    BatchWithdrawalRelayerQuote,
    BatchWithdrawGroup,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    ILogger,
    INoteManager,
    IPayoutRoutingCodec,
    IPreparedTxVerifier,
    ITransactOrchestrator,
    Note,
    NoteData,
    PendingNote,
    PreparedTransaction,
    TransactParams,
    TransactProof,
    TxLog,
} from "../internal.js";

/**
 * Configuration for BatchWithdrawOrchestrator construction, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`, and
 * raw receipt-log type `TLog`.
 */
export interface BatchWithdrawOrchestratorConfig<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> {
    /** Shared transact infrastructure (read-only prepareTransact + deferred persist). */
    core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    /** Note manager used to read the ACTIVE balance being withdrawn. */
    noteManager: INoteManager<TAddress>;
    /** Encodes each item's PayoutRouting tuple into `TransactParams.data`. */
    payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    /** Compares two `TAddress` values for equality (chain-specific canonicalization rules). */
    addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    /**
     * Verifies the prepared `relayBatch` transaction before it is handed to a wallet, since a
     * {@link SelfSubmitBatchPrepareResult} is plain data that can be carried between the prepare
     * and submit steps.
     */
    preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    /**
     * The chain's empty address — the fee recipient of a self-submitted batch, which pays no fee.
     * Defaults to EVM's zero address; a chain whose routing codec cannot encode that (Stellar)
     * supplies its own.
     */
    emptyAddress?: TAddress;
}

/** Optional dependencies for BatchWithdrawOrchestrator. */
export interface BatchWithdrawOrchestratorDependencies {
    logger?: ILogger;
}

/**
 * Parameters for prepareBatchWithdraw, generic over the chain's address type `TAddress`. All
 * values are Hex at the boundary.
 *
 * This flow is RELAYER-AUTHORITATIVE: the fee split is not computed locally.
 * Instead the caller supplies the relayer's signed batch quote, whose
 * `feeCommitment.data` ABI-encodes the whole `PayoutRouting[]`. The orchestrator
 * decodes it and binds each item's routing (recipient, feeRecipient, feeAmount,
 * nativeGas) into that item's proof `context`, so the on-chain `relayBatch` can
 * only sum and cap — it cannot re-split.
 */
export interface BatchWithdrawParams<TAddress = Address> {
    /** Token identifier for the asset whose full active balance is withdrawn. */
    tokenId: TAddress;
    /** Recipient address that receives the net amount of every batch item. */
    recipientAddress: TAddress;
    /** Relay processor address bound as each item's `TransactParams.processor`. */
    relayAddress: TAddress;
    /**
     * The relayer's signed batch withdrawal quote. Its `feeCommitment.data`
     * carries the ABI-encoded `PayoutRouting[]` (one routing per note group, in
     * selection order) that determines every item's fee split.
     */
    quote: BatchWithdrawalRelayerQuote;
    /**
     * Pre-computed note groups from the caller's selection. When omitted the
     * orchestrator selects the asset's active balance itself. The session passes
     * the same groups it used to quote `amounts`, so the balance is partitioned
     * once and cannot shift between quoting and proving (review QUALITY-2).
     */
    groups?: BatchWithdrawGroup[];
}

/** One prepared transact within a batch withdrawal, generic over the chain's address type `TAddress`. */
export interface BatchWithdrawItem<TAddress = Address> {
    /** The ZK proof for this item's transact. */
    proof: TransactProof;
    /** Encoded PayoutRouting transact params bound into this item's proof context. */
    transactParams: TransactParams<TAddress>;
    /** Encrypted note data payloads for this item (the change note). */
    noteData: NoteData[];
    /** Total value released from the pool by this item. */
    amountOut: Hex;
    /** Fee allocated to this item by the batch fee split. */
    feeAmount: Hex;
    /** Number of input nullifiers (input commitments spent by this item). */
    inputNullifierNumber: number;
    /** Number of output commitments (change notes created by this item). */
    outputCommitmentNumber: number;
}

/** Result of prepareBatchWithdraw, generic over the chain's address type `TAddress`. */
export interface BatchPrepareResult<TAddress = Address> {
    /** One prepared transact per selected note group. */
    items: BatchWithdrawItem<TAddress>[];
    /** Sum of every item's amountOut. */
    totalAmountOut: Hex;
    /** Sum of every item's feeAmount (equals the supplied totalFee). */
    totalFee: Hex;
    /** Every input note spent across the whole batch (mark SPENT after confirmation). */
    spentNotes: Note<TAddress>[];
    /**
     * Every nullifier hash spent across the batch (parallel to `spentNotes`), threaded
     * to `persistBatchNoteUpdates` so it can verify the confirmed receipt's `Transacted`
     * logs consumed them before marking the notes SPENT (AW-L-02 / #1070).
     */
    spentNullifiers: Hex[];
    /** Every change pending note created across the batch (persist after confirmation). */
    changePendingNotes: PendingNote<TAddress>[];
}

/**
 * Parameters for a SELF-SUBMIT batch withdrawal, generic over the chain's address type
 * `TAddress` — the gas-paying variant of {@link BatchWithdrawParams}. No relayer, so no signed
 * quote: every item is proven with a zero-fee routing (`feeAmount` 0, `feeRecipient` empty,
 * `nativeGas` 0) and the user submits the atomic `relayBatch` themselves. The permissionless
 * on-chain `relayBatch` accepts it because a zero fee trivially satisfies the fee caps.
 */
export interface SelfSubmitBatchParams<TAddress = Address> {
    /** Token identifier for the asset whose full active balance is withdrawn. */
    tokenId: TAddress;
    /** Recipient address that receives every item's full withdrawn value. */
    recipientAddress: TAddress;
    /** The PrivacyPoolRelay contract address — the `relayBatch` transaction target. */
    relayContractAddress: TAddress;
    /**
     * Pre-computed note groups. When omitted the orchestrator selects the asset's full
     * active balance itself (the common case — the session delegates directly).
     */
    groups?: BatchWithdrawGroup[];
}

/**
 * Result of prepareSelfSubmitBatch, generic over the chain's prepared-transaction type `TTx`
 * and address type `TAddress`: a ready-to-sign `relayBatch` transaction plus the note-state
 * deltas to persist once it confirms.
 */
export interface SelfSubmitBatchPrepareResult<TTx = PreparedTransaction, TAddress = Address> {
    /** The ready-to-sign `relayBatch` transaction. */
    relayBatchTx: TTx;
    /**
     * The relay contract `relayBatchTx` targets. Carried in the result so the submit step can
     * check the transaction against it without holding state from the orchestrator that prepared
     * the batch — a prepared batch must stay transportable between processes and sessions.
     */
    relayContractAddress: TAddress;
    /** Every input note spent across the whole batch (mark SPENT after confirmation). */
    spentNotes: Note<TAddress>[];
    /**
     * Every nullifier hash spent across the batch (parallel to `spentNotes`), threaded
     * to `persistBatchNoteUpdates` so it can verify the confirmed receipt's `Transacted`
     * logs consumed them before marking the notes SPENT (AW-L-02 / #1070).
     */
    spentNullifiers: Hex[];
    /** Every change pending note created across the batch (persist after confirmation). */
    changePendingNotes: PendingNote<TAddress>[];
}
