import { beforeEach, describe, expect, it } from "vitest";

import type { IStorageService } from "../../../../src/internal.js";
import { InMemoryStorageService } from "../../../../src/internal.js";

describe("InMemoryStorageService", () => {
    let adapter: IStorageService;

    beforeEach(() => {
        adapter = new InMemoryStorageService();
    });

    it("return null for a key that has not been set", async () => {
        expect(await adapter.get("missing")).toBeNull();
    });

    it("store and retrieve a string value", async () => {
        await adapter.set("key", "value");
        expect(await adapter.get("key")).toBe("value");
    });

    it("store and retrieve a nested object", async () => {
        const obj = { a: 1, b: [2, 3] };
        await adapter.set("obj", obj);
        expect(await adapter.get("obj")).toEqual(obj);
    });

    it("overwrite an existing key with a new value", async () => {
        await adapter.set("key", "first");
        await adapter.set("key", "second");
        expect(await adapter.get("key")).toBe("second");
    });

    it("delete a key so subsequent get returns null", async () => {
        await adapter.set("key", "value");
        await adapter.delete("key");
        expect(await adapter.get("key")).toBeNull();
    });

    it("delete a non-existent key without throwing", async () => {
        await expect(adapter.delete("phantom")).resolves.toBeUndefined();
    });

    it("clear all entries", async () => {
        await adapter.set("a", 1);
        await adapter.set("b", 2);
        await adapter.clear();
        expect(await adapter.get("a")).toBeNull();
        expect(await adapter.get("b")).toBeNull();
    });
});
