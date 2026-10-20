/**
 * Shared helpers for the perf suite: proxy control, quote requests with
 * timing, and result recording for baseline snapshots.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const RELAYER_URL = process.env.RELAYER_URL ?? "http://localhost:3210";
export const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:8546";
// Proxy in front of the mainnet (chain 1) anvil fork — the Curve-path tests.
export const PROXY_MAINNET_URL = process.env.PROXY_MAINNET_URL ?? "http://localhost:8547";
export const CHAIN_ID = process.env.TEST_CHAIN_ID ?? "11155111";
export const MAINNET_CHAIN_ID = "1";
export const API_VERSION = process.env.API_VERSION ?? "v1";

/** Baseline mode: record current behavior, skip post-optimization assertions. */
export const BASELINE_MODE = process.env.PERF_BASELINE === "1";
export const DEADLINE_BUDGET_MS = Number(process.env.PERF_DEADLINE_BUDGET_MS ?? 9000);

export const quoteEndpoint = (chainId: string = CHAIN_ID): string =>
    `${RELAYER_URL}/${API_VERSION}/quote/evm/${chainId}`;
export const QUOTE_ENDPOINT = quoteEndpoint();

// Sepolia assets from the committed relayer.config.json (all Mock-quoted).
export const ETH_ADDRESS = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
export const USDC_ADDRESS = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
// Mainnet assets, Curve-quoted in relayer.perf.config.json (chain 1 fork).
export const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
export const RECIPIENT = "0x000000000000000000000000000000000000dEaD";

export interface ProxyStats {
    httpRequests: number;
    batchedHttpRequests: number;
    rpcCalls: Record<string, number>;
    totalRpcCalls: number;
}

export async function proxyReset(proxyUrl: string = PROXY_URL): Promise<void> {
    await fetch(`${proxyUrl}/__perf/reset`, { method: "POST" });
}

export async function proxyStats(proxyUrl: string = PROXY_URL): Promise<ProxyStats> {
    const res = await fetch(`${proxyUrl}/__perf/stats`);
    return (await res.json()) as ProxyStats;
}

export async function proxySetMode(
    mode: {
        kind: "passthrough" | "delay" | "error" | "hang";
        latencyMs?: number;
        statusCode?: number;
        methods?: string[];
    },
    proxyUrl: string = PROXY_URL
): Promise<void> {
    const res = await fetch(`${proxyUrl}/__perf/mode`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(mode),
    });
    if (!res.ok) throw new Error(`proxy mode change failed: ${res.status} ${await res.text()}`);
}

export interface TimedResponse {
    status: number;
    ms: number;
    body: unknown;
}

/** POST a quote request, measuring wall-clock ms. Never throws on HTTP errors. */
export async function timedQuote(
    path: "transfer" | "send",
    body: Record<string, unknown>,
    timeoutMs = 150_000,
    chainId: string = CHAIN_ID
): Promise<TimedResponse> {
    const t0 = performance.now();
    const res = await fetch(`${quoteEndpoint(chainId)}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = performance.now() - t0;
    let parsed: unknown = null;
    try {
        parsed = await res.json();
    } catch {
        // non-JSON error body — fine
    }
    return { status: res.status, ms, body: parsed };
}

export function transferQuoteBody(asset: string = ETH_ADDRESS): Record<string, unknown> {
    return { asset, commit: false };
}

export function sendQuoteBody(asset: string = ETH_ADDRESS): Record<string, unknown> {
    return {
        asset,
        // 1 ETH (18 dec) — must comfortably exceed the relay fee on the fork,
        // or the quote 400s with "Relay fee exceeds withdrawal amount".
        amount: "1000000000000000000",
        recipient: RECIPIENT,
        extraGas: false,
        commit: false,
    };
}

const RESULTS_DIR = join(import.meta.dirname, "..", "results");

/**
 * Record a scenario's measurements to results/<scenario>.json so bench:save
 * can fold test-derived metrics (RPC counts, fault-response times) into the
 * dated baseline snapshot alongside the latency benchmark.
 */
export function record(scenario: string, data: Record<string, unknown>): void {
    mkdirSync(RESULTS_DIR, { recursive: true });
    writeFileSync(
        join(RESULTS_DIR, `${scenario}.json`),
        JSON.stringify({ scenario, recordedAt: new Date().toISOString(), ...data }, null, 4)
    );
    console.log(`[perf] ${scenario}: ${JSON.stringify(data)}`);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The relayer's module-level gas price cache TTL (evm.chain.service.ts). */
export const GAS_PRICE_TTL_MS = 15_000;
