import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Hex,
    ISwapProvider,
    SwapStatusRequest,
    SwapStatusResult,
} from "../../../src/internal.js";
import {
    LiFiSwapQuoteProvider,
    PoolSession,
    SwapQuoteProviderBaseError,
    SwapStatusFailed,
} from "../../../src/internal.js";

// --- Constants ---

const MOCK_TX_HASH = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890" as Hex;
const FROM_CHAIN_ID = 42161;
const TO_CHAIN_ID = 10;

// --- LiFi status response fixtures ---

 
function makeLiFiStatusResponse(overrides: Record<string, unknown> = {}) {
    return {
        status: "PENDING",
        substatus: "WAIT_DESTINATION_TRANSACTION",
        substatusMessage: "Waiting for destination chain transaction",
        sending: {
            txHash: MOCK_TX_HASH,
            chainId: FROM_CHAIN_ID,
            txLink: "https://arbiscan.io/tx/" + MOCK_TX_HASH,
            amount: "1000000",
            amountUSD: "1.00",
        },
        receiving: {
            txHash: undefined,
            chainId: TO_CHAIN_ID,
        },
        bridgeExplorerLink: "https://explorer.li.fi/tx/123",
        ...overrides,
    };
}

// --- Tests ---

describe("LiFiSwapQuoteProvider.getSwapStatus", () => {
    let provider: LiFiSwapQuoteProvider;
    let fetchSpy: ReturnType<typeof vi.fn>;

    const baseRequest: SwapStatusRequest = {
        txHash: MOCK_TX_HASH,
        fromChainId: FROM_CHAIN_ID,
        toChainId: TO_CHAIN_ID,
    };

    beforeEach(() => {
        fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        provider = new LiFiSwapQuoteProvider({
            apiUrl: "https://li.quest/v1",
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("return PENDING status with substatus and transaction info", async () => {
        const lifiResponse = makeLiFiStatusResponse();
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => lifiResponse,
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("PENDING");
        expect(result.substatus).toBe("WAIT_DESTINATION_TRANSACTION");
        expect(result.substatusMessage).toBe("Waiting for destination chain transaction");
        expect(result.sending?.txHash).toBe(MOCK_TX_HASH);
        expect(result.sending?.chainId).toBe(FROM_CHAIN_ID);
        expect(result.sending?.amount).toBe("1000000");
        expect(result.receiving?.chainId).toBe(TO_CHAIN_ID);
        expect(result.explorerLink).toBe("https://explorer.li.fi/tx/123");
    });

    it("return DONE status when swap completes", async () => {
        const receivingTx =
            "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () =>
                makeLiFiStatusResponse({
                    status: "DONE",
                    substatus: "COMPLETED",
                    substatusMessage: "Transfer completed",
                    receiving: {
                        txHash: receivingTx,
                        chainId: TO_CHAIN_ID,
                        txLink: "https://optimistic.etherscan.io/tx/" + receivingTx,
                        amount: "990000",
                        amountUSD: "0.99",
                    },
                }),
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("DONE");
        expect(result.substatus).toBe("COMPLETED");
        expect(result.receiving?.txHash).toBe(receivingTx);
        expect(result.receiving?.amount).toBe("990000");
    });

    it("return FAILED status on bridge failure", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () =>
                makeLiFiStatusResponse({
                    status: "FAILED",
                    substatus: "UNKNOWN_ERROR",
                    substatusMessage: "Bridge transaction failed",
                }),
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("FAILED");
        expect(result.substatus).toBe("UNKNOWN_ERROR");
    });

    it("pass INVALID status through unchanged, not folded into NOT_FOUND", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({ status: "INVALID" }),
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("INVALID");
    });

    it("return NOT_FOUND status directly", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({ status: "NOT_FOUND" }),
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("NOT_FOUND");
    });

    it("include bridge param in URL when provided", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => makeLiFiStatusResponse(),
        });

        await provider.getSwapStatus({
            ...baseRequest,
            bridge: "stargateV2",
        });

        const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
        expect(calledUrl.searchParams.get("bridge")).toBe("stargateV2");
        expect(calledUrl.searchParams.get("txHash")).toBe(MOCK_TX_HASH);
        expect(calledUrl.searchParams.get("fromChain")).toBe(FROM_CHAIN_ID.toString());
        expect(calledUrl.searchParams.get("toChain")).toBe(TO_CHAIN_ID.toString());
    });

    it("omit bridge param from URL when not provided", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => makeLiFiStatusResponse(),
        });

        await provider.getSwapStatus(baseRequest);

        const calledUrl = new URL(fetchSpy.mock.calls[0][0] as string);
        expect(calledUrl.searchParams.has("bridge")).toBe(false);
    });

    it("throw a retryable SwapStatusFailed on a 500 HTTP response", async () => {
        fetchSpy.mockResolvedValue({
            ok: false,
            status: 500,
            statusText: "Internal Server Error",
        });

        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow(SwapStatusFailed);
        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow(
            "LiFi status API returned 500: Internal Server Error",
        );
        await expect(provider.getSwapStatus(baseRequest)).rejects.toMatchObject({
            retryable: true,
        });
    });

    it("throw a retryable SwapStatusFailed on a 429 HTTP response", async () => {
        fetchSpy.mockResolvedValue({ ok: false, status: 429, statusText: "Too Many Requests" });

        await expect(provider.getSwapStatus(baseRequest)).rejects.toMatchObject({
            retryable: true,
        });
    });

    it("throw a retryable SwapStatusFailed on a 404 HTTP response (not-yet-indexed, not gone)", async () => {
        fetchSpy.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });

        await expect(provider.getSwapStatus(baseRequest)).rejects.toMatchObject({
            retryable: true,
        });
    });

    it("throw a non-retryable SwapStatusFailed on a 400 HTTP response", async () => {
        fetchSpy.mockResolvedValue({ ok: false, status: 400, statusText: "Bad Request" });

        await expect(provider.getSwapStatus(baseRequest)).rejects.toMatchObject({
            retryable: false,
        });
    });

    it("throw a retryable SwapStatusFailed on network error", async () => {
        fetchSpy.mockRejectedValue(new Error("fetch failed"));

        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow(SwapStatusFailed);
        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow("fetch failed");
        await expect(provider.getSwapStatus(baseRequest)).rejects.toMatchObject({
            retryable: true,
        });
    });

    it("handle response with no sending or receiving info", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({ status: "PENDING" }),
        });

        const result = await provider.getSwapStatus(baseRequest);

        expect(result.status).toBe("PENDING");
        expect(result.sending).toBeUndefined();
        expect(result.receiving).toBeUndefined();
        expect(result.explorerLink).toBeUndefined();
    });

    it("use custom apiUrl from config", async () => {
        const customProvider = new LiFiSwapQuoteProvider({
            apiUrl: "https://custom-api.example.com/v1",
        });

        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => makeLiFiStatusResponse(),
        });

        await customProvider.getSwapStatus(baseRequest);

        const calledUrl = fetchSpy.mock.calls[0][0] as string;
        expect(calledUrl).toContain("https://custom-api.example.com/v1/status");
    });

    it("throw SwapStatusFailed on an unknown status value", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => ({ status: "TOTALLY_NEW_STATUS" }),
        });

        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow(SwapStatusFailed);
        await expect(provider.getSwapStatus(baseRequest)).rejects.toThrow(
            "unknown status: TOTALLY_NEW_STATUS",
        );
    });

    it("send the configured apiKey as the x-lifi-api-key header", async () => {
        const keyedProvider = new LiFiSwapQuoteProvider({
            apiUrl: "https://li.quest/v1",
            apiKey: "secret-key",
        });

        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => makeLiFiStatusResponse(),
        });

        await keyedProvider.getSwapStatus(baseRequest);

        const requestInit = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(requestInit.headers).toEqual({ "x-lifi-api-key": "secret-key" });
    });

    it("omit the api-key header when no apiKey is configured", async () => {
        fetchSpy.mockResolvedValue({
            ok: true,
            json: async () => makeLiFiStatusResponse(),
        });

        await provider.getSwapStatus(baseRequest);

        const requestInit = fetchSpy.mock.calls[0][1] as RequestInit;
        expect(requestInit.headers).toEqual({});
    });
});

// --- PoolSession.getSwapStatus facade tests ---

describe("PoolSession.getSwapStatus facade", () => {
    const baseRequest: SwapStatusRequest = {
        txHash: MOCK_TX_HASH,
        fromChainId: FROM_CHAIN_ID,
        toChainId: TO_CHAIN_ID,
    };

    // Minimal delegates to satisfy PoolSession constructor
    const minimalDelegates = {
        chainId: FROM_CHAIN_ID,
        keystoreInteractor: { exportLeafCache: () => undefined } as never,
        keystore: {} as never,
        export: {} as never,
    };

    it("throw SwapQuoteProviderBaseError when swapProvider delegate not configured", () => {
        const session = new PoolSession(minimalDelegates);

        expect(() => session.getSwapStatus(baseRequest)).toThrow(SwapQuoteProviderBaseError);
        expect(() => session.getSwapStatus(baseRequest)).toThrow(
            "Swap status tracking is not available",
        );
    });

    it("delegate to swapProvider.getSwapStatus when configured", async () => {
        const mockResult: SwapStatusResult = {
            status: "DONE",
            substatus: "COMPLETED",
        };
        const mockSwapProvider: ISwapProvider = {
            getSwapStatus: vi.fn().mockResolvedValue(mockResult),
        };

        const session = new PoolSession({
            ...minimalDelegates,
            swapProvider: mockSwapProvider,
        });

        const result = await session.getSwapStatus(baseRequest);

        expect(result).toBe(mockResult);
        expect(mockSwapProvider.getSwapStatus).toHaveBeenCalledWith(baseRequest);
    });
});
