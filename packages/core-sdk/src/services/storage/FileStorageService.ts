import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";

import type { FileStorageServiceConfig, IStorageService } from "../../internal.js";
import {
    InvalidStorageFilename,
    SAFE_STORAGE_FILENAME_PATTERN,
    UnreadableStorageFile,
} from "../../internal.js";

/**
 * Node.js IStorageService backed by a single JSON file.
 * File path: `{dirPath}/{filename}.json`.
 * Writes are atomic: data is written to a `.tmp` file first, then renamed
 * so a crash mid-write leaves the previous file intact.
 */
export class FileStorageService implements IStorageService {
    private readonly filePath: string;
    private readonly tmpPath: string;
    /**
     * Serializes concurrent write operations to prevent lost updates.
     *
     * Each mutating method (`set`, `delete`, `clear`) chains its work onto this
     * promise instead of running immediately. Because every new operation is
     * appended via `.then()` to the current tail of the chain, operations always
     * execute one-at-a-time in arrival order — even when callers fire them in
     * parallel without awaiting.
     *
     * Without this, two concurrent `set` calls would both read the same stale
     * file, each write a different key, and the last rename would silently
     * overwrite the other's change.
     */
    private _writeQueue: Promise<unknown> = Promise.resolve();

    /**
     * @param config - Service configuration.
     * @param config.filename - Filename (without extension) for the JSON file.
     * @param config.dirPath - Directory where the JSON file is stored. Created if absent.
     */
    constructor({ filename, dirPath }: FileStorageServiceConfig) {
        if (!SAFE_STORAGE_FILENAME_PATTERN.test(filename)) {
            throw new InvalidStorageFilename(filename);
        }
        this.filePath = join(dirPath, `${filename}.json`);
        this.tmpPath = join(dirPath, `${filename}.json.tmp`);
    }

    /** @inheritdoc IStorageService.get */
    async get<T>(key: string): Promise<T | null> {
        // Queued alongside the writes because a read can now move an unparseable file
        // aside. Running that concurrently with a `set` could rename the file the write
        // had just replaced, which would discard a good store.
        return this.enqueue(async () => {
            const store = await this.readStore();
            return (store[key] as T) ?? null;
        });
    }

    /** @inheritdoc IStorageService.set */
    set<T>(key: string, value: T): Promise<void> {
        return this.enqueue(async () => {
            const store = await this.readStore();
            store[key] = value;
            await this.writeStore(store);
        });
    }

    /** @inheritdoc IStorageService.delete */
    delete(key: string): Promise<void> {
        return this.enqueue(async () => {
            const store = await this.readStore();
            Reflect.deleteProperty(store, key);
            await this.writeStore(store);
        });
    }

    /** @inheritdoc IStorageService.clear */
    clear(): Promise<void> {
        return this.enqueue(() => this.writeStore({}));
    }

    // ── Private helpers ──────────────────────────────────────────────────────

    /**
     * Append `op` to the write queue and return a promise that resolves/rejects
     * with this op's outcome. Critical: the queue itself is rejoined via
     * `.catch(() => undefined)` so a prior op's rejection does not poison
     * downstream writes — without this, the first disk-full/EACCES error
     * would permanently lock out every subsequent set/delete/clear.
     */
    private enqueue<T>(op: () => Promise<T>): Promise<T> {
        const next = this._writeQueue.then(op, op);
        this._writeQueue = next.catch(() => undefined);
        return next;
    }

    private async readStore(): Promise<Record<string, unknown>> {
        let content: string;
        try {
            content = await readFile(this.filePath, "utf-8");
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
            throw e;
        }
        try {
            const parsed: unknown = JSON.parse(content);
            // An array, a primitive or `null` parses but is not a key/value store: reading a
            // key off it yields `undefined` and writing one back would serialize a shape no
            // load path accepts. Treat it exactly as unparseable rather than half-using it.
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("storage root is not a JSON object");
            }
            return parsed as Record<string, unknown>;
        } catch {
            // A corrupted file (mid-write crash, external tampering, partial
            // truncation) must not propagate as a SyntaxError that crashes
            // session bootstrap. Treat the store as empty; downstream schema
            // validation in NoteStorageAdapter still rejects malformed shapes.
            //
            // "Empty" is only a safe answer once the existing bytes are out of the way:
            // `set`/`delete` write back exactly what this returns, so the next write would
            // rename a one-key store over a file that still holds every record. Move it
            // aside first, under a name this service never reads, so the records survive
            // for recovery and this read genuinely finds nothing.
            await this.setAsideUnparseableStore();
            return {};
        }
    }

    /**
     * Renames the unparseable store to a sibling that will never be read back.
     *
     * The name carries a timestamp and a random id so two recoveries cannot overwrite
     * each other: a fixed `.corrupt` suffix would make the second unparseable store
     * destroy the first one's contents, which is the same loss this exists to prevent.
     *
     * Failing to move the file is reported rather than absorbed. With the file still in
     * place, returning an empty store is precisely what erases it.
     *
     * @throws {UnreadableStorageFile} When the file cannot be moved aside.
     */
    private async setAsideUnparseableStore(): Promise<void> {
        try {
            await rename(this.filePath, `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}`);
        } catch (error) {
            // Already gone: something else preserved or removed it, so the empty answer
            // this read is about to give is accurate and nothing is at risk.
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new UnreadableStorageFile(
                this.filePath,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    private async writeStore(store: Record<string, unknown>): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true });
        await writeFile(this.tmpPath, JSON.stringify(store), "utf-8");
        await rename(this.tmpPath, this.filePath);
    }
}
