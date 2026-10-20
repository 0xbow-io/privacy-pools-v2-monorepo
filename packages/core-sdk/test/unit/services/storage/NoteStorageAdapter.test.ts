import { beforeEach, describe, expect, it, vi } from "vitest";

import type { IStorageService, NoteManagerState } from "../../../../src/internal.js";
import {
    InvalidStorageStateError,
    NoteStorageAdapter,
    STORAGE_KEYS,
} from "../../../../src/internal.js";

function makeMockStorage(): IStorageService {
    return {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
    };
}

const key = `v1:${STORAGE_KEYS.NOTE_MANAGER_STATE}:1:0x0000000000000000000000000000000000000001`;

const SAMPLE_STATE: NoteManagerState = {
    notes: [],
    syncCursor: "0x1" as NoteManagerState["syncCursor"],
};

describe("NoteStorageAdapter", () => {
    let mockStorage: IStorageService;
    let adapter: NoteStorageAdapter;

    beforeEach(() => {
        mockStorage = makeMockStorage();
        adapter = new NoteStorageAdapter(
            1,
            mockStorage,
            "0x0000000000000000000000000000000000000001",
        );
        vi.clearAllMocks();
    });

    describe("saveState", () => {
        it("delegates to storage.set with NOTE_MANAGER_STATE key and state value", async () => {
            await adapter.saveState(SAMPLE_STATE);
            expect(mockStorage.set).toHaveBeenCalledWith(key, SAMPLE_STATE);
        });
    });

    describe("getState", () => {
        it("delegates to storage.get with NOTE_MANAGER_STATE key", async () => {
            await adapter.getState();
            expect(mockStorage.get).toHaveBeenCalledWith(key);
        });

        it("returns null when storage has no value", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue(null);
            expect(await adapter.getState()).toBeNull();
        });

        it("returns the stored state when present", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue(SAMPLE_STATE);
            expect(await adapter.getState()).toEqual(SAMPLE_STATE);
        });

        it("throws InvalidStorageStateError when persisted data fails schema validation", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue({ invalid: true });
            await expect(adapter.getState()).rejects.toThrow(InvalidStorageStateError);
        });
    });

    describe("clearState", () => {
        it("delegates to storage.delete with NOTE_MANAGER_STATE key", async () => {
            await adapter.clearState();
            expect(mockStorage.delete).toHaveBeenCalledWith(key);
        });
    });
});
