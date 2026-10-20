import type {
    Address,
    AddNoteParams,
    EVMProof,
    Hex,
    ILogger,
    INoteManager,
    IPoolSessionNoteManager,
    IPoolVaultInteractor,
    MarkNoteExitedParams,
    MarkNoteSpentParams,
    PoolSessionNoteManagerConfig,
    PoolSessionNoteManagerDependencies,
    PreparedTransaction,
    TxLog,
} from "../../internal.js";
import {
    InvalidAddNoteParams,
    InvalidMarkNoteExitedParams,
    InvalidMarkNoteSpentParams,
    InvalidStatusTransitionError,
    makeAddNoteParamsSchema,
    MarkNoteExitedParamsSchema,
    MarkNoteSpentParamsSchema,
    NoteCommitmentNotMined,
    NoteStatus,
    resolveCommitmentTimestamp,
} from "../../internal.js";

/**
 * Batch-validate-then-flush implementation of {@link IPoolSessionNoteManager}, generic over the
 * chain's prepared-transaction type `TTx`, address type `TAddress`, on-chain proof type `TProof`,
 * and raw receipt-log type `TLog`.
 */
export class PoolSessionNoteManager<
    TTx = PreparedTransaction,
    TAddress = Address,
    TProof = EVMProof,
    TLog = TxLog,
> implements IPoolSessionNoteManager<TAddress>
{
    private readonly noteManager: INoteManager<TAddress>;
    private readonly poolVaultInteractor: IPoolVaultInteractor<TTx, TAddress, TProof, TLog>;
    private readonly addNoteParamsSchema: ReturnType<typeof makeAddNoteParamsSchema<TAddress>>;
    private readonly logger?: ILogger;

    /**
     * Creates a new PoolSessionNoteManager instance.
     *
     * @param config - Required service dependencies.
     * @param config.noteManager - The NoteManager to insert pending notes into.
     * @param config.poolVaultInteractor - PoolVault interactor for resolving commitment timestamps.
     * @param config.addressSchema - Validates `tokenId`/`ownerAddress` against the chain's real address shape.
     * @param dependencies - Optional dependencies.
     * @param dependencies.logger - Optional logger for debug output.
     */
    constructor(
        config: PoolSessionNoteManagerConfig<TTx, TAddress, TProof, TLog>,
        dependencies?: PoolSessionNoteManagerDependencies,
    ) {
        this.noteManager = config.noteManager;
        this.poolVaultInteractor = config.poolVaultInteractor;
        this.addNoteParamsSchema = makeAddNoteParamsSchema(config.addressSchema);
        this.logger = dependencies?.logger;
        this.logger?.debug("PoolSessionNoteManager initialized");
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.addNotes
     * @throws {InvalidAddNoteParams} On Zod failure (includes the isOwned gate).
     * @throws {NoteCommitmentNotMined} When any timestamp cannot be resolved.
     * @throws {InvalidNoteError} When NoteManager rejects an assembled note.
     */
    async addNotes(params: AddNoteParams<TAddress>[]): Promise<void> {
        if (params.length === 0) return;

        // Only `.success` is read; the generically-typed `params` entries (not the schema's
        // `.data`) are what continue through the pipeline below.
        const validated = params.map((entry) => {
            const result = this.addNoteParamsSchema.safeParse(entry);
            if (!result.success) {
                throw new InvalidAddNoteParams(result.error.issues[0].message);
            }
            return entry;
        });

        const timestamps = await Promise.all(
            validated.map((v) =>
                resolveCommitmentTimestamp(this.poolVaultInteractor, v.pendingNote.commitment, {
                    logger: this.logger,
                }),
            ),
        );

        timestamps.forEach((createdAtBlock, i) => {
            if (createdAtBlock === null) {
                throw new NoteCommitmentNotMined(validated[i].pendingNote.commitment);
            }
        });

        validated.forEach((entry, i) => {
            this.noteManager.addNote({
                ...entry.pendingNote,
                status: NoteStatus.PENDING,
                createdAtBlock: timestamps[i] as Hex,
                spentAtBlock: null,
                txHash: entry.txHash,
            });
        });

        await this.noteManager.flush();
        this.logger?.debug("Registered externally-broadcast notes as PENDING", {
            count: validated.length,
        });
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.markNotesSpent
     * @throws {InvalidMarkNoteSpentParams} On Zod failure.
     * @throws {NoteNotFoundError} When any commitment is not tracked locally.
     * @throws {InvalidStatusTransitionError} When any note is not ACTIVE.
     */
    async markNotesSpent(params: MarkNoteSpentParams[]): Promise<void> {
        if (params.length === 0) return;

        const validated = params.map((entry) => {
            const result = MarkNoteSpentParamsSchema.safeParse(entry);
            if (!result.success) {
                throw new InvalidMarkNoteSpentParams(result.error.issues[0].message);
            }
            return result.data;
        });

        for (const { commitment } of validated) {
            const note = this.noteManager.getNote(commitment);
            if (note.status !== NoteStatus.ACTIVE) {
                throw new InvalidStatusTransitionError(note.status, NoteStatus.SPENT);
            }
        }

        for (const { commitment, spentAtBlock } of validated) {
            this.noteManager.updateNoteStatus(commitment, NoteStatus.SPENT, spentAtBlock);
        }

        await this.noteManager.flush();
        this.logger?.debug("Marked externally-broadcast input notes as SPENT", {
            count: validated.length,
        });
    }

    /**
     * @inheritdoc IPoolSessionNoteManager.markNotesExited
     *
     * Records `EXIT_PENDING`, not `EXITED`, despite the name. The caller supplies
     * the block, and this SDK cannot verify that a caller-supplied block is settled
     * — nor that the exit happened at all. `EXITED` has no outgoing edge, so
     * accepting one on trust would let a caller irreversibly retire a note the user
     * still owns. Discovery promotes it to `EXITED` once it reads the chain's own
     * ragequit event for that note at a final block, which is the same evidence it
     * demands of every other terminal write.
     *
     * The note is unspendable from the moment this is called, so an
     * externally-broadcast exit still stops the note being double-spent; only the
     * irreversible part waits for proof.
     *
     * @throws {InvalidMarkNoteExitedParams} On Zod failure.
     * @throws {NoteNotFoundError} When any commitment is not tracked locally.
     * @throws {InvalidStatusTransitionError} When any note is not ACTIVE or REJECTED.
     */
    async markNotesExited(params: MarkNoteExitedParams[]): Promise<void> {
        if (params.length === 0) return;

        const validated = params.map((entry) => {
            const result = MarkNoteExitedParamsSchema.safeParse(entry);
            if (!result.success) {
                throw new InvalidMarkNoteExitedParams(result.error.issues[0].message);
            }
            return result.data;
        });

        for (const { commitment } of validated) {
            const note = this.noteManager.getNote(commitment);
            if (note.status !== NoteStatus.ACTIVE && note.status !== NoteStatus.REJECTED) {
                throw new InvalidStatusTransitionError(note.status, NoteStatus.EXITED);
            }
        }

        for (const { commitment, exitedAtBlock } of validated) {
            this.noteManager.updateNoteStatus(commitment, NoteStatus.EXIT_PENDING, exitedAtBlock);
        }

        await this.noteManager.flush();
        this.logger?.debug("Marked externally-broadcast notes as exit-pending", {
            count: validated.length,
        });
    }
}
