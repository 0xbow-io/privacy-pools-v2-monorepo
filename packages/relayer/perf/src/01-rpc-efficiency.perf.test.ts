/**
 * RPC-efficiency regression tests — deterministic, timing-free.
 *
 * These encode the optimization targets as exact RPC-call counts observed at
 * the proxy. They are expected to FAIL on pre-optimization code (that's the
 * point); run with PERF_BASELINE=1 to record current behavior without failing.
 *
 * Keep the whole file's quote count low: the relayer throttles quotes at
 * 20/min per client IP (in-memory). This file issues 6.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
    BASELINE_MODE,
    ETH_ADDRESS,
    USDC_ADDRESS,
    proxyReset,
    proxySetMode,
    proxyStats,
    record,
    sendQuoteBody,
    timedQuote,
    transferQuoteBody,
} from "./harness";

function expectNotThrottled(status: number) {
    if (status === 429) {
        throw new Error(
            "Quote throttled (429): the relayer allows 20 quotes/min. " +
                "Wait 60s (or `pnpm stack:restart-relayer`) and rerun."
        );
    }
}

describe("RPC efficiency", () => {
    beforeAll(async () => {
        await proxySetMode({ kind: "passthrough" });
        await proxyReset();
    });

    it("transfer quote (ETH): at most 2 RPC round trips, even cold", async () => {
        await proxyReset();
        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);

        const stats = await proxyStats();
        record("rpc-transfer-eth-cold", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
            httpRequests: stats.httpRequests,
            batchedHttpRequests: stats.batchedHttpRequests,
        });

        if (!BASELINE_MODE) {
            // Optimized target: gas price + asset config at most; batched
            // transport should coalesce them into a single HTTP request.
            expect(stats.totalRpcCalls).toBeLessThanOrEqual(2);
            expect(stats.httpRequests).toBeLessThanOrEqual(2);
        }
    });

    it("repeat transfer quote (ETH): fully served from caches — zero RPC", async () => {
        await proxyReset();
        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);

        const stats = await proxyStats();
        record("rpc-transfer-eth-warm", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
        });

        if (!BASELINE_MODE) {
            // Gas price cache (15s TTL) + asset-config cache -> no RPC at all.
            expect(stats.totalRpcCalls).toBe(0);
        }
    });

    it("send quote (ETH): warm path needs zero RPC", async () => {
        await proxyReset();
        const res = await timedQuote("send", sendQuoteBody(ETH_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);

        const stats = await proxyStats();
        record("rpc-send-eth-warm", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
        });

        if (!BASELINE_MODE) {
            expect(stats.totalRpcCalls).toBe(0);
        }
    });

    it("send quote (USDC): first sight of the asset costs at most 1 eth_call", async () => {
        await proxyReset();
        const res = await timedQuote("send", sendQuoteBody(USDC_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);

        const stats = await proxyStats();
        record("rpc-send-usdc-cold-asset", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
        });

        if (!BASELINE_MODE) {
            // Gas price is cached from earlier tests; USDC's assets() config
            // is not yet cached, so exactly one eth_call is allowed. The Mock
            // rate provider makes no network calls.
            expect(stats.totalRpcCalls).toBeLessThanOrEqual(1);
        }
    });

    it("repeat send quote (USDC): zero RPC once the asset config is cached", async () => {
        await proxyReset();
        const res = await timedQuote("send", sendQuoteBody(USDC_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);

        const stats = await proxyStats();
        record("rpc-send-usdc-warm", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
        });

        if (!BASELINE_MODE) {
            expect(stats.totalRpcCalls).toBe(0);
        }
    });

    it("quote responses stay correct while cached (sanity)", async () => {
        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        expectNotThrottled(res.status);
        expect(res.status).toBe(201);
        const body = res.body as Record<string, unknown>;
        expect(body).toHaveProperty("txCost");
        expect(body).toHaveProperty("gasPrice");
        expect(body).toHaveProperty("feeAmount");
    });
});
