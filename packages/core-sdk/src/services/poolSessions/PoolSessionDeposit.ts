import type {
    Address,
    ASPCipherTextPayload,
    AssetConfig,
    DepositForParams,
    DepositInternalParams,
    DepositParams,
    EVMProof,
    Hex,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    IASPClient,
    IContextHashService,
    ICryptoService,
    IEntrypointInteractor,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPoolSessionDeposit,
    IPoolVaultInteractor,
    IPreparedTxVerifier,
    IProofService,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    NoteDataBuilder,
    NoteDataBuilderInput,
    PendingNote,
    PoolSessionDepositConfig,
    PoolSessionDepositDependencies,
    PrepareDepositResult,
    PreparedTransaction,
    TxLog,
    TxReceipt,
} from "../../internal.js";
import {
    AssetNotEnabled,
    BelowMinimumAmount,
    bigintToHex,
    DepositRecipientViewingKeyUnregistered,
    EMPTY_ADDRESS,
    EMPTY_BYTES32,
    EMPTY_NOTE_DATA,
    encodeASPCipherText,
    InvalidDepositParams,
    InvalidPoolSessionConfig,
    makePoolSessionDepositSchemas,
    NATIVE_ASSET_ADDRESS,
    NoteStatus,
    PoolSessionDepositBaseError,
    resolveCommitmentTimestamp,
    resolveRecipientViewingKey,
    UnexpectedTransactionTarget,
} from "../../internal.js";
import { planApprovals } from "../../utils/Erc20Approval.js";

/**
 * Default implementation of {@link IPoolSessionDeposit}, generic over the chain's
 * prepared-transaction type `TTx`, address type `TAddress`, and on-chain proof type `TProof`.
 * Chain-specific mechanics live in the injected interactors/`contextHashService`; this class
 * owns the deposit pipeline itself (witness building, proof generation, note bookkeeping).
 *
 * `executeDeposit`/`assertApprovalTx` verify prepared transactions via the injected
 * `preparedTxVerifier` ({@link IPreparedTxVerifier}) rather than calling an EVM-only guard
 * directly — a Stellar variant supplies its own XDR-shaped implementation of that interface.
 *
 * `INoteComputationService`/`IWitnessPreparationService` still take a concrete `Address` for
 * owner/token fields (not `TAddress`) — by design, per the SDK's key-derivation notes: the
 * Poseidon-hash layer expects an already field-sized `Hex`, which EVM addresses already are.
 * Calls into these methods go through the injected `addressFieldConverter`
 * ({@link IAddressFieldConverter}) rather than a raw cast, so a non-hex `TAddress` (e.g.
 * Stellar's StrKey) has an explicit, chain-owned conversion step to plug into.
 */
export class PoolSessionDeposit<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionDeposit<TTx, TAddress, TProof, TLog>
{
    private readonly ownerAddress: TAddress;
    private readonly cryptoService: ICryptoService;
    private readonly witnessPreparationService: IWitnessPreparationService;
    private readonly proofService: IProofService<TProof>;
    private readonly entrypointInteractor: IEntrypointInteractor<TTx, TAddress, TProof>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly aspClient: IASPClient;
    private readonly keystoreManager: IKeystoreManager;
    private readonly noteComputationService: INoteComputationService;
    private readonly keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly contextHashService: IContextHashService<TAddress>;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly schemas: ReturnType<typeof makePoolSessionDepositSchemas<TAddress>>;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidPoolSessionConfig} When the owner or entrypoint address is invalid.
     */
    constructor(
        config: PoolSessionDepositConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionDepositDependencies,
    ) {
        this.schemas = makePoolSessionDepositSchemas(config.addressSchema);

        const validated = this.schemas.poolSessionDepositConfigSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidPoolSessionConfig(validated.error.issues[0].message);
        }

        this.ownerAddress = config.ownerAddress;
        this.cryptoService = config.cryptoService;
        this.witnessPreparationService = config.witnessPreparationService;
        this.proofService = config.proofService;
        this.entrypointInteractor = config.entrypointInteractor;
        this.noteManager = config.noteManager;
        this.aspClient = config.aspClient;
        this.keystoreManager = config.keystoreManager;
        this.noteComputationService = config.noteComputationService;
        this.keystoreInteractor = config.keystoreInteractor;
        this.poolVaultInteractor = config.poolVaultInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.contextHashService = config.contextHashService;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.addressFieldConverter = config.addressFieldConverter;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionDeposit.prepareDeposit
     * @throws {InvalidDepositParams} When tokenId or value fails validation.
     * @throws {AssetNotEnabled} When the asset is disabled in the Entrypoint config.
     * @throws {BelowMinimumAmount} When the deposit amount is below the configured minimum.
     * @throws {DepositWitnessFailed} When witness building fails.
     * @throws {DepositProofFailed} When proof generation fails.
     * @throws {AllowanceCheckFailed} When the ERC-2 allowance check fails.
     */
    async prepareDeposit(params: DepositParams<TAddress>): Promise<PrepareDepositResult<TTx, TAddress>> {
        const validatedParams = this.schemas.depositParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new InvalidDepositParams(validatedParams.error.issues[0].message);
        }

        const { tokenId, value } = params;
        const noteSecret = this.cryptoService.generateSecret();

        const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
            this.addressFieldConverter.toField(this.ownerAddress),
            noteSecret,
        );

        const viewingKeyPair = this.keystoreManager.getViewingKeyPair();

        const result = await this.prepareDepositInternal({
            tokenId,
            value,
            noteAddressHash,
            noteSecret,
            publicViewingKey: viewingKeyPair.publicKey,
            ownerAddress: this.ownerAddress,
        });

        return {
            ...result,
            pendingNote: { ...result.pendingNote, isOwned: true },
        };
    }

    /**
     * @inheritdoc IPoolSessionDeposit.prepareDepositFor
     * @throws {InvalidDepositParams} When params fail validation.
     * @throws {AssetNotEnabled} When the asset is disabled in the Entrypoint config.
     * @throws {BelowMinimumAmount} When the deposit amount is below the configured minimum.
     * @throws {DepositWitnessFailed} When witness building fails.
     * @throws {DepositProofFailed} When proof generation fails.
     * @throws {AllowanceCheckFailed} When the ERC-20 allowance check fails.
     * @throws {DepositRecipientViewingKeyUnregistered} When `discoveryData.evmAddress` has no
     *   registered viewing key and `allowOutOfBandFallback` was not set.
     */
    async prepareDepositFor(
        params: DepositForParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        const validatedParams = this.schemas.depositForParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new InvalidDepositParams(validatedParams.error.issues[0].message);
        }

        const resolvedParams = await this.resolveDepositForParams(params);
        const result = await this.prepareDepositInternal(resolvedParams);

        // Out-of-band fallback is the only path that resolves a noteSecret without a
        // publicViewingKey (see resolveDepositForParams): the blind noteAddressHash path never
        // carries a noteSecret, and the publicViewingKey discoveryData variant always carries both.
        if (resolvedParams.noteSecret && !resolvedParams.publicViewingKey) {
            return { ...result, noteSecret: resolvedParams.noteSecret };
        }

        return result;
    }

    /**
     * @inheritdoc IPoolSessionDeposit.deposit
     */
    async deposit(params: DepositParams<TAddress>): Promise<TxReceipt<TLog>> {
        const result = await this.prepareDeposit(params);
        return this.executeDeposit(result);
    }

    /**
     * @inheritdoc IPoolSessionDeposit.executeDeposit
     */
    async executeDeposit(result: PrepareDepositResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        // In order: a zero reset first on a residual allowance (Tether-style tokens), then
        // the real approval. Results built by an older SDK carry only `approvalTx`.
        // Every approval the result names is validated and submitted: `approvalTxs` in order,
        // plus a legacy/single `approvalTx` when it is not already one of them — so a tampered
        // copy in either field is caught, never silently skipped.
        // Chain-generic `TTx` has no `to`/`data` to compare, so identity is its serialized form.
        const identity = (tx: TTx): string =>
            JSON.stringify(tx, (_key, value: unknown) =>
                typeof value === "bigint" ? value.toString() : value,
            );
        const approvals = [
            ...(result.approvalTxs ?? []),
            ...(result.approvalTx ? [result.approvalTx] : []),
        ].filter((tx, i, all) => all.findIndex((o) => identity(o) === identity(tx)) === i);
        // Validate everything before signing anything: a tampered transaction must never be
        // preceded by a genuine one already on-chain — approvals and the deposit alike.
        for (const approvalTx of approvals) {
            this.assertApprovalTx(approvalTx, result.pendingNote.tokenId);
        }
        this.preparedTxVerifier.assertMatches(result.depositTx, {
            to: this.entrypointInteractor.getAddress(),
            operation: "deposit",
        });
        for (const approvalTx of approvals) {
            const approvalHash = await this.entrypointInteractor.submitTransaction(approvalTx);
            const approvalReceipt =
                await this.rpcInteractor.waitForTransactionReceipt(approvalHash);
            if (!approvalReceipt.status) {
                throw new PoolSessionDepositBaseError("ERC-20 approval transaction reverted");
            }
        }

        const txHash = await this.entrypointInteractor.submitTransaction(result.depositTx);
        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (txReceipt.status && result.pendingNote.isOwned) {
            const blockTimestamp = await resolveCommitmentTimestamp(
                this.poolVaultInteractor,
                result.pendingNote.commitment,
                { logger: this.logger },
            );

            if (blockTimestamp === null) {
                // Deposit succeeded on-chain but the storage read for the
                // commitment's block.timestamp glitched (RPC inconsistency or
                // reorg window). The noteData payload was encrypted to the
                // sender's own viewing key, so a future discoverNotes() call
                // will pick the note up. Skip local persistence rather than
                // store a 0x0 timestamp, which would silently break ragequit
                // / transact witnesses (computeTimestampedLeaf hashes
                // commitment ‖ timestamp into the state-tree leaf).
                this.logger?.warn(
                    "Deposit succeeded but commitment timestamp could not be resolved; " +
                        "note not persisted locally — discoverNotes() will recover it",
                    {
                        commitment: result.pendingNote.commitment,
                        txHash: txReceipt.txHash,
                    },
                );
            } else {
                this.noteManager.addNote({
                    ...result.pendingNote,
                    noteSecret: result.pendingNote.noteSecret!,
                    status: NoteStatus.PENDING,
                    createdAtBlock: blockTimestamp,
                    spentAtBlock: null,
                    txHash: txReceipt.txHash,
                });
            }
        }

        return txReceipt;
    }

    /**
     * @inheritdoc IPoolSessionDeposit.depositFor
     * @throws {InvalidDepositParams} When `discoveryData.allowOutOfBandFallback` is set — this
     *   one-shot method returns only a `TxReceipt`, with no channel to hand back a recovered
     *   `noteSecret` if the fallback fires. Use `prepareDepositFor` + `executeDeposit` instead
     *   and deliver `PrepareDepositResult.noteSecret` yourself.
     */
    async depositFor(params: DepositForParams<TAddress>): Promise<TxReceipt<TLog>> {
        if (
            params.discoveryData &&
            "evmAddress" in params.discoveryData &&
            params.discoveryData.allowOutOfBandFallback
        ) {
            throw new InvalidDepositParams(
                "depositFor() cannot honor allowOutOfBandFallback — it returns only a TxReceipt, " +
                    "with no channel to hand back a recovered noteSecret. Use prepareDepositFor() " +
                    "+ executeDeposit() and deliver PrepareDepositResult.noteSecret yourself.",
            );
        }

        const result = await this.prepareDepositFor(params);
        return this.executeDeposit(result);
    }

    /**
     * Shared deposit pipeline used by both self-deposit and deposit-for flows.
     * Computes the commitment hash chain (precommitment → label → commitment),
     * generates the ZK proof, encrypts the note data when discovery info is available,
     * and builds the calldata.
     *
     * @param params - Resolved deposit parameters with noteAddressHash and optional discovery fields.
     * @returns The prepared deposit result with calldata, pending note, and optional approval tx.
     */
    private async prepareDepositInternal(
        params: DepositInternalParams<TAddress>,
    ): Promise<PrepareDepositResult<TTx, TAddress>> {
        const { noteAddressHash, tokenId, value, noteSecret, publicViewingKey, ownerAddress } =
            params;
        const tokenIdField = this.addressFieldConverter.toTokenIdField(tokenId);
        const depositSecret = params.depositSecret ?? this.cryptoService.generateSecret();
        const assetConfig = await this.validateAssetConfig(tokenId, value);

        const precommitment = this.noteComputationService.computePrecommitment(
            noteAddressHash,
            tokenIdField,
            value,
        );
        const label = this.noteComputationService.computeLabel(precommitment, depositSecret);
        const commitment = this.noteComputationService.computeFullCommitment({
            noteAddressHash,
            tokenId: tokenIdField,
            value,
            label,
        });

        // Priority: caller-supplied noteData > generated (if viewing key available) > empty.
        // When noteData is supplied, the proof context is bound to it — the caller MUST submit
        // exactly this noteData on-chain or PoolVault_ProofContextMismatch will fire.
        // A builder (NoteDataBuilder) is resolved here, once the label and commitment are fixed,
        // and its output re-validated: a malformed payload would otherwise only surface on-chain.
        const suppliedNoteData =
            typeof params.noteData === "function"
                ? this.resolveNoteDataBuilder(params.noteData, {
                      tokenId,
                      value,
                      noteAddressHash,
                      depositSecret,
                      label,
                      commitment,
                  })
                : params.noteData;
        const noteData =
            suppliedNoteData ??
            (noteSecret && publicViewingKey
                ? this.noteComputationService.generateNoteData(
                      { noteSecret, value, tokenId: tokenIdField, label },
                      publicViewingKey,
                  )
                : EMPTY_NOTE_DATA);

        const context = this.contextHashService.computeDepositContext(noteData);
        const witness = await this.witnessPreparationService.buildDepositWitness({
            noteAddressHash,
            tokenId: tokenIdField,
            value,
            context,
            depositSecret,
        });

        const proofResult = await this.proofService.proveDeposit(witness);
        const aspCiphertext = await this.generateASPCipherText({
            noteAddressHash: witness.noteAddressHash,
            tokenId: tokenIdField,
            value,
            depositSecret,
            metadata: "0x0" as Hex,
        });
        const msgValue = this.computeMsgValue(tokenId, value, assetConfig.vettingFeeBPS);
        const formattedProof = this.proofService.formatForChain(proofResult);
        const depositTx = await this.entrypointInteractor.encodeDeposit(
            formattedProof,
            noteData,
            aspCiphertext,
            msgValue,
            tokenId,
        );
        const approvalTxs = await this.buildApprovalTxs(tokenId, value, assetConfig.vettingFeeBPS);

        this.logger?.info("Deposit prepared", { commitment, label });

        const pendingNote: PendingNote<TAddress> = {
            noteAddressHash,
            commitment,
            value,
            tokenId,
            label,
            status: NoteStatus.PENDING,
            isOwned: false,
            ownerAddress: ownerAddress ?? (EMPTY_ADDRESS as unknown as TAddress),
            noteSecret: noteSecret ?? EMPTY_BYTES32,
            depositSecret,
        };

        return {
            pendingNote,
            depositTx,
            approvalTxs,
            approvalTx: approvalTxs[approvalTxs.length - 1] ?? null,
        };
    }

    /**
     * Resolves `DepositForParams` into the flat `DepositInternalParams` consumed by the pipeline.
     *
     * - Path A (`noteAddressHash` only): blind cold-start, no note announcement.
     * - Path B variant 1 (`evmAddress`): SDK fetches viewing key, generates noteSecret if absent,
     *   computes noteAddressHash. Unregistered recipient throws
     *   `DepositRecipientViewingKeyUnregistered` by default; `allowOutOfBandFallback: true` opts
     *   into resolving with `noteSecret` set and no `publicViewingKey` (no on-chain announcement —
     *   `prepareDepositFor` surfaces the secret via `PrepareDepositResult.noteSecret`).
     * - Path B variant 2 (`publicViewingKey`): caller provides everything.
     *
     * @param params - The validated depositFor parameters.
     * @returns The resolved internal parameters.
     * @throws {DepositRecipientViewingKeyUnregistered} See Path B variant 1 above.
     * @throws {InvalidDepositParams} When `discoveryData.evmAddress` is this session's own address.
     */
    private async resolveDepositForParams(
        params: DepositForParams<TAddress>,
    ): Promise<DepositInternalParams<TAddress>> {
        if (params.noteAddressHash) {
            return {
                tokenId: params.tokenId,
                value: params.value,
                noteAddressHash: params.noteAddressHash,
                noteData: params.noteData,
                depositSecret: params.depositSecret,
            };
        }

        const { discoveryData } = params;

        if ("evmAddress" in discoveryData) {
            // A depositFor to yourself would come back unowned (isOwned false) and never be persisted
            // by this session. Refuse it so a caller that meant a self-deposit uses prepareDeposit.
            if (this.addressEqualityComparator.equals(discoveryData.evmAddress, this.ownerAddress)) {
                throw new InvalidDepositParams(
                    "discoveryData.evmAddress is this session's own address. Use prepareDeposit to deposit for yourself",
                );
            }
            const noteSecret = discoveryData.noteSecret ?? this.cryptoService.generateSecret();
            const noteAddressHash = this.noteComputationService.computeNoteAddressHash(
                this.addressFieldConverter.toField(discoveryData.evmAddress),
                noteSecret,
            );

            const resolved = await resolveRecipientViewingKey(
                discoveryData.evmAddress,
                this.keystoreInteractor,
                {
                    allowOutOfBandFallback: discoveryData.allowOutOfBandFallback,
                    onUnregistered: (evmAddress) =>
                        new DepositRecipientViewingKeyUnregistered(`${evmAddress}`),
                },
            );

            if (resolved.kind === "outOfBand") {
                this.logger?.warn(
                    "Recipient viewing key not registered — falling back to out-of-band (caller opted in)",
                    { recipientEvmAddress: discoveryData.evmAddress },
                );
                return {
                    tokenId: params.tokenId,
                    value: params.value,
                    noteAddressHash,
                    noteSecret,
                    ownerAddress: discoveryData.evmAddress,
                };
            }

            return {
                tokenId: params.tokenId,
                value: params.value,
                noteAddressHash,
                noteSecret,
                publicViewingKey: resolved.publicViewingKey,
                ownerAddress: discoveryData.evmAddress,
            };
        }

        return {
            tokenId: params.tokenId,
            value: params.value,
            noteAddressHash: discoveryData.noteAddressHash,
            noteSecret: discoveryData.noteSecret,
            publicViewingKey: discoveryData.publicViewingKey,
        };
    }

    /**
     * Calls a caller-supplied {@link NoteDataBuilder} with the fixed note and validates what it
     * returns.
     *
     * @throws {InvalidDepositParams} When the builder throws or returns a malformed payload.
     */
    private resolveNoteDataBuilder(
        builder: NoteDataBuilder<TAddress>,
        note: NoteDataBuilderInput<TAddress>,
    ): { hint: Hex; data: Hex } {
        let built: unknown;
        try {
            built = builder(note);
        } catch (error) {
            throw new InvalidDepositParams(
                `noteData builder failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        }
        // A transpiled async builder is not tagged AsyncFunction, so the schema cannot catch it:
        // name the real problem instead of reporting a pending Promise as a malformed payload.
        if (typeof (built as { then?: unknown } | null)?.then === "function") {
            throw new InvalidDepositParams(
                "noteData builder returned a Promise. The builder must be synchronous",
            );
        }
        const validated = this.schemas.noteDataPayloadSchema.safeParse(built);
        if (!validated.success) {
            throw new InvalidDepositParams(
                `noteData builder returned an invalid payload: ${validated.error.issues[0].message}`,
            );
        }
        const payload = built as { hint: Hex; data: Hex };
        return { hint: payload.hint, data: payload.data };
    }

    /**
     * Fetches the on-chain asset config and rejects disabled assets or amounts below minimum.
     *
     * @param tokenId - The token address to validate.
     * @param value - The deposit amount to check against the minimum.
     * @returns The validated asset configuration.
     */
    private async validateAssetConfig(tokenId: TAddress, value: Hex): Promise<AssetConfig> {
        try {
            const config = await this.entrypointInteractor.getAssetConfig(tokenId);

            if (!config.enabled) {
                throw new AssetNotEnabled(`${tokenId}`);
            }

            if (BigInt(value) < BigInt(config.minAmount)) {
                throw new BelowMinimumAmount(`value ${value} is below minimum ${config.minAmount}`);
            }

            return config;
        } catch (error) {
            if (error instanceof PoolSessionDepositBaseError) {
                throw error;
            }
            throw new InvalidDepositParams(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Returns `value + vettingFee` for native ETH deposits, `0x0` for ERC-20s.
     *
     * @param tokenId - The token address (native ETH or ERC-20).
     * @param value - The deposit amount.
     * @param vettingFeeBPS - The vetting fee in basis points.
     * @returns The msg.value to send with the transaction.
     */
    private computeMsgValue(tokenId: TAddress, value: Hex, vettingFeeBPS: Hex): Hex {
        if (this.addressEqualityComparator.equals(tokenId, NATIVE_ASSET_ADDRESS as unknown as TAddress)) {
            const valueBigInt = BigInt(value);
            const feeBPS = BigInt(vettingFeeBPS);
            const fee = (valueBigInt * feeBPS) / 10_000n;
            return bigintToHex(valueBigInt + fee);
        }

        return bigintToHex(0n) as Hex;
    }

    /**
     * Builds an ERC-20 `approve` tx for `value + fee` if the current allowance is insufficient.
     *
     * @param tokenId - The ERC-20 token address.
     * @param value - The deposit amount.
     * @param vettingFeeBPS - The vetting fee in basis points.
     * @returns A prepared approval transaction, or null if allowance is sufficient or token is native ETH.
     */
    private async buildApprovalTxs(
        tokenId: TAddress,
        value: Hex,
        vettingFeeBPS?: Hex,
    ): Promise<TTx[]> {
        if (this.addressEqualityComparator.equals(tokenId, NATIVE_ASSET_ADDRESS as unknown as TAddress)) {
            return [];
        }

        const currentAllowance = await this.entrypointInteractor.getAllowance(
            tokenId,
            this.ownerAddress,
            this.entrypointInteractor.getAddress(),
        );

        const valueBigInt = BigInt(value);
        const feeBPS = BigInt(vettingFeeBPS ?? 0n);
        const fee = (valueBigInt * feeBPS) / 10_000n;
        const totalAmount = valueBigInt + fee;

        // Zero reset first on a residual allowance (mainnet USDT reverts otherwise), vuln-mining #28.
        const amounts = planApprovals(BigInt(currentAllowance), totalAmount, (amount) => amount);
        const approvals: TTx[] = [];
        for (const amount of amounts) {
            approvals.push(await this.entrypointInteractor.encodeApprove(tokenId, bigintToHex(amount)));
        }
        return approvals;
    }

    /**
     * Validates a prepared ERC-20 approval before signing: it must target the
     * deposit token, call `approve`, and name the Entrypoint as the spender.
     * The spender check is the load-bearing one — a tampered `approvalTx` that
     * kept the right token + selector but swapped in an attacker spender would
     * otherwise have the wallet grant the attacker an allowance. The approved
     * amount is intentionally not pinned: over-approving the Entrypoint (a
     * trusted contract) is not a theft vector.
     *
     * @throws {UnexpectedTransactionTarget} On token, selector, or spender mismatch.
     */
    private assertApprovalTx(approvalTx: TTx, token: TAddress): void {
        const { args } = this.preparedTxVerifier.assertMatches(approvalTx, {
            to: token,
            operation: "approve",
        });

        const expectedSpender = this.entrypointInteractor.getAddress();
        const spender = args[0] as TAddress;
        if (!this.addressEqualityComparator.equals(spender, expectedSpender)) {
            throw new UnexpectedTransactionTarget(
                `approval spender ${spender} does not match Entrypoint ${expectedSpender}`,
            );
        }
    }

    /**
     * Encrypts the deposit payload for the ASP using an ephemeral X25519
     * keypair (ECDH with the ASP's public key). The ciphertext prefix is the
     * ephemeral public key — not the depositor's long-term viewing key —
     * so the on-chain `LabelRegistered` event cannot be joined with the
     * keystore's `setViewingKey` registrations to deanonymize the depositor.
     *
     * @param payload - The deposit metadata to encrypt (noteAddressHash, tokenId, value, depositSecret).
     * @returns The ASP ciphertext as `ephemeralPublicKey ‖ encrypted`.
     */
    private async generateASPCipherText(payload: ASPCipherTextPayload): Promise<Hex> {
        const aspPublicKey = await this.aspClient.getASPPublicKey();

        return encodeASPCipherText(
            payload,
            { aspPublicKey },
            { cryptoService: this.cryptoService, logger: this.logger },
        );
    }
}
