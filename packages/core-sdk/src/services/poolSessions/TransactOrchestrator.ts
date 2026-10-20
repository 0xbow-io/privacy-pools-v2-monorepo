import type {
    Address,
    BuildTransactWitnessInputs,
    EVMProof,
    Hash,
    Hex,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    IASPClient,
    IContextHashService,
    ICryptoService,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPayoutRoutingCodec,
    IPoolVaultInteractor,
    IProofService,
    IRelayBatchCodec,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    Label,
    Note,
    NoteData,
    PendingNote,
    PreparedTransaction,
    PrepareTransactParams,
    PrepareTransactResult,
    RelayBatchEncodeItem,
    RelayBatchItem,
    ResolvedTransferRecipient,
    SpentNoteVerification,
    TransactOrchestratorConfig,
    TransactOrchestratorDependencies,
    TransactParams,
    TransactProof,
    TxLog,
} from "../../internal.js";
import {
    assertKeystoreRegistered,
    bigintToHex,
    EMPTY_ADDRESS,
    EMPTY_BYTES32,
    groupByLabel,
    InsufficientTransactValue,
    InvalidPoolSessionTransactConfig,
    InvalidTransactParams,
    ITransactOrchestrator,
    makeTransactOrchestratorConfigSchema,
    MAX_INPUTS,
    MIN_INPUTS,
    NoteStatus,
    resolveCommitmentTimestamp,
    TransactNoteNotActive,
} from "../../internal.js";

/**
 * Shared infrastructure used by both {@link PoolSessionTransfer} and
 * {@link PoolSessionWithdraw}. Owns all dependencies that either flow needs
 * and exposes the common operations as methods. The two flow classes depend
 * only on a TransactOrchestrator instance plus their flow-specific relayer.
 *
 * Generic over the chain's prepared-transaction type `TTx`, address type `TAddress`, and
 * on-chain proof type `TProof`. Its calls into `INoteComputationService`/
 * `IWitnessPreparationService` (which stay concretely typed by design — see
 * `PoolSessionDeposit`'s class doc for why) go through the injected `addressFieldConverter`
 * ({@link IAddressFieldConverter}) rather than a raw cast.
 */
export class TransactOrchestrator<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements ITransactOrchestrator<TTx, TAddress, TProof, TLog>
{
    readonly ownerAddress: TAddress;
    readonly poolAddress: TAddress;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly keystoreManager: IKeystoreManager;
    private readonly witnessPreparationService: IWitnessPreparationService;
    private readonly proofService: IProofService<TProof>;
    private readonly keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    private readonly aspClient: IASPClient;
    private readonly cryptoService: ICryptoService;
    private readonly noteComputationService: INoteComputationService;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly contextHashService: IContextHashService<TAddress>;
    private readonly payoutRoutingCodec: IPayoutRoutingCodec<TAddress>;
    private readonly relayBatchCodec: IRelayBatchCodec<TTx, TAddress, TProof>;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidPoolSessionTransactConfig} When the config is invalid.
     */
    constructor(
        config: TransactOrchestratorConfig<TTx, TAddress, TProof, TLog>,
        deps?: TransactOrchestratorDependencies,
    ) {
        const configSchema = makeTransactOrchestratorConfigSchema(config.addressSchema);
        const validated = configSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidPoolSessionTransactConfig(validated.error.issues[0].message);
        }

        this.ownerAddress = config.ownerAddress;
        this.poolAddress = config.poolVaultInteractor.getAddress();
        this.noteManager = config.noteManager;
        this.keystoreManager = config.keystoreManager;
        this.witnessPreparationService = config.witnessPreparationService;
        this.proofService = config.proofService;
        this.keystoreInteractor = config.keystoreInteractor;
        this.poolVaultInteractor = config.poolVaultInteractor;
        this.aspClient = config.aspClient;
        this.cryptoService = config.cryptoService;
        this.noteComputationService = config.noteComputationService;
        this.rpcInteractor = config.rpcInteractor;
        this.contextHashService = config.contextHashService;
        this.payoutRoutingCodec = config.payoutRoutingCodec;
        this.relayBatchCodec = config.relayBatchCodec;
        this.addressFieldConverter = config.addressFieldConverter;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.logger = deps?.logger;
    }

    /** Submits a prepared transaction to the PoolVault. */
    async submit(tx: TTx): Promise<Hash> {
        return this.poolVaultInteractor.submitTransaction(tx);
    }

    /** @inheritdoc ITransactOrchestrator.warmMerkleCaches */
    async warmMerkleCaches(): Promise<void> {
        await Promise.all([
            this.keystoreInteractor.getKeystoreLeaves(),
            this.poolVaultInteractor.getStateLeaves(),
        ]);
    }

    /**
     * Unified transact pipeline used by both transfer and withdraw flows.
     * Resolves inputs, builds output notes, generates the witness + proof, and
     * returns everything the caller needs for submission and deferred persistence.
     *
     * Recipient noteData is encrypted and published only when
     * `params.recipient?.kind === "discoverable"`. `blind` and `outOfBand` produce
     * the same on-chain footprint (no recipient Note event).
     *
     * @throws {KeystoreNotRegistered} When the owner has no registered keystore and the call is not a
     *   register-and-withdraw bundle (`pendingKeystoreRegistration`). Registered accounts whose session
     *   keys still miss the tree fail later, in witness building.
     * @throws {RegistrationCheckFailed} When the on-chain registration read fails.
     */
    async prepareTransact(
        params: PrepareTransactParams<TAddress>,
    ): Promise<PrepareTransactResult<TTx, TAddress>> {
        const {
            inputCommitments,
            amount,
            tokenId,
            relayAddress,
            processorAddress,
            feeAmount,
            transactParams,
            amountOut,
            recipient,
            recipientAddress,
            nativeGas,
            feeRecipient,
            pendingKeystoreRegistration,
        } = params;
        const totalSpent = BigInt(amount) + BigInt(feeAmount);

        this.logger?.debug("Preparing transact", {
            inputCommitments,
            amount,
            hasRecipient: !!recipient,
            recipientDiscoverable: !!recipient?.publicViewingKey,
        });

        const { inputNotes } = this.resolveAndValidateTransactInputs(
            inputCommitments,
            bigintToHex(totalSpent),
            tokenId,
        );

        const { changeNotes, recipientNotes } = this.getTransactOutputNotes(
            inputNotes,
            amount,
            feeAmount,
            tokenId,
            recipient,
        );

        const computedTransactParams =
            transactParams ??
            this.getTransactParams({
                recipient: recipientAddress,
                feeRecipient: feeRecipient ?? relayAddress,
                processorAddress,
                feeAmount: BigInt(feeAmount),
                nativeGas: BigInt(nativeGas ?? "0x0"),
            });

        const notesData = this.buildNotesData(changeNotes, recipientNotes, tokenId, recipient);

        const nInputs = inputNotes.length;
        const mOutputs = changeNotes.length + recipientNotes.length;

        // A register-and-withdraw bundle proves against the predicted post-registration root, so its
        // owner is legitimately not on-chain yet; every other spend needs a registered keystore.
        if (!pendingKeystoreRegistration) {
            await assertKeystoreRegistered(this.keystoreInteractor, this.ownerAddress);
        }

        const [stateLeaves, keystoreLeaves, aspLeaves] = await this.fetchMerkleLeaves();
        const privateNullifyingKey = this.keystoreManager.getPrivateNullifyingKey();
        const privateRevocableKey = this.keystoreManager.getPrivateRevocableKey();
        const context = this.computeTransactContext(computedTransactParams, notesData);

        // Internal transfers (amountOut == 0) must encode tokenIdOut as the zero
        // address: PoolVault.transact reverts with `PoolVault_TokenIdMustBeZeroOnInternalTransfer`
        // when amountOut is 0 and tokenIdOut != address(0) (PoolVault.sol:188).
        const isInternalTransfer = BigInt(amountOut) === 0n;
        const witnessInputs: BuildTransactWitnessInputs = {
            inputNotes: inputNotes as Note[],
            changeNotes: changeNotes as PendingNote[],
            recipientNotes: recipientNotes as PendingNote[],
            ownerAddress: this.addressFieldConverter.toField(this.ownerAddress),
            privateNullifyingKey,
            privateRevocableKey,
            tokenId: this.addressFieldConverter.toTokenIdField(tokenId),
            amountOut,
            tokenIdOut: isInternalTransfer
                ? EMPTY_ADDRESS
                : this.addressFieldConverter.toTokenIdField(tokenId),
            context,
            stateLeaves,
            keystoreLeaves,
            aspLeaves,
            pendingKeystoreRegistration,
        };

        const { transactTx, proof } = await this.buildWitnessAndProve(
            witnessInputs,
            nInputs,
            mOutputs,
            computedTransactParams,
            notesData,
            tokenId,
            // A register-and-withdraw proof is anchored to a keystore root that only exists once
            // the bundled registration lands: nothing can simulate it before then.
            pendingKeystoreRegistration !== undefined,
        );

        // The proof's leading `nInputs` public signals ARE the spent notes' nullifier
        // hashes. Capture them here (parallel to `spentNotes`) so a downstream persist can
        // verify the confirmed receipt actually consumed them before marking SPENT
        // (AW-L-02 / #1070) — the Note type does not itself carry the nullifier hash.
        const spentNullifiers = proof.publicSignals
            .slice(0, nInputs)
            .map((signal) => bigintToHex(BigInt(signal)));

        return {
            changePendingNotes: changeNotes,
            recipientPendingNotes: recipientNotes,
            transactTx,
            spentNotes: inputNotes,
            spentNullifiers,
            notesData,
            proof,
        };
    }

    /**
     * @inheritdoc ITransactOrchestrator.persistNoteUpdates
     */
    async persistNoteUpdates(
        spentNotes: Note<TAddress>[],
        pendingOutputNotes: PendingNote<TAddress>[],
        txHash: Hash,
        verification: SpentNoteVerification<TLog>,
    ): Promise<boolean> {
        // Verify-before-persist (AW-L-02 / #1070): every caller persists on the strength of a
        // relayer/self-supplied receipt, so confirm the receipt's PoolVault-emitted `Transacted`
        // logs actually consumed every spent nullifier. A relayer that returns the hash of an
        // unrelated successful tx would otherwise make the wallet mark still-spendable notes
        // SPENT. On a mismatch we WARN and persist nothing rather than throw: a hard gate could
        // strand a genuinely-spent note whose logs are merely unparseable (e.g. a proxied call),
        // whereas discoverNotes() reconciles a real spend.
        //
        // `verification` is REQUIRED. It was optional, which made this check fail-OPEN — the
        // relayed swap paths (withdraw-and-swap, reshield) omitted it and persisted SPENT on an
        // unverified relayer txHash. Since SPENT is terminal, that corruption is unrecoverable.
        // Belt-and-braces for callers TypeScript cannot police (plain-JS consumers, `as any`
        // dispatch, a downstream package compiled against the older .d.ts). Treat a missing
        // argument the same as a failed verification — warn and persist nothing — rather than
        // dereferencing `undefined` and throwing after the spend has already confirmed.
        if (!verification) {
            this.logger?.warn(
                "Skipping note SPENT persistence — persistNoteUpdates was called without the " +
                    "required receipt verification. Relying on discoverNotes() as the backstop.",
                { txHash },
            );
            return false;
        }

        if (!this.receiptConfirmsSpentNullifiers(verification, txHash)) {
            return false;
        }

        for (const note of spentNotes) {
            this.noteManager.updateNoteStatus(note.commitment, NoteStatus.SPENT);
        }

        for (const pending of pendingOutputNotes) {
            const commitmentTimeStamp = await resolveCommitmentTimestamp(
                this.poolVaultInteractor,
                pending.commitment,
                { logger: this.logger },
            );

            // Tx already succeeded; if the storage read glitches we skip
            // local persistence rather than store a 0x0 timestamp (which
            // would silently break ragequit / transact witnesses). The note
            // is encrypted to the sender's viewing key so discoverNotes()
            // will recover it on the next scan.
            if (commitmentTimeStamp === null) {
                this.logger?.warn("Skipping note persistence — commitment timestamp unresolved", {
                    commitment: pending.commitment,
                    txHash,
                });
                continue;
            }

            this.noteManager.addNote({
                ...pending,
                noteSecret: pending.noteSecret!,
                status: NoteStatus.ACTIVE,
                createdAtBlock: commitmentTimeStamp,
                spentAtBlock: null,
                txHash,
            });
        }

        // Flush the in-memory SPENT/ACTIVE changes to storage before returning. Without this the
        // updates live only in memory: if the process exits right after a successful spend, the
        // next start reads the old state, treats a spent note as ACTIVE, and the re-spend reverts
        // on-chain (nullifier already consumed). Callers await this for that durability.
        await this.noteManager.flush();
        return true;
    }

    async prepareRecipientNotes(
        recipientNotes: PendingNote<TAddress>[],
        txHash: Hash,
    ): Promise<Note<TAddress>[]> {
        const resolved = await Promise.all(
            recipientNotes.map(async (note): Promise<Note<TAddress> | null> => {
                const timestamp = await resolveCommitmentTimestamp(
                    this.poolVaultInteractor,
                    note.commitment,
                    { logger: this.logger },
                );

                if (timestamp === null) {
                    this.logger?.warn(
                        "Dropping recipient note from result — commitment timestamp unresolved",
                        { commitment: note.commitment, txHash },
                    );
                    return null;
                }

                return {
                    ...note,
                    createdAtBlock: timestamp,
                    spentAtBlock: null,
                    txHash,
                };
            }),
        );

        return resolved.filter((n): n is Note<TAddress> => n !== null);
    }

    /**
     * @inheritdoc ITransactOrchestrator.encodeRelayBatch
     */
    async encodeRelayBatch(relayAddress: TAddress, items: RelayBatchItem<TAddress>[], asset: TAddress): Promise<TTx> {
        // Each item's raw proof is reshaped into the on-chain `TransactProof` tuple exactly
        // as `encodeTransact` does for a single transact — `relayBatch` takes the array form.
        const encodeItems: RelayBatchEncodeItem<TAddress, TProof>[] = items.map((item) => ({
            proof: this.proofService.formatForChain(item.proof),
            pubSignals: this.restructureTransactPubSignals(item.proof, item.nInputs, item.mOutputs),
            transactParams: item.transactParams,
            noteData: item.noteData,
        }));

        return this.relayBatchCodec.encodeRelayBatch(relayAddress, encodeItems, asset);
    }

    /**
     * Parses the confirmed receipt's PoolVault-emitted `Transacted` logs and checks that
     * every expected spent nullifier was actually consumed (AW-L-02 / #1070). Returns true
     * when all are present; on any miss it logs a warning identifying the unconfirmed
     * nullifiers and returns false so the caller skips persistence (verify-and-WARN, not a
     * hard gate — see {@link persistNoteUpdates}).
     */
    private receiptConfirmsSpentNullifiers(
        verification: SpentNoteVerification<TLog>,
        txHash: Hash,
    ): boolean {
        const confirmed = new Set(
            this.poolVaultInteractor
                .extractSpentNullifiers(verification.receiptLogs)
                .map((nullifier) => nullifier.toLowerCase()),
        );

        const unconfirmed = verification.expectedNullifiers.filter(
            (nullifier) => !confirmed.has(nullifier.toLowerCase()),
        );

        if (unconfirmed.length > 0) {
            this.logger?.warn(
                "Skipping note SPENT persistence — the confirmed receipt's PoolVault Transacted " +
                    "logs did not consume the expected nullifiers (possible bogus/unrelated relayer " +
                    "txHash). Relying on discoverNotes() as the backstop.",
                { txHash, unconfirmed, confirmedCount: confirmed.size },
            );
            return false;
        }

        return true;
    }

    /**
     * Builds the on-chain noteData array. Sender's change notes are always encrypted to
     * the sender's own viewing key. Recipient notes are encrypted only when the resolved
     * recipient carries a `publicViewingKey` (the discoverable variant).
     */
    private buildNotesData(
        changeNotes: PendingNote<TAddress>[],
        recipientNotes: PendingNote<TAddress>[],
        tokenId: TAddress,
        recipient: ResolvedTransferRecipient | undefined,
    ): NoteData[] {
        const senderViewingKey = this.keystoreManager.getViewingKeyPair().publicKey;
        const tokenIdField = this.addressFieldConverter.toTokenIdField(tokenId);

        const changeNotesData = changeNotes.map((note) =>
            this.noteComputationService.generateNoteData(
                {
                    noteSecret: note.noteSecret,
                    value: note.value,
                    tokenId: tokenIdField,
                    label: note.label,
                },
                senderViewingKey,
            ),
        );

        if (!recipient?.publicViewingKey) return changeNotesData;

        // Payment-request fulfillment (discoverable-without-secrets): the sender never
        // holds the noteSecret. Emit a v2 payload carrying the pre-committed
        // noteAddressHash; the recipient reconstructs the secret from its local map.
        if (!recipient.noteSecretsMap) {
            const recipientNotesData = recipientNotes.map((note) =>
                this.noteComputationService.generatePaymentRequestNoteData(
                    {
                        noteAddressHash: note.noteAddressHash,
                        value: note.value,
                        tokenId: tokenIdField,
                        label: note.label,
                    },
                    recipient.publicViewingKey,
                    recipient.hint,
                ),
            );
            return changeNotesData.concat(recipientNotesData);
        }

        const recipientNotesData = recipientNotes.map((note) =>
            this.noteComputationService.generateNoteData(
                {
                    noteSecret: recipient.noteSecretsMap.get(note.noteAddressHash)!,
                    value: note.value,
                    tokenId: tokenIdField,
                    label: note.label,
                },
                recipient.publicViewingKey,
                recipient.hint,
            ),
        );

        return changeNotesData.concat(recipientNotesData);
    }

    /**
     * Validates input commitment dimensions up-front, dedups, and fetches each
     * note asserting ACTIVE status.
     *
     * Dimension bounds are enforced before any witness/Merkle work — previously
     * `ProofService.proveTransact` rejected oversized inputs *after* the
     * orchestrator had already built per-input state and ASP Merkle proofs,
     * letting an attacker burn CPU on duplicated/oversized arrays before
     * hitting the cheap bounds check (M-2 / line 157). Duplicate commitments
     * are likewise rejected at the boundary: PoolVault enforces nullifier
     * uniqueness on-chain, so any pair of duplicates is guaranteed to revert,
     * but the SDK was happy to build the witness first.
     */
    private resolveAndValidateInputNotes(commitments: Hash[]): Note<TAddress>[] {
        if (commitments.length < MIN_INPUTS || commitments.length > MAX_INPUTS) {
            throw new InvalidTransactParams(
                `inputCommitments length ${commitments.length} out of range [${MIN_INPUTS}, ${MAX_INPUTS}]`,
            );
        }
        const seen = new Set<string>();
        for (const commitment of commitments) {
            const key = commitment.toLowerCase();
            if (seen.has(key)) {
                throw new InvalidTransactParams(
                    `Duplicate inputCommitment ${commitment} — nullifier reuse would revert on-chain`,
                );
            }
            seen.add(key);
        }
        const notes: Note<TAddress>[] = [];
        for (const commitment of commitments) {
            const note = this.noteManager.getNote(commitment);
            if (note.status !== NoteStatus.ACTIVE) {
                throw new TransactNoteNotActive(commitment);
            }
            notes.push(note);
        }
        return notes;
    }

    /** Fetches state, keystore, and ASP leaves in parallel. */
    private async fetchMerkleLeaves(): Promise<[Hex[], Hex[], Hex[]]> {
        this.logger?.debug("Fetching on-chain data for witness");
        return Promise.all([
            this.poolVaultInteractor.getStateLeaves(),
            this.keystoreInteractor.getKeystoreLeaves(),
            this.aspClient.getAssociationSetLeaves(),
        ]);
    }

    /**
     * Resolves input commitments to notes, verifies sufficient value, and verifies
     * a single tokenId across the input set.
     */
    private resolveAndValidateTransactInputs(
        inputCommitments: Hash[],
        amount: Hex,
        tokenId: TAddress,
    ): { inputNotes: Note<TAddress>[]; totalInputValue: bigint } {
        const inputNotes = this.resolveAndValidateInputNotes(inputCommitments);
        const totalInputValue = this.computeTotalNoteValue(inputNotes);
        const notesTokenId = this.getNotesTokenId(inputNotes);

        if (totalInputValue < BigInt(amount)) {
            throw new InsufficientTransactValue(`0x${totalInputValue.toString(16)}`, amount);
        }

        if (!this.addressEqualityComparator.equals(notesTokenId, tokenId)) {
            throw new InvalidTransactParams(
                `Input notes have tokenId ${notesTokenId} but transact tokenId is ${tokenId}`,
            );
        }

        return { inputNotes, totalInputValue };
    }

    /**
     * Builds a transact witness, generates a ZK proof, formats it for the chain, and
     * encodes the transact calldata.
     */
    private async buildWitnessAndProve(
        witnessInputs: BuildTransactWitnessInputs,
        nInputs: number,
        mOutputs: number,
        transactParams: TransactParams<TAddress>,
        noteData: NoteData[],
        asset: TAddress,
        deferSimulation = false,
    ): Promise<{ proof: TransactProof; transactTx: TTx }> {
        this.logger?.debug("Building transact witness", { nInputs, mOutputs });

        const witness = await this.witnessPreparationService.buildTransactWitness(witnessInputs);

        this.logger?.debug("Generating transact proof", { nInputs, mOutputs });

        const proof = await this.proofService.proveTransact(witness, nInputs, mOutputs);

        const formattedProof = this.proofService.formatForChain(proof);
        const transactPubSignals = this.restructureTransactPubSignals(proof, nInputs, mOutputs);
        const transactTx = await this.poolVaultInteractor.encodeTransact(
            formattedProof,
            transactPubSignals,
            transactParams,
            noteData,
            asset,
            { deferSimulation },
        );

        return { proof, transactTx };
    }

    private getTransactOutputNotes(
        inputNotes: Note<TAddress>[],
        amount: Hex,
        feeAmount: Hex,
        tokenId: TAddress,
        recipient: ResolvedTransferRecipient | undefined,
    ): { changeNotes: PendingNote<TAddress>[]; recipientNotes: PendingNote<TAddress>[] } {
        const changeNotes: PendingNote<TAddress>[] = [];
        const recipientNotes: PendingNote<TAddress>[] = [];
        const notesByLabel = groupByLabel(inputNotes);
        let remainingSentAmount = BigInt(amount);
        let remainingTotalAmount = BigInt(amount) + BigInt(feeAmount);

        const recipientNoteSecretsMap = recipient?.noteSecretsMap;
        const hashByLabel = this.resolveHashByLabel(recipient, notesByLabel);

        for (const [label, notes] of notesByLabel) {
            const totalLabelValue = this.computeTotalNoteValue(notes);
            const deductAmount =
                remainingTotalAmount >= totalLabelValue ? totalLabelValue : remainingTotalAmount;
            const sentAmount =
                remainingSentAmount >= totalLabelValue ? totalLabelValue : remainingSentAmount;
            const changeValue = totalLabelValue - deductAmount;
            const noteAddressHash = hashByLabel?.get(label);

            changeNotes.push(this.generatePendingNote(tokenId, label, bigintToHex(changeValue)));
            if (noteAddressHash && remainingSentAmount > 0n) {
                recipientNotes.push(
                    this.generatePendingNote(
                        tokenId,
                        label,
                        bigintToHex(sentAmount),
                        noteAddressHash,
                        recipientNoteSecretsMap,
                    ),
                );
                remainingSentAmount -= sentAmount;
            }

            remainingTotalAmount -= deductAmount;
        }

        // Defensive: if a recipient was supplied at all, the input set must
        // cover the requested amount via recipient outputs.
        if (hashByLabel && remainingSentAmount > 0n) {
            throw new InvalidTransactParams(
                `Transfer truncated: ${remainingSentAmount} units of amount could not be assigned to a recipient note. This indicates the input commitments do not provide enough value at recipient-mapped labels.`,
            );
        }

        return { changeNotes, recipientNotes };
    }

    /**
     * Normalises the recipient's hash material into a single `Map<Label, Hash>`
     * keyed by label name, regardless of whether the caller supplied the new
     * `noteAddressHashByLabel` Map or the deprecated positional `noteAddressHash`
     * array.
     *
     * - **New path:** requires strict keyset equality with the unique labels
     *   in `notesByLabel` (no missing entries, no extras).
     * - **Deprecated path:** preserves the historical first-occurrence
     *   iteration order by zipping the positional array against
     *   `notesByLabel`'s key order. The previous strict-`>` length guard is
     *   preserved (throws when fewer hashes than unique labels).
     */
    private resolveHashByLabel(
        recipient: ResolvedTransferRecipient | undefined,
        notesByLabel: Map<Label, Note<TAddress>[]>,
    ): Map<Label, Hash> | undefined {
        if (!recipient) return undefined;

        const uniqueLabels = [...notesByLabel.keys()];

        if (recipient.noteAddressHashByLabel) {
            const provided = recipient.noteAddressHashByLabel;
            for (const label of uniqueLabels) {
                if (!provided.has(label)) {
                    throw new InvalidTransactParams(
                        `recipientNoteAddressHashByLabel missing entry for input label ${label}`,
                    );
                }
            }
            for (const label of provided.keys()) {
                if (!notesByLabel.has(label)) {
                    throw new InvalidTransactParams(
                        `recipientNoteAddressHashByLabel contains label ${label} not present in input commitments`,
                    );
                }
            }
            return provided;
        }

        const hashes = recipient.noteAddressHash;
        if (!hashes || hashes.length === 0) return undefined;

        if (hashes.length < uniqueLabels.length) {
            throw new InvalidTransactParams(
                `Too few noteAddressHashes for recipient notes: ${uniqueLabels.length} > ${hashes.length}`,
            );
        }
        return new Map(uniqueLabels.map((label, i) => [label, hashes[i]]));
    }

    private generatePendingNote(
        tokenId: TAddress,
        label: Label,
        value: Hex,
        noteAddressHash?: Hash,
        recipientNoteSecretsMap?: Map<Hash, Hex>,
    ): PendingNote<TAddress> {
        const noteSecret = this.cryptoService.generateSecret();
        const computedNoteAddressHash =
            noteAddressHash ??
            this.noteComputationService.computeNoteAddressHash(
                this.addressFieldConverter.toField(this.ownerAddress),
                noteSecret,
            );
        const commitment = this.noteComputationService.computeFullCommitment({
            noteAddressHash: computedNoteAddressHash,
            value,
            tokenId: this.addressFieldConverter.toTokenIdField(tokenId),
            label,
        });

        if (!noteAddressHash) {
            return {
                noteAddressHash: computedNoteAddressHash,
                commitment,
                value,
                tokenId,
                label,
                isOwned: true,
                noteSecret,
                ownerAddress: this.ownerAddress,
                status: NoteStatus.PENDING,
            };
        }

        const recipientNoteSecret = this.resolveRecipientNoteSecret(
            computedNoteAddressHash,
            recipientNoteSecretsMap,
        );

        return {
            noteAddressHash: computedNoteAddressHash,
            commitment,
            value,
            tokenId,
            label,
            isOwned: false,
            ownerAddress: EMPTY_ADDRESS as TAddress,
            status: NoteStatus.PENDING,
            noteSecret: recipientNoteSecret,
        };
    }

    /**
     * Resolves the `noteSecret` field for a recipient's pending note.
     *
     * - Blind variant supplies no map: the recipient owns the secret
     *   out-of-band and the SDK never sees it. `EMPTY_BYTES32` is the
     *   documented placeholder.
     * - Non-blind variants (outOfBand / discoverable) must carry an entry
     *   for every computed hash. A miss means the supplied (hashes, map)
     *   are inconsistent and the recipient note would be unspendable —
     *   throw loudly instead of silently substituting `EMPTY_BYTES32`.
     *
     * @throws {InvalidTransactParams} When a `noteSecretsMap` is supplied
     *     but does not contain the requested hash.
     */
    private resolveRecipientNoteSecret(
        noteAddressHash: Hash,
        recipientNoteSecretsMap: Map<Hash, Hex> | undefined,
    ): Hex {
        if (recipientNoteSecretsMap === undefined) return EMPTY_BYTES32;

        const found = recipientNoteSecretsMap.get(noteAddressHash);
        if (found === undefined) {
            throw new InvalidTransactParams(
                `noteSecretsMap is missing an entry for noteAddressHash ${noteAddressHash} — supplied (hashes, map) are inconsistent`,
            );
        }
        return found;
    }

    private computeTotalNoteValue(notes: Note<TAddress>[]): bigint {
        return notes.reduce((sum, note) => sum + BigInt(note.value), 0n);
    }

    private getNotesTokenId(notes: Note<TAddress>[]): TAddress {
        const tokenId = notes.reduce((tokenId: TAddress | null, note: Note<TAddress>) => {
            if (tokenId === null) {
                return note.tokenId;
            }

            // One account's notes can spell the same token differently (EVM: checksummed
            // on one note, lowercase on another), and raw equality made those notes
            // unspendable together. The chain's own comparator decides what "same" means.
            if (!this.addressEqualityComparator.equals(note.tokenId, tokenId)) {
                throw new InvalidTransactParams(
                    `All input notes must have the same tokenId. Found mismatch: ${tokenId} vs ${note.tokenId}`,
                );
            }

            return tokenId;
        }, null);

        if (tokenId === null) {
            throw new InvalidTransactParams("No notes provided to determine token ID");
        }

        return tokenId;
    }

    /**
     * Encodes the PayoutRouting tuple into TransactParams.processor/data. Layout
     * matches `IPrivacyPoolRelay.PayoutRouting` (recipient, feeRecipient,
     * feeAmount, nativeGas) so PrivacyPoolRelay.relay can decode it.
     */
    private getTransactParams(args: {
        recipient: TAddress;
        feeRecipient: TAddress;
        processorAddress: TAddress;
        feeAmount: bigint;
        nativeGas: bigint;
    }): TransactParams<TAddress> {
        const payoutRoutingData = this.payoutRoutingCodec.encode({
            recipient: args.recipient,
            feeRecipient: args.feeRecipient,
            feeAmount: args.feeAmount,
            nativeGas: args.nativeGas,
        });

        return {
            processor: args.processorAddress,
            data: payoutRoutingData,
        };
    }

    private computeTransactContext(
        transactParams: TransactParams<TAddress>,
        noteData: NoteData[],
    ): Hex {
        return this.contextHashService.computeTransactContext(transactParams, noteData);
    }

    /**
     * Restructures flat public signals from the transact proof into a 2D array
     * matching the on-chain struct layout: [nullifiers, outputCommitments, stateRoot,
     * keystoreRoot, associationSetRoot, amountOut, tokenIdOut, context].
     */
    private restructureTransactPubSignals(
        proofResult: TransactProof,
        nInputs: number,
        mOutputs: number,
    ): bigint[][] {
        const { publicSignals } = proofResult;

        const nullifiers = publicSignals.slice(0, nInputs).map((s) => BigInt(s));
        const outputCommitments = publicSignals
            .slice(nInputs, nInputs + mOutputs)
            .map((s) => BigInt(s));
        const pubInputBase = nInputs + mOutputs;
        const stateRoot = BigInt(publicSignals[pubInputBase]);
        const keystoreRoot = BigInt(publicSignals[pubInputBase + 1]);
        const associationSetRoot = BigInt(publicSignals[pubInputBase + 2]);
        const amountOut = BigInt(publicSignals[pubInputBase + 3]);
        const tokenIdOut = BigInt(publicSignals[pubInputBase + 4]);
        const context = BigInt(publicSignals[pubInputBase + 5]);

        return [
            nullifiers,
            outputCommitments,
            [stateRoot],
            [keystoreRoot],
            [associationSetRoot],
            [amountOut],
            [tokenIdOut],
            [context],
        ];
    }
}
