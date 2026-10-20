import type { IStorageService, LocalStorageServiceConfig } from "../../internal.js";
import { StorageQuotaError } from "../../internal.js";

/**
 * Browser IStorageService backed by window.localStorage.
 * Keys are namespaced as `${prefix}:${key}` to avoid collisions between applications.
 */
export class LocalStorageService implements IStorageService {
    private readonly namespace: string;

    /**
     * @param config - Service configuration.
     * @param config.prefix - Key prefix. Defaults to "privacy-pool".
     */
    constructor({ prefix = "privacy-pool" }: LocalStorageServiceConfig = {}) {
        this.namespace = prefix;
    }

    /** @inheritdoc IStorageService.get */
    async get<T>(key: string): Promise<T | null> {
        const raw = localStorage.getItem(this.buildKey(key));
        if (raw === null) return null;
        try {
            return JSON.parse(raw) as T;
        } catch {
            // localStorage is shared across the origin: extensions, devtools,
            // sibling tabs, or a half-written quota-exceeded value can plant
            // unparseable JSON at our key. Treat it as missing so session
            // bootstrap recovers cleanly; downstream schema validation
            // already rejects malformed shapes.
            return null;
        }
    }

    /**
     * @inheritdoc IStorageService.set
     * @throws {StorageQuotaError} When the browser localStorage quota is exceeded.
     */
    async set<T>(key: string, value: T): Promise<void> {
        try {
            localStorage.setItem(this.buildKey(key), JSON.stringify(value));
        } catch (e) {
            if (e instanceof DOMException && e.name === "QuotaExceededError") {
                throw new StorageQuotaError(key);
            }
            throw e;
        }
    }

    /** @inheritdoc IStorageService.delete */
    async delete(key: string): Promise<void> {
        localStorage.removeItem(this.buildKey(key));
    }

    /** @inheritdoc IStorageService.clear */
    async clear(): Promise<void> {
        const prefix = `${this.namespace}:`;
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k?.startsWith(prefix)) keysToRemove.push(k);
        }
        for (const k of keysToRemove) {
            localStorage.removeItem(k);
        }
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    private buildKey(key: string): string {
        return `${this.namespace}:${key}`;
    }
}
