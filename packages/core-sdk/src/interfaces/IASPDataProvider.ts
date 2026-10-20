import type { EventSnapshot, Hash, Hex, LabelStatus, NoteEvent, PublicKey } from "../internal.js";

/**
 * Abstraction for fetching association set data from an ASP.
 * Implementations may use HTTP, IPFS, or other transports.
 */
export interface IASPDataProvider {
    /**
     * Retrieves the current association set root.
     *
     * @returns The association set root hash.
     * @throws {ASPClientBaseError}
     */
    getRoot(): Promise<Hash>;

    /**
     * Retrieves all leaves of the association set.
     *
     * @returns Array of leaf hashes.
     * @throws {ASPClientBaseError}
     */
    getLeaves(): Promise<Hash[]>;

    /**
     * Retrieves the status of a given label.
     *
     * @param labelHash - The label hash to query.
     * @returns The label status.
     * @throws {ASPClientBaseError}
     */
    getLabelStatus(labelHash: Hash): Promise<LabelStatus>;

    /**
     * Retrieves the ASP's public key.
     *
     * @returns The ASP public key.
     * @throws {ASPClientBaseError}
     */
    getASPPublicKey(): Promise<PublicKey>;

    /**
     * Fetches the full event snapshot from the ASP.
     * Returns all deposits, transacts, ragequits, and leaves up to the snapshot block.
     *
     * @returns The event snapshot payload.
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    getEventSnapshot(): Promise<EventSnapshot>;

    /**
     * Returns raw on-chain Note event entries the SDK uses for
     * discovery, replacing the chunked `eth_getLogs` scrape.
     *
     * Every field in the response is data the ASP fetched from public
     * RPC — same `(blockNumber, txHash, hint, data)` bundle any RPC node
     * returns for `Note(bytes32 indexed hint, bytes data)`. The ASP is
     * not creating any new linkage; it's just caching public chain
     * state.
     *
     * The ASP returns `lastSyncedBlock` alongside the events so the
     * caller can fall back to `IPoolVaultInteractor.getNoteEvents` for
     * any missing range between `lastSyncedBlock` and `toBlock` when the
     * ASP's cache lags behind chain head.
     *
     * @returns The Note events plus the highest block the ASP has indexed.
     * @throws {ASPUnavailable} When the HTTP request fails.
     */
    getNoteEvents(
        fromBlock?: Hex,
        toBlock?: Hex,
    ): Promise<{ events: NoteEvent[]; lastSyncedBlock: Hex }>;
}
