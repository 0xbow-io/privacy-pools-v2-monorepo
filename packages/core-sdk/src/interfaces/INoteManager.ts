import {
    Address,
    Hash,
    Hex,
    Label,
    Note,
    NoteFilters,
    NoteLineage,
    NoteManagerExport,
    NoteStatus,
} from "../internal.js";

/**
 * Interface for the NoteManager, generic over the chain's address type `TAddress` (defaults to
 * EVM's {@link Address}).
 * NoteManager is the stateful core of note lifecycle management.
 * It owns the canonical set of all notes belonging to an account and tracks
 * each note through its lifecycle (INACTIVE → PENDING → ACTIVE → SPENT/EXITED).
 */
export interface INoteManager<TAddress = Address> {
    /**
     * Inserts a new note into the internal state.
     * Groups the note into its label's lineage automatically.
     *
     * Re-adding a note whose commitment already maps to an identical note is a
     * no-op and preserves the stored copy. A commitment already held by a note
     * with different identity fields is rejected.
     *
     * @param note - The note object to add.
     * @throws {NoteManagerBaseError}
     */
    addNote(note: Note<TAddress>): void;

    /**
     * Transitions a note to a new lifecycle status.
     *
     * @param commitmentHash - Commitment hash identifying the note to update.
     * @param status - New status (INACTIVE, PENDING, ACTIVE, SPENT, or EXITED).
     * @param currentBlock - Optional block number at which the status change occurred (used for SPENT/EXITED).
     * @throws {NoteManagerBaseError}
     */
    updateNoteStatus(commitmentHash: Hash, status: NoteStatus, currentBlock?: Hex): void;

    /**
     * Removes a note from local state and its lineage. Reserved for the
     * phantom-note purge path — purges locally-persisted notes whose
     * commitment was never inserted on-chain (decryption garbage from
     * earlier SDK builds). Not part of the normal lifecycle.
     *
     * @param commitmentHash - Commitment hash identifying the note to remove.
     * @throws {NoteManagerBaseError}
     */
    deleteNote(commitmentHash: Hash): void;

    /**
     * Replaces a note's commitment and value, re-keying internal storage.
     * Used when a note's value changes after initial insertion (e.g., fee adjustment
     * during relay), which also changes its commitment.
     *
     * @param oldCommitment - Current commitment hash identifying the note.
     * @param newCommitment - New commitment hash after value change.
     * @param newValue - Updated note value.
     * @throws {NoteManagerBaseError}
     */
    updateNote(oldCommitment: Hash, newCommitment: Hash, newValue: Hex): void;

    /**
     * Returns all notes matching the given filters.
     * If no filters are provided, returns all notes.
     *
     * @param filters - Optional filtering criteria (status, label, tokenId).
     * @returns Array of Note objects matching all provided filters (AND logic).
     */
    getNotes(filters?: NoteFilters<TAddress>): Note<TAddress>[];

    /**
     * Returns a single note by its commitment hash.
     *
     * @param commitmentHash - Commitment hash identifying the note.
     * @returns The full Note object.
     * @throws {NoteManagerBaseError}
     */
    getNote(commitmentHash: Hash): Note<TAddress>;

    /**
     * Returns the lineage for a given label.
     * The lineage includes all notes that share the label.
     *
     * @param label - The label identifying the deposit lineage to retrieve.
     * @returns The NoteLineage including all notes and aggregates.
     * @throws {NoteManagerBaseError}
     */
    getNoteLineage(label: Label): NoteLineage<TAddress>;

    /**
     * Returns all lineages tracked by NoteManager.
     * Each lineage corresponds to one deposit.
     *
     * @returns Array of all NoteLineage objects.
     */
    getAllLineages(): NoteLineage<TAddress>[];

    /**
     * Recomputes cached aggregate values (totalValue, activeNotes) for a given lineage.
     * Called internally after note mutations.
     * Filters notes by ACTIVE status and sums their values.
     *
     * @param lineage - The lineage to recompute aggregates for (modified in place).
     */
    computeAggregates(lineage: NoteLineage<TAddress>): void;

    /**
     * Returns the current sync cursor (last synced block number).
     * Used by note discovery to determine the starting block for incremental scanning.
     *
     * @returns The sync cursor as a hex string.
     */
    getSyncCursor(): Hex;

    /**
     * Updates the sync cursor to the given block number.
     * Called after successful note discovery to record progress.
     *
     * @param blockNumber - The new sync cursor value (hex-encoded block number).
     */
    setSyncCursor(blockNumber: Hex): void;

    /**
     * Serializes all note state for account export.
     *
     * @returns NoteManagerExport containing notes and syncCursor.
     */
    exportState(): NoteManagerExport<TAddress>;

    /**
     * Restores note state from a previous export.
     * Storage is only written when `options.overwrite` is explicitly `true`.
     *
     * @param data - Previously exported state from exportState().
     * @param options - Optional import options.
     * @param options.overwrite - When `true`, persists the imported state to storage. Defaults to `false`.
     * @throws {NoteManagerBaseError}
     */
    importState(data: NoteManagerExport<TAddress>, options?: { overwrite?: boolean }): Promise<void>;

    /**
     * Immediately writes all pending state to the storage adapter.
     * Call this before process exit or page unload to prevent data loss.
     */
    flush(): Promise<void>;

    /**
     * Loads previously persisted state from the storage adapter into memory.
     * No-op when no storage adapter is configured or no persisted state exists.
     * Must be called before using the NoteManager when persistence is desired.
     *
     * @throws {NoteManagerBaseError}
     */
    loadFromStorage(): Promise<void>;
}
