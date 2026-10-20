import type { Address } from "./Address.js";
import type { Hex } from "./Hex.js";
import type { Note } from "./Note.js";

/**
 * Internal storage state for NoteManager, generic over the chain's address type `TAddress`.
 * Persisted as a single atomic blob via INoteStorageAdapter.
 */
export interface NoteManagerState<TAddress = Address> {
    /** All tracked notes. */
    notes: Note<TAddress>[];
    /** Last synced block number as a hex string. */
    syncCursor: Hex;
}
