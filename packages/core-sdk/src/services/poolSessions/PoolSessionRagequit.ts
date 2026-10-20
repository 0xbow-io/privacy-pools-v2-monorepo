import type {
    Address,
    EVMProof,
    Hash,
    IAddressFieldConverter,
    IKeystoreInteractor,
    IKeystoreManager,
    ILogger,
    INoteManager,
    IPoolSessionRagequit,
    IPoolVaultInteractor,
    IPreparedTxVerifier,
    IProofService,
    ITxReceiptWaiter,
    IWitnessPreparationService,
    Note,
    PoolSessionRagequitConfig,
    PoolSessionRagequitDependencies,
    PrepareRageQuitResult,
    PreparedTransaction,
    RageQuitParams,
    TxLog,
    TxReceipt,
} from "../../internal.js";
import {
    assertKeystoreRegistered,
    EMPTY_ADDRESS,
    InvalidPoolSessionRagequitConfig,
    InvalidRageQuitParams,
    makePoolSessionRagequitConfigSchema,
    NoteStatus,
    RagequitAddresslessNoteError,
    RagequitNoteAlreadyExitedError,
    RageQuitParamsSchema,
} from "../../internal.js";

/**
 * Orchestrates the ragequit (emergency withdrawal) flow for a single note, generic over the
 * chain's prepared-transaction type `TTx`, address type `TAddress`, and on-chain proof type
 * `TProof`.
 *
 * Ragequit is the failsafe exit path that bypasses ASP compliance entirely.
 * It allows a user to publicly withdraw their funds when normal spending
 * is unavailable (e.g. label revoked, ASP censorship).
 *
 * The circuit enforces that funds go to the note's ownerAddress —
 * no theft is possible even though compliance is bypassed.
 *
 * `executeRageQuit` verifies the prepared transaction via the injected `preparedTxVerifier`
 * ({@link IPreparedTxVerifier}) rather than an EVM-only guard called directly.
 */
export class PoolSessionRagequit<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionRagequit<TTx, TAddress, TProof, TLog>
{
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    private readonly noteManager: INoteManager<TAddress>;
    private readonly keystoreManager: IKeystoreManager;
    private readonly witnessPreparationService: IWitnessPreparationService;
    private readonly proofService: IProofService<TProof>;
    private readonly keystoreInteractor: IKeystoreInteractor<TTx, TAddress>;
    private readonly rpcInteractor: ITxReceiptWaiter<TLog>;
    private readonly preparedTxVerifier: IPreparedTxVerifier<TTx, TAddress>;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly logger?: ILogger;

    /**
     * @throws {InvalidPoolSessionRagequitConfig} When the config fails validation.
     */
    constructor(
        config: PoolSessionRagequitConfig<TTx, TAddress, TProof, TLog>,
        deps?: PoolSessionRagequitDependencies,
    ) {
        const configSchema = makePoolSessionRagequitConfigSchema(config.addressSchema);
        const validated = configSchema.safeParse(config);
        if (!validated.success) {
            throw new InvalidPoolSessionRagequitConfig(validated.error.issues[0].message);
        }

        this.poolVaultInteractor = config.poolVaultInteractor;
        this.noteManager = config.noteManager;
        this.keystoreManager = config.keystoreManager;
        this.witnessPreparationService = config.witnessPreparationService;
        this.proofService = config.proofService;
        this.keystoreInteractor = config.keystoreInteractor;
        this.rpcInteractor = config.rpcInteractor;
        this.preparedTxVerifier = config.preparedTxVerifier;
        this.addressFieldConverter = config.addressFieldConverter;
        this.logger = deps?.logger;
    }

    /**
     * @inheritdoc IPoolSessionRagequit.prepareRageQuit
     * @throws {InvalidRageQuitParams} When the commitment fails validation.
     * @throws {NoteNotFoundError} If the note does not exist in NoteManager.
     * @throws {RagequitNoteAlreadyExitedError} If the note has already been exited.
     * @throws {RagequitAddresslessNoteError} If the note has no owner address (addressless flow).
     * @throws {KeystoreNotRegistered} If the note's owner never registered a keystore, so no witness can be built.
     * @throws {RegistrationCheckFailed} If the on-chain registration check fails.
     */
    async prepareRageQuit(params: RageQuitParams): Promise<PrepareRageQuitResult<TTx, TAddress>> {
        const validatedParams = RageQuitParamsSchema.safeParse(params);
        if (!validatedParams.success) {
            throw new InvalidRageQuitParams(validatedParams.error.issues[0].message);
        }

        const { commitment } = params;

        this.logger?.debug("Preparing ragequit", { commitment });

        const note = this.noteManager.getNote(commitment);

        // A convenience guard, not a safety one: the chain publishes a nullifier at
        // most once, so a note that really was exited reverts on submission either
        // way. What this check cannot do is tell a real exit from a claimed one, and
        // `EXITED` can be set from an unauthenticated ASP snapshot row. Since `EXITED`
        // is terminal, refusing on it locks the owner out of the only path that exists
        // to recover a note still spendable on chain — silently and permanently, which
        // is the worst possible failure shape for a failsafe. Callers that could not
        // corroborate the exit may say so and proceed.
        if (note.status === NoteStatus.EXITED && !params.allowUnconfirmedExit) {
            throw new RagequitNoteAlreadyExitedError(commitment);
        }
        if (note.status === NoteStatus.EXITED) {
            this.logger?.warn(
                "Ragequitting a note whose status is already EXITED, at the caller's request; the chain decides",
                { commitment },
            );
        }

        // Addressless note (payment-key flow): its commitment binds 0x0 and can never ragequit.
        // See RagequitAddresslessNoteError for why. Fail here, before the opaque proof-gen failure.
        if (note.ownerAddress === (EMPTY_ADDRESS as TAddress)) {
            throw new RagequitAddresslessNoteError(commitment);
        }

        // The ragequit witness proves membership of the NOTE OWNER's keystore leaf; an unregistered
        // owner has none, so fail here instead of with an opaque witness error.
        await assertKeystoreRegistered(this.keystoreInteractor, note.ownerAddress);

        const privateNullifyingKey = this.keystoreManager.getPrivateNullifyingKey();
        const privateRevocableKey = this.keystoreManager.getPrivateRevocableKey();

        this.logger?.debug("Fetching keystore leaves", { commitment });
        const keystoreLeaves = await this.keystoreInteractor.getKeystoreLeaves();

        this.logger?.debug("Building ragequit witness", { commitment });
        const ragequitWitness = await this.witnessPreparationService.buildRagequitWitness({
            note: note as Note,
            ownerAddress: this.addressFieldConverter.toField(note.ownerAddress),
            privateNullifyingKey,
            privateRevocableKey,
            tokenId: this.addressFieldConverter.toTokenIdField(note.tokenId),
            label: note.label,
            keystoreLeaves,
        });

        this.logger?.debug("Generating ragequit proof", { commitment });
        const proof = await this.proofService.proveRagequit(ragequitWitness.witness);

        const formattedProof = this.proofService.formatForChain(proof);
        const ragequitTx = await this.poolVaultInteractor.encodeRagequit(
            formattedProof,
            note.tokenId,
        );

        this.logger?.info("Ragequit prepared", { commitment });

        return {
            commitment,
            value: note.value,
            tokenId: note.tokenId,
            nullifierHash: ragequitWitness.nullifierHash as Hash,
            recipientAddress: note.ownerAddress,
            ragequitTx,
        };
    }

    /**
     * @inheritdoc IPoolSessionRagequit.rageQuit
     */
    async rageQuit(params: RageQuitParams): Promise<TxReceipt<TLog>> {
        const result = await this.prepareRageQuit(params);
        return this.executeRageQuit(result);
    }

    /**
     * @inheritdoc IPoolSessionRagequit.executeRageQuit
     */
    async executeRageQuit(result: PrepareRageQuitResult<TTx, TAddress>): Promise<TxReceipt<TLog>> {
        this.preparedTxVerifier.assertMatches(result.ragequitTx, {
            to: this.poolVaultInteractor.getAddress(),
            operation: "ragequit",
        });
        const txHash = await this.poolVaultInteractor.submitTransaction(result.ragequitTx);
        const txReceipt = await this.rpcInteractor.waitForTransactionReceipt(txHash);

        if (txReceipt.status) {
            // EXIT_PENDING, not EXITED. A mined transaction can still be reorged
            // out, and `EXITED` has no way back — so writing it here would record
            // irreversibly an exit the canonical chain may never contain, hiding a
            // note the user still owns. A receipt is no more final than a log, and
            // the discovery path already refuses to write a terminal status from an
            // unsettled log; this is the same rule for the same reason.
            //
            // Discovery settles it: `EXITED` once the chain's own ragequit event for
            // this note is final, or back to `ACTIVE` if the exit turns out never to
            // have happened. The note is unspendable in the meantime, because
            // spendability is an allowlist on `ACTIVE`.
            this.noteManager.updateNoteStatus(
                result.commitment,
                NoteStatus.EXIT_PENDING,
                txReceipt.blockNumber,
            );
        }

        return txReceipt;
    }
}
