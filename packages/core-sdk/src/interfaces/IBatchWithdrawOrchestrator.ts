import type {
    Address,
    BatchPrepareResult,
    BatchWithdrawParams,
    Hash,
    Note,
    PendingNote,
    PreparedTransaction,
    SelfSubmitBatchParams,
    SelfSubmitBatchPrepareResult,
    SpentNoteVerification,
    TxLog,
} from "../internal.js";

/**
 * Orchestrates a full-balance batch withdrawal: drains every ACTIVE note of an
 * asset to a single recipient as a set of independent transacts, one per
 * single-label note group, with a single relayer fee split across them.
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, and raw
 * receipt-log type `TLog`.
 *
 * `prepareBatchWithdraw` is read-only with respect to local note state; callers
 * must invoke `persistBatchNoteUpdates` only after the batch lands on-chain.
 */
export interface IBatchWithdrawOrchestrator<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * Awaits completion of the keystore + state-tree leaf-cache warm-up so callers
     * can guarantee both are populated before requesting a committed relayer quote,
     * whose short-lived fee-commitment TTL should not be spent on an on-chain scan.
     * Delegates to the underlying {@link ITransactOrchestrator.warmMerkleCaches}.
     */
    warmMerkleCaches(): Promise<void>;

    /**
     * Selects the asset's full active balance, splits the batch fee, and builds
     * one transact (proof + routing) per note group without mutating local note
     * state.
     *
     * @param params - The target asset, recipient, fee bounds, and relay routing.
     * @returns The prepared per-item transacts plus the aggregate spent/change notes.
     * @throws {BatchWithdrawBaseError}
     */
    prepareBatchWithdraw(params: BatchWithdrawParams<TAddress>): Promise<BatchPrepareResult<TAddress>>;

    /**
     * Builds a SELF-SUBMIT batch: selects the asset's full active balance and proves one
     * zero-fee transact per note group, then encodes the whole set into a single
     * `relayBatch` transaction the gas-paying user submits themselves (no relayer). Does
     * not mutate local note state.
     *
     * @param params - The target asset, recipient, and PrivacyPoolRelay contract address.
     * @returns The ready-to-sign `relayBatch` transaction plus the aggregate spent/change notes.
     * @throws {BatchWithdrawBaseError}
     */
    prepareSelfSubmitBatch(
        params: SelfSubmitBatchParams<TAddress>,
    ): Promise<SelfSubmitBatchPrepareResult<TTx, TAddress>>;

    /**
     * Submits a prepared self-submit batch as the caller's own `relayBatch` transaction.
     *
     * @param prepared - The result of {@link IBatchWithdrawOrchestrator.prepareSelfSubmitBatch}.
     * @returns The submitted transaction hash.
     */
    submitSelfSubmitBatch(prepared: SelfSubmitBatchPrepareResult<TTx, TAddress>): Promise<Hash>;

    /**
     * Persists the note-state changes for an entire confirmed batch in one pass:
     * marks every input note SPENT and adds every change note. Call ONLY after
     * the batch's on-chain transaction has been confirmed, since it makes the
     * spend durable.
     *
     * @param spentNotes - Every input note spent across the batch.
     * @param changePendingNotes - Every change note created across the batch.
     * @param txHash - The confirmed batch transaction hash.
     * @param verification - REQUIRED receipt-log evidence: the batch's `Transacted` logs are
     *   parsed and every spent nullifier must be confirmed before persisting SPENT, else it
     *   warns and persists nothing (AW-L-02 / #1070). Required rather than optional because
     *   SPENT is terminal — an unverified persist is unrecoverable — and an optional parameter
     *   made the same check fail-open on the relayed swap paths.
     * @throws {NoteManagerBaseError}
     */
    persistBatchNoteUpdates(
        spentNotes: Note<TAddress>[],
        changePendingNotes: PendingNote<TAddress>[],
        txHash: Hash,
        verification: SpentNoteVerification<TLog>,
    ): Promise<void>;
}
