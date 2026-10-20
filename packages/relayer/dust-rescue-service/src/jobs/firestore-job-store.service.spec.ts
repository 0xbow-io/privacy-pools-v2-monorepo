import { mock } from "jest-mock-extended";
import type { DustRescueConfigService } from "../config/dust-rescue-config.service";
import { JobAlreadyExistsError } from "./job-store.interface";
import type { NewDustRescueJob } from "./job.types";

const create = jest.fn();
const get = jest.fn();
const update = jest.fn();
const docFn = jest.fn().mockReturnValue({ create, get, update });
const where = jest.fn();
const orderBy = jest.fn();
const limit = jest.fn();
const collectionFn = jest.fn().mockReturnValue({ doc: docFn, where });

jest.mock("@google-cloud/firestore", () => ({
    Firestore: jest.fn().mockImplementation(() => ({ collection: collectionFn })),
}));

// Imported after the mock so it picks up the mocked Firestore constructor.
import { FirestoreDustRescueJobStore } from "./firestore-job-store.service";

const NEW_JOB: NewDustRescueJob = {
    sourceTxHash: "0xabc",
    fromChainId: 1,
    destinationChainId: 8453,
    tokenId: "0x0000000000000000000000000000000000000aaa",
    recipientIdentifier: { kind: "raw", spendingPubKey: "0xdead" },
    usdRate: { source: "Curve", microUsdPerWholeTokenX1e18: "0x1", tokenDecimals: 18 },
};

describe("FirestoreDustRescueJobStore", () => {
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let store: FirestoreDustRescueJobStore;

    beforeEach(() => {
        jest.clearAllMocks();
        config = mock<DustRescueConfigService>();
        config.firestoreCollection.mockReturnValue("dustRescueJobs");
        store = new FirestoreDustRescueJobStore(config);
    });

    it("creates a PENDING doc keyed by sourceTxHash.", async () => {
        create.mockResolvedValue(undefined);

        await store.createPending(NEW_JOB);

        expect(collectionFn).toHaveBeenCalledWith("dustRescueJobs");
        expect(docFn).toHaveBeenCalledWith("0xabc");
        expect(create).toHaveBeenCalledWith(expect.objectContaining({ ...NEW_JOB, state: "PENDING", attempts: 0 }));
    });

    it("throws JobAlreadyExistsError on a Firestore ALREADY_EXISTS (code 6) error, not the raw error.", async () => {
        create.mockRejectedValue({ code: 6, message: "ALREADY_EXISTS" });

        await expect(store.createPending(NEW_JOB)).rejects.toThrow(JobAlreadyExistsError);
    });

    it("rethrows a non-ALREADY_EXISTS error unchanged.", async () => {
        const err = new Error("permission denied");
        create.mockRejectedValue(err);

        await expect(store.createPending(NEW_JOB)).rejects.toBe(err);
    });

    it("markAwaitingDestination updates the doc's state.", async () => {
        update.mockResolvedValue(undefined);

        await store.markAwaitingDestination("0xabc");

        expect(docFn).toHaveBeenCalledWith("0xabc");
        expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: "AWAITING_DESTINATION" }));
    });

    it("get returns undefined when the doc doesn't exist.", async () => {
        get.mockResolvedValue({ exists: false });

        const job = await store.get("0xabc");

        expect(job).toBeUndefined();
    });

    it("get returns the doc data when it exists.", async () => {
        get.mockResolvedValue({ exists: true, data: () => ({ sourceTxHash: "0xabc", state: "PROVING" }) });

        const job = await store.get("0xabc");

        expect(job).toEqual({ sourceTxHash: "0xabc", state: "PROVING" });
    });

    it("listNonTerminal queries the non-terminal states, oldest-updated first, capped at the given limit.", async () => {
        const docs = [{ data: () => ({ sourceTxHash: "0xabc", state: "PROVING" }) }];
        const getDocs = jest.fn().mockResolvedValue({ docs });
        limit.mockReturnValue({ get: getDocs });
        orderBy.mockReturnValue({ limit });
        where.mockReturnValue({ orderBy });

        const jobs = await store.listNonTerminal(30);

        expect(where).toHaveBeenCalledWith(
            "state",
            "in",
            expect.arrayContaining(["PENDING", "AWAITING_DESTINATION", "PROVING", "SUBMITTING", "SUBMITTED"])
        );
        expect(orderBy).toHaveBeenCalledWith("updatedAt", "asc");
        expect(limit).toHaveBeenCalledWith(30);
        expect(jobs).toEqual([{ sourceTxHash: "0xabc", state: "PROVING" }]);
    });

    it("update patches the doc and stamps updatedAt.", async () => {
        update.mockResolvedValue(undefined);

        await store.update("0xabc", { state: "SUBMITTED" });

        expect(update).toHaveBeenCalledWith(
            expect.objectContaining({ state: "SUBMITTED", updatedAt: expect.any(Number) })
        );
    });

    it("touch bumps only updatedAt, no other fields.", async () => {
        update.mockResolvedValue(undefined);

        await store.touch("0xabc");

        expect(docFn).toHaveBeenCalledWith("0xabc");
        expect(update).toHaveBeenCalledWith({ updatedAt: expect.any(Number) });
    });
});
