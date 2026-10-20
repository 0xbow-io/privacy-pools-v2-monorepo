import type { Address, NoteManagerState } from "../internal.js";

/**
 * Domain-specific storage interface for NoteManager state, generic over the chain's address type
 * `TAddress`.
 * Wraps IStorageService with typed, named methods.
 * Persists notes and syncCursor as a single atomic state blob.
 */
export interface INoteStorageAdapter<TAddress = Address> {
    /**
     * Persists the full NoteManager state atomically.
     * @param state - Notes array and sync cursor.
     * @throws {StorageAdapterBaseError}
     */
    saveState(state: NoteManagerState<TAddress>): Promise<void>;

    /**
     * Retrieves the persisted NoteManager state.
     * @returns The stored state, or null if none exists.
     * @throws {StorageAdapterBaseError} On storage errors or if persisted data fails schema validation.
     */
    getState(): Promise<NoteManagerState<TAddress> | null>;

    /**
     * Removes the persisted NoteManager state.
     * @throws {StorageAdapterBaseError}
     */
    clearState(): Promise<void>;
}
