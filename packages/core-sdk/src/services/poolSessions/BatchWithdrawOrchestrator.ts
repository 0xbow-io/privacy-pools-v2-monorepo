import type {
    Address,
    BatchPrepareResult,
    BatchWithdrawItem,
    BatchWithdrawOrchestratorConfig,
    BatchWithdrawOrchestratorDependencies,
    BatchWithdrawParams,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IBatchWithdrawOrchestrator,
    ILogger,
    INoteManager,
    IPayoutRoutingCodec,
    IPreparedTxVerifier,
    ITransactOrchestrator,
    Note,
    PendingNote,
    PreparedTransaction,
    RelayBatchItem,
    SelfSubmitBatchParams,
    SelfSubmitBatchPrepareResult,
    SpentNoteVerification,
    TransactParams,
    TxLog,
} from "../../internal.js";
import {
    BatchRoutingInvalid,
    BatchRoutingMismatch,
    BatchTooLarge,
    bigintToHex,
    computeBatchItemFee,
    EMPTY_ADDRESS,
    EmptyBatchSelection,
    MAX_BATCH,
    MAX_INPUTS,
    NoteStatus,
    selectNotesForFullWithdraw,
} from "../../internal.js";

/**
 * Orchestrates full-balance batch withdrawals, generic over the chain's prepared-transaction
 * type `TTx`, address type `TAddress`, and on-chain proof type `TProof`. Reuses the shared
 * {@link ITransactOrchestrator} per item — each note group becomes one
 * independent withdraw transact (full withdrawal, zero-value change).
 *
 * The fee split is RELAYER-AUTHORITATIVE: the relayer's signed batch quote
 * carries the whole `PayoutRouting[]` (ABI-encoded in `feeCommitment.data`), and
 * this orchestrator decodes it and binds each item's routing into that item's
 * proof `context`. It does not compute the split itself.
 *
 * `prepareBatchWithdraw` never mutates local note state; persistence is deferred
 * to `persistBatchNoteUpdates`, called once after on-chain confirmation.
 *
 * The `PayoutRouting[]` array-decode of the relayer's batch fee commitment goes through the
 * injected `payoutRoutingCodec`'s {@link IPayoutRoutingCodec.decodeArray}, so a chain-specific
 * codec owns the batch-shaped decode the same way {@link IPayoutRoutingCodec.decode} owns the
 * single-item shape.
 */
export class BatchWithdrawOrchestrator<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IBatchWithdrawOrchestrator<TTx, TAddress, TLog>
{
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly emptyAddress: TAddress;
    private readonly logger?: ILogger;

    constructor(
        config: BatchWithdrawOrchestratorConfig<TTx, TAddress, TProof, TLog>,
        deps?: BatchWithdrawOrchestratorDependencies,
    ) {
        this.core = config.core;
        this.noteManager = config.noteManager;
        this.payoutRoutingCodec = config.payoutRoutingCodec;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.emptyAddress = config.emptyAddress ?? (EMPTY_ADDRESS as unknown as TAddress);
        this.logger = deps?.logger;
    }

    /** @inheritdoc IBatchWithdrawOrchestrator.warmMerkleCaches */
    async warmMerkleCaches(): Promise<void> {
        await this.core.warmMerkleCaches();
    }

    /**
     * @inheritdoc IBatchWithdrawOrchestrator.prepareBatchWithdraw
     * @throws {EmptyBatchSelection} When the asset has no active notes to withdraw.
     * @throws {BatchTooLarge} When the selection needs more transacts than MAX_BATCH.
     * @throws {BatchRoutingMismatch} When the quote's PayoutRouting[] length does not match the note groups.
     * @throws {BatchRoutingInvalid} When a routing's recipient differs, or its feeAmount does not equal the recomputed single-tx fee.
     * @throws {InfeasibleBatchFee} When a group's recomputed single-tx fee exceeds its own amountOut.
     */
    async prepareBatchWithdraw(
        params: BatchWithdrawParams<TAddress>,
    ): Promise<BatchPrepareResult<TAddress>> {
        const { tokenId, recipientAddress, relayAddress, quote } = params;

        // Reuse the caller's selection when provided (the session computes it once to
        // derive quote amounts, then passes it here) so the balance is partitioned a
        // single time — avoids a re-selection TOCTOU across the async quote fetch
        // (review QUALITY-2). Falls back to selecting for direct orchestrator callers.
        const groups =
            params.groups ??
            selectNotesForFullWithdraw({
                notes: this.noteManager.getNotes({ status: NoteStatus.ACTIVE, tokenId }),
                tokenId: tokenId as string,
                maxInputs: MAX_INPUTS,
            });

        // Preserve the empty-selection contract for callers that supply a precomputed
        // `groups` array: the auto-select path throws EmptyBatchSelection when there are
        // no active notes, but an explicitly-passed `[]` would otherwise slip past the
        // 0-vs-0 routing-length match and TypeError on `routings[0]` below.
        if (groups.length === 0) {
            throw new EmptyBatchSelection(tokenId as string);
        }

        if (groups.length > MAX_BATCH) {
            throw new BatchTooLarge(groups.length, MAX_BATCH);
        }

        // Relayer-authoritative fee split: decode the whole PayoutRouting[] the
        // relayer signed into the batch fee commitment. One routing per note
        // group, in the same selection order the amounts were quoted in.
        const routings = this.payoutRoutingCodec.decodeArray(quote.feeCommitment.data);
        if (routings.length !== groups.length) {
            throw new BatchRoutingMismatch(routings.length, groups.length);
        }

        // The SIGNED fee-model parameters. The SDK recomputes each item's fee from
        // these and asserts the relayer's routing charged exactly that. A greedy
        // relayer that re-concentrates the fee (e.g. loads the whole batch fee onto
        // one item so it can cherry-pick that proof via the single relay() escape
        // hatch) produces routings that no longer match the recomputed split.
        const relayCost = BigInt(quote.feeCommitment.relayCost);
        const feeBps = BigInt(quote.feeCommitment.feeBps);
        const flatFee = BigInt(quote.feeCommitment.flatFee);
        const maxRelayFee = BigInt(quote.feeCommitment.maxRelayFee);

        this.logger?.debug("Preparing batch withdraw", {
            tokenId,
            groupCount: groups.length,
            totalFee: quote.totalFee,
        });

        const items: BatchWithdrawItem<TAddress>[] = [];
        const spentNotes: Note<TAddress>[] = [];
        const spentNullifiers: Hex[] = [];
        const changePendingNotes: PendingNote<TAddress>[] = [];
        let totalAmountOut = 0n;
        let totalFee = 0n;

        // Cross-item routing consistency, validated UP FRONT before any proof is built: the contract
        // requires every batch item to share one recipient and one feeRecipient
        // (PrivacyPoolRelay_InconsistentRecipient). A divergent one would otherwise only surface as an
        // opaque on-chain revert after N proofs are generated — exactly what this pre-check pre-empts.
        const expectedFeeRecipient = routings[0].feeRecipient;
        for (let i = 0; i < groups.length; i++) {
            const routing = routings[i];
            if (!this.addressEqualityComparator.equals(routing.recipient, recipientAddress)) {
                throw new BatchRoutingInvalid(
                    i,
                    `routing recipient ${routing.recipient} does not match requested recipient ${recipientAddress}`,
                );
            }
            if (!this.addressEqualityComparator.equals(routing.feeRecipient, expectedFeeRecipient)) {
                throw new BatchRoutingInvalid(
                    i,
                    `routing feeRecipient ${routing.feeRecipient} is not consistent across the batch (item 0 uses ${expectedFeeRecipient})`,
                );
            }
        }

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            const routing = routings[i];
            // Recompute-and-verify the per-item fee: the relayer signs each routing, but a greedy or
            // tampered feeAmount would otherwise only surface as an opaque on-chain revert after N
            // proofs are generated. Recompute the fair single-tx fee from the SIGNED fee model and
            // assert the routing charged exactly that.
            const expectedFee = computeBatchItemFee({
                relayCost,
                feeBps,
                flatFee,
                amountOut: group.amountOut,
                maxRelayFee,
            });
            if (routing.feeAmount !== expectedFee) {
                throw new BatchRoutingInvalid(
                    i,
                    `routing feeAmount ${routing.feeAmount} does not match the recomputed single-tx fee ${expectedFee}`,
                );
            }
            const feeAmount = routing.feeAmount;
            const nativeGas = bigintToHex(routing.nativeGas);
            // Re-encode the relayer's per-item routing exactly as decoded so the
            // proof context binds recipient, feeRecipient, feeAmount and nativeGas.
            const transactParams = this.buildPayoutRoutingParams(
                routing.recipient,
                routing.feeRecipient,
                relayAddress,
                feeAmount,
                routing.nativeGas,
            );

            const result = await this.core.prepareTransact({
                inputCommitments: group.inputCommitments,
                tokenId,
                amount: bigintToHex(group.amountOut - feeAmount),
                amountOut: bigintToHex(group.amountOut),
                feeAmount: bigintToHex(feeAmount),
                recipientAddress,
                relayAddress,
                processorAddress: relayAddress,
                transactParams,
                nativeGas,
            });

            items.push({
                proof: result.proof,
                transactParams,
                noteData: result.notesData,
                amountOut: bigintToHex(group.amountOut),
                feeAmount: bigintToHex(feeAmount),
                inputNullifierNumber: group.inputCommitments.length,
                outputCommitmentNumber: result.changePendingNotes.length,
            });

            spentNotes.push(...result.spentNotes);
            spentNullifiers.push(...result.spentNullifiers);
            changePendingNotes.push(...result.changePendingNotes);
            totalAmountOut += group.amountOut;
            totalFee += feeAmount;
        }

        return {
            items,
            totalAmountOut: bigintToHex(totalAmountOut),
            totalFee: bigintToHex(totalFee),
            spentNotes,
            spentNullifiers,
            changePendingNotes,
        };
    }

    /**
     * @inheritdoc IBatchWithdrawOrchestrator.persistBatchNoteUpdates
     * @throws {NoteManagerBaseError} When a note status transition or store operation fails.
     */
    async persistBatchNoteUpdates(
        spentNotes: Note<TAddress>[],
        changePendingNotes: PendingNote<TAddress>[],
        txHash: Hash,
        verification: SpentNoteVerification<TLog>,
    ): Promise<void> {
        await this.core.persistNoteUpdates(spentNotes, changePendingNotes, txHash, verification);
    }

    /**
     * @inheritdoc IBatchWithdrawOrchestrator.prepareSelfSubmitBatch
     * @throws {EmptyBatchSelection} When the asset has no active notes to withdraw.
     * @throws {BatchTooLarge} When the selection needs more transacts than MAX_BATCH.
     */
    async prepareSelfSubmitBatch(
        params: SelfSubmitBatchParams<TAddress>,
    ): Promise<SelfSubmitBatchPrepareResult<TTx, TAddress>> {
        const { tokenId, recipientAddress, relayContractAddress } = params;

        const groups =
            params.groups ??
            selectNotesForFullWithdraw({
                notes: this.noteManager.getNotes({ status: NoteStatus.ACTIVE, tokenId }),
                tokenId: tokenId as string,
                maxInputs: MAX_INPUTS,
            });

        // Preserve the empty-selection contract for callers that supply a precomputed
        // `groups` array: an explicitly-passed `[]` would otherwise silently produce an
        // empty relayBatch instead of the EmptyBatchSelection the auto-select path throws.
        if (groups.length === 0) {
            throw new EmptyBatchSelection(tokenId as string);
        }

        if (groups.length > MAX_BATCH) {
            throw new BatchTooLarge(groups.length, MAX_BATCH);
        }

        this.logger?.debug("Preparing self-submit batch", { tokenId, groupCount: groups.length });

        const items: RelayBatchItem<TAddress>[] = [];
        const spentNotes: Note<TAddress>[] = [];
        const spentNullifiers: Hex[] = [];
        const changePendingNotes: PendingNote<TAddress>[] = [];

        for (const group of groups) {
            // Self-submit pays NO relayer fee: zero feeAmount, empty feeRecipient (irrelevant
            // when no fee is taken), zero nativeGas. Each item is a full withdrawal of its group
            // to the user's own recipient address, and the zero fee trivially clears the on-chain
            // relayBatch fee caps. The routing is bound into the proof context exactly as the
            // relayed path does, so relayBatch's homogeneity + fee checks pass.
            const transactParams = this.buildPayoutRoutingParams(
                recipientAddress,
                this.emptyAddress,
                relayContractAddress,
                0n,
                0n,
            );

            const result = await this.core.prepareTransact({
                inputCommitments: group.inputCommitments,
                tokenId,
                amount: bigintToHex(group.amountOut),
                amountOut: bigintToHex(group.amountOut),
                feeAmount: bigintToHex(0n),
                recipientAddress,
                relayAddress: relayContractAddress,
                processorAddress: relayContractAddress,
                transactParams,
                nativeGas: bigintToHex(0n),
            });

            items.push({
                proof: result.proof,
                transactParams,
                noteData: result.notesData,
                nInputs: group.inputCommitments.length,
                mOutputs: result.changePendingNotes.length,
            });
            spentNotes.push(...result.spentNotes);
            spentNullifiers.push(...result.spentNullifiers);
            changePendingNotes.push(...result.changePendingNotes);
        }

        const relayBatchTx = await this.core.encodeRelayBatch(relayContractAddress, items, tokenId);
        return {
            relayBatchTx,
            relayContractAddress,
            spentNotes,
            spentNullifiers,
            changePendingNotes,
        };
    }

    /**
     * @inheritdoc IBatchWithdrawOrchestrator.submitSelfSubmitBatch
     */
    async submitSelfSubmitBatch(
        prepared: SelfSubmitBatchPrepareResult<TTx, TAddress>,
    ): Promise<Hash> {
        // Checks what the wallet is about to sign, as the single-transact submit sites do
        // (`PoolSessionWithdraw.executeWithdraw`, `PoolSessionTransfer.executeTransfer`).
        // Prepare and submit are separate public steps, and a `SelfSubmitBatchPrepareResult` is
        // a plain data object that can be serialized, stored and carried between them, so
        // without this the calldata reaching the wallet is whatever the caller hands over.
        this.preparedTxVerifier.assertMatches(prepared.relayBatchTx, {
            to: prepared.relayContractAddress,
            operation: "relayBatch",
        });
        return this.core.submit(prepared.relayBatchTx);
    }

    /**
     * Encodes the PayoutRouting tuple into TransactParams.processor/data, matching
     * `IPrivacyPoolRelay.PayoutRouting` (recipient, feeRecipient, feeAmount,
     * nativeGas) exactly as PoolSessionWithdraw / TransactOrchestrator do, so the
     * relay contract can decode each item's routing.
     */
    private buildPayoutRoutingParams(
        recipient: TAddress,
        feeRecipient: TAddress,
        processor: TAddress,
        feeAmount: bigint,
        nativeGas: bigint,
    ): TransactParams<TAddress> {
        const data = this.payoutRoutingCodec.encode({
            recipient,
            feeRecipient,
            feeAmount,
            nativeGas,
        });

        return { processor, data };
    }
}
