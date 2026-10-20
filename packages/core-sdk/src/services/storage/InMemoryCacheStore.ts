import type { ICacheStore } from "../../internal.js";

/**
 * In-memory {@link ICacheStore} backed by a `Map`. Default cache for
 * {@link IpfsCircuitArtifacts}. Session-scoped: contents do not persist
 * across page reloads or process restarts.
 */
export class InMemoryCacheStore implements ICacheStore {
    private readonly map = new Map<string, Uint8Array>();

    /** @inheritdoc ICacheStore.get */
    async get(key: string): Promise<Uint8Array | null> {
        return this.map.get(key) ?? null;
    }

    /** @inheritdoc ICacheStore.set */
    async set(key: string, value: Uint8Array): Promise<void> {
        this.map.set(key, value);
    }
}
