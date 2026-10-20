import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    IStorageService,
    PaymentRequestServiceState,
    Secret,
} from "../../../../src/internal.js";
import {
    InvalidStorageStateError,
    PaymentRequestStorageAdapter,
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

const key = `v1:${STORAGE_KEYS.PAYMENT_REQUEST_STATE}:1:0x0000000000000000000000000000000000000001`;

const SAMPLE_STATE: PaymentRequestServiceState = {
    requests: [
        {
            paymentId: ("0x" + "11".repeat(32)) as Hash,
            noteAddressHashes: [("0x" + "22".repeat(32)) as Hash],
            noteSecretsMap: new Map<Hash, Secret>([
                [("0x" + "22".repeat(32)) as Hash, ("0x" + "33".repeat(32)) as Secret],
            ]),
            amount: "0x1" as Hash,
            tokenId: ("0x" + "44".repeat(20)) as Address,
            tag: ("0x" + "55".repeat(32)) as Hash,
            paymentPubKey: ("0x" + "66".repeat(32)) as Hash,
            recipientAddress: ("0x" + "88".repeat(20)) as Address,
            status: "OPEN",
            createdAt: "0x1" as Hash,
            fulfilledByCommitments: [],
            consumedSlots: [],
        },
    ],
};

describe("PaymentRequestStorageAdapter", () => {
    let mockStorage: IStorageService;
    let adapter: PaymentRequestStorageAdapter;

    beforeEach(() => {
        mockStorage = makeMockStorage();
        adapter = new PaymentRequestStorageAdapter(
            1,
            mockStorage,
            "0x0000000000000000000000000000000000000001",
        );
        vi.clearAllMocks();
    });

    describe("saveState", () => {
        it("delegate to storage.set with PAYMENT_REQUEST_STATE key and JSON-serializable state", async () => {
            await adapter.saveState(SAMPLE_STATE);
            // Maps don't survive JSON.stringify. Adapter converts
            // noteSecretsMap to array-of-entries so backed storage
            // round-trips correctly; schema codec restores Map on load.
            const expectedSerialized = {
                requests: SAMPLE_STATE.requests.map((r) => ({
                    ...r,
                    noteSecretsMap: Array.from(r.noteSecretsMap.entries()),
                })),
            };
            expect(mockStorage.set).toHaveBeenCalledWith(key, expectedSerialized);
        });
    });

    describe("getState", () => {
        it("delegate to storage.get with PAYMENT_REQUEST_STATE key", async () => {
            await adapter.getState();
            expect(mockStorage.get).toHaveBeenCalledWith(key);
        });

        it("return null when storage has no value", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue(null);
            expect(await adapter.getState()).toBeNull();
        });

        it("return the stored state when present", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue(SAMPLE_STATE);
            const result = await adapter.getState();
            expect(result).toEqual(SAMPLE_STATE);
        });

        it("throw InvalidStorageStateError when persisted data fails schema validation", async () => {
            vi.mocked(mockStorage.get).mockResolvedValue({ invalid: true });
            await expect(adapter.getState()).rejects.toThrow(InvalidStorageStateError);
        });
    });

    describe("clearState", () => {
        it("delegate to storage.delete with PAYMENT_REQUEST_STATE key", async () => {
            await adapter.clearState();
            expect(mockStorage.delete).toHaveBeenCalledWith(key);
        });
    });
});
