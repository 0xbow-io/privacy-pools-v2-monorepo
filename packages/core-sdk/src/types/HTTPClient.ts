import type { ILogger } from "../internal.js";

/**
 * Configuration for the DefaultHTTPClient.
 */
export interface HTTPClientConfig {
    /** Request timeout in milliseconds. Defaults to 15000. */
    timeout?: number;
    /** Number of retry attempts for failed requests. Defaults to 3. */
    retryAttempts?: number;
    /** Delay between retry attempts in milliseconds. Defaults to 500. */
    retryDelay?: number;
    /** Default headers to include in all requests. */
    headers?: Record<string, string>;
}

/**
 * Optional dependencies for the DefaultHTTPClient.
 */
export interface HTTPClientDependencies {
    logger?: ILogger;
}

/**
 * Per-request options that override the client defaults.
 */
export interface HTTPRequestOptions {
    /** Per-request timeout override in milliseconds. */
    timeout?: number;
    /** Per-request header overrides (merged with default headers). */
    headers?: Record<string, string>;
    /** External abort signal. */
    signal?: AbortSignal;
    /**
     * Per-request `fetch` cache mode. Left unset by default, so normal HTTP caching applies —
     * content-addressed fetches (IPFS by CID) benefit from it and can never go stale. Freshness-
     * sensitive endpoints (the ASP root/leaves and other mutable on-chain state) pass "no-store"
     * so a browser HTTP cache cannot serve a stale response. Node/undici currently ignores this.
     */
    cache?: RequestCache;
}
