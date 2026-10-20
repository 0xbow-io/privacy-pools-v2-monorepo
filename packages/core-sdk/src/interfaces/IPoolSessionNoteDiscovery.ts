import type {
    Address,
    DiscoverNotesParams,
    Hash,
    Note,
    PurgePhantomNotesParams,
} from "../internal.js";

/**
 * Orchestrates note discovery: fetching on-chain events from the PoolVault contract,
 * scanning them for notes belonging to the account, and integrating discovered notes
 * into the NoteManager. Generic over the chain's address type `TAddress`.
 */
export interface IPoolSessionNoteDiscovery<TAddress = Address> {
    /**
     * Discovers notes by fetching Note and Transacted events from the PoolVault contract
     * starting from the sync cursor (or the provided fromBlock).
     *
     * If contacts are provided, runs targeted discovery (O(k) where k = number of contacts).
     * Otherwise runs catch-all discovery (O(N) where N = all anonymous transfers).
     *
     * Discovered notes are automatically added to the NoteManager with INACTIVE status.
     * After successful discovery, the sync cursor is advanced to the current block.
     *
     * @param params - Optional discovery parameters including fromBlock and contacts.
     * @returns Array of newly discovered Note objects added to the NoteManager.
     * @throws {PoolSessionNoteDiscoveryBaseError}
     */
    discoverNotes(params?: DiscoverNotesParams): Promise<Note<TAddress>[]>;

    /**
     * Removes locally-stored notes whose commitment is not present on-chain.
     *
     * Builds the on-chain commitment set by unioning deposit and transact-output
     * commitments from the ASP `EventSnapshot` with a chain-tail catch-up
     * (`Deposited` + `Transacted` logs from the snapshot block to the current
     * head). For each candidate not in the union set, performs a per-candidate
     * `getCommitmentTimestamp` eth_call as a final on-chain double-check before
     * deletion — defense against ASP indexing gaps. Only when the eth_call
     * confirms `0n` (absent on-chain) is the note deleted via the NoteManager,
     * and the storage adapter is flushed.
     *
     * Must not be called while a transaction is in flight (deposit/transfer/
     * withdraw) — locally-staged notes whose commitments have not yet been
     * mined will be classified as phantoms and removed.
     *
     * This is an explicit maintenance op — it is NOT called from `discoverNotes`.
     * Use cases: one-shot cleanup of phantom notes left by older SDK builds
     * (decryption garbage from the alt-parity / Curve25519 transition).
     *
     * The sync cursor is not modified; purge is independent of discovery progress.
     *
     * @param params - Optional `{ dryRun }`. When `dryRun: true`, runs the
     * entire pipeline (ASP fetch, tail catch-up, per-candidate on-chain
     * double-check) and returns the would-purge set without mutating the
     * NoteManager or storage.
     * @returns Commitments of the notes that were purged (or would have been
     * purged, when `dryRun: true`).
     * @throws {PoolSessionNoteDiscoveryBaseError}
     */
    purgePhantomNotes(params?: PurgePhantomNotesParams): Promise<Hash[]>;
}
