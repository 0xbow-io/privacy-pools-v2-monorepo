import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalStorageServiceConfig } from "../../../../src/internal.js";
import { LocalStorageService, StorageQuotaError } from "../../../../src/internal.js";

// ── Minimal localStorage mock ──────────────────────────────────────────────────

function makeLocalStorageMock(): Storage {
    const store = new Map<string, string>();
    return {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => {
            store.delete(key);
        },
        key: (index: number) => Array.from(store.keys())[index] ?? null,
        get length() {
            return store.size;
        },
        clear: () => {
            store.clear();
        },
    } as Storage;
}

const BASE_CONFIG: LocalStorageServiceConfig = {};

describe("LocalStorageService", () => {
    let adapter: LocalStorageService;

    beforeEach(() => {
        vi.stubGlobal("localStorage", makeLocalStorageMock());
        adapter = new LocalStorageService(BASE_CONFIG);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("return null for a key that has not been set", async () => {
        expect(await adapter.get("missing")).toBeNull();
    });

    it("store and retrieve a string value", async () => {
        await adapter.set("key", "hello");
        expect(await adapter.get("key")).toBe("hello");
    });

    it("store and retrieve an array of objects", async () => {
        const notes = [{ commitment: "0xabc", value: "0x1" }];
        await adapter.set("notes", notes);
        expect(await adapter.get("notes")).toEqual(notes);
    });

    it("namespace keys by prefix so two adapters with different prefixes do not collide", async () => {
        const adapterA = new LocalStorageService({ prefix: "app-a" });
        const adapterB = new LocalStorageService({ prefix: "app-b" });
        await adapterA.set("cursor", "0x1");
        await adapterB.set("cursor", "0x2");
        expect(await adapterA.get("cursor")).toBe("0x1");
        expect(await adapterB.get("cursor")).toBe("0x2");
    });

    it("use custom prefix when provided", async () => {
        const custom = new LocalStorageService({ prefix: "my-app" });
        await custom.set("key", "value");
        expect(localStorage.getItem("my-app:key")).toBe('"value"');
    });

    it("delete a key so subsequent get returns null", async () => {
        await adapter.set("key", "value");
        await adapter.delete("key");
        expect(await adapter.get("key")).toBeNull();
    });

    it("clear only keys belonging to this adapter's prefix", async () => {
        const adapterA = new LocalStorageService({ prefix: "app-a" });
        const adapterB = new LocalStorageService({ prefix: "app-b" });
        await adapterA.set("notes", "data-a");
        await adapterB.set("notes", "data-b");
        await adapterA.clear();
        expect(await adapterA.get("notes")).toBeNull();
        expect(await adapterB.get("notes")).toBe("data-b");
    });

    it("throw StorageQuotaError when localStorage is full", async () => {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("Storage quota exceeded", "QuotaExceededError");
        });
        await expect(adapter.set("key", "value")).rejects.toThrow(StorageQuotaError);
    });

    it("re-throw a non-quota DOMException without wrapping", async () => {
        vi.spyOn(localStorage, "setItem").mockImplementation(() => {
            throw new DOMException("something else", "SecurityError");
        });
        await expect(adapter.set("key", "value")).rejects.toBeInstanceOf(DOMException);
    });

    it("delete a non-existent key without throwing", async () => {
        await expect(adapter.delete("phantom")).resolves.toBeUndefined();
    });

    it("use default prefix privacy-pool for the underlying storage key", async () => {
        await adapter.set("notes", "data");
        expect(localStorage.getItem("privacy-pool:notes")).toBe('"data"');
    });
});
