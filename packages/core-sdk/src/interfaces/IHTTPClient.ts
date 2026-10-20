import type { HTTPRequestOptions } from "../internal.js";

/**
 * Interface for performing HTTP requests with built-in retry and timeout logic.
 */
export interface IHTTPClient {
    /**
     * Performs an HTTP GET request and returns parsed JSON.
     * @param url - The URL to fetch.
     * @param options - Optional per-request overrides (timeout, headers, signal).
     * @returns The parsed JSON response.
     * @throws {HTTPClientBaseError}
     */
    get<T>(url: string, options?: HTTPRequestOptions): Promise<T>;

    /**
     * Performs an HTTP POST request and returns parsed JSON.
     * @param url - The URL to post to.
     * @param body - The request body to send (will be JSON-serialized).
     * @param options - Optional per-request overrides (timeout, headers, signal).
     * @returns The parsed JSON response.
     * @throws {HTTPClientBaseError}
     */
    post<T>(url: string, body: unknown, options?: HTTPRequestOptions): Promise<T>;

    /**
     * Performs an HTTP GET request and returns the raw response bytes.
     * @param url - The URL to fetch.
     * @param options - Optional per-request overrides (timeout, headers, signal).
     * @returns The response body as a Uint8Array.
     * @throws {HTTPClientBaseError}
     */
    getBinary(url: string, options?: HTTPRequestOptions): Promise<Uint8Array>;
}
