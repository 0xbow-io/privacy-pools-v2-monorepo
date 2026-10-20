import { getContractCallsQuote } from "@lifi/sdk";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SwapAndDepositQuoteRequest } from "../../../src/internal.js";
import { LiFiSwapQuoteProvider, SwapQuoteFailed } from "../../../src/internal.js";
import {
    acrossLegStep,
    acrossTx,
    BRIDGED_TOKEN,
    decodeAcrossTx,
    DEPOSIT_CALLDATA,
    DEST_TOKEN,
    dexSwap,
    FALLBACK,
    ourCall,
    POOL,
    SRC_TOKEN,
    TX_FULL,
    TX_REDUCED,
} from "../helpers/acrossTestCalldata.js";

vi.mock("@lifi/sdk", () => ({
    createClient: vi.fn(() => ({})),
    getQuote: vi.fn(),
    getContractCallsQuote: vi.fn(),
}));

const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

const lifiStep = (
    data: Hex,
    o: {
        fromAmount: bigint;
        toAmount: bigint;
        legIn: bigint;
        legOut: bigint;
        gasFee?: bigint;
        callAmount: bigint;
        tool?: string;
        fromChainId?: number;
        to?: string;
    },
) => ({
    tool: o.tool ?? "across",
    action: {
        fromToken: { address: SRC_TOKEN },
        toToken: { address: DEST_TOKEN },
        fromChainId: o.fromChainId ?? 10,
        toChainId: 56,
    },
    estimate: {
        fromAmount: o.fromAmount.toString(),
        toAmount: o.toAmount.toString(),
        toAmountMin: o.toAmount.toString(),
        fromAmountUSD: "1",
        toAmountUSD: "1",
        approvalAddress: DIAMOND,
        executionDuration: 60,
    },
    includedSteps: [
        acrossLegStep(o.legIn, o.legOut, o.gasFee ?? 20_000n, BRIDGED_TOKEN, o.tool ?? "across"),
        {
            tool: "custom",
            action: { fromChainId: 56, fromToken: { address: DEST_TOKEN } },
            estimate: { fromAmount: o.callAmount.toString(), toAmount: "0" },
        },
    ],
    transactionRequest: { data, to: o.to ?? DIAMOND, value: "0x0" },
});

const request = (overrides: Partial<SwapAndDepositQuoteRequest> = {}): SwapAndDepositQuoteRequest =>
    ({
        fromChainId: 10,
        toChainId: 56,
        fromToken: SRC_TOKEN,
        toToken: DEST_TOKEN,
        fromAddress: SRC_TOKEN,
        netFromAmount: "1000000",
        depositAmount: "985000",
        poolAddress: POOL,
        depositCalldata: DEPOSIT_CALLDATA,
        fallbackAddress: FALLBACK,
        ...overrides,
    }) as unknown as SwapAndDepositQuoteRequest;

const directTx = acrossTx({
    minAmount: 1_000_000n,
    outputAmount: 990_000n,
    swaps: [ourCall(990_000n, BRIDGED_TOKEN)],
});

const fullSwapTx = acrossTx({
    txId: TX_FULL,
    minAmount: 1_000_000n,
    outputAmount: 990_000n,
    swaps: [dexSwap(990_000n), ourCall(985_000n)],
});
const reducedSwapTx = acrossTx({
    txId: TX_REDUCED,
    minAmount: 990_000n,
    outputAmount: 980_100n,
    swaps: [dexSwap(980_100n), ourCall(975_000n)],
});

const fullSwapStep = lifiStep(fullSwapTx, {
    fromAmount: 1_000_000n,
    toAmount: 985_000n,
    legIn: 1_000_000n,
    legOut: 990_000n,
    callAmount: 985_000n,
});
const reducedSwapStep = (data: Hex = reducedSwapTx, to?: string) =>
    lifiStep(data, {
        fromAmount: 990_000n,
        toAmount: 975_000n,
        legIn: 990_000n,
        legOut: 980_100n,
        callAmount: 975_000n,
        to,
    });

describe("LiFiSwapQuoteProvider Across fill headroom", () => {
    beforeEach(() => {
        vi.mocked(getContractCallsQuote).mockReset();
    });

    it("lower the delivery and the deposit budget when the deposit follows the bridge", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValueOnce(
            lifiStep(directTx, {
                fromAmount: 1_000_000n,
                toAmount: 990_000n,
                legIn: 1_000_000n,
                legOut: 990_000n,
                callAmount: 990_000n,
            }) as never,
        );
        const quote = await new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request());

        expect(getContractCallsQuote).toHaveBeenCalledTimes(1);
        // 20_000 gas fee * 990_000 / 1_000_000 * 50%
        expect(quote.destinationCallAmount).toBe("980100");
        expect(quote.toAmount).toBe("980100");
        expect(quote.toAmountMin).toBe("980100");
        expect(quote.fromAmount).toBe("1000000");
        const d = decodeAcrossTx(quote.transactionData);
        expect(d.across.outputAmount).toBe(980_100n);
        expect(d.payload.swaps[0].fromAmount).toBe(980_100n);
        expect(d.bridgeData.minAmount).toBe(1_000_000n);
    });

    it("combine a second quote when LiFi swaps on the destination before the deposit", async () => {
        vi.mocked(getContractCallsQuote)
            .mockResolvedValueOnce(fullSwapStep as never)
            .mockResolvedValueOnce(reducedSwapStep() as never);
        const quote = await new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request());

        expect(getContractCallsQuote).toHaveBeenCalledTimes(2);
        const [first, second] = vi.mocked(getContractCallsQuote).mock.calls.map((c) => c[1]);
        // 20_000 * 1_000_000 / 1_000_000 * 50% off the input, nothing else changes.
        expect(second).toEqual({ ...first, fromAmount: "990000" });

        expect(quote.fromAmount).toBe("1000000");
        expect(quote.toAmount).toBe("975000");
        expect(quote.toAmountMin).toBe("975000");
        expect(quote.destinationCallAmount).toBe("975000");
        const d = decodeAcrossTx(quote.transactionData);
        expect(d.bridgeData.minAmount).toBe(1_000_000n);
        expect(d.bridgeData.transactionId).toBe(TX_REDUCED);
        expect(d.across.outputAmount).toBe(980_100n);
        expect(d.payload.swaps.map((s) => s.fromAmount)).toEqual([980_100n, 975_000n]);
    });

    it("re-quote in fromAmount mode, dropping toAmount, when the first quote targeted an output", async () => {
        vi.mocked(getContractCallsQuote)
            .mockResolvedValueOnce(fullSwapStep as never)
            .mockResolvedValueOnce(reducedSwapStep() as never);
        await new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(
            request({ netFromAmount: undefined }),
        );
        const [first, second] = vi.mocked(getContractCallsQuote).mock.calls.map((c) => c[1]);
        expect(first).toHaveProperty("toAmount", "985000");
        expect(second).not.toHaveProperty("toAmount");
        const { toAmount: _t, ...rest } = first as unknown as Record<string, unknown>;
        expect(second).toEqual({ ...rest, fromAmount: "990000" });
    });

    it("refuse when the re-quote goes through another router", async () => {
        vi.mocked(getContractCallsQuote)
            .mockResolvedValueOnce(fullSwapStep as never)
            .mockResolvedValueOnce(
                reducedSwapStep(
                    reducedSwapTx,
                    "0x9999999999999999999999999999999999999999",
                ) as never,
            );
        await expect(
            new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request()),
        ).rejects.toBeInstanceOf(SwapQuoteFailed);
    });

    it("refuse when the re-quote takes another bridge", async () => {
        vi.mocked(getContractCallsQuote)
            .mockResolvedValueOnce(fullSwapStep as never)
            .mockResolvedValueOnce(reducedSwapStep("0x12345678") as never);
        await expect(
            new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request()),
        ).rejects.toBeInstanceOf(SwapQuoteFailed);
    });

    it.each([
        ["token", { acrossReceivingAsset: DEST_TOKEN }],
        ["receiver", { acrossReceiver: SRC_TOKEN }],
        ["refund address", { refund: SRC_TOKEN }],
        ["fallback", { payloadReceiver: SRC_TOKEN }],
    ] as const)("refuse when the re-quote has a different %s", async (_, o) => {
        vi.mocked(getContractCallsQuote)
            .mockResolvedValueOnce(fullSwapStep as never)
            .mockResolvedValueOnce(
                reducedSwapStep(
                    acrossTx({
                        txId: TX_REDUCED,
                        minAmount: 990_000n,
                        outputAmount: 980_100n,
                        swaps: [dexSwap(980_100n), ourCall(975_000n)],
                        ...o,
                    }),
                ) as never,
            );
        await expect(
            new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request()),
        ).rejects.toBeInstanceOf(SwapQuoteFailed);
    });

    it("leave a Stargate route as LiFi built it", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValueOnce(
            lifiStep(directTx, {
                fromAmount: 1_000_000n,
                toAmount: 990_000n,
                legIn: 1_000_000n,
                legOut: 990_000n,
                callAmount: 990_000n,
                tool: "stargateV2",
            }) as never,
        );
        const quote = await new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(request());
        expect(getContractCallsQuote).toHaveBeenCalledTimes(1);
        expect(quote.transactionData).toBe(directTx);
        expect(quote.destinationCallAmount).toBe("990000");
    });

    it("leave a same-chain route as LiFi built it", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValueOnce(
            lifiStep(directTx, {
                fromAmount: 1_000_000n,
                toAmount: 990_000n,
                legIn: 1_000_000n,
                legOut: 990_000n,
                callAmount: 990_000n,
                fromChainId: 56,
            }) as never,
        );
        const quote = await new LiFiSwapQuoteProvider({}).getSwapAndDepositQuote(
            request({ fromChainId: 56 } as Partial<SwapAndDepositQuoteRequest>),
        );
        expect(getContractCallsQuote).toHaveBeenCalledTimes(1);
        expect(quote.transactionData).toBe(directTx);
    });
});
