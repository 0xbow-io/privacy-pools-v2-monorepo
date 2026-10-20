import type {
    Address,
    BatchWithdrawSessionParams,
    PreparedTransaction,
    PrepareBatchWithdrawResult,
    SelfSubmitBatchParams,
    SelfSubmitBatchPrepareResult,
    TxLog,
    TxReceipt,
} from "../internal.js";

/**
 * Orchestrates a full-balance batch withdrawal end-to-end through a PoolSession.
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, and raw
 * receipt-log type `TLog`.
 *
 * The relayed path (`prepareBatchWithdraw`/`relayBatchWithdraw`) fetches one aggregate
 * relayer quote and binds each proof to its signed fee split; the self-submit path
 * (`selfSubmitBatchWithdraw` and its prepare/execute halves) proves zero-fee items and
 * submits the atomic `relayBatch` as the gas-paying user's own transaction.
 */
export interface IPoolSessionBatchWithdraw<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> {
    /**
     * Prepares a full-balance batch withdrawal: partitions the asset's active
     * notes into per-transact groups, requests a single aggregate batch quote,
     * and builds one proof per group bound to the relayer's signed routing.
     * Local note state is not mutated; call {@link IPoolSessionBatchWithdraw.relayBatchWithdraw}
     * to submit and persist.
     *
     * @param params - The target asset and shared recipient.
     * @returns The prepared batch plus the selected relayer and its signed quote.
     * @throws {BatchWithdrawBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     * @throws {RelayerInteractorBaseError}
     */
    prepareBatchWithdraw(
        params: BatchWithdrawSessionParams<TAddress>,
    ): Promise<PrepareBatchWithdrawResult<TAddress>>;

    /**
     * Submits a prepared batch withdrawal to its selected relayer and, on
     * success, persists the note-state changes for the whole batch in one pass.
     *
     * @param params - The result returned by {@link IPoolSessionBatchWithdraw.prepareBatchWithdraw}.
     * @returns The on-chain transaction receipt.
     * @throws {BatchWithdrawBaseError}
     * @throws {RelayerInteractorBaseError}
     */
    relayBatchWithdraw(params: PrepareBatchWithdrawResult<TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Full-balance SELF-SUBMIT batch: prepares zero-fee proofs for the asset's whole active
     * balance and submits the atomic `relayBatch` as the caller's own gas-paying transaction
     * (no relayer). Persists the note-state changes on success.
     *
     * @param params - The target asset, recipient, and PrivacyPoolRelay contract address.
     * @returns The on-chain transaction receipt.
     * @throws {BatchWithdrawBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    selfSubmitBatchWithdraw(params: SelfSubmitBatchParams<TAddress>): Promise<TxReceipt<TLog>>;

    /**
     * Prepares a self-submit batch without submitting: proves one zero-fee transact per note
     * group and encodes them into a single ready-to-sign `relayBatch` transaction. Local note
     * state is not mutated; call {@link IPoolSessionBatchWithdraw.executeSelfSubmitBatch} to submit.
     *
     * @param params - The target asset, recipient, and PrivacyPoolRelay contract address.
     * @returns The ready-to-sign `relayBatch` transaction plus the aggregate spent/change notes.
     * @throws {BatchWithdrawBaseError}
     * @throws {PoolSessionKeystoreBaseError} If the spending account has no registered keystore ({@link KeystoreNotRegistered}) or the registration check fails.
     */
    prepareSelfSubmitBatch(
        params: SelfSubmitBatchParams<TAddress>,
    ): Promise<SelfSubmitBatchPrepareResult<TTx, TAddress>>;

    /**
     * Submits a prepared self-submit batch and, on success, persists the note-state changes.
     *
     * @param prepared - The result of {@link IPoolSessionBatchWithdraw.prepareSelfSubmitBatch}.
     * @returns The on-chain transaction receipt.
     * @throws {BatchWithdrawBaseError}
     */
    executeSelfSubmitBatch(prepared: SelfSubmitBatchPrepareResult<TTx, TAddress>): Promise<TxReceipt<TLog>>;
}
