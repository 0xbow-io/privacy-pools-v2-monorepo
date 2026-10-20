/**
 * Raw key-value storage interface for persisting SDK state.
 *
 * `IStorageService` is NOT chain-scoped. It is a plain backend store that
 * operates on arbitrary string keys. Chain-specific and version-specific key
 * prefixing is the responsibility of higher-level adapters such as
 * `NoteStorageAdapter`, which constructs keys of the form
 * `<version>:<domain>:<chainId>` before calling this interface.
 *
 * Custom implementations MUST NOT add their own chain-specific prefixing —
 * doing so would cause keys to be double-prefixed when used through an adapter.
 */
export interface IStorageService {
    /**
     * Retrieves a value by key.
     * @param key - Storage key.
     * @returns The stored value, or null if not found.
     * @throws {StorageAdapterBaseError}
     */
    get<T>(key: string): Promise<T | null>;

    /**
     * Stores a value by key.
     * @param key - Storage key.
     * @param value - Value to store.
     * @throws {StorageAdapterBaseError}
     */
    set<T>(key: string, value: T): Promise<void>;

    /**
     * Removes a single key-value entry.
     * @param key - Storage key to remove.
     * @throws {StorageAdapterBaseError}
     */
    delete(key: string): Promise<void>;

    /**
     * Removes ALL entries from the backend store — not scoped to any particular
     * chain or version. Callers that need to clear data for a specific chain
     * should delete individual keys via {@link delete} rather than calling this
     * method.
     * @throws {StorageAdapterBaseError}
     */
    clear(): Promise<void>;
}
