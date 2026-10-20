import type { IStorageService } from "../../internal.js";

/**
 * In-memory IStorageService implementation.
 * Used as the default when no adapter is provided (preserves existing in-memory behavior)
 * and as the test double for services that depend on IStorageService.
 * Storing `undefined` as a value is treated equivalently to the key being absent.
 */
export class InMemoryStorageService implements IStorageService {
    private readonly store = new Map<string, unknown>();

    /** @inheritdoc IStorageService.get */
    async get<T>(key: string): Promise<T | null> {
        return (this.store.get(key) as T) ?? null;
    }

    /** @inheritdoc IStorageService.set */
    async set<T>(key: string, value: T): Promise<void> {
        this.store.set(key, value);
    }

    /** @inheritdoc IStorageService.delete */
    async delete(key: string): Promise<void> {
        this.store.delete(key);
    }

    /** @inheritdoc IStorageService.clear */
    async clear(): Promise<void> {
        this.store.clear();
    }
}
