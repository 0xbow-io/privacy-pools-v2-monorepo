import type {
    AccountExport,
    Address,
    IAddressEqualityComparator,
    IAddressFieldConverter,
    ILogger,
    INoteComputationService,
    INoteManager,
    IPaymentRequestService,
    IPoolSessionExport,
    Note,
    PoolSessionExportConfig,
    PoolSessionExportDependencies,
    SealedEnvelope,
} from "../../internal.js";
import {
    AccountExportMismatch,
    InvalidNoteError,
    makeNoteSchema,
    NoteStatus,
    openSealed,
    sealValue,
} from "../../internal.js";

/**
 * Facade for account export/import operations, generic over the chain's address type `TAddress`.
 *
 * Serializes note state (via NoteManager) and pending payment requests (via
 * PaymentRequestService) into one portable envelope, stamped with the owner
 * and chain it belongs to. Keys are excluded — they are always provided at
 * construction time.
 *
 * `INoteComputationService` still takes a concrete `Address` (not `TAddress`) — by design, per
 * the same boundary as `PoolSessionDeposit`. Calls into it route through the injected
 * `addressFieldConverter` ({@link IAddressFieldConverter}) rather than a raw cast.
 */
export class PoolSessionExport<TAddress = Address> implements IPoolSessionExport<TAddress> {
    private readonly noteManager: INoteManager<TAddress>;
    private readonly noteComputationService: INoteComputationService;
    private readonly addressFieldConverter: IAddressFieldConverter<TAddress>;
    private readonly addressEqualityComparator: IAddressEqualityComparator<TAddress>;
    private readonly paymentRequestService: IPaymentRequestService;
    private readonly ownerAddress: TAddress;
    private readonly chainId: number;
    private readonly noteSchema: ReturnType<typeof makeNoteSchema<TAddress>>;
    private readonly logger?: ILogger;

    /**
     * Creates a new PoolSessionExport instance.
     * @param config - Required service dependencies.
     * @param config.noteManager - The NoteManager to export/import note state from.
     * @param config.noteComputationService - Recomputes note hashes for received-note verification.
     * @param config.addressFieldConverter - Converts `TAddress` into the field-sized `Hex` `noteComputationService` expects.
     * @param config.addressEqualityComparator - Compares two `TAddress` values for equality.
     * @param config.paymentRequestService - The PaymentRequestService to export/import pending requests from.
     * @param config.ownerAddress - Owner stamped into the envelope, checked on import, and required for received-note ownership.
     * @param config.chainId - Chain id stamped into the envelope and checked on import.
     * @param dependencies - Optional dependencies.
     * @param dependencies.logger - Optional logger for debug output.
     */
    constructor(
        config: PoolSessionExportConfig<TAddress>,
        dependencies?: PoolSessionExportDependencies,
    ) {
        this.noteManager = config.noteManager;
        this.noteComputationService = config.noteComputationService;
        this.addressFieldConverter = config.addressFieldConverter;
        this.addressEqualityComparator = config.addressEqualityComparator;
        this.paymentRequestService = config.paymentRequestService;
        this.ownerAddress = config.ownerAddress;
        this.chainId = config.chainId;
        this.noteSchema = makeNoteSchema(config.addressSchema);
        this.logger = dependencies?.logger;
        this.logger?.debug("PoolSessionExport initialized");
    }

    /**
     * @inheritdoc IPoolSessionExport.exportAccount
     */
    async exportAccount(): Promise<AccountExport<TAddress>> {
        const noteState = this.noteManager.exportState();
        const paymentRequests = this.paymentRequestService.exportState();
        this.logger?.debug("Account exported", {
            noteCount: noteState.notes.length,
            paymentRequestCount: paymentRequests.length,
        });
        return {
            ...noteState,
            owner: this.ownerAddress,
            chainId: this.chainId,
            paymentRequests,
        };
    }

    /**
     * @inheritdoc IPoolSessionExport.exportAccountSealed
     * @throws {InvalidAtRestPassphrase} If the passphrase is empty.
     */
    async exportAccountSealed(passphrase: string | Uint8Array): Promise<SealedEnvelope> {
        const account = await this.exportAccount();
        const sealed = await sealValue(account, passphrase);
        this.logger?.debug("Account exported (sealed)");
        return sealed;
    }

    /**
     * @inheritdoc IPoolSessionExport.importAccount
     * @throws {AccountExportMismatch} If the envelope's owner or chain differs from this session.
     * @throws {NoteManagerBaseError} If the note data is invalid or lineages cannot be rebuilt.
     * @throws {PaymentRequestBaseError} If the payment-request snapshot fails validation.
     */
    async importAccount(data: AccountExport<TAddress>): Promise<void> {
        this.assertEnvelopeMatches(data);
        await this.noteManager.importState(data, { overwrite: true });
        // Skip the payment-request restore for legacy blobs that predate the
        // field, so importing them does not wipe in-memory requests.
        if (Array.isArray(data.paymentRequests)) {
            await this.paymentRequestService.importState(data.paymentRequests);
        }
        this.logger?.debug("Account imported", {
            noteCount: data.notes?.length ?? 0,
            paymentRequestCount: data.paymentRequests?.length ?? 0,
        });
    }

    /**
     * @inheritdoc IPoolSessionExport.importAccountSealed
     * @throws {InvalidAtRestPassphrase} If the passphrase is empty.
     * @throws {InvalidEncryptedRecord} If the sealed envelope is malformed.
     * @throws {AtRestDecryptionError} If the passphrase is wrong or the envelope was tampered with.
     * @throws {AccountExportMismatch} If the envelope's owner or chain differs from this session.
     * @throws {NoteManagerBaseError} If the note data is invalid or lineages cannot be rebuilt.
     * @throws {PaymentRequestBaseError} If the payment-request snapshot fails validation.
     */
    async importAccountSealed(
        sealed: SealedEnvelope,
        passphrase: string | Uint8Array,
    ): Promise<void> {
        const account = await openSealed<AccountExport<TAddress>>(sealed, passphrase);
        await this.importAccount(account);
        this.logger?.debug("Account imported (sealed)");
    }

    /**
     * @inheritdoc IPoolSessionExport.importReceivedNote
     * @throws {InvalidNoteError} If the note fails shape validation or its owner / noteAddressHash / commitment is inconsistent.
     * @throws {NoteManagerBaseError} If the note conflicts with a stored note.
     */
    async importReceivedNote(note: Note<TAddress>): Promise<void> {
        // Internal consistency only proves the note was built from this owner's secret; it
        // does not prove a deposit or transfer happened. The note enters PENDING and the
        // status sync promotes it only once its commitment is in the on-chain set
        // (PoolSessionNoteDiscovery.syncNotesStatus), whatever its label says.
        this.assertNoteInternallyConsistent(note);
        this.noteManager.addNote({ ...note, status: NoteStatus.PENDING, spentAtBlock: null });
        await this.noteManager.flush();
        this.logger?.debug("Received note imported", { commitment: note.commitment });
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Verifies a received note's fields bind together before it is stored.
     *
     * Unlike `importAccount` (which restores the user's own trusted backup), a
     * received note comes from another party, so its fields are untrusted. The
     * shape check runs first so the `BigInt` comparisons below always receive
     * valid hex — a malformed field surfaces as `InvalidNoteError`, not a raw
     * `BigInt` `SyntaxError`. We then rebuild the cryptographic chain —
     * noteSecret to noteAddressHash to commitment — and reject any mismatch. A
     * note whose commitment does not bind its value would be unspendable, and an
     * owner mismatch means the note cannot be spent with this session's keys.
     * BigInt comparison ignores hex padding and case.
     */
    private assertNoteInternallyConsistent(note: Note<TAddress>): void {
        const validation = this.noteSchema.safeParse(note);
        if (!validation.success) {
            throw new InvalidNoteError(`Received note: ${validation.error.issues[0].message}`);
        }

        if (!this.addressEqualityComparator.equals(note.ownerAddress, this.ownerAddress)) {
            throw new InvalidNoteError(
                `received note owner ${note.ownerAddress} does not match session owner`,
            );
        }

        const expectedAddressHash = this.noteComputationService.computeNoteAddressHash(
            this.addressFieldConverter.toField(note.ownerAddress),
            note.noteSecret,
        );
        if (BigInt(expectedAddressHash) !== BigInt(note.noteAddressHash)) {
            throw new InvalidNoteError(
                "received note noteAddressHash does not match owner and secret",
            );
        }

        const expectedCommitment = this.noteComputationService.computeFullCommitment({
            noteAddressHash: note.noteAddressHash,
            tokenId: this.addressFieldConverter.toTokenIdField(note.tokenId),
            value: note.value,
            label: note.label,
        });
        if (BigInt(expectedCommitment) !== BigInt(note.commitment)) {
            throw new InvalidNoteError("received note commitment does not bind its fields");
        }
    }

    /**
     * Rejects an export produced for a different owner or chain. Either field
     * may be absent on legacy blobs; a missing field skips its check.
     * @throws {AccountExportMismatch} On a present-but-mismatched owner or chainId.
     */
    private assertEnvelopeMatches(data: AccountExport<TAddress>): void {
        if (data.owner != null && !this.addressEqualityComparator.equals(data.owner, this.ownerAddress)) {
            throw new AccountExportMismatch(
                "owner",
                String(this.ownerAddress),
                String(data.owner),
            );
        }
        if (data.chainId != null && data.chainId !== this.chainId) {
            throw new AccountExportMismatch("chainId", String(this.chainId), String(data.chainId));
        }
    }
}
