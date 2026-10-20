import type {
    Address,
    BatchWithdrawSessionParams,
    IBatchWithdrawOrchestrator,
    ILogger,
    INoteManager,
    IPoolSessionBatchWithdraw,
    IRelayerInteractor,
    ITxReceiptWaiter,
    PoolSessionBatchWithdrawConfig,
    PoolSessionBatchWithdrawDependencies,
    PreparedTransaction,
    PrepareBatchWithdrawResult,
    RelayerInfo,
    SelfSubmitBatchParams,
    SelfSubmitBatchPrepareResult,
    TxLog,
    TxReceipt,
} from "../../internal.js";
import {
    assertFeeCommitmentLive,
    BatchTooLarge,
    MAX_BATCH,
    MAX_INPUTS,
    NoteStatus,
    RelayerRequestFailed,
    selectNotesForFullWithdraw,
} from "../../internal.js";

/**
 * Session-level entry for full-balance batch withdrawals — the batch analog of
 * {@link PoolSessionWithdraw}. Generic over the chain's prepared-transaction type `TTx`,
 * address type `TAddress`, and raw receipt-log type `TLog`. No `TProof` — proof formatting is
 * fully encapsulated inside the injected orchestrator/core, never touched by this class
 * directly.
 *
 * `prepareBatchWithdraw` partitions the asset's active balance into per-transact
 * groups, requests ONE aggregate quote from a relayer, and hands the relayer's
 * signed `PayoutRouting[]` to the {@link IBatchWithdrawOrchestrator} so each
 * item's proof binds the relayer-authoritative fee split. Unlike
 * {@link PoolSessionWithdraw} (whose proofs are relayer-agnostic until relay
 * time), a batch's proofs are bound to a single quote at prepare time, so the
 * selected relayer and quote are returned for `relayBatchWithdraw` to submit.
 */
export class PoolSessionBatchWithdraw<
    TTx = PreparedTransaction,
    TAddress = Address,
    TLog = TxLog,
> implements IPoolSessionBatchWithdraw<TTx, TAddress, TLog>
{
    private readonly orchestrator: IBatchWithdrawOrchestrator<TTx, TAddress, TLog>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly logger?: ILogger;

    constructor(
        config: PoolSessionBatchWithdrawConfig<TTx, TAddress, TLog>,
        deps?: PoolSessionBatchWithdrawDependencies,
    ) {
        this.orchestrator = config.orchestrator;
        this.noteManager = config.noteManager;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.prepareBatchWithdraw
     * @throws {EmptyBatchSelection} When the asset has no active notes to withdraw.
     * @throws {BatchTooLarge} When the selection needs more transacts than MAX_BATCH.
     * @throws {BatchRoutingMismatch} When the quote's PayoutRouting[] length does not match the note groups.
     * @throws {BatchRoutingInvalid} When a routing's recipient or feeAmount does not fit its paired note group.
     * @throws {RelayerRequestFailed} When no relayer is available to quote the batch.
     * @throws {FeeCommitmentExpired} When the relayer returns an already-expired quote.
     */
    async prepareBatchWithdraw(
        params: BatchWithdrawSessionParams<TAddress>,
    ): Promise<PrepareBatchWithdrawResult<TAddress>> {
        const { tokenId, recipientAddress } = params;

        // Partition the balance ONCE: the same groups drive the quote `amounts`
        // and are handed to the orchestrator, so amounts[i] lines up with the group
        // the relayer's routings[i] is paired against — and the balance cannot shift
        // between quoting and proving (review QUALITY-2).
        const notes = this.noteManager.getNotes({ status: NoteStatus.ACTIVE, tokenId });
        const groups = selectNotesForFullWithdraw({
            notes,
            tokenId: tokenId as string,
            maxInputs: MAX_INPUTS,
        });

        // Fail fast before the relayer round-trip: an oversized selection is always
        // rejected by the orchestrator (and the on-chain relayBatch cap), so quoting
        // it first would waste a network request on a doomed batch (review BW-1).
        if (groups.length > MAX_BATCH) {
            throw new BatchTooLarge(groups.length, MAX_BATCH);
        }

        const amounts = groups.map((group) => group.amountOut.toString());

        const relayer = await this.selectRelayer();

        // Wait for the keystore + state-tree leaf caches to finish warming BEFORE
        // requesting the committed quote below — that's what starts the relayer's
        // short-lived commitment clock. Usually a no-op; only waits if a scan is
        // still genuinely in flight (same fix as PoolSessionReshieldCrosschain).
        await this.orchestrator.warmMerkleCaches();

        const quote = await this.relayerInteractor.getBatchWithdrawalQuote(relayer, {
            asset: tokenId,
            commit: true,
            recipient: recipientAddress,
            extraGas: false,
            amounts,
        });

        // Fail fast on an already-expired quote before the expensive proof loop.
        assertFeeCommitmentLive(quote.feeCommitment.expiration);

        const prepared = await this.orchestrator.prepareBatchWithdraw({
            tokenId,
            recipientAddress,
            relayAddress: relayer.processorAddress,
            quote,
            groups,
        });

        return { ...prepared, relayerInfo: relayer, quote };
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.relayBatchWithdraw
     * @throws {FeeCommitmentExpired} When the signed batch quote expired before submission.
     * @throws {RelayerRejected} When the relayer rejects the batch.
     */
    async relayBatchWithdraw(params: PrepareBatchWithdrawResult<TAddress>): Promise<TxReceipt<TLog>> {
        const { relayerInfo, quote, items, spentNotes, spentNullifiers, changePendingNotes } =
            params;

        // Recheck expiry here too: the quote may lapse during proof generation.
        assertFeeCommitmentLive(quote.feeCommitment.expiration);

        const txHash = await this.relayerInteractor.relayBatchWithdrawal(relayerInfo, {
            items: items.map((item) => ({
                proof: item.proof,
                noteData: item.noteData,
                inputNullifierNumber: item.inputNullifierNumber,
                outputCommitmentNumber: item.outputCommitmentNumber,
            })),
            signedBatchFeeCommitment: quote.feeCommitment,
        });

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (!txReceipt.status) return txReceipt;

        await this.orchestrator.persistBatchNoteUpdates(
            spentNotes,
            changePendingNotes,
            txReceipt.txHash,
            { expectedNullifiers: spentNullifiers, receiptLogs: txReceipt.logs },
        );

        return txReceipt;
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.selfSubmitBatchWithdraw
     * @throws {EmptyBatchSelection} When the asset has no active notes to withdraw.
     * @throws {BatchTooLarge} When the selection needs more transacts than MAX_BATCH.
     */
    async selfSubmitBatchWithdraw(params: SelfSubmitBatchParams<TAddress>): Promise<TxReceipt<TLog>> {
        const prepared = await this.prepareSelfSubmitBatch(params);
        return this.executeSelfSubmitBatch(prepared);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.prepareSelfSubmitBatch
     * @throws {EmptyBatchSelection} When the asset has no active notes to withdraw.
     * @throws {BatchTooLarge} When the selection needs more transacts than MAX_BATCH.
     */
    async prepareSelfSubmitBatch(
        params: SelfSubmitBatchParams<TAddress>,
    ): Promise<SelfSubmitBatchPrepareResult<TTx, TAddress>> {
        return this.orchestrator.prepareSelfSubmitBatch(params);
    }

    /**
     * @inheritdoc IPoolSessionBatchWithdraw.executeSelfSubmitBatch
     */
    async executeSelfSubmitBatch(
        prepared: SelfSubmitBatchPrepareResult<TTx, TAddress>,
    ): Promise<TxReceipt<TLog>> {
        const txHash = await this.orchestrator.submitSelfSubmitBatch(prepared);
        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (!txReceipt.status) return txReceipt;

        await this.orchestrator.persistBatchNoteUpdates(
            prepared.spentNotes,
            prepared.changePendingNotes,
            txReceipt.txHash,
            {
                expectedNullifiers: prepared.spentNullifiers,
                receiptLogs: txReceipt.logs,
            },
        );

        return txReceipt;
    }

    /**
     * Resolves a relayer to sign and submit the batch, preferring an active one.
     *
     * @throws {RelayerRequestFailed} When no relayer is configured.
     */
    private async selectRelayer(): Promise<RelayerInfo<TAddress>> {
        const relayers = await this.relayerInteractor.getRelayers();
        const relayer = relayers.find((candidate) => candidate.status === "active") ?? relayers[0];
        if (!relayer) {
            this.logger?.error("No relayer available for batch withdrawal");
            throw new RelayerRequestFailed("No relayer available for batch withdrawal");
        }
        return relayer;
    }
}
