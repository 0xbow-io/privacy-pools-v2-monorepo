/**
 * Persistent byte-blob cache used by artifact loaders (e.g. {@link IpfsCircuitArtifacts}).
 * Implementations may back onto IndexedDB, filesystem, or any other storage layer.
 */
export interface ICacheStore {
    /**
     * Returns the cached bytes for the given key, or `null` if not present.
     * @param key - The cache key (typically a content hash such as an IPFS CID).
     * @returns The cached bytes, or `null` on miss.
     */
    get(key: string): Promise<Uint8Array | null>;

    /**
     * Stores the given bytes under the specified key.
     * @param key - The cache key (typically a content hash such as an IPFS CID).
     * @param value - The bytes to store.
     */
    set(key: string, value: Uint8Array): Promise<void>;
}
