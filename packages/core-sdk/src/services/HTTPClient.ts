import type {
    HTTPClientConfig,
    HTTPClientDependencies,
    HTTPRequestOptions,
    IHTTPClient,
    ILogger,
} from "../internal.js";
import {
    HTTPClientConfigSchema,
    HTTPRequestFailed,
    HTTPResponseError,
    sleep,
} from "../internal.js";

/**
 * Default HTTP client with retry logic, timeout via AbortController, and JSON parsing.
 * Extracted from the HTTP patterns in RelayerInteractor for reuse across services.
 */
export class HTTPClient implements IHTTPClient {
    private readonly timeout: number;
    private readonly retryAttempts: number;
    private readonly retryDelay: number;
    private readonly headers: Record<string, string>;
    private readonly logger?: ILogger;

    /**
     * Creates a new DefaultHTTPClient instance.
     * @param config - Optional configuration for timeout, retries, and default headers.
     * @param dependencies - Optional dependencies (logger).
     * @throws {HTTPRequestFailed} If the configuration is invalid.
     */
    constructor(config?: HTTPClientConfig, dependencies?: HTTPClientDependencies) {
        const validated = HTTPClientConfigSchema.safeParse(config ?? {});
        if (!validated.success) {
            throw new HTTPRequestFailed(
                `DefaultHTTPClient initialization error: ${validated.error.issues[0]!.message}`,
            );
        }

        this.timeout = validated.data.timeout;
        this.retryAttempts = validated.data.retryAttempts;
        this.retryDelay = validated.data.retryDelay;
        this.headers = validated.data.headers ?? { "Content-Type": "application/json" };
        this.logger = dependencies?.logger;
    }

    /**
     * @inheritdoc IHTTPClient.get
     * @throws {HTTPRequestFailed} If the request fails after all retry attempts.
     * @throws {HTTPResponseError} If the server returns a non-ok status code.
     */
    async get<T>(url: string, options?: HTTPRequestOptions): Promise<T> {
        return this.request<T>(url, { method: "GET" }, options);
    }

    /**
     * @inheritdoc IHTTPClient.post
     * @throws {HTTPRequestFailed} If the request fails after all retry attempts.
     * @throws {HTTPResponseError} If the server returns a non-ok status code.
     */
    async post<T>(url: string, body: unknown, options?: HTTPRequestOptions): Promise<T> {
        return this.request<T>(
            url,
            {
                method: "POST",
                body: JSON.stringify(body),
            },
            options,
        );
    }

    /**
     * @inheritdoc IHTTPClient.getBinary
     * @throws {HTTPRequestFailed} If the request fails after all retry attempts.
     * @throws {HTTPResponseError} If the server returns a non-ok status code.
     */
    async getBinary(url: string, options?: HTTPRequestOptions): Promise<Uint8Array> {
        return this.request<Uint8Array>(url, { method: "GET" }, options, "binary");
    }

    private async request<T>(
        url: string,
        init: RequestInit,
        options?: HTTPRequestOptions,
        parseAs: "json" | "binary" = "json",
    ): Promise<T> {
        let lastError: Error | undefined;
        const requestTimeout = options?.timeout ?? this.timeout;
        const mergedHeaders = { ...this.headers, ...options?.headers };

        for (let attempt = 0; attempt <= this.retryAttempts; attempt++) {
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), requestTimeout);

                // If an external signal is provided, forward its abort
                if (options?.signal) {
                    if (options.signal.aborted) {
                        controller.abort();
                    } else {
                        options.signal.addEventListener("abort", () => controller.abort(), {
                            once: true,
                        });
                    }
                }

                const response = await fetch(url, {
                    ...init,
                    headers: mergedHeaders,
                    signal: controller.signal,
                    // Per-request, not blanket. Freshness-sensitive callers (ASP root/leaves) pass
                    // "no-store" so a browser HTTP cache cannot serve a stale set; content-addressed
                    // IPFS fetches leave it unset so immutable bytes stay cacheable. Undefined means
                    // the platform default.
                    cache: options?.cache,
                });

                if (!response.ok) {
                    // The body usually names the reason (validation issues,
                    // misroutes); see HTTPResponseError. Read it before
                    // disarming the timeout so a stalled stream still aborts.
                    const errorBody = await response.text().catch(() => undefined);
                    clearTimeout(timeoutId);
                    throw new HTTPResponseError(response.status, response.statusText, errorBody);
                }

                // Keep the AbortController armed for the body read. Headers
                // can arrive within the timeout while the body stream stalls
                // for far longer (CDN drip, slow undici reads); clearing the
                // timer too early let the request hang indefinitely
                // (sub-2040). The finally block disarms it on completion.
                try {
                    if (parseAs === "binary") {
                        return new Uint8Array(await response.arrayBuffer()) as T;
                    }
                    return (await response.json()) as T;
                } finally {
                    clearTimeout(timeoutId);
                }
            } catch (error) {
                if (error instanceof HTTPResponseError) {
                    throw error;
                }

                lastError = error instanceof Error ? error : new Error(String(error));

                if (attempt < this.retryAttempts) {
                    this.logger?.debug("Request failed, retrying...", {
                        attempt: attempt + 1,
                        url,
                        error: lastError.message,
                    });
                    await sleep(this.retryDelay);
                }
            }
        }

        throw new HTTPRequestFailed(lastError!.message);
    }
}
