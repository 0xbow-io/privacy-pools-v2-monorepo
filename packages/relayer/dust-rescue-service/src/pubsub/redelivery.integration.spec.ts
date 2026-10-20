import { mock } from "jest-mock-extended";
import { PubSubController } from "./pubsub.controller";
import { SweepService } from "../sweep/sweep.service";
import { JobAlreadyExistsError, type IDustRescueJobStore } from "../jobs/job-store.interface";
import { TERMINAL_STATES, type DustRescueJob, type NewDustRescueJob } from "../jobs/job.types";
import type { DetectionService } from "../detection/detection.service";
import type { ChainWriteService } from "../chain-write/chain-write.service";
import type { DustRescueConfigService } from "../config/dust-rescue-config.service";
import { proveDustRescueDeposit } from "@privacy-pools-v2/dust-rescue-prover";
import type { Hex } from "viem";

// Regression pin for RC-07: a Pub/Sub redelivery of an already-CONFIRMED job must be a
// genuine no-op — no second Entrypoint.deposit from the shared relayer wallet. Exercises
// the real PubSubController and SweepService (as the finding's PoC did) against a
// stateful in-memory store mirroring FirestoreDustRescueJobStore's two relevant
// semantics: createPending() throws on an existing doc, update() is an unguarded patch.

jest.mock("@privacy-pools-v2/dust-rescue-prover", () => ({ proveDustRescueDeposit: jest.fn() }));
jest.mock("../detection/detection.service", () => ({ DetectionService: jest.fn() }));
const mockProve = proveDustRescueDeposit as jest.Mock;

class InMemoryStore implements IDustRescueJobStore {
    docs = new Map<string, DustRescueJob>();
    async createPending(job: NewDustRescueJob): Promise<void> {
        if (this.docs.has(job.sourceTxHash)) throw new JobAlreadyExistsError(job.sourceTxHash);
        const now = Date.now();
        this.docs.set(job.sourceTxHash, { ...job, state: "PENDING", attempts: 0, createdAt: now, updatedAt: now });
    }
    async markAwaitingDestination(h: Hex): Promise<void> {
        await this.update(h, { state: "AWAITING_DESTINATION" });
    }
    async get(h: Hex): Promise<DustRescueJob | undefined> {
        return this.docs.get(h);
    }
    async listNonTerminal(limit: number): Promise<DustRescueJob[]> {
        return [...this.docs.values()]
            .filter((j) => !TERMINAL_STATES.includes(j.state))
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .slice(0, limit)
            .map((j) => ({ ...j }));
    }
    async update(h: Hex, patch: Partial<DustRescueJob>): Promise<void> {
        const cur = this.docs.get(h);
        if (!cur) throw new Error("NOT_FOUND");
        this.docs.set(h, { ...cur, ...patch, updatedAt: Date.now() });
    }
    async touch(h: Hex): Promise<void> {
        await this.update(h, {});
    }
}

const JOB = {
    sourceTxHash: "0xaaa" as Hex,
    fromChainId: 1,
    destinationChainId: 8453,
    tokenId: "0x0000000000000000000000000000000000000aaa",
    recipientIdentifier: { kind: "raw" as const, spendingPubKey: "0xdead" as const },
    usdRate: {
        source: "Curve" as const,
        microUsdPerWholeTokenX1e18: `0x${(10n ** 18n).toString(16)}` as Hex,
        tokenDecimals: 0,
    },
};

function envelope(payload: unknown) {
    return {
        message: {
            data: Buffer.from(JSON.stringify(payload)).toString("base64"),
            messageId: "1",
            publishTime: "2026-08-17T00:00:00Z",
        },
        subscription: "projects/p/subscriptions/s",
    };
}

describe("RC-07 regression: Pub/Sub redelivery does not rewind an advanced job", () => {
    let store: InMemoryStore;
    let detection: ReturnType<typeof mock<DetectionService>>;
    let chainWrite: ReturnType<typeof mock<ChainWriteService>>;
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let controller: PubSubController;
    let sweep: SweepService;
    let depositCount: number;

    beforeEach(() => {
        jest.clearAllMocks();
        store = new InMemoryStore();
        detection = mock<DetectionService>();
        chainWrite = mock<ChainWriteService>();
        config = mock<DustRescueConfigService>();
        config.sweepMaxAttempts.mockReturnValue(5);
        config.sweepBatchSize.mockReturnValue(50);
        config.minWorthUsdMicros.mockReturnValue(1000n);
        config.chain.mockReturnValue({ rpcUrl: "http://x", aspUrl: "http://y", circuitArtifactsDir: "/z" } as never);
        detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 10_000n, receivingTxHash: "0xrecv" });
        mockProve.mockResolvedValue({
            depositCallData: "0xcafe",
            depositTarget: "0x0000000000000000000000000000000000000e01",
            depositMsgValue: "0x0",
            approvalTx: { to: "0x0000000000000000000000000000000000000aaa", data: "0xa9", value: "0x0" },
        });
        chainWrite.approve.mockResolvedValue("0xapprove1");
        depositCount = 0;
        chainWrite.deposit.mockImplementation(async () => `0xdeposit${++depositCount}` as Hex);
        chainWrite.waitForReceipt.mockResolvedValue({ status: "success" } as never);
        controller = new PubSubController(store);
        sweep = new SweepService(store, detection, chainWrite, config);
    });

    it("CONFIRMED job: redelivery is a true no-op — the job stays CONFIRMED and no second deposit is sent.", async () => {
        await controller.pending(envelope(JOB));
        for (let i = 0; i < 4; i++) await sweep.run();
        const afterRound1 = (await store.get(JOB.sourceTxHash))!;
        expect(afterRound1.state).toBe("CONFIRMED");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        expect(afterRound1.depositTxHash).toBe("0xdeposit1");

        // Pub/Sub at-least-once: the SAME message arrives again.
        await controller.pending(envelope(JOB));
        const afterRedelivery = (await store.get(JOB.sourceTxHash))!;
        expect(afterRedelivery.state).toBe("CONFIRMED"); // NOT rewound to AWAITING_DESTINATION
        expect(afterRedelivery.depositTxHash).toBe("0xdeposit1"); // unchanged
        expect(await store.listNonTerminal(50)).toHaveLength(0); // never re-enters the sweep's working set

        for (let i = 0; i < 4; i++) await sweep.run();
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1); // still just the one deposit
        expect(mockProve).toHaveBeenCalledTimes(1);
    });

    it("SUBMITTED (not yet confirmed) job: redelivery is a true no-op — still only one deposit.", async () => {
        await controller.pending(envelope(JOB));
        for (let i = 0; i < 3; i++) await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTED");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);

        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTED"); // NOT rewound

        for (let i = 0; i < 4; i++) await sweep.run();
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("CONFIRMED");
    });

    it("SUBMITTING (calldata built, nothing broadcast) job: redelivery is a true no-op — no wasted re-proving.", async () => {
        await controller.pending(envelope(JOB));
        for (let i = 0; i < 2; i++) await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTING");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(0);
        expect(mockProve).toHaveBeenCalledTimes(1);

        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("SUBMITTING"); // NOT rewound

        for (let i = 0; i < 4; i++) await sweep.run();
        expect(chainWrite.deposit).toHaveBeenCalledTimes(1);
        expect(mockProve).toHaveBeenCalledTimes(1); // no wasted second proof either
    });

    it("BELOW_THRESHOLD job: redelivery is a true no-op — job never resurrects, no deposit.", async () => {
        config.minWorthUsdMicros.mockReturnValue(1_000_000n); // sweptAmount 10_000 < threshold
        await controller.pending(envelope(JOB));
        await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("BELOW_THRESHOLD");
        expect(detection.check).toHaveBeenCalledTimes(1);

        await controller.pending(envelope(JOB));
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("BELOW_THRESHOLD"); // NOT resurrected
        expect(await store.listNonTerminal(50)).toHaveLength(0);

        await sweep.run();
        expect((await store.get(JOB.sourceTxHash))!.state).toBe("BELOW_THRESHOLD");
        expect(chainWrite.deposit).toHaveBeenCalledTimes(0);
        expect(detection.check).toHaveBeenCalledTimes(1); // no re-detection either
    });

    it("FAILED job (attempts exhausted): redelivery is a true no-op — attempts and state untouched.", async () => {
        await controller.pending(envelope(JOB));
        await store.update(JOB.sourceTxHash, { state: "FAILED", attempts: 5, lastError: "x" });

        await controller.pending(envelope(JOB));
        const j = (await store.get(JOB.sourceTxHash))!;
        expect(j.state).toBe("FAILED"); // NOT resurrected
        expect(j.attempts).toBe(5);
        expect(await store.listNonTerminal(50)).toHaveLength(0);
    });
});
