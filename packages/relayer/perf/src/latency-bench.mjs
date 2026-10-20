#!/usr/bin/env node
/**
 * Latency benchmark for the relayer quote endpoint.
 *
 * Runs from the HOST against the docker-composed perf stack (see compose.yaml;
 * `pnpm stack:up` first). Reports latency percentiles + the proxy's RPC-call
 * counts, and writes results/bench.json for `pnpm bench:save` / `bench:compare`.
 *
 * The relayer throttles quotes at 20/min per client IP (in-memory), so the
 * default request count stays under that. Use --n and --concurrency knowingly:
 * 429s are counted and reported, not silently ignored.
 *
 * Usage:
 *   node src/latency-bench.mjs [--n 15] [--concurrency 1] [--endpoint transfer|send]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3210";
const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:8546";
const CHAIN_ID = process.env.TEST_CHAIN_ID ?? "11155111";
const ETH = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const N = Number(arg("n", 15));
const CONCURRENCY = Number(arg("concurrency", 1));
const ENDPOINT = arg("endpoint", "transfer");

const url = `${RELAYER_URL}/v1/quote/evm/${CHAIN_ID}/${ENDPOINT}`;
const body = JSON.stringify(
    ENDPOINT === "transfer"
        ? { asset: ETH, commit: false }
        : { asset: ETH, amount: "1000000000000000000", recipient: RECIPIENT, extraGas: false, commit: false }
);

async function one() {
    const t0 = performance.now();
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(150_000),
        });
        await res.arrayBuffer();
        return { ms: performance.now() - t0, status: res.status };
    } catch (e) {
        return { ms: performance.now() - t0, status: 0, error: String(e) };
    }
}

function pct(sorted, p) {
    if (sorted.length === 0) return NaN;
    const k = Math.max(0, Math.min(sorted.length - 1, Math.round((p / 100) * (sorted.length - 1))));
    return sorted[k];
}

function summarize(results) {
    const ok = results.filter((r) => r.status === 201);
    const throttled = results.filter((r) => r.status === 429).length;
    const failed = results.length - ok.length - throttled;
    const lats = ok.map((r) => r.ms).sort((a, b) => a - b);
    const mean = lats.reduce((a, b) => a + b, 0) / (lats.length || 1);
    return {
        requests: results.length,
        ok: ok.length,
        throttled,
        failed,
        latencyMs:
            lats.length > 0
                ? {
                      min: +lats[0].toFixed(1),
                      p50: +pct(lats, 50).toFixed(1),
                      p90: +pct(lats, 90).toFixed(1),
                      p95: +pct(lats, 95).toFixed(1),
                      max: +lats[lats.length - 1].toFixed(1),
                      mean: +mean.toFixed(1),
                  }
                : null,
    };
}

async function proxyCtl(path, init) {
    const res = await fetch(`${PROXY_URL}/__perf/${path}`, init);
    return res.json();
}

console.log(`Latency bench: ${url}`);
console.log(`  n=${N} concurrency=${CONCURRENCY}`);

await proxyCtl("mode", { method: "POST", body: JSON.stringify({ kind: "passthrough" }) });

// Cold request measured separately — don't let it skew the warm distribution.
const cold = await one();
console.log(`  cold: ${cold.ms.toFixed(1)} ms (status ${cold.status})`);

await proxyCtl("reset", { method: "POST" });

let results = [];
if (CONCURRENCY <= 1) {
    for (let i = 0; i < N; i++) {
        const r = await one();
        results.push(r);
        process.stdout.write(r.status === 201 ? "." : "x");
    }
    process.stdout.write("\n");
} else {
    let launched = 0;
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (launched < N) {
            launched++;
            const r = await one();
            results.push(r);
            process.stdout.write(r.status === 201 ? "." : "x");
        }
    });
    await Promise.all(workers);
    process.stdout.write("\n");
}

const stats = await proxyCtl("stats");
const summary = summarize(results);
const okCount = summary.ok || 1;

const out = {
    kind: "latency-bench",
    date: new Date().toISOString(),
    config: { n: N, concurrency: CONCURRENCY, endpoint: ENDPOINT, relayerUrl: RELAYER_URL },
    cold: { ms: +cold.ms.toFixed(1), status: cold.status },
    warm: summary,
    rpc: {
        totalRpcCalls: stats.totalRpcCalls,
        rpcCalls: stats.rpcCalls,
        httpRequests: stats.httpRequests,
        rpcCallsPerQuote: +(stats.totalRpcCalls / okCount).toFixed(2),
    },
};

console.log(JSON.stringify(out, null, 4));
if (summary.throttled > 0) {
    console.log(`WARNING: ${summary.throttled} requests throttled (429) — lower --n or wait 60s between runs.`);
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "results");
mkdirSync(resultsDir, { recursive: true });
writeFileSync(join(resultsDir, "bench.json"), JSON.stringify(out, null, 4));
console.log(`written: results/bench.json`);
