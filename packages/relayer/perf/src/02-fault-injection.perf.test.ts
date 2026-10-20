/**
 * Fault-injection tests — the regression tests for the "30-60s quote" bug.
 *
 * The proxy simulates a sick RPC provider (hanging sockets, 503s). The
 * assertion is that the relayer answers the client within the deadline budget
 * (PERF_DEADLINE_BUDGET_MS, default 9s) instead of inheriting viem's default
 * 10s-timeout x 4-attempts ~= 40s per RPC call.
 *
 * Expected to FAIL on pre-optimization code. PERF_BASELINE=1 records the
 * (pathological) current numbers instead of failing.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import {
    BASELINE_MODE,
    DEADLINE_BUDGET_MS,
    ETH_ADDRESS,
    GAS_PRICE_TTL_MS,
    proxyReset,
    proxySetMode,
    record,
    sleep,
    timedQuote,
    transferQuoteBody,
} from "./harness";

describe("Fault injection", () => {
    beforeAll(async () => {
        await proxySetMode({ kind: "passthrough" });
        // Let the relayer's gas-price cache (15s TTL) expire so the faulted
        // quote is forced onto the network instead of being served from cache.
        await sleep(GAS_PRICE_TTL_MS + 1_000);
    });

    afterEach(async () => {
        await proxySetMode({ kind: "passthrough" });
    });

    afterAll(async () => {
        await proxySetMode({ kind: "passthrough" });
        await proxyReset();
    });

    it("provider hangs: quote still answers within the deadline budget", async () => {
        await proxySetMode({ kind: "hang" });

        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        record("fault-hang", {
            responseMs: Math.round(res.ms),
            status: res.status,
            budgetMs: DEADLINE_BUDGET_MS,
        });

        if (!BASELINE_MODE) {
            expect(res.ms).toBeLessThanOrEqual(DEADLINE_BUDGET_MS);
            // Any *answer* is acceptable — success (from cache/fallback) or a
            // clean error — as long as the client isn't left hanging.
            expect(res.status).toBeGreaterThanOrEqual(200);
        }
    });

    it("provider returns 503s: quote fails fast, not after retry pileup", async () => {
        await proxySetMode({ kind: "error", statusCode: 503 });

        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        record("fault-error-503", {
            responseMs: Math.round(res.ms),
            status: res.status,
            budgetMs: DEADLINE_BUDGET_MS,
        });

        if (!BASELINE_MODE) {
            expect(res.ms).toBeLessThanOrEqual(DEADLINE_BUDGET_MS);
        }
    });

    it("recovery: passthrough restored, quotes work again", async () => {
        // afterEach already restored passthrough; prove the stack recovered.
        const res = await timedQuote("transfer", transferQuoteBody(ETH_ADDRESS));
        expect(res.status).toBe(201);
        record("fault-recovery", { responseMs: Math.round(res.ms), status: res.status });
    });
});
