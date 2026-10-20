import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    HttpASPDataProviderConfig,
    IHTTPClient,
    ILogger,
} from "../../../src/internal.js";
import {
    ASPUnavailable,
    bigintToHex,
    HttpASPDataProvider,
    HTTPResponseError,
    YIELD_FEED_MAX_PAGES,
    YIELD_FEED_PAGE_SIZE,
} from "../../../src/internal.js";

const SHARE = "0xC246AfB23482Ff9596E9CEe5f1f678EfE0eb1AD6" as Address;
const SHARE_LOWER = SHARE.toLowerCase();
const OTHER_SHARE = "0xa4cf419558ef36cc6ffb666195684dc963910426";

function createMockHttpClient(): IHTTPClient {
    return { get: vi.fn(), post: vi.fn(), getBinary: vi.fn() };
}

function createMockLogger(): ILogger {
    return {
        child: vi.fn(),
        level: "debug",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
    };
}

/** One rate row as the ASP serialises it. */
function rateRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: String(id),
        exchangeRate: String(1_000_000 + id),
        shareDecimals: 18,
        assetDecimals: 6,
        feeBps: 2000,
        observationBlock: String(25_906_022 + id * 300),
        observationTimestamp: new Date((1_757_000_000 + id * 3600) * 1000).toISOString(),
        ...overrides,
    };
}

function ratePage(ids: number[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        chainId: "1",
        ppUsdcAddress: SHARE_LOWER,
        assets: [SHARE_LOWER, OTHER_SHARE],
        intervalSeconds: 3600,
        snapshots: ids.map((id) => rateRow(id)),
        lastSyncedId: String(ids[ids.length - 1] ?? 0),
        ...overrides,
    };
}

/** One deposit fact as the ASP serialises it (decimal strings throughout). */
function factRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: String(id),
        txHash: `0x${id.toString(16).padStart(64, "0")}`,
        logIndex: 29,
        blockNumber: String(25_906_428 + id),
        blockTimestamp: new Date((1_757_000_000 + id * 60) * 1000).toISOString(),
        outputCommitment: String(
            14_430_310_383_053_476_341_834_276_543_445_841_403_175_606_727_452_137_046_646_934_167_914_007_902_559n +
                BigInt(id),
        ),
        asset: SHARE_LOWER,
        grossUnderlying: "49750002",
        noteShares: "49747910585665987693",
        totalSharesMinted: "49747910585665987693",
        vettingFeeShares: "0",
        ...overrides,
    };
}

function factPage(ids: number[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        deposits: ids.map((id) => factRow(id)),
        lastSyncedId: String(ids[ids.length - 1] ?? 0),
        ...overrides,
    };
}

function range(from: number, to: number): number[] {
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function urlsOf(client: IHTTPClient): URL[] {
    return vi.mocked(client.get).mock.calls.map(([url]) => new URL(url));
}

describe("HttpASPDataProvider yield feeds", () => {
    let http: IHTTPClient;
    let provider: HttpASPDataProvider;
    let logger: ILogger;

    const config = (): HttpASPDataProviderConfig => ({
        aspUrl: "https://asp.example.com",
        chainId: 1,
        entrypointAddress: "0xEB3e3961008952348445513e418ad6F43C23ca9a",
        httpClient: http,
    });

    beforeEach(() => {
        http = createMockHttpClient();
        logger = createMockLogger();
        provider = new HttpASPDataProvider(config(), { logger });
    });

    describe("getYieldRateSeries", () => {
        it("fetch one short page and return the series ascending with the rows' decimals", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(ratePage([1, 3, 5]));
            const result = await provider.getYieldRateSeries(SHARE);
            expect(result).toEqual({
                share: SHARE_LOWER,
                shareDecimals: 18,
                assetDecimals: 6,
                observations: [1, 3, 5].map((id) => ({
                    timestamp: 1_757_000_000 + id * 3600,
                    exchangeRate: BigInt(1_000_000 + id),
                    block: BigInt(25_906_022 + id * 300),
                })),
            });
            const [url] = urlsOf(http);
            expect(url!.pathname).toBe("/1/public/ppusdc-rate-history");
            expect([...url!.searchParams.keys()]).toEqual(["asset"]);
            expect(url!.searchParams.get("asset")).toBe(SHARE_LOWER);
            expect(http.get).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ cache: "no-store" }),
            );
        });

        it("drain every page: a full page asks for the next with the server's cursor, a short page ends it", async () => {
            const first = range(1, YIELD_FEED_PAGE_SIZE);
            const second = range(YIELD_FEED_PAGE_SIZE + 1, 2 * YIELD_FEED_PAGE_SIZE);
            const third = range(2 * YIELD_FEED_PAGE_SIZE + 1, 2 * YIELD_FEED_PAGE_SIZE + 7);
            vi.mocked(http.get)
                .mockResolvedValueOnce(ratePage(first))
                .mockResolvedValueOnce(ratePage(second))
                .mockResolvedValueOnce(ratePage(third));
            const result = await provider.getYieldRateSeries(SHARE);
            expect(result!.observations).toHaveLength(2 * YIELD_FEED_PAGE_SIZE + 7);
            const urls = urlsOf(http);
            expect(urls).toHaveLength(3);
            expect(urls[0]!.searchParams.get("sinceId")).toBeNull();
            expect(urls[1]!.searchParams.get("sinceId")).toBe(String(YIELD_FEED_PAGE_SIZE));
            expect(urls[2]!.searchParams.get("sinceId")).toBe(String(2 * YIELD_FEED_PAGE_SIZE));
            // The request never carries anything but the share and the server's own cursor: no
            // time, no block, no note. This is the privacy property, so it is asserted, not assumed.
            for (const url of urls) {
                expect([...url.searchParams.keys()].sort()).toEqual(
                    url.searchParams.has("sinceId") ? ["asset", "sinceId"] : ["asset"],
                );
            }
        });

        it("return null when the first page answers 404: the feed is not served on this chain", async () => {
            vi.mocked(http.get).mockRejectedValueOnce(
                new HTTPResponseError(
                    404,
                    "Not Found",
                    '{"message":"ppusdc-rate-history feed is not enabled on this chain"}',
                ),
            );
            await expect(provider.getYieldRateSeries(SHARE)).resolves.toBeNull();
        });

        it("throw ASPUnavailable on a 404 after the first page, on any other status, and on a network error", async () => {
            vi.mocked(http.get)
                .mockResolvedValueOnce(ratePage(range(1, YIELD_FEED_PAGE_SIZE)))
                .mockRejectedValueOnce(new HTTPResponseError(404, "Not Found"));
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(ASPUnavailable);

            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockRejectedValueOnce(
                new HTTPResponseError(500, "Internal Server Error"),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(ASPUnavailable);

            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockRejectedValueOnce(new Error("Network error"));
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(ASPUnavailable);
        });

        it("throw ASPUnavailable when the cursor does not advance instead of looping", async () => {
            const full = range(1, YIELD_FEED_PAGE_SIZE);
            vi.mocked(http.get).mockResolvedValue(ratePage(full)); // lastSyncedId stays "1000"
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(
                /cursor did not advance/,
            );
            expect(http.get).toHaveBeenCalledTimes(2);
        });

        it("throw ASPUnavailable after the page cap rather than hand back a partial feed", async () => {
            vi.mocked(http.get).mockImplementation(async (url: string) => {
                const since = Number(new URL(url).searchParams.get("sinceId") ?? "0");
                return ratePage(range(since + 1, since + YIELD_FEED_PAGE_SIZE));
            });
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(/drain incomplete/);
            expect(http.get).toHaveBeenCalledTimes(YIELD_FEED_MAX_PAGES);
        });

        it("throw ASPUnavailable when a page fails validation", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(
                ratePage([1], { snapshots: [rateRow(1, { exchangeRate: "1.5e6" })] }),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(ASPUnavailable);
            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockResolvedValueOnce(
                ratePage([1], { snapshots: [rateRow(1, { observationTimestamp: "yesterday" })] }),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(/failed validation/);
        });

        it("throw ASPUnavailable when the ASP serves a different share than asked", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(
                ratePage([1], { ppUsdcAddress: OTHER_SHARE }),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(/different share/);
        });

        it("throw ASPUnavailable when no row carries decimals or rows disagree on them", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(
                ratePage([1, 2], {
                    snapshots: [
                        rateRow(1, { shareDecimals: null, assetDecimals: null }),
                        rateRow(2, { shareDecimals: null, assetDecimals: null }),
                    ],
                }),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(/no decimals/);
            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockResolvedValueOnce(
                ratePage([1, 2], { snapshots: [rateRow(1), rateRow(2, { assetDecimals: 18 })] }),
            );
            await expect(provider.getYieldRateSeries(SHARE)).rejects.toThrow(/disagree/);
        });

        it("return an empty series, not null, when the feed is served but holds no rows yet", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(ratePage([], { lastSyncedId: "0" }));
            const result = await provider.getYieldRateSeries(SHARE);
            expect(result?.observations).toEqual([]);
        });
    });

    describe("getYieldDepositFacts", () => {
        it("fetch the whole feed with no filter and keep only this share's facts, canonicalising commitments", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(
                factPage([1, 2, 3], {
                    deposits: [
                        factRow(1),
                        factRow(2, { asset: OTHER_SHARE }),
                        factRow(3, {
                            vettingFeeShares: undefined,
                            totalSharesMinted: "49747910585665987700",
                        }),
                    ],
                }),
            );
            const result = await provider.getYieldDepositFacts(SHARE);
            expect(result).toHaveLength(2);
            expect(result![0]).toEqual({
                outputCommitment: bigintToHex(BigInt(factRow(1).outputCommitment as string)),
                asset: SHARE_LOWER,
                txHash: factRow(1).txHash,
                grossUnderlying: 49_750_002n,
                noteShares: 49_747_910_585_665_987_693n,
                totalSharesMinted: 49_747_910_585_665_987_693n,
                vettingFeeShares: 0n,
                blockTimestamp: 1_757_000_000 + 60,
            });
            // The vetting-fee column is derived when the wire omits it.
            expect(result![1]!.vettingFeeShares).toBe(7n);
            const [url] = urlsOf(http);
            expect(url!.pathname).toBe("/1/public/yield-deposits");
            expect([...url!.searchParams.keys()]).toEqual([]);
        });

        it("drain every page with only the server's cursor on the wire", async () => {
            vi.mocked(http.get)
                .mockResolvedValueOnce(factPage(range(1, YIELD_FEED_PAGE_SIZE)))
                .mockResolvedValueOnce(
                    factPage(range(YIELD_FEED_PAGE_SIZE + 1, YIELD_FEED_PAGE_SIZE + 3)),
                );
            const result = await provider.getYieldDepositFacts(SHARE);
            expect(result).toHaveLength(YIELD_FEED_PAGE_SIZE + 3);
            const urls = urlsOf(http);
            expect(urls).toHaveLength(2);
            expect([...urls[0]!.searchParams.keys()]).toEqual([]);
            expect([...urls[1]!.searchParams.keys()]).toEqual(["sinceId"]);
            expect(urls[1]!.searchParams.get("sinceId")).toBe(String(YIELD_FEED_PAGE_SIZE));
        });

        it("return null on a first-page 404 and throw ASPUnavailable on everything else", async () => {
            vi.mocked(http.get).mockRejectedValueOnce(new HTTPResponseError(404, "Not Found"));
            await expect(provider.getYieldDepositFacts(SHARE)).resolves.toBeNull();
            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockRejectedValueOnce(
                new HTTPResponseError(503, "Service Unavailable"),
            );
            await expect(provider.getYieldDepositFacts(SHARE)).rejects.toThrow(ASPUnavailable);
            vi.mocked(http.get).mockReset();
            vi.mocked(http.get).mockResolvedValueOnce({ deposits: "nope", lastSyncedId: "1" });
            await expect(provider.getYieldDepositFacts(SHARE)).rejects.toThrow(ASPUnavailable);
        });

        it("drop a fact with null value columns and say how many, so it reads as deposit-fact-missing downstream", async () => {
            vi.mocked(http.get).mockResolvedValueOnce(
                factPage([1, 2], { deposits: [factRow(1, { grossUnderlying: null }), factRow(2)] }),
            );
            const result = await provider.getYieldDepositFacts(SHARE);
            expect(result).toHaveLength(1);
            expect(logger.warn).toHaveBeenCalledWith(
                expect.stringContaining("Dropped 1 yield-deposit fact"),
            );
        });
    });
});
