import { getContractCallsQuote, getQuote } from "@lifi/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hex,
    SwapAndDepositQuoteRequest,
    SwapQuoteRequest,
} from "../../../src/internal.js";
import { LiFiSwapQuoteProvider } from "../../../src/internal.js";

vi.mock("@lifi/sdk", () => ({
    createClient: vi.fn(() => ({})),
    getQuote: vi.fn(),
    getContractCallsQuote: vi.fn(),
}));

const A = "0x1111111111111111111111111111111111111111" as Address;
const B = "0x2222222222222222222222222222222222222222" as Address;
const STEP = {
    tool: "across",
    action: {
        fromToken: { address: A },
        toToken: { address: B },
        fromChainId: 10,
        toChainId: 1,
        fromAddress: A,
    },
    estimate: {
        fromAmount: "100",
        toAmount: "99",
        toAmountMin: "98",
        fromAmountUSD: "1",
        toAmountUSD: "1",
        approvalAddress: A,
        executionDuration: 60,
    },
    transactionRequest: { data: "0x1234", to: A, value: "0" },
};

const swapReq = (fromChainId: number, toChainId: number): SwapQuoteRequest =>
    ({
        fromChainId,
        toChainId,
        fromToken: A,
        toToken: B,
        fromAddress: A,
        amount: "100",
        amountType: "from",
    }) as unknown as SwapQuoteRequest;

const depositReq = (fromChainId: number, toChainId: number): SwapAndDepositQuoteRequest =>
    ({
        fromChainId,
        toChainId,
        fromToken: A,
        toToken: B,
        fromAddress: A,
        depositAmount: "99",
        poolAddress: B,
        depositCalldata: "0xabcd" as Hex,
    }) as unknown as SwapAndDepositQuoteRequest;

describe("LiFiSwapQuoteProvider allowBridges", () => {
    beforeEach(() => {
        vi.mocked(getQuote)
            .mockReset()
            .mockResolvedValue(STEP as never);
        vi.mocked(getContractCallsQuote)
            .mockReset()
            .mockResolvedValue(STEP as never);
    });

    it("restrict a cross-chain swap quote to the configured bridges", async () => {
        const provider = new LiFiSwapQuoteProvider({ allowBridges: ["across"] });
        await provider.getSwapQuote(swapReq(10, 1)).catch(() => undefined);
        expect(vi.mocked(getQuote).mock.calls[0][1]).toMatchObject({ allowBridges: ["across"] });
    });

    it("restrict a cross-chain swap-and-deposit quote to the configured bridges", async () => {
        const provider = new LiFiSwapQuoteProvider({ allowBridges: ["across"] });
        await provider.getSwapAndDepositQuote(depositReq(10, 1)).catch(() => undefined);
        expect(vi.mocked(getContractCallsQuote).mock.calls[0][1]).toMatchObject({
            allowBridges: ["across"],
        });
    });

    it("never restrict a same-chain quote", async () => {
        const provider = new LiFiSwapQuoteProvider({ allowBridges: ["across"] });
        await provider.getSwapQuote(swapReq(1, 1)).catch(() => undefined);
        await provider.getSwapAndDepositQuote(depositReq(1, 1)).catch(() => undefined);
        expect(vi.mocked(getQuote).mock.calls[0][1]).not.toHaveProperty("allowBridges");
        expect(vi.mocked(getContractCallsQuote).mock.calls[0][1]).not.toHaveProperty(
            "allowBridges",
        );
    });

    it("leave the bridge to LiFi when not configured", async () => {
        const provider = new LiFiSwapQuoteProvider({});
        await provider.getSwapQuote(swapReq(10, 1)).catch(() => undefined);
        expect(vi.mocked(getQuote).mock.calls[0][1]).not.toHaveProperty("allowBridges");
    });
});
