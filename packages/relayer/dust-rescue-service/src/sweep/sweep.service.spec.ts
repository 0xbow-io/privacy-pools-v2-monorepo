import { mock } from "jest-mock-extended";
import { SweepService } from "./sweep.service";
// import type only: these classes' real modules pull in @privacy-pools-v2/evm-sdk's CJS
// build, which itself require()s ESM-only transitive deps (@noble/ciphers,
// multiformats) that Jest's module loader can't execute — see the transformIgnorePatterns
// comment in package.json. A type-only import is erased at compile time, so Jest never
// requires the real module; mock<T>() only needs the type, never the runtime class.
import type { DetectionService } from "../detection/detection.service";
import type { ChainWriteService } from "../chain-write/chain-write.service";
import type { DustRescueConfigService } from "../config/dust-rescue-config.service";
import type { IDustRescueJobStore } from "../jobs/job-store.interface";
import type { DustRescueJob } from "../jobs/job.types";
import { proveDustRescueDeposit } from "@privacy-pools-v2/dust-rescue-prover";

jest.mock("@privacy-pools-v2/dust-rescue-prover", () => ({
    proveDustRescueDeposit: jest.fn(),
}));
const mockProveDustRescueDeposit = proveDustRescueDeposit as jest.Mock;

// sweep.service.ts imports the real DetectionService class (required for NestJS DI
// metadata via `emitDecoratorMetadata`), which transitively pulls in
// @privacy-pools-v2/evm-sdk — mock via an explicit factory (not bare automock, which would
// still require() the real module to introspect its shape) so that chain never loads.
jest.mock("../detection/detection.service", () => ({ DetectionService: jest.fn() }));

function buildJob(overrides: Partial<DustRescueJob> = {}): DustRescueJob {
    return {
        sourceTxHash: "0xabc",
        fromChainId: 1,
        destinationChainId: 8453,
        tokenId: "0x0000000000000000000000000000000000000aaa",
        recipientIdentifier: { kind: "raw", spendingPubKey: "0xdead" },
        // tokenDecimals: 0 + rate: 1e18 makes sweptAmountUsdMicros == sweptAmount
        // numerically, so tests can use plain, easy-to-reason-about numbers.
        usdRate: { source: "Curve", microUsdPerWholeTokenX1e18: `0x${(10n ** 18n).toString(16)}`, tokenDecimals: 0 },
        state: "AWAITING_DESTINATION",
        attempts: 0,
        createdAt: 0,
        updatedAt: 0,
        ...overrides,
    };
}

describe("SweepService", () => {
    let jobStore: ReturnType<typeof mock<IDustRescueJobStore>>;
    let detection: ReturnType<typeof mock<DetectionService>>;
    let chainWrite: ReturnType<typeof mock<ChainWriteService>>;
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let service: SweepService;

    beforeEach(() => {
        jest.clearAllMocks();
        jobStore = mock<IDustRescueJobStore>();
        detection = mock<DetectionService>();
        chainWrite = mock<ChainWriteService>();
        config = mock<DustRescueConfigService>();
        config.sweepMaxAttempts.mockReturnValue(5);
        config.sweepBatchSize.mockReturnValue(30);
        config.minWorthUsdMicros.mockReturnValue(1000n);
        service = new SweepService(jobStore, detection, chainWrite, config);
    });

    it("passes the configured batch size to listNonTerminal.", async () => {
        config.sweepBatchSize.mockReturnValue(7);
        jobStore.listNonTerminal.mockResolvedValue([]);

        await service.run();

        expect(jobStore.listNonTerminal).toHaveBeenCalledWith(7);
    });

    describe("AWAITING_DESTINATION", () => {
        it("touches (not updates) the job on WAIT — round-robin fairness (finding #10, Problem A).", async () => {
            jobStore.listNonTerminal.mockResolvedValue([buildJob({ state: "AWAITING_DESTINATION" })]);
            detection.check.mockResolvedValue({ outcome: "WAIT" });

            await service.run();

            expect(jobStore.touch).toHaveBeenCalledWith("0xabc");
            expect(jobStore.update).not.toHaveBeenCalled();
        });

        it("moves to FAILED on a FAILED detection outcome.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([buildJob({ state: "AWAITING_DESTINATION" })]);
            detection.check.mockResolvedValue({ outcome: "FAILED", reason: "bridge refunded" });

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", { state: "FAILED", lastError: "bridge refunded" });
        });

        it("moves to FAILED, never PROVING, when the swept amount exceeds the job's dust ceiling (minr #2).", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "AWAITING_DESTINATION", maxDustAmount: "0x64" }), // ceiling 100
            ]);
            detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 1_000_000n, receivingTxHash: "0xdest" });

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({
                    state: "FAILED",
                    lastError: expect.stringContaining("exceeds the dust ceiling 100"),
                    sweptAmount: "0xf4240",
                    receivingTxHash: "0xdest",
                })
            );
            expect(jobStore.update).not.toHaveBeenCalledWith("0xabc", expect.objectContaining({ state: "PROVING" }));
        });

        it("a swept amount at or below the ceiling proceeds normally.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "AWAITING_DESTINATION", maxDustAmount: "0x64" }),
            ]);
            detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 100n, receivingTxHash: "0xdest" });
            config.minWorthUsdMicros.mockReturnValue(0n);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", expect.objectContaining({ state: "PROVING" }));
        });

        it("moves to BELOW_THRESHOLD when the swept amount is under the configured floor.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([buildJob({ state: "AWAITING_DESTINATION" })]);
            detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 500n, receivingTxHash: "0xdest" });
            config.minWorthUsdMicros.mockReturnValue(1000n);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({ state: "BELOW_THRESHOLD" })
            );
        });

        it("moves to PROVING when the swept amount clears the configured floor.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([buildJob({ state: "AWAITING_DESTINATION" })]);
            detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 5000n, receivingTxHash: "0xdest" });
            config.minWorthUsdMicros.mockReturnValue(1000n);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", expect.objectContaining({ state: "PROVING" }));
        });

        it("moves to BELOW_THRESHOLD, never PROVING, on a zero swept amount even when the floor is configured to 0.", async () => {
            // Same-chain job with no dust1ForwardTxHash (DetectionService.checkSameChain) reports
            // READY with sweptAmount 0n. A floor of 0n would otherwise satisfy `usdMicros <
            // minWorthUsdMicros` as false and fall through to PROVING a zero-value deposit.
            jobStore.listNonTerminal.mockResolvedValue([buildJob({ state: "AWAITING_DESTINATION" })]);
            detection.check.mockResolvedValue({ outcome: "READY", sweptAmount: 0n, receivingTxHash: "0xsrc" });
            config.minWorthUsdMicros.mockReturnValue(0n);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({ state: "BELOW_THRESHOLD", sweptAmount: "0x0" })
            );
            expect(jobStore.update).not.toHaveBeenCalledWith("0xabc", expect.objectContaining({ state: "PROVING" }));
        });
    });

    describe("PROVING", () => {
        it("moves to SUBMITTING and records calldata before any signing.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "PROVING", sweptAmount: "0x1000" as `0x${string}` }),
            ]);
            config.chain.mockReturnValue({
                rpcUrl: "https://rpc",
                aspUrl: "https://asp",
                circuitArtifactsDir: "/artifacts",
            } as never);
            mockProveDustRescueDeposit.mockResolvedValue({
                depositCallData: "0xcalldata",
                depositTarget: "0x00000000000000000000000000000000000fff",
                depositMsgValue: "0x0",
                approvalTx: null,
            });

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({
                    state: "SUBMITTING",
                    depositCalldata: "0xcalldata",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                })
            );
        });

        it("records the failure and retries (not FAILED yet) below sweepMaxAttempts.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "PROVING", sweptAmount: "0x1000" as `0x${string}`, attempts: 1 }),
            ]);
            config.chain.mockReturnValue({
                rpcUrl: "https://rpc",
                aspUrl: "https://asp",
                circuitArtifactsDir: "/a",
            } as never);
            mockProveDustRescueDeposit.mockRejectedValue(new Error("ASP unreachable"));

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", { attempts: 2, lastError: "ASP unreachable" });
        });

        it("moves to FAILED once attempts reaches sweepMaxAttempts.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "PROVING", sweptAmount: "0x1000" as `0x${string}`, attempts: 4 }),
            ]);
            config.chain.mockReturnValue({
                rpcUrl: "https://rpc",
                aspUrl: "https://asp",
                circuitArtifactsDir: "/a",
            } as never);
            config.sweepMaxAttempts.mockReturnValue(5);
            mockProveDustRescueDeposit.mockRejectedValue(new Error("ASP unreachable"));

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({ state: "FAILED", attempts: 5 })
            );
        });
    });

    describe("SUBMITTING", () => {
        it("submits the approval before the deposit when approvalTx is present and unsent.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({
                    state: "SUBMITTING",
                    depositCalldata: "0xdeposit",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                    depositMsgValue: "0x0",
                    approvalTx: { to: "0x00000000000000000000000000000000000eee", data: "0xapprove", value: "0x0" },
                }),
            ]);
            chainWrite.approve.mockResolvedValue("0xapprovalhash");
            chainWrite.deposit.mockResolvedValue("0xdeposithash");

            await service.run();

            expect((chainWrite.approve as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
                (chainWrite.deposit as jest.Mock).mock.invocationCallOrder[0]
            );
            expect(jobStore.update).toHaveBeenCalledWith("0xabc", expect.objectContaining({ approvalTxHash: "0xapprovalhash" }));
            expect(jobStore.update).toHaveBeenCalledWith("0xabc", {
                state: "SUBMITTED",
                depositTxHash: "0xdeposithash",
            });
        });

        it("submits every approval in order (zero reset, then the real one) before the deposit, recording each hash (minr #28).", async () => {
            const reset = { to: "0x00000000000000000000000000000000000eee", data: "0xreset", value: "0x0" } as const;
            const approve = { to: "0x00000000000000000000000000000000000eee", data: "0xapprove", value: "0x0" } as const;
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({
                    state: "SUBMITTING",
                    depositCalldata: "0xdeposit",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                    depositMsgValue: "0x0",
                    approvalTx: approve,
                    approvalTxs: [reset, approve],
                }),
            ]);
            chainWrite.approve.mockResolvedValueOnce("0xresethash").mockResolvedValueOnce("0xapprovalhash");
            chainWrite.deposit.mockResolvedValue("0xdeposithash");

            await service.run();

            expect(chainWrite.approve.mock.calls.map((c) => c[1])).toEqual([reset, approve]);
            expect(jobStore.update).toHaveBeenCalledWith("0xabc", { approvalTxHashes: ["0xresethash"] });
            expect(jobStore.update).toHaveBeenCalledWith("0xabc", {
                approvalTxHashes: ["0xresethash", "0xapprovalhash"],
                approvalTxHash: "0xapprovalhash",
            });
            expect((chainWrite.deposit as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
                (chainWrite.approve as jest.Mock).mock.invocationCallOrder[1]
            );
        });

        it("resumes ordered approvals after the first one was already sent (crash between the two).", async () => {
            const reset = { to: "0x00000000000000000000000000000000000eee", data: "0xreset", value: "0x0" } as const;
            const approve = { to: "0x00000000000000000000000000000000000eee", data: "0xapprove", value: "0x0" } as const;
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({
                    state: "SUBMITTING",
                    depositCalldata: "0xdeposit",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                    depositMsgValue: "0x0",
                    approvalTxs: [reset, approve],
                    approvalTxHashes: ["0xresethash"],
                }),
            ]);
            chainWrite.approve.mockResolvedValue("0xapprovalhash");
            chainWrite.deposit.mockResolvedValue("0xdeposithash");

            await service.run();

            expect(chainWrite.approve).toHaveBeenCalledTimes(1);
            expect(chainWrite.approve).toHaveBeenCalledWith(8453, approve);
        });

        it("skips approval when approvalTxHash is already recorded (resume after crash).", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({
                    state: "SUBMITTING",
                    depositCalldata: "0xdeposit",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                    depositMsgValue: "0x0",
                    approvalTx: { to: "0x00000000000000000000000000000000000eee", data: "0xapprove", value: "0x0" },
                    approvalTxHash: "0xalreadysent",
                }),
            ]);
            chainWrite.deposit.mockResolvedValue("0xdeposithash");

            await service.run();

            expect(chainWrite.approve).not.toHaveBeenCalled();
            expect(chainWrite.deposit).toHaveBeenCalled();
        });

        it("refuses to re-broadcast when depositTxHash is already recorded, instead of paying twice.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({
                    state: "SUBMITTING",
                    depositCalldata: "0xdeposit",
                    depositTarget: "0x00000000000000000000000000000000000fff",
                    depositMsgValue: "0x0",
                    depositTxHash: "0xalreadydeposited",
                }),
            ]);

            await service.run();

            expect(chainWrite.deposit).not.toHaveBeenCalled();
            expect(chainWrite.approve).not.toHaveBeenCalled();
            expect(jobStore.update).toHaveBeenCalledWith(
                "0xabc",
                expect.objectContaining({ attempts: 1, lastError: expect.stringContaining("0xalreadydeposited") })
            );
        });
    });

    describe("SUBMITTED", () => {
        it("touches (not updates) the job when the receipt isn't mined yet.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "SUBMITTED", depositTxHash: "0xdeposithash" }),
            ]);
            chainWrite.waitForReceipt.mockResolvedValue(undefined);

            await service.run();

            expect(jobStore.touch).toHaveBeenCalledWith("0xabc");
            expect(jobStore.update).not.toHaveBeenCalled();
        });

        it("moves to CONFIRMED on a successful receipt.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "SUBMITTED", depositTxHash: "0xdeposithash" }),
            ]);
            chainWrite.waitForReceipt.mockResolvedValue({ status: "success" } as never);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", { state: "CONFIRMED" });
        });

        it("moves to FAILED on a reverted receipt.", async () => {
            jobStore.listNonTerminal.mockResolvedValue([
                buildJob({ state: "SUBMITTED", depositTxHash: "0xdeposithash" }),
            ]);
            chainWrite.waitForReceipt.mockResolvedValue({ status: "reverted" } as never);

            await service.run();

            expect(jobStore.update).toHaveBeenCalledWith("0xabc", expect.objectContaining({ state: "FAILED" }));
        });
    });

    it("processes jobs sequentially, not concurrently (shared Child 1 signer).", async () => {
        const order: string[] = [];
        const jobA = buildJob({
            sourceTxHash: "0xaaa",
            state: "SUBMITTING",
            depositCalldata: "0xa",
            depositTarget: "0x00000000000000000000000000000000000fff",
            depositMsgValue: "0x0",
        });
        const jobB = buildJob({
            sourceTxHash: "0xbbb",
            state: "SUBMITTING",
            depositCalldata: "0xb",
            depositTarget: "0x00000000000000000000000000000000000fff",
            depositMsgValue: "0x0",
        });
        jobStore.listNonTerminal.mockResolvedValue([jobA, jobB]);
        chainWrite.deposit.mockImplementation(async (_chainId, _target, data) => {
            order.push(`start:${data}`);
            await new Promise((r) => setTimeout(r, 5));
            order.push(`end:${data}`);
            return "0xhash";
        });

        await service.run();

        // If jobs ran concurrently, both "start" entries would appear before either "end".
        expect(order).toEqual(["start:0xa", "end:0xa", "start:0xb", "end:0xb"]);
    });

    it("returns the count of jobs processed.", async () => {
        jobStore.listNonTerminal.mockResolvedValue([buildJob(), buildJob({ sourceTxHash: "0xdef" })]);
        detection.check.mockResolvedValue({ outcome: "WAIT" });

        const result = await service.run();

        expect(result).toEqual({ processed: 2 });
    });
});
