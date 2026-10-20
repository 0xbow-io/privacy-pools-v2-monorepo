import { mock } from "jest-mock-extended";
import { createPublicClient } from "viem";
import { DetectionService } from "./detection.service";
import { DustRescueConfigService } from "../config/dust-rescue-config.service";
import type { DustRescueJob } from "../jobs/job.types";

const getSwapStatus = jest.fn();
jest.mock("@privacy-pools-v2/evm-sdk", () => {
    // Declared inside the factory (not closed over from module scope) — jest.mock
    // factories run at first require-time, before top-level const/class declarations
    // that aren't behind a further-deferred closure like getSwapStatus is here.
    class SwapStatusFailed extends Error {
        readonly retryable: boolean;
        constructor(message: string, retryable = false) {
            super(message);
            this.name = "SwapStatusFailed";
            this.retryable = retryable;
        }
    }
    return {
        LiFiSwapQuoteProvider: jest.fn().mockImplementation(() => ({ getSwapStatus })),
        SwapStatusFailed,
    };
});
// Re-imported off the now-mocked module so tests construct the exact same class
// detection.service.ts's `instanceof SwapStatusFailed` checks against.
const { SwapStatusFailed: FakeSwapStatusFailed } = jest.requireMock("@privacy-pools-v2/evm-sdk") as {
    SwapStatusFailed: new (message: string, retryable?: boolean) => Error & { retryable: boolean };
};

jest.mock("viem", () => {
    const actual = jest.requireActual("viem");
    return { ...actual, createPublicClient: jest.fn() };
});
const mockCreatePublicClient = createPublicClient as jest.Mock;
const getTransactionReceipt = jest.fn();

function buildJob(overrides: Partial<DustRescueJob> = {}): DustRescueJob {
    return {
        sourceTxHash: "0xabc",
        fromChainId: 1,
        destinationChainId: 8453,
        tokenId: "0x0000000000000000000000000000000000000aaa",
        recipientIdentifier: { kind: "raw", spendingPubKey: "0xdead" },
        usdRate: { source: "Curve", microUsdPerWholeTokenX1e18: "0x1" as `0x${string}`, tokenDecimals: 18 },
        state: "AWAITING_DESTINATION",
        attempts: 0,
        createdAt: Date.now(),
        updatedAt: 0,
        ...overrides,
    };
}

describe("DetectionService", () => {
    let config: ReturnType<typeof mock<DustRescueConfigService>>;
    let service: DetectionService;

    beforeEach(() => {
        jest.clearAllMocks();
        mockCreatePublicClient.mockReturnValue({ getTransactionReceipt });
        config = mock<DustRescueConfigService>();
        config.chain.mockReturnValue({
            chainId: 8453,
            rpcUrl: "https://rpc.example.com",
            aspUrl: "https://asp.example.com",
            circuitArtifactsDir: "/artifacts",
            minWorthUsdMicros: 0n,
        } as never);
        config.notFoundAgeOutMs.mockReturnValue(Infinity); // fresh by default; overridden in the age-out tests below
        service = new DetectionService(config);
    });

    it("returns WAIT while LiFi reports PENDING.", async () => {
        getSwapStatus.mockResolvedValue({ status: "PENDING" });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "WAIT" });
    });

    it("returns WAIT while LiFi reports NOT_FOUND.", async () => {
        getSwapStatus.mockResolvedValue({ status: "NOT_FOUND" });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "WAIT" });
    });

    it("returns FAILED when LiFi reports FAILED.", async () => {
        getSwapStatus.mockResolvedValue({ status: "FAILED", substatus: "REFUNDED" });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "FAILED", reason: "REFUNDED" });
    });

    describe("INVALID is not NOT_FOUND — dead on arrival, not aged out (finding #10, Problem C)", () => {
        it("returns FAILED immediately on INVALID, never WAIT.", async () => {
            getSwapStatus.mockResolvedValue({ status: "INVALID" });

            const result = await service.check(buildJob());

            expect(result).toEqual({
                outcome: "FAILED",
                reason: "INVALID: unrecognized or expired transfer",
            });
        });

        it("fails on INVALID even for a brand-new job — no age grace period, unlike NOT_FOUND.", async () => {
            getSwapStatus.mockResolvedValue({ status: "INVALID" });

            const result = await service.check(buildJob({ createdAt: Date.now() }));

            expect(result.outcome).toBe("FAILED");
        });
    });

    describe("genuine NOT_FOUND ages out on job.createdAt, not attempts (finding #10, Problem C)", () => {
        it("stays WAIT while the job is still younger than the configured age-out.", async () => {
            config.notFoundAgeOutMs.mockReturnValue(60_000);
            getSwapStatus.mockResolvedValue({ status: "NOT_FOUND" });

            const result = await service.check(buildJob({ createdAt: Date.now() - 1_000 }));

            expect(result).toEqual({ outcome: "WAIT" });
        });

        it("gives up once the job has outlived the configured age-out.", async () => {
            config.notFoundAgeOutMs.mockReturnValue(60_000);
            getSwapStatus.mockResolvedValue({ status: "NOT_FOUND" });

            const result = await service.check(buildJob({ createdAt: Date.now() - 120_000 }));

            expect(result).toEqual({
                outcome: "FAILED",
                reason: "gave up waiting for the bridge to recognize this transfer",
            });
        });
    });

    describe("a retryable SwapStatusFailed is a WAIT, not a consumed attempt (finding #10, Problem C)", () => {
        it("returns WAIT when the LiFi call throws a retryable SwapStatusFailed.", async () => {
            getSwapStatus.mockRejectedValue(new FakeSwapStatusFailed("LiFi status API returned 503", true));

            const result = await service.check(buildJob());

            expect(result).toEqual({ outcome: "WAIT" });
        });

        it("rethrows a non-retryable SwapStatusFailed instead of swallowing it.", async () => {
            const err = new FakeSwapStatusFailed("LiFi status API returned 400", false);
            getSwapStatus.mockRejectedValue(err);

            await expect(service.check(buildJob())).rejects.toBe(err);
        });

        it("rethrows an error that isn't a SwapStatusFailed at all.", async () => {
            const err = new Error("boom");
            getSwapStatus.mockRejectedValue(err);

            await expect(service.check(buildJob())).rejects.toBe(err);
        });
    });

    it("returns WAIT when DONE but receiving.txHash isn't populated yet.", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: undefined });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "WAIT" });
        expect(getTransactionReceipt).not.toHaveBeenCalled();
    });

    it("returns WAIT when DONE but receiving.amount isn't populated yet.", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest" } });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "WAIT" });
    });

    it("returns FAILED on a malformed receiving.amount (not a crash).", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest", amount: "not-a-number" } });

        const result = await service.check(buildJob());

        expect(result.outcome).toBe("FAILED");
    });

    it("returns FAILED when receiving.amount is 0.", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest", amount: "0" } });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "FAILED", reason: "DONE but reported amount is 0" });
    });

    it("returns FAILED when the receiving tx reverted on-chain.", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest", amount: "42" } });
        getTransactionReceipt.mockResolvedValue({ status: "reverted" });

        const result = await service.check(buildJob());

        expect(result.outcome).toBe("FAILED");
    });

    it("returns READY with the amount straight from LiFi and the receiving tx hash — ERC-20.", async () => {
        getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest", amount: "42" } });
        getTransactionReceipt.mockResolvedValue({ status: "success" });

        const result = await service.check(buildJob());

        expect(result).toEqual({ outcome: "READY", sweptAmount: 42n, receivingTxHash: "0xdest" });
    });

    it("returns READY the same way for a native-asset tokenId — no special-casing needed.", async () => {
        getSwapStatus.mockResolvedValue({
            status: "DONE",
            receiving: { txHash: "0xdest", amount: "1000000000000000000" },
        });
        getTransactionReceipt.mockResolvedValue({ status: "success" });

        const result = await service.check(buildJob({ tokenId: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }));

        expect(result).toEqual({ outcome: "READY", sweptAmount: 10n ** 18n, receivingTxHash: "0xdest" });
    });

    describe("two-leg sum (issue #222 — dust #1 forward tracked alongside dust #2)", () => {
        it("stays single-leg when dust1ForwardTxHash is absent — only one getSwapStatus call.", async () => {
            getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest", amount: "42" } });
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(buildJob());

            expect(result).toEqual({ outcome: "READY", sweptAmount: 42n, receivingTxHash: "0xdest" });
            expect(getSwapStatus).toHaveBeenCalledTimes(1);
        });

        it("sums both legs once both resolve DONE.", async () => {
            getSwapStatus.mockImplementation(({ txHash }: { txHash: string }) =>
                Promise.resolve(
                    txHash === "0xsource"
                        ? { status: "DONE", receiving: { txHash: "0xdest2", amount: "42" } }
                        : { status: "DONE", receiving: { txHash: "0xdest1", amount: "8" } }
                )
            );
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(
                buildJob({
                    sourceTxHash: "0xsource" as `0x${string}`,
                    dust1ForwardTxHash: "0xforward" as `0x${string}`,
                })
            );

            expect(result).toEqual({
                outcome: "READY",
                sweptAmount: 50n,
                receivingTxHash: "0xdest2",
                dust1ReceivingTxHash: "0xdest1",
            });
        });

        it("stays WAIT overall while dust #2 is DONE but dust #1's leg is still pending.", async () => {
            getSwapStatus.mockImplementation(({ txHash }: { txHash: string }) =>
                Promise.resolve(
                    txHash === "0xsource"
                        ? { status: "DONE", receiving: { txHash: "0xdest2", amount: "42" } }
                        : { status: "PENDING" }
                )
            );
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(
                buildJob({
                    sourceTxHash: "0xsource" as `0x${string}`,
                    dust1ForwardTxHash: "0xforward" as `0x${string}`,
                })
            );

            expect(result).toEqual({ outcome: "WAIT" });
        });

        it("proceeds with dust #2 alone when dust #1's leg FAILED — not fatal to the job.", async () => {
            getSwapStatus.mockImplementation(({ txHash }: { txHash: string }) =>
                Promise.resolve(
                    txHash === "0xsource"
                        ? { status: "DONE", receiving: { txHash: "0xdest2", amount: "42" } }
                        : { status: "FAILED", substatus: "REFUNDED" }
                )
            );
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(
                buildJob({
                    sourceTxHash: "0xsource" as `0x${string}`,
                    dust1ForwardTxHash: "0xforward" as `0x${string}`,
                })
            );

            expect(result).toEqual({ outcome: "READY", sweptAmount: 42n, receivingTxHash: "0xdest2" });
        });

        it("never checks dust #1's leg when dust #2 itself hasn't resolved.", async () => {
            getSwapStatus.mockResolvedValue({ status: "PENDING" });

            const result = await service.check(buildJob({ dust1ForwardTxHash: "0xforward" as `0x${string}` }));

            expect(result).toEqual({ outcome: "WAIT" });
            expect(getSwapStatus).toHaveBeenCalledTimes(1);
        });
    });

    describe("same-chain jobs skip the sourceTxHash LiFi-status leg entirely", () => {
        function sameChainJob(overrides: Partial<DustRescueJob> = {}): DustRescueJob {
            return buildJob({ fromChainId: 8453, destinationChainId: 8453, ...overrides });
        }

        it("returns READY with sweptAmount 0 and never calls getSwapStatus when there is no dust1ForwardTxHash.", async () => {
            const result = await service.check(sameChainJob());

            expect(result).toEqual({ outcome: "READY", sweptAmount: 0n, receivingTxHash: "0xabc" });
            expect(getSwapStatus).not.toHaveBeenCalled();
        });

        it("checks the forward leg's own LiFi status, never job.sourceTxHash.", async () => {
            getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest1", amount: "7" } });
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            await service.check(sameChainJob({ dust1ForwardTxHash: "0xforward" as `0x${string}` }));

            expect(getSwapStatus).toHaveBeenCalledTimes(1);
            expect(getSwapStatus).toHaveBeenCalledWith(
                expect.objectContaining({ txHash: "0xforward", fromChainId: 8453, toChainId: 8453 }),
            );
        });

        it("returns WAIT while the forward leg is still pending.", async () => {
            getSwapStatus.mockResolvedValue({ status: "PENDING" });

            const result = await service.check(
                sameChainJob({ dust1ForwardTxHash: "0xforward" as `0x${string}` }),
            );

            expect(result).toEqual({ outcome: "WAIT" });
        });

        it("fails the job when the forward leg fails — this is the only leg a same-chain job has, unlike cross-chain's non-fatal leg 1.", async () => {
            getSwapStatus.mockResolvedValue({ status: "FAILED", substatus: "REFUNDED" });

            const result = await service.check(
                sameChainJob({ dust1ForwardTxHash: "0xforward" as `0x${string}` }),
            );

            expect(result).toEqual({ outcome: "FAILED", reason: "REFUNDED" });
        });

        it("returns READY with the forward leg's own amount and receiving tx hash once it resolves DONE.", async () => {
            getSwapStatus.mockResolvedValue({ status: "DONE", receiving: { txHash: "0xdest1", amount: "7" } });
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(
                sameChainJob({ dust1ForwardTxHash: "0xforward" as `0x${string}` }),
            );

            expect(result).toEqual({ outcome: "READY", sweptAmount: 7n, receivingTxHash: "0xdest1" });
        });
    });

    describe("DONE is not enough — substatus and chain must say the dust actually landed (minr #2)", () => {
        it("returns READY on DONE/COMPLETED with the receiving leg on the destination chain.", async () => {
            getSwapStatus.mockResolvedValue({
                status: "DONE",
                substatus: "COMPLETED",
                receiving: { txHash: "0xdest", chainId: 8453, amount: "42" },
            });
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(buildJob());

            expect(result).toEqual({ outcome: "READY", sweptAmount: 42n, receivingTxHash: "0xdest" });
        });

        it("fails loudly on DONE/PARTIAL — the Executor dropped the whole principal at the fallback, that is not dust.", async () => {
            getSwapStatus.mockResolvedValue({
                status: "DONE",
                substatus: "PARTIAL",
                receiving: { txHash: "0xdest", chainId: 8453, amount: "1000000" },
            });

            const result = await service.check(buildJob());

            expect(result).toEqual({
                outcome: "FAILED",
                reason: "DONE/PARTIAL: not a clean delivery, needs manual handling",
            });
            expect(getTransactionReceipt).not.toHaveBeenCalled();
        });

        it("fails loudly on DONE/REFUNDED instead of chasing the source-chain refund tx on the destination client.", async () => {
            getSwapStatus.mockResolvedValue({
                status: "DONE",
                substatus: "REFUNDED",
                receiving: { txHash: "0xrefund", chainId: 1, amount: "1000000" },
            });

            const result = await service.check(buildJob());

            expect(result).toEqual({
                outcome: "FAILED",
                reason: "DONE/REFUNDED: not a clean delivery, needs manual handling",
            });
            expect(getTransactionReceipt).not.toHaveBeenCalled();
        });

        it("fails when the receiving leg is on a different chain than the job's destination.", async () => {
            getSwapStatus.mockResolvedValue({
                status: "DONE",
                receiving: { txHash: "0xdest", chainId: 1, amount: "42" },
            });

            const result = await service.check(buildJob());

            expect(result).toEqual({
                outcome: "FAILED",
                reason: "receiving leg landed on chain 1, expected 8453",
            });
            expect(getTransactionReceipt).not.toHaveBeenCalled();
        });

        it("keeps waiting when the receiving tx is not yet visible to our destination RPC.", async () => {
            getSwapStatus.mockResolvedValue({
                status: "DONE",
                substatus: "COMPLETED",
                receiving: { txHash: "0xdest", chainId: 8453, amount: "42" },
            });
            const { TransactionReceiptNotFoundError } = jest.requireActual("viem");
            getTransactionReceipt.mockRejectedValue(new TransactionReceiptNotFoundError({ hash: "0xdest" }));

            const result = await service.check(buildJob());

            expect(result).toEqual({ outcome: "WAIT" });
        });

        it("a PARTIAL dust #1 leg is not fatal — the job proceeds on dust #2 alone.", async () => {
            getSwapStatus.mockImplementation(({ txHash }: { txHash: string }) =>
                Promise.resolve(
                    txHash === "0xsource"
                        ? {
                              status: "DONE",
                              substatus: "COMPLETED",
                              receiving: { txHash: "0xdest2", chainId: 8453, amount: "42" },
                          }
                        : {
                              status: "DONE",
                              substatus: "PARTIAL",
                              receiving: { txHash: "0xdest1", chainId: 8453, amount: "7" },
                          }
                )
            );
            getTransactionReceipt.mockResolvedValue({ status: "success" });

            const result = await service.check(
                buildJob({
                    sourceTxHash: "0xsource" as `0x${string}`,
                    dust1ForwardTxHash: "0xforward" as `0x${string}`,
                })
            );

            expect(result).toEqual({ outcome: "READY", sweptAmount: 42n, receivingTxHash: "0xdest2" });
        });
    });
});
