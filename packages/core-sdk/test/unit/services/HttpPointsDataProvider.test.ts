import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Hex, HttpPointsDataProviderConfig, IHTTPClient } from "../../../src/internal.js";
import {
    BN254_SCALAR_MODULUS,
    bigintToHex as h,
    HttpPointsDataProvider,
    HTTPResponseError,
    InvalidPointsDataProviderConfig,
    MerkleService,
    POINTS_NULLIFIER_LEAF_TAG,
    PointsDataUnavailable,
    PoseidonHashService,
} from "../../../src/internal.js";

const BASE = "https://asp.example.com/1/public/points";
const ENTRYPOINT = "0xEB3e3961008952348445513e418ad6F43C23ca9a";
const SNAPSHOT = 1785715200n; // 2026-08-03T00:00:00Z
const PAD = BN254_SCALAR_MODULUS - 1n;

let hashService: PoseidonHashService;
let merkleService: MerkleService;

beforeAll(async () => {
    hashService = await PoseidonHashService.create();
    merkleService = new MerkleService({ hashService });
});

function createMockHttpClient(): IHTTPClient {
    return { get: vi.fn(), post: vi.fn(), getBinary: vi.fn() };
}

function epochRow(id: number, epochNumber = id) {
    return {
        id: String(id),
        epochNumber: h(BigInt(epochNumber)),
        snapshotBlock: h(9012345n),
        snapshotTime: h(SNAPSHOT),
        aspRoot: h(123n),
        eligibilityRoot: h(456n),
        eligibilityIpfsCid: "bafyelig",
        eligibilityLeafCount: 1024,
        eligibilityMerkleTreeId: "305",
        spentNoteRoot: h(789n),
        spentNoteIpfsCid: "bafyspent",
        spentNoteLeafCount: 217,
        publishTxHash: null,
        createdAt: h(SNAPSHOT + 300n),
    };
}

/** Independent of the code under test: leaf hashes by hand, root via MerkleService. */
async function spentRoot(pairs: [bigint, bigint][]): Promise<Hex> {
    const leaves = pairs.map(([n, t]) =>
        hashService.hash([h(POINTS_NULLIFIER_LEAF_TAG), h(n), h(t)]),
    );
    return h(BigInt(await merkleService.computeRoot(leaves)));
}

async function rateRoot(pairs: [bigint, bigint][]): Promise<Hex> {
    const leaves = pairs.map(([tokenId, rate]) => hashService.hash([h(tokenId), h(rate)]));
    return h(BigInt(await merkleService.computeRoot(leaves)));
}

describe("HttpPointsDataProvider", () => {
    let httpClient: IHTTPClient;

    beforeEach(() => {
        vi.clearAllMocks();
        httpClient = createMockHttpClient();
    });

    const validConfig = (): HttpPointsDataProviderConfig => ({
        aspUrl: "https://asp.example.com/",
        chainId: 1,
        entrypointAddress: ENTRYPOINT,
        httpClient,
        hashService,
    });

    describe("constructor", () => {
        it("create instance with valid config", () => {
            expect(() => new HttpPointsDataProvider(validConfig())).not.toThrow();
        });

        it("throw InvalidPointsDataProviderConfig for an invalid URL", () => {
            expect(
                () => new HttpPointsDataProvider({ ...validConfig(), aspUrl: "not-a-url" }),
            ).toThrow(InvalidPointsDataProviderConfig);
        });

        it("throw InvalidPointsDataProviderConfig for an invalid chainId", () => {
            expect(() => new HttpPointsDataProvider({ ...validConfig(), chainId: 0 })).toThrow(
                InvalidPointsDataProviderConfig,
            );
        });

        it("throw InvalidPointsDataProviderConfig for an empty entrypoint", () => {
            expect(
                () =>
                    new HttpPointsDataProvider({
                        ...validConfig(),
                        entrypointAddress: "",
                    }),
            ).toThrow(InvalidPointsDataProviderConfig);
        });

        it("throw InvalidPointsDataProviderConfig for a missing entrypoint", () => {
            const { entrypointAddress: _omitted, ...config } = validConfig();
            expect(
                () => new HttpPointsDataProvider(config as HttpPointsDataProviderConfig),
            ).toThrow(InvalidPointsDataProviderConfig);
        });

        it("throw InvalidPointsDataProviderConfig for an httpClient without get()", () => {
            expect(
                () =>
                    new HttpPointsDataProvider({
                        ...validConfig(),
                        httpClient: {} as IHTTPClient,
                    }),
            ).toThrow(InvalidPointsDataProviderConfig);
        });

        it("throw InvalidPointsDataProviderConfig for a missing hashService", () => {
            const { hashService: _omitted, ...config } = validConfig();
            expect(
                () => new HttpPointsDataProvider(config as HttpPointsDataProviderConfig),
            ).toThrow(InvalidPointsDataProviderConfig);
        });
    });

    describe("getEpochs", () => {
        it("fetch and parse a single page, stopping at the empty page", async () => {
            vi.mocked(httpClient.get)
                .mockResolvedValueOnce({ epochs: [epochRow(1)], lastSyncedId: "1" })
                .mockResolvedValueOnce({ epochs: [], lastSyncedId: "1" });
            const provider = new HttpPointsDataProvider(validConfig());

            const epochs = await provider.getEpochs();

            expect(vi.mocked(httpClient.get).mock.calls).toEqual([
                [`${BASE}/epochs?entrypoint=${ENTRYPOINT}`, { cache: "no-store" }],
                [`${BASE}/epochs?sinceId=1&entrypoint=${ENTRYPOINT}`, { cache: "no-store" }],
            ]);
            expect(epochs).toEqual([
                {
                    ...epochRow(1),
                    rateRoot: null,
                    rateIpfsCid: null,
                    rateLeafCount: null,
                    cliffSeconds: null,
                    cohortEdges: null,
                    cohortWeights: null,
                    cohortIpfsCid: null,
                    tvlSeriesDigest: null,
                    tvlSeriesLastSample: null,
                    correctedAt: null,
                    correctionTxHash: null,
                },
            ]);
        });

        it("parse the rate tree, cliff and cohort fields when present", async () => {
            vi.mocked(httpClient.get)
                .mockResolvedValueOnce({
                    epochs: [
                        {
                            ...epochRow(1),
                            rateRoot: h(42n),
                            rateIpfsCid: "bafyrate",
                            rateLeafCount: 4,
                            cliffSeconds: 604800,
                            cohortEdges: [h(1780272000n), h(140737488355329n), h(140737488355330n)],
                            cohortWeights: [60000, 40000, 20000, 10000],
                            cohortIpfsCid: "bafycohort",
                            tvlSeriesDigest: "ab",
                            tvlSeriesLastSample: h(SNAPSHOT - 86400n),
                            correctedAt: null,
                            correctionTxHash: null,
                        },
                    ],
                    lastSyncedId: "1",
                })
                .mockResolvedValueOnce({ epochs: [], lastSyncedId: "1" });
            const provider = new HttpPointsDataProvider(validConfig());

            const [epoch] = await provider.getEpochs();

            expect(epoch).toMatchObject({
                rateRoot: h(42n),
                cliffSeconds: 604800,
                cohortEdges: [h(1780272000n), h(140737488355329n), h(140737488355330n)],
                cohortWeights: [60000, 40000, 20000, 10000],
                tvlSeriesLastSample: h(SNAPSHOT - 86400n),
            });
        });

        it("normalize uppercase hex to lowercase", async () => {
            vi.mocked(httpClient.get)
                .mockResolvedValueOnce({
                    epochs: [
                        {
                            ...epochRow(1),
                            aspRoot: `0x${"0".repeat(32)}${"AB".repeat(16)}`,
                        },
                    ],
                    lastSyncedId: "1",
                })
                .mockResolvedValueOnce({ epochs: [], lastSyncedId: "1" });
            const provider = new HttpPointsDataProvider(validConfig());

            const [epoch] = await provider.getEpochs();

            expect(epoch?.aspRoot).toBe(`0x${"0".repeat(32)}${"ab".repeat(16)}`);
        });

        it("keep draining past a short page until an empty one", async () => {
            vi.mocked(httpClient.get)
                .mockResolvedValueOnce({
                    epochs: [epochRow(1), epochRow(2)],
                    lastSyncedId: "2",
                })
                .mockResolvedValueOnce({ epochs: [epochRow(3)], lastSyncedId: "3" })
                .mockResolvedValueOnce({ epochs: [], lastSyncedId: "3" });
            const provider = new HttpPointsDataProvider(validConfig());

            const epochs = await provider.getEpochs();

            expect(epochs.map((e) => e.id)).toEqual(["1", "2", "3"]);
            expect(vi.mocked(httpClient.get).mock.calls.map((call) => call[0])).toEqual([
                `${BASE}/epochs?entrypoint=${ENTRYPOINT}`,
                `${BASE}/epochs?sinceId=2&entrypoint=${ENTRYPOINT}`,
                `${BASE}/epochs?sinceId=3&entrypoint=${ENTRYPOINT}`,
            ]);
        });

        it("throw PointsDataUnavailable when the cursor does not advance", async () => {
            vi.mocked(httpClient.get).mockResolvedValue({
                epochs: [epochRow(1)],
                lastSyncedId: "1",
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getEpochs()).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable on a decimal value where hex is required", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochs: [{ ...epochRow(1), snapshotTime: "1785715200" }],
                lastSyncedId: "1",
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getEpochs()).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable on an ISO timestamp", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochs: [{ ...epochRow(1), createdAt: "2026-08-03T00:05:00.000Z" }],
                lastSyncedId: "1",
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getEpochs()).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable on a root outside the field", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochs: [{ ...epochRow(1), spentNoteRoot: h(BN254_SCALAR_MODULUS) }],
                lastSyncedId: "1",
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getEpochs()).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable when the request fails", async () => {
            vi.mocked(httpClient.get).mockRejectedValueOnce(new Error("network down"));
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getEpochs()).rejects.toThrow(PointsDataUnavailable);
        });
    });

    describe("getLatestEpoch", () => {
        it("fetch the latest epoch", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce(epochRow(7, 6));
            const provider = new HttpPointsDataProvider(validConfig());

            const epoch = await provider.getLatestEpoch();

            expect(httpClient.get).toHaveBeenCalledWith(
                `${BASE}/epochs/latest?entrypoint=${ENTRYPOINT}`,
                { cache: "no-store" },
            );
            expect(epoch?.epochNumber).toBe(h(6n));
        });

        it("return null when no epoch has been published", async () => {
            vi.mocked(httpClient.get).mockRejectedValueOnce(
                new HTTPResponseError(404, "Not Found"),
            );
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getLatestEpoch()).resolves.toBeNull();
        });

        it("throw PointsDataUnavailable on a server error", async () => {
            vi.mocked(httpClient.get).mockRejectedValueOnce(
                new HTTPResponseError(500, "Internal Server Error"),
            );
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getLatestEpoch()).rejects.toThrow(PointsDataUnavailable);
        });
    });

    describe("getSpentNoteLeaves", () => {
        const pairs: [bigint, bigint][] = [
            [0n, 0n],
            [123456789n, 1754179200n],
            [987654321n, 1754265600n],
            [PAD, 0n],
        ];
        const body = async () => ({
            epochNumber: h(6n),
            spentNoteRoot: await spentRoot(pairs),
            leaves: pairs.map(([n, t]) => [h(n), h(t)]),
        });

        it("fetch the whole leaf set, verify its root and parse each pair", async () => {
            const served = await body();
            vi.mocked(httpClient.get).mockResolvedValueOnce(served);
            const provider = new HttpPointsDataProvider(validConfig());

            const result = await provider.getSpentNoteLeaves(h(6n));

            expect(httpClient.get).toHaveBeenCalledWith(
                `${BASE}/epochs/6/spent-note-leaves?entrypoint=${ENTRYPOINT}`,
                { cache: "no-store" },
            );
            expect(result).toEqual({
                epochNumber: h(6n),
                spentNoteRoot: served.spentNoteRoot,
                leaves: pairs.map(([n, t]) => ({ nullifierHash: h(n), spentAt: h(t) })),
            });
        });

        it("throw PointsDataUnavailable when a leaf was tampered with", async () => {
            const served = await body();
            served.leaves[1] = [h(123456789n), h(1754179201n)];
            vi.mocked(httpClient.get).mockResolvedValueOnce(served);
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves(h(6n))).rejects.toThrow(
                "do not recompute to spentNoteRoot",
            );
        });

        it("throw PointsDataUnavailable when a leaf was dropped", async () => {
            const served = await body();
            served.leaves.splice(2, 1);
            vi.mocked(httpClient.get).mockResolvedValueOnce(served);
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable when served a different epoch", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                epochNumber: h(5n),
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable on a malformed leaf", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                leaves: [[h(1n)]],
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable for a non-hex epoch number", async () => {
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves("6" as Hex)).rejects.toThrow(
                PointsDataUnavailable,
            );
            expect(httpClient.get).not.toHaveBeenCalled();
        });

        it("throw PointsDataUnavailable for an unknown epoch", async () => {
            vi.mocked(httpClient.get).mockRejectedValueOnce(
                new HTTPResponseError(404, "Not Found"),
            );
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getSpentNoteLeaves(h(99n))).rejects.toThrow(
                PointsDataUnavailable,
            );
        });
    });

    describe("getRateLeaves", () => {
        const pairs: [bigint, bigint][] = [
            [162766344143417102391406016098380093604093193784n, 11574074074074074n],
            [1364068194842176056990105843868530818345537040110n, 34722222n],
        ];
        const body = async () => ({
            epochNumber: h(6n),
            rateRoot: await rateRoot(pairs),
            leaves: pairs.map(([tokenId, rate]) => [h(tokenId), h(rate)]),
            table: { program: { rateScale: "1000000000" } },
            rateScale: h(1_000_000_000n),
            cliffSeconds: 604800,
            cohortEdges: [h(140737488355328n), h(140737488355329n), h(140737488355330n)],
            cohortWeights: [60000, 40000, 20000, 10000],
        });

        it("fetch the whole rate tree and verify its root", async () => {
            const served = await body();
            vi.mocked(httpClient.get).mockResolvedValueOnce(served);
            const provider = new HttpPointsDataProvider(validConfig());

            const result = await provider.getRateLeaves(h(6n));

            expect(httpClient.get).toHaveBeenCalledWith(
                `${BASE}/epochs/6/rate-leaves?entrypoint=${ENTRYPOINT}`,
                { cache: "no-store" },
            );
            expect(result).toMatchObject({
                epochNumber: h(6n),
                rateRoot: served.rateRoot,
                leaves: pairs.map(([tokenId, rate]) => ({
                    tokenId: h(tokenId),
                    rate: h(rate),
                })),
                rateScale: h(1_000_000_000n),
                cliffSeconds: 604800,
                cohortEdges: served.cohortEdges,
                cohortWeights: [60000, 40000, 20000, 10000],
            });
        });

        it("throw PointsDataUnavailable when a rate was tampered with", async () => {
            const served = await body();
            const [[tokenId, rate]] = pairs as [[bigint, bigint]];
            served.leaves[0] = [h(tokenId), h(rate * 10n)];
            vi.mocked(httpClient.get).mockResolvedValueOnce(served);
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getRateLeaves(h(6n))).rejects.toThrow(
                "do not recompute to rateRoot",
            );
        });

        it("report a null rate scale when none is published", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                rateScale: null,
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getRateLeaves(h(6n))).resolves.toMatchObject({
                rateScale: null,
            });
        });

        it("throw PointsDataUnavailable on a zero rate scale", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                rateScale: h(0n),
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getRateLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable on a numeric rate scale", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                rateScale: 1e27,
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getRateLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable when served a different epoch", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                ...(await body()),
                epochNumber: h(5n),
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getRateLeaves(h(6n))).rejects.toThrow(PointsDataUnavailable);
        });
    });

    describe("getCohorts", () => {
        const page = (
            series: unknown[],
            seriesNextSince: string | null,
            seriesHasMore = seriesNextSince !== null,
        ) => ({
            campaignKey: "points-v1",
            cliffSeconds: 604800,
            sampleIntervalSeconds: 86400,
            sustainSamples: 7,
            seriesStartUnix: h(1780272000n),
            priceRule: "chainlink-served-at-sample",
            thresholdsUsd8: [h(1000000000000000n), h(5000000000000000n), h(10000000000000000n)],
            weightsBps: [60000, 40000, 20000, 10000],
            includedPools: [{ chainId: "1", poolConfigurationId: "4" }],
            publishedEdges: [h(140737488355328n), h(140737488355329n), h(140737488355330n)],
            publishedWeights: [60000, 40000, 20000, 10000],
            publishedInEpoch: h(6n),
            cohortIpfsCid: null,
            pinnedOnChain: false,
            publishTxHash: null,
            tiers: [
                {
                    tier: 0,
                    thresholdUsd8: h(1000000000000000n),
                    weightBps: 60000,
                    sealed: false,
                    edgeUnix: null,
                    sealedInEpoch: null,
                    sealedAt: null,
                    runFirstAt: null,
                    runLastAt: null,
                },
            ],
            baseWeightBps: 10000,
            seriesDigest: null,
            seriesLastSample: h(SNAPSHOT - 86400n),
            seriesHasMore,
            seriesNextSince,
            series,
        });
        const sample = (at: bigint) => ({
            at: h(at),
            totalUsd8: h(100n),
            priced: true,
            unpricedReason: null,
            tierCleared: -1,
        });

        it("drain every series page through the server's cursor", async () => {
            vi.mocked(httpClient.get)
                .mockResolvedValueOnce(page([sample(1780272000n)], "2026-06-02T00:00:00.000Z"))
                .mockResolvedValueOnce(page([sample(1780358400n)], null));
            const provider = new HttpPointsDataProvider(validConfig());

            const cohorts = await provider.getCohorts();

            expect(vi.mocked(httpClient.get).mock.calls.map((call) => call[0])).toEqual([
                `${BASE}/cohorts?entrypoint=${ENTRYPOINT}`,
                `${BASE}/cohorts?since=2026-06-02T00%3A00%3A00.000Z&entrypoint=${ENTRYPOINT}`,
            ]);
            expect(cohorts.series.map((s) => s.at)).toEqual([h(1780272000n), h(1780358400n)]);
            expect(cohorts).toMatchObject({
                publishedEdges: [h(140737488355328n), h(140737488355329n), h(140737488355330n)],
                publishedInEpoch: h(6n),
                pinnedOnChain: false,
            });
            expect(cohorts).not.toHaveProperty("seriesHasMore");
        });

        it("throw PointsDataUnavailable when more pages are promised without a cursor", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce(
                page([sample(1780272000n)], null, true),
            );
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getCohorts()).rejects.toThrow(PointsDataUnavailable);
        });

        it("throw PointsDataUnavailable when the series cursor does not advance", async () => {
            vi.mocked(httpClient.get).mockResolvedValue(page([], "2026-06-02T00:00:00.000Z"));
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getCohorts()).rejects.toThrow(PointsDataUnavailable);
        });
    });

    describe("getStats", () => {
        it("fetch and parse aggregate stats", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochCount: 6,
                latestEpochNumber: h(5n),
                latestSnapshotTime: h(SNAPSHOT),
                latestSpentNoteLeafCount: 217,
                latestEligibilityLeafCount: 1024,
            });
            const provider = new HttpPointsDataProvider(validConfig());

            const stats = await provider.getStats();

            expect(httpClient.get).toHaveBeenCalledWith(`${BASE}/stats?entrypoint=${ENTRYPOINT}`, {
                cache: "no-store",
            });
            expect(stats).toEqual({
                epochCount: 6,
                latestEpochNumber: h(5n),
                latestSnapshotTime: h(SNAPSHOT),
                latestSpentNoteLeafCount: 217,
                latestEligibilityLeafCount: 1024,
                latestRateLeafCount: null,
            });
        });

        it("throw PointsDataUnavailable on a missing epoch count", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochCount: null,
                latestEpochNumber: null,
                latestSnapshotTime: null,
                latestSpentNoteLeafCount: null,
                latestEligibilityLeafCount: null,
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getStats()).rejects.toThrow(PointsDataUnavailable);
        });

        it("parse empty stats for a pool with no epochs", async () => {
            vi.mocked(httpClient.get).mockResolvedValueOnce({
                epochCount: 0,
                latestEpochNumber: null,
                latestSnapshotTime: null,
                latestSpentNoteLeafCount: null,
                latestEligibilityLeafCount: null,
            });
            const provider = new HttpPointsDataProvider(validConfig());

            await expect(provider.getStats()).resolves.toMatchObject({
                epochCount: 0,
                latestEpochNumber: null,
            });
        });
    });
});
