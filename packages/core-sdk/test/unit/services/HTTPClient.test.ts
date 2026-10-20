import { beforeEach, describe, expect, it, vi } from "vitest";

import { HTTPClient, HTTPRequestFailed, HTTPResponseError } from "../../../src/internal.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function createMockResponse(body: unknown, ok = true, status = 200, statusText?: string): Response {
    return {
        ok,
        status,
        statusText: statusText ?? (ok ? "OK" : "Internal Server Error"),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(body === null ? "" : JSON.stringify(body)),
    } as Response;
}

function createMockBinaryResponse(
    bytes: Uint8Array,
    ok = true,
    status = 200,
    statusText?: string,
): Response {
    return {
        ok,
        status,
        statusText: statusText ?? (ok ? "OK" : "Internal Server Error"),
        arrayBuffer: () =>
            Promise.resolve(
                bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
            ),
        text: () => Promise.resolve(""),
    } as Response;
}

describe("HTTPClient", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    describe("constructor", () => {
        it("apply defaults when no config provided", () => {
            expect(() => new HTTPClient()).not.toThrow();
        });

        it("accept valid config", () => {
            expect(
                () =>
                    new HTTPClient({
                        timeout: 5000,
                        retryAttempts: 2,
                        retryDelay: 100,
                    }),
            ).not.toThrow();
        });

        it("throw HTTPRequestFailed for invalid config", () => {
            expect(() => new HTTPClient({ timeout: -1 })).toThrow(HTTPRequestFailed);
        });
    });

    describe("get", () => {
        it("return parsed JSON on success", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            const data = { message: "hello" };
            mockFetch.mockResolvedValueOnce(createMockResponse(data));

            const result = await client.get<{ message: string }>("https://api.example.com/data");

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.example.com/data",
                expect.objectContaining({ method: "GET" }),
            );
        });

        it("forward a per-request cache mode so freshness-sensitive callers can opt into no-store", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.get("https://api.example.com/association-set/root", {
                cache: "no-store",
            });

            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.example.com/association-set/root",
                expect.objectContaining({ cache: "no-store" }),
            );
        });

        it("leave cache unset by default so content-addressed responses stay cacheable", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            await client.get("https://ipfs.example.com/bafyCID");

            expect(mockFetch).toHaveBeenCalledWith(
                "https://ipfs.example.com/bafyCID",
                expect.objectContaining({ cache: undefined }),
            );
        });

        it("throw HTTPResponseError on non-ok status", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 404, "Not Found"));

            await expect(client.get("https://api.example.com/data")).rejects.toThrow(
                HTTPResponseError,
            );

            try {
                mockFetch.mockResolvedValueOnce(
                    createMockResponse(null, false, 500, "Internal Server Error"),
                );
                await client.get("https://api.example.com/data");
            } catch (error) {
                expect(error).toBeInstanceOf(HTTPResponseError);
                expect((error as HTTPResponseError).status).toBe(500);
                expect((error as HTTPResponseError).statusText).toBe("Internal Server Error");
            }
        });

        it("surface the error response body in HTTPResponseError", async () => {
            // Status alone hides the reason — a relayer 400 carries the
            // actual revert/validation message in the body.
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(
                createMockResponse(
                    { message: "Relay failed: PoolVault_ProofContextMismatch()" },
                    false,
                    400,
                    "Bad Request",
                ),
            );

            await expect(client.get("https://relayer.example.com/relay")).rejects.toThrow(
                /PoolVault_ProofContextMismatch/,
            );
        });

        it("throw HTTPRequestFailed on network error", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockRejectedValueOnce(new Error("Network error"));

            await expect(client.get("https://api.example.com/data")).rejects.toThrow(
                HTTPRequestFailed,
            );
        });

        it("retry on transient failure then succeed", async () => {
            const client = new HTTPClient({ retryAttempts: 2, retryDelay: 0 });
            const data = { success: true };

            mockFetch
                .mockRejectedValueOnce(new Error("Transient error"))
                .mockRejectedValueOnce(new Error("Transient error"))
                .mockResolvedValueOnce(createMockResponse(data));

            const result = await client.get<{ success: boolean }>("https://api.example.com/data");

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledTimes(3);
        });

        it("respect timeout (abort)", async () => {
            const client = new HTTPClient({ timeout: 1, retryAttempts: 0 });

            mockFetch.mockImplementationOnce(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => {
                            reject(new DOMException("The operation was aborted.", "AbortError"));
                        });
                    }),
            );

            await expect(client.get("https://api.example.com/slow")).rejects.toThrow(
                HTTPRequestFailed,
            );
        });

        it("respect per-request timeout override", async () => {
            const client = new HTTPClient({ timeout: 60000, retryAttempts: 0 });

            mockFetch.mockImplementationOnce(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => {
                            reject(new DOMException("The operation was aborted.", "AbortError"));
                        });
                    }),
            );

            await expect(
                client.get("https://api.example.com/slow", { timeout: 1 }),
            ).rejects.toThrow(HTTPRequestFailed);
        });
    });

    describe("getBinary", () => {
        it("return response bytes as Uint8Array on success", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
            mockFetch.mockResolvedValueOnce(createMockBinaryResponse(bytes));

            const result = await client.getBinary("https://ipfs.example.com/bafy");

            expect(result).toBeInstanceOf(Uint8Array);
            expect(Array.from(result)).toEqual([0xde, 0xad, 0xbe, 0xef]);
            expect(mockFetch).toHaveBeenCalledWith(
                "https://ipfs.example.com/bafy",
                expect.objectContaining({ method: "GET" }),
            );
        });

        it("throw HTTPResponseError on non-ok status", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(
                createMockBinaryResponse(new Uint8Array(), false, 404, "Not Found"),
            );

            await expect(client.getBinary("https://ipfs.example.com/bafy")).rejects.toThrow(
                HTTPResponseError,
            );
        });

        it("throw HTTPRequestFailed on network error", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockRejectedValueOnce(new Error("Network error"));

            await expect(client.getBinary("https://ipfs.example.com/bafy")).rejects.toThrow(
                HTTPRequestFailed,
            );
        });

        it("retry on transient failure then succeed", async () => {
            const client = new HTTPClient({ retryAttempts: 1, retryDelay: 0 });
            const bytes = new Uint8Array([1, 2, 3]);

            mockFetch
                .mockRejectedValueOnce(new Error("Transient error"))
                .mockResolvedValueOnce(createMockBinaryResponse(bytes));

            const result = await client.getBinary("https://ipfs.example.com/bafy");

            expect(Array.from(result)).toEqual([1, 2, 3]);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });

        it("respect timeout (abort)", async () => {
            const client = new HTTPClient({ timeout: 1, retryAttempts: 0 });

            mockFetch.mockImplementationOnce(
                (_url: string, init: RequestInit) =>
                    new Promise((_resolve, reject) => {
                        init.signal!.addEventListener("abort", () => {
                            reject(new DOMException("The operation was aborted.", "AbortError"));
                        });
                    }),
            );

            await expect(client.getBinary("https://ipfs.example.com/slow")).rejects.toThrow(
                HTTPRequestFailed,
            );
        });
    });

    describe("post", () => {
        it("return parsed JSON on success", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            const responseData = { id: 1 };
            mockFetch.mockResolvedValueOnce(createMockResponse(responseData));

            const result = await client.post<{ id: number }>("https://api.example.com/items", {
                name: "test",
            });

            expect(result).toEqual(responseData);
        });

        it("send body as JSON with Content-Type header", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(createMockResponse({ ok: true }));

            const body = { key: "value" };
            await client.post("https://api.example.com/items", body);

            expect(mockFetch).toHaveBeenCalledWith(
                "https://api.example.com/items",
                expect.objectContaining({
                    method: "POST",
                    body: JSON.stringify(body),
                    headers: expect.objectContaining({
                        "Content-Type": "application/json",
                    }) as Record<string, string>,
                }),
            );
        });

        it("throw HTTPResponseError on non-ok status", async () => {
            const client = new HTTPClient({ retryAttempts: 0 });
            mockFetch.mockResolvedValueOnce(createMockResponse(null, false, 400, "Bad Request"));

            await expect(client.post("https://api.example.com/items", {})).rejects.toThrow(
                HTTPResponseError,
            );
        });

        it("retry on transient failure then succeed", async () => {
            const client = new HTTPClient({ retryAttempts: 1, retryDelay: 0 });
            const data = { created: true };

            mockFetch
                .mockRejectedValueOnce(new Error("Connection reset"))
                .mockResolvedValueOnce(createMockResponse(data));

            const result = await client.post<{ created: boolean }>(
                "https://api.example.com/items",
                { name: "test" },
            );

            expect(result).toEqual(data);
            expect(mockFetch).toHaveBeenCalledTimes(2);
        });
    });
});
