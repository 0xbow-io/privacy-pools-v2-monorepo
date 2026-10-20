import type { ZodType } from "zod";

import type {
    Address,
    Hash,
    Hex,
    ILogger,
    INoteManager,
    INoteStorageAdapter,
    InternalLineage,
    Label,
    Note,
    NoteFilters,
    NoteIdentityComparator,
    NoteLineage,
    NoteManagerConfig,
    NoteManagerDependencies,
    NoteManagerExport,
} from "../internal.js";
import {
    AddressSchema,
    bigintToHex,
    InvalidLineageError,
    InvalidNoteError,
    InvalidStatusTransitionError,
    makeNoteManagerStateSchema,
    makeNoteSchema,
    NoteConflictError,
    NoteNotFoundError,
    NoteStatus,
    VALID_STATUS_TRANSITIONS,
} from "../internal.js";

/**
 * Default `NoteIdentityComparator`: EVM-shaped, compares `tokenId`/`ownerAddress` via `BigInt()`
 * (case/padding-insensitive for hex). Used by `NoteManager` when the caller supplies no
 * `noteIdentityComparator` — a non-EVM `TAddress` (e.g. Stellar's StrKey, not numeric) MUST
 * supply its own, since `BigInt()` throws on a non-numeric address string.
 */
export function defaultNoteIdentityComparator(a: Note, b: Note): boolean {
    return (
        BigInt(a.noteAddressHash) === BigInt(b.noteAddressHash) &&
        BigInt(a.tokenId) === BigInt(b.tokenId) &&
        BigInt(a.value) === BigInt(b.value) &&
        BigInt(a.label) === BigInt(b.label) &&
        BigInt(a.ownerAddress) === BigInt(b.ownerAddress) &&
        BigInt(a.noteSecret) === BigInt(b.noteSecret)
    );
}

/**
 * Implementation of the NoteManager interface, generic over the chain's address type `TAddress`.
 * Manages the stateful core of note lifecycle, tracking all notes grouped by label.
 * Uses dual in-memory storage: Map<Hash, Note<TAddress>> for O(1) note lookups and
 * Map<Label, InternalLineage> for flat lineages keyed by label.
 */
export class NoteManager<TAddress = Address> implements INoteManager<TAddress> {
    private readonly notes: Map<Hash, Note<TAddress>>;
    private readonly lineages: Map<Label, InternalLineage<TAddress>>;
    private syncCursor = 0n;
    private readonly logger?: ILogger;
    private readonly storageAdapter?: INoteStorageAdapter<TAddress>;
    private readonly noteIdentityComparator: NoteIdentityComparator<TAddress>;
    private readonly noteSchema: ReturnType<typeof makeNoteSchema<TAddress>>;
    private readonly noteManagerStateSchema: ReturnType<typeof makeNoteManagerStateSchema<TAddress>>;

    /**
     * Creates a new NoteManager instance.
     * @param config - The configuration for the NoteManager.
     * @param dependencies - Optional dependencies for the NoteManager.
     * @param dependencies.logger - The logger to use.
     */
    constructor(config: NoteManagerConfig<TAddress>, dependencies?: NoteManagerDependencies<TAddress>) {
        this.notes = new Map<Hash, Note<TAddress>>();
        this.lineages = new Map<Label, InternalLineage<TAddress>>();
        this.logger = dependencies?.logger;
        this.storageAdapter = dependencies?.storageAdapter;
        this.noteIdentityComparator =
            dependencies?.noteIdentityComparator ??
            (defaultNoteIdentityComparator as NoteIdentityComparator<TAddress>);
        const addressSchema = config.addressSchema ?? (AddressSchema as unknown as ZodType<TAddress>);
        this.noteSchema = makeNoteSchema(addressSchema);
        this.noteManagerStateSchema = makeNoteManagerStateSchema(addressSchema);

        this.logger?.debug("NoteManager initialized", { config });
    }

    /**
     * Loads existing state from storage into this instance, if available.
     * No-op when no storage adapter is configured or no persisted state exists.
     */
    async loadFromStorage(): Promise<void> {
        const state = await this.storageAdapter?.getState();

        if (state) {
            this.syncCursor = BigInt(state.syncCursor);
            this.rebuildState(state.notes);
            this.logger?.debug("Loaded NoteManager state from storage", {
                lineageCount: this.lineages.size,
                noteCount: this.notes.size,
            });
        } else {
            this.logger?.debug("No existing NoteManager state found in storage");
        }
    }

    /**
     * @inheritdoc INoteManager.addNote
     * @throws {InvalidNoteError} If the note fails schema validation.
     * @throws {NoteConflictError} If a different note already holds this commitment.
     */
    addNote(note: Note<TAddress>): void {
        const validation = this.noteSchema.safeParse(note);
        if (!validation.success) {
            throw new InvalidNoteError(`Add Note: ${validation.error.issues[0].message}`);
        }

        const existing = this.notes.get(note.commitment);
        if (existing) {
            // A reorg can re-deliver a note we already hold. Keep the stored
            // copy on an identical re-add. See NoteConflictError for why a
            // differing note is rejected rather than overwritten.
            if (this.noteIdentityComparator(existing, note)) return;
            throw new NoteConflictError(note.commitment);
        }

        this.notes.set(note.commitment, note);

        const existingLineage = this.lineages.get(note.label);
        if (existingLineage) {
            existingLineage.noteHashes.push(note.commitment);
            this.recomputeAggregates(existingLineage);
        } else {
            const lineage: InternalLineage<TAddress> = {
                label: note.label,
                tokenId: note.tokenId,
                depositSecret: note.depositSecret,
                noteHashes: [note.commitment],
                activeNoteHashes: [],
                totalValue: "0x0",
            };
            this.lineages.set(note.label, lineage);
            this.recomputeAggregates(lineage);
            this.logger?.debug("Created new lineage", { label: note.label });
        }
    }

    /**
     * @inheritdoc INoteManager.updateNoteStatus
     * @throws {NoteNotFoundError} If the note with the given commitment hash doesn't exist.
     * @throws {InvalidStatusTransitionError} If the status transition is not allowed.
     */
    updateNoteStatus(commitmentHash: Hash, status: NoteStatus, currentBlock?: Hex): void {
        const note = this.notes.get(commitmentHash);
        if (!note) throw new NoteNotFoundError(commitmentHash);

        const allowed = VALID_STATUS_TRANSITIONS[note.status];
        if (!allowed.has(status)) {
            throw new InvalidStatusTransitionError(note.status, status);
        }

        const previous = note.status;
        note.status = status;

        if (status === NoteStatus.EXIT_PENDING) {
            // OVERWRITE, not `??=`. This block is not a record of what happened, it
            // is the address the settler reads back — the one thing that decides
            // whether this note becomes EXITED or returns to ACTIVE. A stale value
            // left over from an import, or from an earlier exit attempt, would send
            // the settler to the wrong block, find no ragequit there, and restore a
            // note whose exit was real.
            note.spentAtBlock = currentBlock ?? bigintToHex(this.syncCursor);
        } else if (status === NoteStatus.SPENT || status === NoteStatus.EXITED) {
            // Leaving EXIT_PENDING, the authoritative block is the one the settler
            // just proved, not the provisional one recorded on the way in. For every
            // other source the original preservation rule still applies: the first
            // block that consumed the note is the true one.
            if (previous === NoteStatus.EXIT_PENDING && currentBlock !== undefined) {
                note.spentAtBlock = currentBlock;
            } else {
                note.spentAtBlock ??= currentBlock ?? bigintToHex(this.syncCursor);
            }
        } else if (status === NoteStatus.ACTIVE) {
            // Reached from EXIT_PENDING when the exit was reorged out. The block
            // recorded above described an exit that never happened; leaving it set
            // would make a live note look spent to anything reading that field.
            note.spentAtBlock = null;
        }

        const lineage = this.lineages.get(note.label);
        if (lineage) this.recomputeAggregates(lineage);

        this.logger?.debug("Updated note status", { commitmentHash, status });
    }

    /**
     * @inheritdoc INoteManager.deleteNote
     * @throws {NoteNotFoundError} If the note with the given commitment hash doesn't exist.
     */
    deleteNote(commitmentHash: Hash): void {
        const note = this.notes.get(commitmentHash);
        if (!note) throw new NoteNotFoundError(commitmentHash);

        this.notes.delete(commitmentHash);

        const lineage = this.lineages.get(note.label);
        if (lineage) {
            lineage.noteHashes = lineage.noteHashes.filter((h) => h !== commitmentHash);
            if (lineage.noteHashes.length === 0) {
                this.lineages.delete(note.label);
            } else {
                this.recomputeAggregates(lineage);
            }
        }

        this.logger?.debug("Deleted note", { commitmentHash });
    }

    /**
     * @inheritdoc INoteManager.updateNote
     * @throws {NoteNotFoundError} If the note with the given old commitment hash doesn't exist.
     */
    updateNote(oldCommitment: Hash, newCommitment: Hash, newValue: Hex): void {
        const note = this.notes.get(oldCommitment);
        if (!note) throw new NoteNotFoundError(oldCommitment);

        // Legitimate same-commitment case: zero-fee change in
        // PoolSessionTransact.computeFeeFromChange returns the original note
        // unchanged, so relayTransfer calls updateNote with old === new and the
        // same value. Skipping the map dance here avoids erasing the entry via
        // set-then-delete on the same key. The value assignment below is a
        // no-op in that path (commitment binds value).
        if (newCommitment !== oldCommitment) {
            this.notes.set(newCommitment, note);
            this.notes.delete(oldCommitment);
        }
        note.commitment = newCommitment;
        note.value = newValue;

        const lineage = this.lineages.get(note.label);
        if (lineage) {
            const idx = lineage.noteHashes.indexOf(oldCommitment);
            if (idx !== -1) lineage.noteHashes[idx] = newCommitment;
            this.recomputeAggregates(lineage);
        }

        this.logger?.debug("Updated note", { oldCommitment, newCommitment, newValue });
    }

    /**
     * @inheritdoc INoteManager.getNotes
     */
    getNotes(filters?: NoteFilters<TAddress>): Note<TAddress>[] {
        const allNotes = Array.from(this.notes.values());

        if (!filters) return allNotes;

        return allNotes.filter((note) => {
            if (filters.status !== undefined && note.status !== filters.status) return false;
            if (filters.label !== undefined && note.label !== filters.label) return false;
            if (filters.tokenId !== undefined && note.tokenId !== filters.tokenId) return false;
            return true;
        });
    }

    /**
     * @inheritdoc INoteManager.getNote
     * @throws {NoteNotFoundError} If the note with the given commitment hash doesn't exist.
     */
    getNote(commitmentHash: Hash): Note<TAddress> {
        const note = this.notes.get(commitmentHash);
        if (!note) throw new NoteNotFoundError(commitmentHash);
        return note;
    }

    /**
     * @inheritdoc INoteManager.getNoteLineage
     * @throws {InvalidLineageError} If the lineage for the given label doesn't exist.
     */
    getNoteLineage(label: Label): NoteLineage<TAddress> {
        const internal = this.lineages.get(label);
        if (!internal) throw new InvalidLineageError(label);
        return this.buildOutputLineage(internal);
    }

    /**
     * @inheritdoc INoteManager.getAllLineages
     */
    getAllLineages(): NoteLineage<TAddress>[] {
        return Array.from(this.lineages.values()).map((internal) =>
            this.buildOutputLineage(internal),
        );
    }

    /**
     * @inheritdoc INoteManager.computeAggregates
     */
    computeAggregates(lineage: NoteLineage<TAddress>): void {
        lineage.activeNotes = lineage.notes.filter((n) => n.status === NoteStatus.ACTIVE);
        const totalBigInt = lineage.activeNotes.reduce((sum, n) => sum + BigInt(n.value), 0n);
        lineage.totalValue = `0x${totalBigInt.toString(16)}` as Hash;
    }

    /** @inheritdoc INoteManager.getSyncCursor */
    getSyncCursor(): Hex {
        return `0x${this.syncCursor.toString(16)}` as Hex;
    }

    /** @inheritdoc INoteManager.setSyncCursor */
    setSyncCursor(blockNumber: Hex): void {
        this.syncCursor = BigInt(blockNumber);
        this.logger?.debug("Updated sync cursor", { blockNumber });
    }

    /**
     * @inheritdoc INoteManager.flush
     */
    async flush(): Promise<void> {
        await this.storageAdapter?.saveState(this.currentState());
    }

    /**
     * @inheritdoc INoteManager.exportState
     */
    exportState(): NoteManagerExport<TAddress> {
        return this.currentState();
    }

    /**
     * @inheritdoc INoteManager.importState
     */
    async importState(data: NoteManagerExport<TAddress>, options?: { overwrite?: boolean }): Promise<void> {
        // Legacy exports may be missing `syncCursor`, `notes`, or both. The
        // two fields are coupled: advancing `syncCursor` past a block means
        // "notes from that block are already persisted", so wiping one side
        // without the other leaves the scan window excluding notes the user
        // still needs. Treat any missing side as a full reset — catch-all
        // discovery will repopulate from chain.
        const hasCursor = data.syncCursor != null;
        const hasNotes = Array.isArray(data.notes);

        if (!hasCursor || !hasNotes) {
            this.logger?.warn("Legacy NoteManager export — resetting to full rescan", {
                hasCursor,
                hasNotes,
            });
            this.syncCursor = 0n;
            this.rebuildState([]);
        } else {
            // Validate before trusting the import — the same schema the load path enforces
            // (NoteStorageAdapter). A forged or corrupt export with a malformed note status, a bad
            // address, or a non-hex cursor would otherwise crash later discovery or skew the scan
            // window. Clamping the cursor against the chain head needs RPC, so it lives a layer up
            // in the discovery flow, not here.
            const parsed = this.noteManagerStateSchema.safeParse({
                notes: data.notes,
                syncCursor: data.syncCursor,
            });
            if (!parsed.success) {
                throw new InvalidNoteError(parsed.error.issues[0]!.message);
            }
            this.syncCursor = BigInt(parsed.data.syncCursor);
            this.rebuildState(parsed.data.notes as unknown as Note<TAddress>[]);
        }

        if (options?.overwrite === true) {
            await this.storageAdapter?.saveState(this.currentState());
        }

        this.logger?.debug("Imported state", { lineageCount: this.lineages.size });
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private rebuildState(notes: Note<TAddress>[]): void {
        this.notes.clear();
        this.lineages.clear();

        for (const note of notes) {
            this.notes.set(note.commitment, note);
        }

        // Group notes by label and rebuild flat lineages
        const notesByLabel = new Map<Label, Note<TAddress>[]>();
        for (const note of notes) {
            const group = notesByLabel.get(note.label) ?? [];
            group.push(note);
            notesByLabel.set(note.label, group);
        }

        for (const [label, labelNotes] of notesByLabel) {
            // Storage order is not guaranteed, so scan the whole group for the
            // one note that carries depositSecret. Stays undefined for
            // received-only lineages, where no note ever held it.
            const depositSecret = labelNotes.find(
                (n) => n.depositSecret !== undefined,
            )?.depositSecret;
            const lineage: InternalLineage<TAddress> = {
                label,
                tokenId: labelNotes[0].tokenId,
                depositSecret,
                noteHashes: labelNotes.map((n) => n.commitment),
                activeNoteHashes: [],
                totalValue: "0x0",
            };
            this.lineages.set(label, lineage);
            this.recomputeAggregates(lineage);
        }
    }

    /**
     * Recomputes aggregate values for an internal lineage using the notes Map.
     * @param lineage - The internal lineage to update.
     */
    private recomputeAggregates(lineage: InternalLineage<TAddress>): void {
        lineage.activeNoteHashes = lineage.noteHashes.filter((hash) => {
            const note = this.notes.get(hash);
            return note?.status === NoteStatus.ACTIVE;
        });
        const totalBigInt = lineage.activeNoteHashes.reduce((sum, hash) => {
            const note = this.notes.get(hash);
            return sum + (note ? BigInt(note.value) : 0n);
        }, 0n);
        lineage.totalValue = `0x${totalBigInt.toString(16)}` as Hash;
    }

    /**
     * Builds a full NoteLineage (output type) from an InternalLineage.
     * Resolves all commitment hashes to Note objects from the notes Map.
     */
    private buildOutputLineage(internal: InternalLineage<TAddress>): NoteLineage<TAddress> {
        const notes = internal.noteHashes.map((hash) => this.notes.get(hash)!).filter(Boolean);

        const activeNotes = internal.activeNoteHashes
            .map((hash) => this.notes.get(hash)!)
            .filter(Boolean);

        return {
            label: internal.label,
            tokenId: internal.tokenId,
            depositSecret: internal.depositSecret,
            notes,
            activeNotes,
            totalValue: internal.totalValue,
        };
    }

    /** Builds the current NoteManagerExport snapshot for persistence. */
    private currentState(): NoteManagerExport<TAddress> {
        return {
            notes: Array.from(this.notes.values()),
            syncCursor: `0x${this.syncCursor.toString(16)}` as Hex,
        };
    }
}
