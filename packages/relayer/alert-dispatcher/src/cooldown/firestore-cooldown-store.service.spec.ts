import { mock } from "jest-mock-extended";
import type { AlertDispatcherConfigService } from "../config/alert-dispatcher-config.service";
import type { AlertEvent } from "../pubsub/pubsub.schemas";
import type { CooldownClaim } from "./cooldown-store.interface";

// A small stateful fake of the slice of Firestore this store uses: collection().doc(), and
// runTransaction() handing the callback a tx with get/set/update. (It doesn't model contention;
// Firestore's own transaction retry is what makes the cross-instance race safe.)
const docs = new Map<string, Record<string, unknown>>();
const collectionName = jest.fn();

const docFn = (id: string) => ({ id });
const collectionFn = jest.fn().mockImplementation((name: string) => {
    collectionName(name);
    return { doc: docFn };
});
const tx = {
    get: jest.fn(async (ref: { id: string }) => ({
        exists: docs.has(ref.id),
        data: () => docs.get(ref.id),
    })),
    set: jest.fn((ref: { id: string }, data: Record<string, unknown>) => void docs.set(ref.id, { ...data })),
    update: jest.fn((ref: { id: string }, patch: Record<string, unknown>) => void docs.set(ref.id, { ...docs.get(ref.id), ...patch })),
};
const runTransaction = jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx));

jest.mock("@google-cloud/firestore", () => ({
    Firestore: jest.fn().mockImplementation(() => ({ collection: collectionFn, runTransaction })),
}));

import { FirestoreAlertCooldownStore } from "./firestore-cooldown-store.service";

const WINDOW_MS = 900_000;
const event = (overrides: Partial<AlertEvent> = {}): AlertEvent => ({
    severity: "turbo",
    message: "signer out of gas",
    context: "EVMChainService",
    dedupKey: "EVMChainService.signerOutOfGas.8453",
    timestamp: "2026-10-16T12:00:00.000Z",
    ...overrides,
});

describe("FirestoreAlertCooldownStore", () => {
    let store: FirestoreAlertCooldownStore;
    let now: number;

    beforeEach(() => {
        docs.clear();
        jest.clearAllMocks();
        now = 1_000_000_000_000;
        jest.spyOn(Date, "now").mockImplementation(() => now);
        const config = mock<AlertDispatcherConfigService>();
        config.cooldownMs.mockReturnValue(WINDOW_MS);
        config.cooldownCollection.mockReturnValue("relayerAlertCooldowns");
        store = new FirestoreAlertCooldownStore(config);
    });

    afterEach(() => jest.restoreAllMocks());

    it("grants the first alert for a dedupKey and records it.", async () => {
        const claim = await store.tryAcquire(event());

        expect(claim).toEqual({ claimedAt: now, previousLastSentAt: 0 });
        expect(collectionName).toHaveBeenCalledWith("relayerAlertCooldowns");
        const [doc] = [...docs.values()];
        expect(doc).toEqual({
            dedupKey: "EVMChainService.signerOutOfGas.8453",
            lastSentAt: now,
            lastSeverity: "turbo",
            lastMessage: "signer out of gas",
            occurrenceCount: 1,
        });
    });

    it("suppresses a repeat inside the cooldown window and counts it.", async () => {
        await store.tryAcquire(event());
        now += WINDOW_MS - 1;

        expect(await store.tryAcquire(event())).toBeUndefined();
        const [doc] = [...docs.values()];
        expect(doc.occurrenceCount).toBe(2);
        expect(doc.lastSentAt).toBe(1_000_000_000_000); // the suppressed repeat did not move the window
    });

    it("grants again once the cooldown window has elapsed (an ongoing outage keeps paging).", async () => {
        await store.tryAcquire(event());
        now += WINDOW_MS;

        const claim = await store.tryAcquire(event({ message: "still out of gas" }));
        expect(claim).toEqual({ claimedAt: now, previousLastSentAt: 1_000_000_000_000 });
        const [doc] = [...docs.values()];
        expect(doc.lastMessage).toBe("still out of gas");
        expect(doc.occurrenceCount).toBe(2);
    });

    it("keeps different dedupKeys independent.", async () => {
        await store.tryAcquire(event());
        expect(await store.tryAcquire(event({ dedupKey: "dustRescue.8453", severity: "warn" }))).toBeDefined();
        expect(docs.size).toBe(2);
    });

    it("uses a hashed, slash-free document id for free-form dedupKeys.", async () => {
        await store.tryAcquire(event({ dedupKey: "a/b/c with spaces" }));
        const [id] = [...docs.keys()];
        expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it("release() restores the previous lastSentAt so a redelivery is granted again.", async () => {
        const claim = await store.tryAcquire(event());
        expect(await store.tryAcquire(event())).toBeUndefined(); // would be suppressed by our own claim...

        await store.release(event(), claim as CooldownClaim);

        expect(await store.tryAcquire(event())).toBeDefined(); // ...but not once the failed attempt is rolled back
    });

    it("release() leaves a newer claim alone.", async () => {
        const first = await store.tryAcquire(event());
        now += WINDOW_MS;
        await store.tryAcquire(event()); // a newer delivery claims the key

        await store.release(event(), first as CooldownClaim);

        const [doc] = [...docs.values()];
        expect(doc.lastSentAt).toBe(now);
    });

    it("release() on a missing document is a no-op.", async () => {
        await expect(store.release(event(), { claimedAt: 1, previousLastSentAt: 0 })).resolves.toBeUndefined();
    });
});
