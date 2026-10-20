import { readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { FileStorageServiceConfig } from "../../../../src/internal.js";
import { FileStorageService, InvalidStorageFilename } from "../../../../src/internal.js";

describe("FileStorageService", () => {
    let dirPath: string;
    let adapter: FileStorageService;
    let config: FileStorageServiceConfig;

    beforeEach(async () => {
        dirPath = join(tmpdir(), `storage-adapter-test-${Date.now()}`);
        config = { filename: "test-store", dirPath };
        adapter = new FileStorageService(config);
    });

    afterEach(async () => {
        await rm(dirPath, { recursive: true, force: true });
    });

    it("reject a filename that could escape the directory", () => {
        // A separator or `..` could escape dirPath; dots-only names are contained only by the
        // appended `.json` suffix (see SAFE_STORAGE_FILENAME_PATTERN). All fail at construction.
        for (const filename of ["../escape", "a/b", "..\\windows", "/etc/passwd", "", ".", ".."]) {
            expect(() => new FileStorageService({ filename, dirPath })).toThrow(
                InvalidStorageFilename,
            );
        }
    });

    it("return null for a key that has not been set", async () => {
        expect(await adapter.get("missing")).toBeNull();
    });

    it("return null when the storage directory does not exist yet", async () => {
        expect(await adapter.get("notes")).toBeNull();
    });

    it("store and retrieve a string value", async () => {
        await adapter.set("cursor", "0xabc");
        expect(await adapter.get("cursor")).toBe("0xabc");
    });

    it("store and retrieve an array of objects", async () => {
        const notes = [{ commitment: "0x1111", value: "0x64" }];
        await adapter.set("notes", notes);
        expect(await adapter.get("notes")).toEqual(notes);
    });

    it("create dirPath automatically on first write", async () => {
        await adapter.set("key", "value");
        const { access } = await import("fs/promises");
        await expect(access(dirPath)).resolves.toBeUndefined();
    });

    it("persist data across adapter instances pointing to the same directory", async () => {
        await adapter.set("notes", [{ commitment: "0xabc" }]);
        const adapter2 = new FileStorageService(config);
        expect(await adapter2.get("notes")).toEqual([{ commitment: "0xabc" }]);
    });

    it("delete a key so subsequent get returns null", async () => {
        await adapter.set("key", "value");
        await adapter.delete("key");
        expect(await adapter.get("key")).toBeNull();
    });

    it("clear removes all keys from the file", async () => {
        await adapter.set("notes", ["a"]);
        await adapter.set("cursor", "0x1");
        await adapter.clear();
        expect(await adapter.get("notes")).toBeNull();
        expect(await adapter.get("cursor")).toBeNull();
    });

    it("leave the old file intact when a write is interrupted mid-tmp (simulated)", async () => {
        await adapter.set("notes", ["original"]);

        const tmpFile = join(dirPath, "test-store.json.tmp");
        await writeFile(tmpFile, "{ corrupted json", "utf-8");

        const adapter2 = new FileStorageService(config);
        expect(await adapter2.get("notes")).toEqual(["original"]);
    });

    it("preserve all updates when concurrent set calls race on the same file", async () => {
        // Fire 10 writes in parallel without awaiting — each targets a distinct key.
        // Without the _writeQueue serialization, concurrent read-modify-write cycles
        // would clobber each other and only the last rename would survive.
        await Promise.all(Array.from({ length: 10 }, (_, i) => adapter.set(`key${i}`, i)));

        for (let i = 0; i < 10; i++) {
            expect(await adapter.get(`key${i}`)).toBe(i);
        }
    });

    it("preserve an unparseable store instead of overwriting it on the next write", async () => {
        // A read that answers "empty" over a file still in place is what destroys it: `set`
        // writes back exactly what the read returned, so one truncated file would become a
        // one-key store and every record in it would be gone.
        await adapter.set("notes", ["original"]);
        const storeFile = join(dirPath, "test-store.json");
        await writeFile(storeFile, "{ truncated", "utf-8");

        const adapter2 = new FileStorageService(config);
        expect(await adapter2.get("notes")).toBeNull();
        await adapter2.set("cursor", "0x1");

        const setAside = (await readdir(dirPath)).filter((f) => f.includes(".corrupt-"));
        expect(setAside).toHaveLength(1);
        expect(await readFile(join(dirPath, setAside[0]), "utf-8")).toBe("{ truncated");
        expect(JSON.parse(await readFile(storeFile, "utf-8"))).toEqual({ cursor: "0x1" });
    });

    it("keep both files when two unparseable stores are set aside in turn", async () => {
        // A fixed suffix would make the second recovery overwrite the first, which is the
        // same loss as not preserving them at all.
        const storeFile = join(dirPath, "test-store.json");
        await adapter.set("notes", ["first"]);
        await writeFile(storeFile, "{ first corruption", "utf-8");
        expect(await new FileStorageService(config).get("notes")).toBeNull();

        await adapter.set("notes", ["second"]);
        await writeFile(storeFile, "{ second corruption", "utf-8");
        expect(await new FileStorageService(config).get("notes")).toBeNull();

        const setAside = (await readdir(dirPath)).filter((f) => f.includes(".corrupt-"));
        expect(setAside).toHaveLength(2);
        const contents = await Promise.all(
            setAside.map((f) => readFile(join(dirPath, f), "utf-8")),
        );
        expect(contents.sort()).toEqual(["{ first corruption", "{ second corruption"]);
    });

    it("treat a JSON root that is not an object as unparseable", async () => {
        // An array, a primitive or null parses but is not a key/value store. Half-using it
        // would write a shape no load path accepts back over the file.
        const storeFile = join(dirPath, "test-store.json");
        await adapter.set("notes", ["original"]); // creates the directory and a valid store
        for (const raw of ["[1,2,3]", '"a string"', "null", "42"]) {
            await writeFile(storeFile, raw, "utf-8");
            expect(await new FileStorageService(config).get("notes")).toBeNull();
            const setAside = (await readdir(dirPath)).filter((f) => f.includes(".corrupt-"));
            expect(setAside.length).toBeGreaterThan(0);
            await Promise.all(setAside.map((f) => rm(join(dirPath, f))));
        }
    });

    it("isolate data per filename when adapters share the same dirPath", async () => {
        const adapterA = new FileStorageService({ filename: "store-a", dirPath });
        const adapterB = new FileStorageService({ filename: "store-b", dirPath });
        await adapterA.set("notes", ["a"]);
        await adapterB.set("notes", ["b"]);
        expect(await adapterA.get("notes")).toEqual(["a"]);
        expect(await adapterB.get("notes")).toEqual(["b"]);
    });
});
