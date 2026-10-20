import { defineConfig } from "vitest/config";

// The suite shares one rpc-proxy (mutable fault modes / counters) and one
// relayer instance (in-memory throttler: 20 quote req/min) — tests MUST run
// sequentially or counters and throttle budgets bleed between files.
export default defineConfig({
    test: {
        root: "./src",
        include: ["**/*.perf.test.ts"],
        fileParallelism: false,
        testTimeout: 180_000,
        hookTimeout: 60_000,
        env: {
            RELAYER_URL: process.env.RELAYER_URL ?? "http://localhost:3210",
            PROXY_URL: process.env.PROXY_URL ?? "http://localhost:8546",
            PROXY_MAINNET_URL: process.env.PROXY_MAINNET_URL ?? "http://localhost:8547",
            TEST_CHAIN_ID: "11155111",
            API_VERSION: "v1",
            // Set PERF_BASELINE=1 to record current behavior without failing
            // the strict (post-optimization) assertions.
            PERF_BASELINE: process.env.PERF_BASELINE ?? "",
            PERF_DEADLINE_BUDGET_MS: process.env.PERF_DEADLINE_BUDGET_MS ?? "9000",
        },
    },
});
