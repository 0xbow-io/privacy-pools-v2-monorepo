import type { ZodType } from "zod";

import type {
    Address,
    ColdStartTransferParams,
    EVMProof,
    ExecuteTransferParams,
    FulfillPaymentRequestParams,
    GeneratePaymentRequestParams,
    Hash,
    Hex,
    IAddressFieldConverter,
    ICryptoService,
    IKeystoreInteractor,
    ILogger,
    INoteComputationService,
    IPaymentRequestService,
    IPoolSessionTransfer,
    IPreparedTxVerifier,
    IRelayerInteractor,
    ITxReceiptWaiter,
    ITransactOrchestrator,
    Note,
    PaymentRequest,
    PendingNote,
    PoolSessionTransferConfig,
    PoolSessionTransferDependencies,
    PreparedTransaction,
    PrepareTransactBase,
    PrepareTransactResult,
    PrepareTransferRelayerQuotes,
    PrepareTransferResult,
    RelayTransferParams,
    ResolvedTransferRecipient,
    Secret,
    TransactParams,
    TransferParams,
    TransferResult,
    TxLog,
    TxReceipt,
} from "../../internal.js";
import {
    assertFeeCommitmentLive,
    bigintToHex,
    EMPTY_ADDRESS,
    EMPTY_BYTES32,
    FulfillPaymentRequestParamsSchema,
    InvalidTransactParams,
    makePoolSessionTransferSchemas,
    PaymentRequestExpired,
    RecipientViewingKeyUnregistered,
    resolveRecipientViewingKey,
    settleTransferRelayerQuotes,
} from "../../internal.js";

/**
 * Orchestrates the transact flow for private transfers (amountOut = 0), generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and on-chain proof type `TProof`.
 *
 * A private transfer moves value between shielded notes inside the pool,
 * creating two output notes: one for the recipient and one for the sender's
 * remaining change. No funds leave the pool publicly.
 *
 * `executeTransfer` verifies the prepared transaction via the injected `preparedTxVerifier`
 * ({@link IPreparedTxVerifier}) rather than an EVM-only guard called directly. Note-hash
 * computation over the recipient's address routes through the injected `addressFieldConverter`
 * ({@link IAddressFieldConverter}) rather than a raw cast, matching PoolSessionDeposit/Ragequit.
 * `generatePaymentRequest`/
 * `prepareFulfillPaymentRequest` still take/return the concrete `PaymentRequest`/
 * `GeneratePaymentRequestParams`/`FulfillPaymentRequestParams` types — the payment-request
 * subsystem (`IPaymentRequestService`) stays EVM-only by the same "stays concretely typed by
 * design" boundary as `INoteComputationService`, not yet genericized.
 */
export class PoolSessionTransfer<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionTransfer<TTx, TAddress, TProof, TLog>
{
    private readonly ownerAddress: TAddress;
    private readonly core: ITransactOrchestrator<TTx, TAddress, TProof, TLog>;
    private readonly relayerInteractor: IRelayerInteractor<TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly cryptoService: ICryptoService;
    private readonly noteComputationService: INoteComputationService;
    private readonly keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    private readonly paymentRequestService: IPaymentRequestService;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly schemas: ReturnType<typeof makePoolSessionTransferSchemas<TAddress & string>>;
    private readonly logger?: ILogger;
    private hasWarnedDeprecatedNoteAddressHash = false;

    constructor(
        config: PoolSessionTransferConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionTransferDependencies,
    ) {
        this.core = config.core;
        this.relayerInteractor = config.relayerInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.cryptoService = config.cryptoService;
        this.noteComputationService = config.noteComputationService;
        this.keystoreInteractor = config.keystoreInteractor;
        this.paymentRequestService = config.paymentRequestService;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.addressFieldConverter = config.addressFieldConverter;
        this.ownerAddress = config.ownerAddress;
        this.schemas = makePoolSessionTransferSchemas(
            config.addressSchema as ZodType<TAddress & string>,
            EMPTY_ADDRESS as TAddress & string,
        );
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareColdStartTransfer
     * @throws {InvalidTransactParams} When the parameters fail validation.
     * @throws {TransactNoteNotActive} When an input note is not ACTIVE.
     * @throws {InsufficientTransactValue} When input notes don't cover the transfer amount.
     */
    async prepareColdStartTransfer(
        params: ColdStartTransferParams<TAddress>,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        const validated = this.schemas.coldStartTransferParamsSchema.safeParse(params);
        if (!validated.success) {
            throw new InvalidTransactParams(validated.error.issues[0].message);
        }

        const noteSecretsMap = this.generateNoteSecretsMap(
            params.inputCommitments,
            params.recipientEvmAddress,
        );
        const recipient: ResolvedTransferRecipient = {
            noteAddressHash: Array.from(noteSecretsMap.keys()),
            noteSecretsMap,
        };

        return this.buildPrepareTransferResult(params, recipient, params.recipientEvmAddress);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareTransfer
     * @throws {InvalidTransactParams} When the parameters fail validation.
     * @throws {TransactNoteNotActive} When an input note is not ACTIVE.
     * @throws {InsufficientTransactValue} When input notes don't cover the transfer amount.
     */
    async prepareTransfer(
        params: TransferParams<TAddress>,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        const validated = this.schemas.transferParamsSchema.safeParse(params);
        if (!validated.success) {
            throw new InvalidTransactParams(validated.error.issues[0].message);
        }

        const recipient = await this.resolveRecipient(params);

        return this.buildPrepareTransferResult(
            params,
            recipient,
            params.recipientDiscoveryData && "evmAddress" in params.recipientDiscoveryData
                ? params.recipientDiscoveryData.evmAddress
                : undefined,
        );
    }

    /**
     * @inheritdoc IPoolSessionTransfer.relayTransfer
     * @throws {PoolSessionTransactBaseError} When relay execution fails.
     */
    async relayTransfer(params: RelayTransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>> {
        // Fail fast on an already-expired quote, before the expensive runPrepareTransact below. The
        // relayer also rechecks at submission (catching expiry during proof gen).
        assertFeeCommitmentLive(params.selectedQuote.quote.feeCommitment.expiration);

        // The relayer's signed commitment must be for the transferred token, otherwise the proof
        // binds a commitment for a different asset. Mirrors relayWithdraw.
        // NOTE: feeCommitment.asset is a wire-protocol `Hex` field (always hex-encoded
        // regardless of chain), not `TAddress` — a plain string compare, not
        // addressEqualityComparator, until the relayer wire protocol itself is genericized.
        const quotedAsset = params.selectedQuote.quote.feeCommitment.asset;
        if (String(quotedAsset).toLowerCase() !== String(params.tokenId).toLowerCase()) {
            throw new InvalidTransactParams(
                `feeCommitment.asset ${quotedAsset} does not match transfer tokenId ${params.tokenId}`,
            );
        }

        // A relayed private transfer moves only the relayer's fee out of the pool (amountOut ==
        // feeAmount, paid to the processor — the recipient's value stays in a shielded note), so
        // unlike withdraw it needs no fee-processor contract to redeem/route a payout. Per
        // contracts-tech-design.md §4 ("User (or Relayer) calls transact(...) on PoolVault"
        // directly) and the relayer's own `simulateAndWriteRelayTransfer` (calls
        // `PoolVault.transact` with `processor: walletClient.account.address`, its own signer —
        // never `relayContractAddress()`), the on-chain `msg.sender` for a relayed transfer is
        // the relayer's own submitting address, not its withdrawal fee-processor contract.
        // `relayerInfo.processorAddress` ("Address of the relayer's fee processor contract")
        // is that withdrawal-only contract; using it here bakes a `processor` into the proof
        // context that the relayer's actual submission can never match, so PoolVault reverts
        // with `PoolVault_ProofContextMismatch()` even though `PoolVault_InvalidProcessor()`
        // itself would have passed (msg.sender does equal relayerInfo.address on submission).
        const transactParams: TransactParams<TAddress> = {
            processor: params.selectedQuote.relayerInfo.address,
            data: params.selectedQuote.quote.feeCommitment.data,
        };
        const feeAmount = bigintToHex(BigInt(params.selectedQuote.quote.feeCommitment.feeAmount));

        const transact = await this.runPrepareTransact(
            { ...params, feeAmount },
            params.recipient,
            transactParams,
            params.selectedQuote.relayerInfo.address,
            params.selectedQuote.relayerInfo.address,
        );

        const relayerResult = await this.relayerInteractor.relayTransfer(
            params.selectedQuote.relayerInfo,
            {
                signedFeeCommitment: params.selectedQuote.quote.feeCommitment,
                proof: transact.proof,
                noteData: transact.notesData,
                inputNullifierNumber: transact.spentNotes.length,
                outputCommitmentNumber:
                    transact.changePendingNotes.length + transact.recipientPendingNotes.length,
            },
        );

        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(relayerResult);
        return this.finalizeTransfer(
            transact.spentNotes,
            transact.spentNullifiers,
            transact.changePendingNotes,
            transact.recipientPendingNotes,
            txReceipt,
            params.recipient,
            params.recipientEvmAddress,
        );
    }

    /**
     * @inheritdoc IPoolSessionTransfer.transfer
     */
    async transfer(params: TransferParams<TAddress>): Promise<TransferResult<TAddress, TLog>> {
        const result = await this.prepareTransfer(params);
        return this.executeTransfer(result.executeOptions);
    }

    /**
     * @inheritdoc IPoolSessionTransfer.executeTransfer
     */
    async executeTransfer(
        opts: ExecuteTransferParams<TTx, TAddress>,
    ): Promise<TransferResult<TAddress, TLog>> {
        this.preparedTxVerifier.assertMatches(opts.transactTx, {
            to: this.core.poolAddress,
            operation: "transact",
        });
        const txHash = await this.core.submit(opts.transactTx);
        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        return this.finalizeTransfer(
            opts.spentNotes,
            opts.spentNullifiers,
            opts.changePendingNotes,
            opts.recipientPendingNotes,
            txReceipt,
            opts.recipient,
            opts.recipientEvmAddress,
        );
    }

    /**
     * @inheritdoc IPoolSessionTransfer.generatePaymentRequest
     * @throws {InvalidPaymentRequestParams} When parameters fail validation.
     */
    async generatePaymentRequest(params: GeneratePaymentRequestParams): Promise<PaymentRequest> {
        const record = await this.paymentRequestService.generate(params);
        return {
            paymentId: record.paymentId,
            noteAddressHashes: record.noteAddressHashes,
            amount: record.amount,
            tokenId: record.tokenId,
            tag: record.tag,
            paymentPubKey: record.paymentPubKey,
            // Carried, not dropped: this is the ONLY path that produces a shareable request, so
            // omitting the stamp here would silently make every request the SDK hands out
            // unexpirable to the sender (`undefined` means "predates the policy") while the
            // recipient still drops it from the scan set shortly after `expiresAt` — reintroducing
            // the invisible-payment loss #600 exists to prevent. Spread conditionally so a legacy
            // record with no stamp yields no key at all rather than an explicit `undefined`,
            // which would survive into the QR/link encoding as a spurious field.
            ...(record.expiresAt !== undefined ? { expiresAt: record.expiresAt } : {}),
        };
    }

    /**
     * @inheritdoc IPoolSessionTransfer.prepareFulfillPaymentRequest
     * @throws {InvalidTransactParams} When parameters fail validation.
     * @throws {PaymentRequestExpired} When the request's `expiresAt` has passed.
     */
    async prepareFulfillPaymentRequest(
        params: FulfillPaymentRequestParams,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        const validated = FulfillPaymentRequestParamsSchema.safeParse(params);
        if (!validated.success) {
            throw new InvalidTransactParams(validated.error.issues[0].message);
        }

        const { paymentRequest, inputCommitments, relayAddress, feeAmount, processorAddress } =
            validated.data;

        // Refuse a lapsed request before spending anything. The recipient drops an expired request
        // from its discovery scan set once its grace window elapses, so paying one risks producing a
        // note that is on-chain, valid, and invisible to them — a silent loss. Refusing at
        // `expiresAt` exactly, while the recipient scans past it, is what makes the grace a safety
        // margin rather than a disagreement. A request with no `expiresAt` predates expiry and
        // never lapses.
        if (paymentRequest.expiresAt !== undefined) {
            const nowMs = BigInt(Date.now());
            if (nowMs > BigInt(paymentRequest.expiresAt)) {
                throw new PaymentRequestExpired(paymentRequest.expiresAt, nowMs);
            }
        }

        return this.prepareTransfer({
            inputCommitments,
            amount: paymentRequest.amount,
            tokenId: paymentRequest.tokenId as TAddress,
            relayAddress: relayAddress as TAddress,
            feeAmount,
            processorAddress: processorAddress as TAddress,
            recipientDiscoveryData: {
                publicViewingKey: paymentRequest.paymentPubKey,
                noteAddressHashes: paymentRequest.noteAddressHashes,
                hint: paymentRequest.tag,
            },
        });
    }

    /**
     * Resolves the user-supplied recipient identity into the canonical
     * {@link ResolvedTransferRecipient} consumed by the orchestrator.
     *
     * For the `evmAddress` branch, an unregistered viewing key (returned as
     * `0x0` by the on-chain keystore mapping) throws
     * {@link RecipientViewingKeyUnregistered} by default. Callers can opt into
     * the silent out-of-band downgrade by setting
     * `recipientDiscoveryData.allowOutOfBandFallback = true`; when they do,
     * they are responsible for delivering `recipientNotes` to the recipient
     * — discarding them locks the funds permanently.
     * RPC errors propagate.
     */
    private async resolveRecipient(
        params: TransferParams<TAddress>,
    ): Promise<ResolvedTransferRecipient> {
        if (params.recipientNoteAddressHash) {
            this.warnDeprecatedNoteAddressHash();
            return { noteAddressHash: params.recipientNoteAddressHash };
        }

        if (params.recipientNoteAddressHashByLabel) {
            const noteAddressHashByLabel = params.recipientNoteAddressHashByLabel;
            return {
                noteAddressHash: Array.from(noteAddressHashByLabel.values()),
                noteAddressHashByLabel,
            };
        }

        const data = params.recipientDiscoveryData;

        if ("publicViewingKey" in data) {
            // Payment-request fulfillment: only the pre-committed noteAddressHash slots
            // are available — the secrets stay recipient-local. Resolves to the
            // discoverable-without-secrets variant (no noteSecretsMap).
            if ("noteAddressHashes" in data) {
                return {
                    noteAddressHash: data.noteAddressHashes,
                    publicViewingKey: data.publicViewingKey,
                    hint: data.hint,
                };
            }
            return {
                noteAddressHash: Array.from(data.noteSecretsMap.keys()),
                noteSecretsMap: data.noteSecretsMap,
                publicViewingKey: data.publicViewingKey,
                hint: data.hint,
            };
        }

        const noteSecretsMap =
            data.noteSecretsMap ??
            this.generateNoteSecretsMap(params.inputCommitments, data.evmAddress);
        // Verify each key == Poseidon(evmAddress, value). A mismatched pair
        // produces a commitment on-chain that the recipient cannot reconstruct
        // from the value alone — funds stranded with no recovery path. The
        // generator path above never mismatches; this check guards the
        // caller-supplied-map case.
        this.assertNoteSecretsMapBinding(noteSecretsMap, data.evmAddress);
        const noteAddressHash = Array.from(noteSecretsMap.keys());

        const resolved = await resolveRecipientViewingKey(
            data.evmAddress,
            this.keystoreInteractor,
            {
                allowOutOfBandFallback: data.allowOutOfBandFallback,
                onUnregistered: (evmAddress) => new RecipientViewingKeyUnregistered(`${evmAddress}`),
            },
        );

        if (resolved.kind === "outOfBand") {
            this.logger?.warn(
                "Recipient viewing key not registered — falling back to out-of-band (caller opted in)",
                { recipientEvmAddress: data.evmAddress },
            );
            return {
                noteAddressHash,
                noteSecretsMap,
            };
        }

        return {
            noteAddressHash,
            noteSecretsMap,
            publicViewingKey: resolved.publicViewingKey,
        };
    }

    /**
     * Emits a once-per-instance deprecation warning for the positional
     * `recipientNoteAddressHash: Hash[]` input. Callers should migrate to
     * {@link TransferParams.recipientNoteAddressHashByLabel}, which keys by
     * label name and removes the implicit-ordering footgun.
     */
    private warnDeprecatedNoteAddressHash(): void {
        if (this.hasWarnedDeprecatedNoteAddressHash) return;
        this.hasWarnedDeprecatedNoteAddressHash = true;
        this.logger?.warn(
            "TransferParams.recipientNoteAddressHash is deprecated — use recipientNoteAddressHashByLabel (Map<Label, Hash>) instead. The positional array silently misaligns recipient hashes when callers do not match the SDK's internal first-occurrence label iteration order.",
        );
    }

    /**
     * Single shared pipeline behind prepareTransfer and prepareColdStartTransfer:
     * fetches relayer quotes, runs the orchestrator, and bundles the executeOptions
     * + per-relayer relayOptions.
     */
    private async buildPrepareTransferResult(
        base: PrepareTransactBase<TAddress>,
        recipient: ResolvedTransferRecipient,
        recipientEvmAddress?: TAddress,
    ): Promise<PrepareTransferResult<TTx, TAddress>> {
        // Wait for the keystore + state-tree leaf caches to finish warming BEFORE
        // requesting the committed quote below — that's what starts the relayer's
        // short-lived commitment clock. Usually a no-op; only waits if a scan is
        // still genuinely in flight (same fix as PoolSessionReshieldCrosschain).
        await this.core.warmMerkleCaches();

        const quotes = await this.getTransferRelayerQuotes(base.tokenId);
        const transact = await this.runPrepareTransact(base, recipient);

        return {
            executeOptions: {
                transactTx: transact.transactTx,
                spentNotes: transact.spentNotes,
                spentNullifiers: transact.spentNullifiers,
                changePendingNotes: transact.changePendingNotes,
                recipientPendingNotes: this.enrichRecipientPendingNotes(
                    transact.recipientPendingNotes,
                    recipient,
                    recipientEvmAddress,
                ),
                recipient,
                recipientEvmAddress,
            },
            relayOptions: quotes.map((selectedQuote) => ({
                inputCommitments: base.inputCommitments,
                amount: base.amount,
                tokenId: base.tokenId,
                relayAddress: base.relayAddress,
                feeAmount: base.feeAmount,
                processorAddress: base.processorAddress,
                recipient,
                recipientEvmAddress,
                selectedQuote,
            })),
        };
    }

    /** Wraps {@link ITransactOrchestrator.prepareTransact} with shared default-resolution. */
    private async runPrepareTransact(
        base: PrepareTransactBase<TAddress>,
        recipient: ResolvedTransferRecipient,
        transactParams?: TransactParams<TAddress>,
        relayAddress?: TAddress,
        processorAddress?: TAddress,
    ): Promise<PrepareTransactResult<TTx, TAddress>> {
        const resolvedRelay = relayAddress ?? base.relayAddress ?? this.ownerAddress;
        const resolvedProcessor = processorAddress ?? base.processorAddress ?? this.ownerAddress;
        const feeAmount = base.feeAmount ?? ("0x0" as Hex);

        return this.core.prepareTransact({
            inputCommitments: base.inputCommitments,
            amount: base.amount,
            tokenId: base.tokenId,
            relayAddress: resolvedRelay,
            processorAddress: resolvedProcessor,
            recipientAddress: resolvedRelay,
            amountOut: feeAmount,
            feeAmount,
            transactParams,
            recipient,
        });
    }

    /**
     * Persists post-tx state and, when the recipient is non-blind, returns the
     * recipient notes enriched with the on-chain block timestamp so the caller
     * can deliver them out-of-band or hand them to {@link IPoolSessionExport.importReceivedNote}.
     */
    private async finalizeTransfer(
        spentNotes: Note<TAddress>[],
        spentNullifiers: Hex[],
        changePendingNotes: PendingNote<TAddress>[],
        recipientPendingNotes: PendingNote<TAddress>[],
        txReceipt: TxReceipt<TLog>,
        recipient: ResolvedTransferRecipient,
        recipientEvmAddress?: TAddress,
    ): Promise<TransferResult<TAddress, TLog>> {
        if (!txReceipt.status) return { txReceipt };

        // Verify-before-persist (AW-L-02 / #1070): confirm the confirmed receipt's PoolVault
        // `Transacted` logs actually consumed the spent nullifiers before marking the input
        // notes SPENT. Critical for the untrusted relayer path (relayTransfer), where a bogus
        // txHash would otherwise strand still-spendable notes. On a mismatch persistNoteUpdates
        // WARNs and persists nothing (never throws) — matching relayWithdraw/relayBatchWithdraw.
        // The verdict is now RETURNED as `spentNullifiersConfirmed` rather than swallowed:
        // skipping persistence protected our own note state, but the caller still received a
        // successful TransferResult and had no way to know this receipt was not its transfer.
        const spentNullifiersConfirmed = await this.core.persistNoteUpdates(
            spentNotes,
            changePendingNotes,
            txReceipt.txHash,
            {
                expectedNullifiers: spentNullifiers,
                receiptLogs: txReceipt.logs,
            },
        );

        if (!recipient.noteSecretsMap) return { txReceipt, spentNullifiersConfirmed };

        const enriched = this.enrichRecipientPendingNotes(
            recipientPendingNotes,
            recipient,
            recipientEvmAddress,
        );
        const recipientNotes = await this.core.prepareRecipientNotes(enriched, txReceipt.txHash);
        return { txReceipt, recipientNotes, spentNullifiersConfirmed };
    }

    /**
     * Decorates recipient pending notes with the noteSecret from the resolved recipient
     * and the supplied address (so an out-of-band recipient can import the note
     * with a valid `ownerAddress` for downstream flows like ragequit). No-op for the
     * blind variant (no `noteSecretsMap`).
     */
    private enrichRecipientPendingNotes(
        recipientPendingNotes: PendingNote<TAddress>[],
        recipient: ResolvedTransferRecipient,
        recipientEvmAddress?: TAddress,
    ): PendingNote<TAddress>[] {
        const noteSecretsMap = recipient.noteSecretsMap;
        if (!noteSecretsMap) return recipientPendingNotes;

        const ownerAddress = recipientEvmAddress ?? (EMPTY_ADDRESS as TAddress);

        return recipientPendingNotes.map((note) => ({
            ...note,
            isOwned: true,
            ownerAddress,
            noteSecret: noteSecretsMap.get(note.noteAddressHash) ?? EMPTY_BYTES32,
        }));
    }

    private getTransferRelayerQuotes = (
        tokenId: TAddress,
    ): Promise<PrepareTransferRelayerQuotes<TAddress>[]> =>
        settleTransferRelayerQuotes(
            this.relayerInteractor,
            { asset: tokenId, commit: true },
            this.logger,
        );

    /**
     * Throws when any (key, secret) pair in the supplied map does not satisfy
     * `key == Poseidon(evmAddress, secret)`. The recipient's discovery flow
     * recomputes the commitment from its decrypted secret; a mismatched map
     * would create on-chain commitments the recipient cannot spend.
     *
     * @throws {InvalidTransactParams} If any entry is mismatched.
     */
    private assertNoteSecretsMapBinding(
        noteSecretsMap: Map<Hash, Secret>,
        evmAddress: TAddress,
    ): void {
        for (const [providedHash, secret] of noteSecretsMap.entries()) {
            const expected = this.noteComputationService.computeNoteAddressHash(
                this.addressFieldConverter.toField(evmAddress),
                secret,
            );
            if (BigInt(expected) !== BigInt(providedHash)) {
                throw new InvalidTransactParams(
                    `noteSecretsMap key ${providedHash} does not equal Poseidon(${evmAddress}, secret)`,
                );
            }
        }
    }

    private generateNoteSecretsMap(
        inputCommitments: Hash[],
        evmAddress: TAddress,
    ): Map<Hash, Secret> {
        return new Map(
            inputCommitments.map(() => {
                const noteSecret = this.cryptoService.generateSecret();
                const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
                    this.addressFieldConverter.toField(evmAddress),
                    noteSecret,
                );
                return [noteAddressHash, noteSecret] as [Hash, Secret];
            }),
        );
    }
}
