import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getContractCallsQuote, getQuote } from "@lifi/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    SwapAndDepositQuoteRequest,
    SwapQuoteRequest,
} from "../../../src/internal.js";
import {
    EMPTY_ADDRESS,
    LiFiSwapQuoteProvider,
    NATIVE_ASSET_ADDRESS,
} from "../../../src/internal.js";

// Replace the LiFi SDK network layer so getSwapQuote / getSwapAndDepositQuote
// replay recorded real responses instead of hitting the API. `createClient` runs
// in the provider constructor. (vi.mock is hoisted above the imports above.)
vi.mock("@lifi/sdk", () => ({
    createClient: vi.fn(() => ({})),
    getQuote: vi.fn(),
    getContractCallsQuote: vi.fn(),
}));

// --- Fixture loading ---
//
// The recorded LiFi responses in packages/swaps/test are JS object-literal dumps
// (console output of a LiFiStep) — unquoted keys, single quotes, BigNumber
// { s, e, c } shapes — so they are NOT strict JSON. Evaluate them to reconstruct
// the exact object the LiFi SDK would have returned, then replay it. This is a
// genuine fixture replay (not a hand-built mock), which is the point per TEST-7:
// it exercises the provider's real response parsing against real bytes.

// Strongly-typed subset of a LiFiStep covering only the fields the provider reads.
interface FixtureToken { address: string }
interface LiFiStepFixture {
    tool: string;
    action: {
        fromToken: FixtureToken;
        toToken: FixtureToken;
        fromChainId: number;
        toChainId: number;
        fromAddress: string;
    };
    estimate: {
        fromAmount: string;
        toAmount: string;
        toAmountMin: string;
        fromAmountUSD: string;
        toAmountUSD: string;
        approvalAddress: string;
        executionDuration: number;
    };
    transactionRequest: { data: string; to: string; value: string };
}

function loadFixture(name: string): LiFiStepFixture {
    const path = fileURLToPath(new URL(`../../../../swaps/test/${name}`, import.meta.url));
    const raw = readFileSync(path, "utf8");
     
    return new Function(`return (${raw});`)() as LiFiStepFixture;
}

const SWAP_FIXTURE = loadFixture("full_swap_response.json");
const SWAP_AND_DEPOSIT_FIXTURE = loadFixture("full_swap_and_contract_response.json");

// --- Tests ---

describe("LiFiSwapQuoteProvider.getSwapQuote (fixture replay)", () => {
    let provider: LiFiSwapQuoteProvider;

    beforeEach(() => {
        vi.mocked(getQuote).mockReset();
        vi.mocked(getContractCallsQuote).mockReset();
        provider = new LiFiSwapQuoteProvider({ apiUrl: "https://li.quest/v1" });
    });

    function swapRequest(overrides?: Partial<SwapQuoteRequest>): SwapQuoteRequest {
        return {
            fromChainId: 42161,
            toChainId: 10,
            fromToken: SWAP_FIXTURE.action.fromToken.address as Address,
            toToken: SWAP_FIXTURE.action.toToken.address as Address,
            fromAddress: SWAP_FIXTURE.action.fromAddress as Address,
            amount: "1000000",
            amountType: "from",
            ...overrides,
        };
    }

    it("parse a recorded swap response into the SDK quote shape", async () => {
        vi.mocked(getQuote).mockResolvedValue(SWAP_FIXTURE as never);

        const result = await provider.getSwapQuote(swapRequest());

        const { estimate, transactionRequest, tool } = SWAP_FIXTURE;
        expect(result.fromAmount).toBe(estimate.fromAmount);
        expect(result.toAmount).toBe(estimate.toAmount);
        expect(result.toAmountMin).toBe(estimate.toAmountMin);
        expect(result.fromAmountUSD).toBe(estimate.fromAmountUSD);
        expect(result.toAmountUSD).toBe(estimate.toAmountUSD);
        expect(result.approvalAddress).toBe(estimate.approvalAddress);
        expect(result.transactionData).toBe(transactionRequest.data);
        expect(result.transactionTo).toBe(transactionRequest.to);
        expect(result.estimatedDuration).toBe(estimate.executionDuration);
        expect(result.tool).toBe(tool);
    });

    it("echo the from/to tokens and chains LiFi actually routed", async () => {
        vi.mocked(getQuote).mockResolvedValue(SWAP_FIXTURE as never);

        const result = await provider.getSwapQuote(swapRequest());

        const { action } = SWAP_FIXTURE;
        expect(result.fromTokenAddress).toBe(action.fromToken.address);
        expect(result.toTokenAddress).toBe(action.toToken.address);
        expect(result.fromChainId).toBe(action.fromChainId);
        expect(result.toChainId).toBe(action.toChainId);
    });

    it("canonicalise LiFi's zero-address echo of native to NATIVE_ASSET_ADDRESS", async () => {
        // LiFi accepts 0xEeee… on the request but always echoes native as the zero
        // address in step.action. The provider rewrites it at the boundary so no
        // SwapQuoteResult carries LiFi's spelling downstream.
        const nativeEcho = {
            ...SWAP_FIXTURE,
            action: {
                ...SWAP_FIXTURE.action,
                fromToken: { ...SWAP_FIXTURE.action.fromToken, address: EMPTY_ADDRESS },
                toToken: { ...SWAP_FIXTURE.action.toToken, address: EMPTY_ADDRESS },
            },
        };
        vi.mocked(getQuote).mockResolvedValue(nativeEcho as never);

        const result = await provider.getSwapQuote(swapRequest({ toToken: NATIVE_ASSET_ADDRESS }));

        expect(result.fromTokenAddress).toBe(NATIVE_ASSET_ADDRESS);
        expect(result.toTokenAddress).toBe(NATIVE_ASSET_ADDRESS);
    });

    it("surface the raw routed toToken so a caller cross-check can detect drift", async () => {
        // The fixture routes to DAI on chain 10. A caller who requested a different
        // toToken sees the provider echo the ACTUAL routed token (not the request),
        // which is exactly what the session-level SwapQuoteMismatch check compares.
        // (SwapQuoteMismatch itself is asserted at the session boundary in
        //  PoolSessionReshield.test.ts / PoolSessionWithdrawAndSwap.test.ts.)
        vi.mocked(getQuote).mockResolvedValue(SWAP_FIXTURE as never);
        const requestedToToken = "0x1111111111111111111111111111111111111111" as Address;

        const result = await provider.getSwapQuote(swapRequest({ toToken: requestedToToken }));

        expect(result.toTokenAddress).toBe(SWAP_FIXTURE.action.toToken.address);
        expect(result.toTokenAddress).not.toBe(requestedToToken);
    });

    it("throw when the recorded response carries no transaction data", async () => {
        const noTxData = { ...SWAP_FIXTURE, transactionRequest: undefined };
        vi.mocked(getQuote).mockResolvedValue(noTxData as never);

        await expect(provider.getSwapQuote(swapRequest())).rejects.toThrow(
            "did not return transaction data",
        );
    });
});

describe("LiFiSwapQuoteProvider.getSwapAndDepositQuote (fixture replay)", () => {
    let provider: LiFiSwapQuoteProvider;

    beforeEach(() => {
        vi.mocked(getQuote).mockReset();
        vi.mocked(getContractCallsQuote).mockReset();
        provider = new LiFiSwapQuoteProvider({ apiUrl: "https://li.quest/v1" });
    });

    function depositRequest(): SwapAndDepositQuoteRequest {
        return {
            fromChainId: 42161,
            toChainId: 10,
            fromToken: SWAP_AND_DEPOSIT_FIXTURE.action.fromToken.address as Address,
            toToken: SWAP_AND_DEPOSIT_FIXTURE.action.toToken.address as Address,
            fromAddress: SWAP_AND_DEPOSIT_FIXTURE.action.fromAddress as Address,
            depositAmount: "100000000",
            depositCalldata: "0xdeadbeef",
            poolAddress: "0x9999999999999999999999999999999999999991" as Address,
        };
    }

    it("parse a recorded contract-calls response into the SDK quote shape", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValue(SWAP_AND_DEPOSIT_FIXTURE as never);

        const result = await provider.getSwapAndDepositQuote(depositRequest());

        const { estimate, transactionRequest } = SWAP_AND_DEPOSIT_FIXTURE;
        expect(result.fromAmount).toBe(estimate.fromAmount);
        expect(result.toAmount).toBe(estimate.toAmount);
        expect(result.fromAmountUSD).toBe(estimate.fromAmountUSD);
        expect(result.toAmountUSD).toBe(estimate.toAmountUSD);
        expect(result.approvalAddress).toBe(estimate.approvalAddress);
        expect(result.transactionData).toBe(transactionRequest.data);
        expect(result.transactionTo).toBe(transactionRequest.to);
        expect(result.transactionValue).toBe(transactionRequest.value);
        expect(result.estimatedDuration).toBe(estimate.executionDuration);
    });

    it("surface the route's toAmountMin and the custom step's fromAmount as destinationCallAmount", async () => {
        const toChainId = SWAP_AND_DEPOSIT_FIXTURE.action.toChainId;
        const withSteps = {
            ...SWAP_AND_DEPOSIT_FIXTURE,
            estimate: { ...SWAP_AND_DEPOSIT_FIXTURE.estimate, toAmountMin: "11212681051733038918" },
            includedSteps: [
                {
                    tool: "across",
                    action: { fromChainId: 1, toChainId },
                    estimate: { fromAmount: "1" },
                },
                {
                    tool: "bitget",
                    action: { fromChainId: toChainId, toChainId },
                    estimate: { fromAmount: "2" },
                },
                // LiFi's own encoding of our destination call: the route's guaranteed delivery.
                {
                    tool: "custom",
                    action: { fromChainId: toChainId, toChainId },
                    estimate: { fromAmount: "11212681051733038918" },
                },
            ],
        };
        vi.mocked(getContractCallsQuote).mockResolvedValue(withSteps as never);

        const result = await provider.getSwapAndDepositQuote(depositRequest());

        expect(result.toAmountMin).toBe("11212681051733038918");
        expect(result.destinationCallAmount).toBe("11212681051733038918");
    });

    it("leave destinationCallAmount unset when the response carries no custom step", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValue({
            ...SWAP_AND_DEPOSIT_FIXTURE,
            includedSteps: [],
        } as never);

        const result = await provider.getSwapAndDepositQuote(depositRequest());

        expect(result.destinationCallAmount).toBeUndefined();
    });

    it("echo the from/to tokens and chains LiFi actually routed", async () => {
        vi.mocked(getContractCallsQuote).mockResolvedValue(SWAP_AND_DEPOSIT_FIXTURE as never);

        const result = await provider.getSwapAndDepositQuote(depositRequest());

        const { action } = SWAP_AND_DEPOSIT_FIXTURE;
        expect(result.fromTokenAddress).toBe(action.fromToken.address);
        expect(result.toTokenAddress).toBe(action.toToken.address);
        expect(result.fromChainId).toBe(action.fromChainId);
        expect(result.toChainId).toBe(action.toChainId);
    });

    it("canonicalise LiFi's zero-address echo of native to NATIVE_ASSET_ADDRESS", async () => {
        const nativeEcho = {
            ...SWAP_AND_DEPOSIT_FIXTURE,
            action: {
                ...SWAP_AND_DEPOSIT_FIXTURE.action,
                fromToken: { ...SWAP_AND_DEPOSIT_FIXTURE.action.fromToken, address: EMPTY_ADDRESS },
                toToken: { ...SWAP_AND_DEPOSIT_FIXTURE.action.toToken, address: EMPTY_ADDRESS },
            },
        };
        vi.mocked(getContractCallsQuote).mockResolvedValue(nativeEcho as never);

        const result = await provider.getSwapAndDepositQuote(depositRequest());

        expect(result.fromTokenAddress).toBe(NATIVE_ASSET_ADDRESS);
        expect(result.toTokenAddress).toBe(NATIVE_ASSET_ADDRESS);
    });

    it("throw when the recorded contract-calls response carries no transaction data", async () => {
        const noTxData = { ...SWAP_AND_DEPOSIT_FIXTURE, transactionRequest: undefined };
        vi.mocked(getContractCallsQuote).mockResolvedValue(noTxData as never);

        await expect(provider.getSwapAndDepositQuote(depositRequest())).rejects.toThrow(
            "did not return transaction data",
        );
    });
});
