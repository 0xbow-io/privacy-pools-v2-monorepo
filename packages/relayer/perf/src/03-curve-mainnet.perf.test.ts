/**
 * Curve-path tests against a mainnet (chain 1) anvil fork.
 *
 * relayer.perf.config.json flips mainnet USDC/USDT to the Curve quoter, so a
 * chain-1 quote runs the REAL Curve rate-provider path: spot
 * get_aggregated_rate + the 50-block historic self-comparison (eth_blockNumber
 * + historic eth_call). These three calls hit the network on every quote by
 * design (the historic check is the flash-manipulation guard and is never
 * cached) — the optimization targets are:
 *   - warm quote = at most those 3 Curve calls (gas + asset config cached)
 *   - a hanging provider still answers within the deadline budget (the Curve
 *     provider builds its own viem client in rate_provider/utilities.ts, which
 *     previously inherited viem's 40s defaults)
 *
 * First quote on a fresh fork is slow: anvil lazily pulls contract state from
 * the upstream RPC (historic block included). beforeAll warms that up.
 */
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import {
    BASELINE_MODE,
    DEADLINE_BUDGET_MS,
    MAINNET_CHAIN_ID,
    PROXY_MAINNET_URL,
    USDT_MAINNET,
    proxyReset,
    proxySetMode,
    proxyStats,
    record,
    timedQuote,
    transferQuoteBody,
} from "./harness";

// Curve oracle spot-rate calldata: get_aggregated_rate(USDT, WETH).
const CURVE_ORACLE = "0xA834f3d23749233c9B61ba723588570A1cCA0Ed7";
const SPOT_RATE_CALLDATA =
    "0xca1751fa" +
    "000000000000000000000000dac17f958d2ee523a2206206994597c13d831ec7" +
    "000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const HISTORIC_LOOKBACK_BLOCKS = 50n;

async function rawRpc(method: string, params: unknown[]): Promise<unknown> {
    const res = await fetch(PROXY_MAINNET_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(150_000),
    });
    const json = (await res.json()) as { result?: unknown; error?: unknown };
    if (json.error) throw new Error(`warm-up ${method} failed: ${JSON.stringify(json.error)}`);
    return json.result;
}

describe("Curve rate-provider path (mainnet fork)", () => {
    beforeAll(async () => {
        await proxySetMode({ kind: "passthrough" }, PROXY_MAINNET_URL);
        // Warm anvil's fork-state cache with RAW JSON-RPC (no client timeout):
        // on a fresh fork the first oracle read lazily pulls many storage slots
        // from the upstream RPC and takes far longer than the relayer's 2.5s
        // transport timeout. Warm both the latest and the historic block the
        // relayer's guard will read, then one quote to fill gas/asset caches.
        const blockHex = (await rawRpc("eth_blockNumber", [])) as string;
        const historicBlock = BigInt(blockHex) - HISTORIC_LOOKBACK_BLOCKS;
        await rawRpc("eth_call", [{ to: CURVE_ORACLE, data: SPOT_RATE_CALLDATA }, "latest"]);
        await rawRpc("eth_call", [{ to: CURVE_ORACLE, data: SPOT_RATE_CALLDATA }, `0x${historicBlock.toString(16)}`]);
        await timedQuote("transfer", transferQuoteBody(USDT_MAINNET), 150_000, MAINNET_CHAIN_ID);
    }, 180_000);

    afterEach(async () => {
        await proxySetMode({ kind: "passthrough" }, PROXY_MAINNET_URL);
    });

    it("warm Curve quote: only the 3 uncacheable Curve calls hit the RPC", async () => {
        await proxyReset(PROXY_MAINNET_URL);
        const res = await timedQuote("transfer", transferQuoteBody(USDT_MAINNET), 150_000, MAINNET_CHAIN_ID);
        expect(res.status).toBe(201);

        const stats = await proxyStats(PROXY_MAINNET_URL);
        record("curve-transfer-usdt-warm", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
            httpRequests: stats.httpRequests,
            responseMs: Math.round(res.ms),
        });

        if (!BASELINE_MODE) {
            // Spot rate + eth_blockNumber + historic rate. Gas price and asset
            // config must come from their caches (warmed by beforeAll).
            expect(stats.totalRpcCalls).toBeLessThanOrEqual(3);
        }
    });

    it("repeat Curve quote: historic guard still re-reads the chain (never cached)", async () => {
        await proxyReset(PROXY_MAINNET_URL);
        const res = await timedQuote("transfer", transferQuoteBody(USDT_MAINNET), 150_000, MAINNET_CHAIN_ID);
        expect(res.status).toBe(201);

        const stats = await proxyStats(PROXY_MAINNET_URL);
        record("curve-transfer-usdt-repeat", {
            rpcCalls: stats.rpcCalls,
            totalRpcCalls: stats.totalRpcCalls,
        });

        if (!BASELINE_MODE) {
            expect(stats.totalRpcCalls).toBeLessThanOrEqual(3);
            // Fail-closed guard intact: the Curve reads must NOT drop to zero —
            // a fully cached Curve quote would mean the flash-manipulation
            // guard got cached away.
            expect(stats.totalRpcCalls).toBeGreaterThanOrEqual(2);
        }
    });

    it("mainnet provider hangs: Curve quote still answers within the deadline budget", async () => {
        await proxySetMode({ kind: "hang" }, PROXY_MAINNET_URL);

        const res = await timedQuote("transfer", transferQuoteBody(USDT_MAINNET), 150_000, MAINNET_CHAIN_ID);
        record("curve-fault-hang", {
            responseMs: Math.round(res.ms),
            status: res.status,
            budgetMs: DEADLINE_BUDGET_MS,
        });

        if (!BASELINE_MODE) {
            expect(res.ms).toBeLessThanOrEqual(DEADLINE_BUDGET_MS);
            expect(res.status).toBeGreaterThanOrEqual(200);
        }
    });

    it("recovery: Curve quotes work again after passthrough is restored", async () => {
        const res = await timedQuote("transfer", transferQuoteBody(USDT_MAINNET), 150_000, MAINNET_CHAIN_ID);
        expect(res.status).toBe(201);
        record("curve-fault-recovery", { responseMs: Math.round(res.ms), status: res.status });
    });
});
