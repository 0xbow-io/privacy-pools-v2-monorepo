import { beforeAll, describe, expect, it } from "vitest";

import type {
    Hex,
    PointsEpoch,
    PointsEpochParams,
    PointsNoteInput,
    RateLeavesResponseDto,
} from "../../../src/internal.js";
import {
    BN254_SCALAR_MODULUS,
    bigintToHex as h,
    computePoints,
    epochParamsFromRateLeaves,
    InvalidPointsEpochParams,
    InvalidPointsInput,
    liveEpochParams,
    MerkleService,
    POINTS_COHORT_EDGE_SENTINEL,
    PointsEpochSchema,
    PoseidonHashService,
    RateLeavesResponseSchema,
} from "../../../src/internal.js";

const DAY = 86_400n;
const T0 = 1_780_272_000n;
const S = 1_000_000_000n;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_KEY = USDC.toLowerCase();
const ETH_KEY = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
// 1 point (1e18 points-wei) per whole token per second at 1x, so expectations stay readable:
// value(1e6 base units) * rate * 10000 * seconds / (S * 10000) = 1e18 * seconds  =>  rate = 1e21.
const ONE_POINT_PER_TOKEN_SECOND = 10n ** 21n;
const ONE = 10n ** 18n;
const SENTINELS = [
    POINTS_COHORT_EDGE_SENTINEL,
    POINTS_COHORT_EDGE_SENTINEL + 1n,
    POINTS_COHORT_EDGE_SENTINEL + 2n,
] as const;

function epoch(
    n: bigint | null,
    from: bigint,
    to: bigint,
    overrides: Partial<PointsEpochParams> = {},
) {
    return {
        epochNumber: n,
        windowStart: from,
        snapshotTime: to,
        rateScale: S,
        rates: new Map([[USDC_KEY, ONE_POINT_PER_TOKEN_SECOND]]),
        cliffSeconds: 0n,
        cohortEdges: SENTINELS,
        cohortWeightsBps: [10_000, 10_000, 10_000, 10_000] as const,
        ...overrides,
    } satisfies PointsEpochParams;
}

function note(overrides: Partial<PointsNoteInput> = {}): PointsNoteInput {
    return {
        commitment: "0x01",
        tokenId: USDC,
        value: 1_000_000n,
        createdAt: T0,
        spentAt: null,
        aspStatus: "approved",
        ...overrides,
    };
}

const e0 = epoch(0n, 0n, T0 + 10n);
const e1 = epoch(1n, T0 + 10n, T0 + 30n);
const live = epoch(null, T0 + 30n, T0 + 35n);

describe("computePoints", () => {
    it("sum published epochs into claimable and the live window into estimated", () => {
        const result = computePoints([note()], [e0, e1], live);
        const [n] = result.notes;
        expect(n?.claimable).toBe(30n * ONE);
        expect(n?.estimated).toBe(5n * ONE);
        expect(n?.perEpoch).toEqual([
            { epochNumber: 0n, points: 10n * ONE },
            { epochNumber: 1n, points: 20n * ONE },
            { epochNumber: null, points: 5n * ONE },
        ]);
        expect(result).toMatchObject({
            claimable: 30n * ONE,
            estimated: 5n * ONE,
            total: 35n * ONE,
        });
        expect(n?.status).toBe("accruing");
        expect(n?.pointsPerDay).toBe(DAY * ONE);
    });

    it("accept published epochs in any order", () => {
        expect(computePoints([note()], [e1, e0], live).claimable).toBe(30n * ONE);
    });

    it("floor each epoch separately, as each epoch is a separate claim", () => {
        const rates = new Map([[USDC_KEY, 6n]]);
        const a = epoch(0n, 0n, T0 + 1n, { rates, rateScale: 10n });
        const b = epoch(1n, T0 + 1n, T0 + 2n, { rates, rateScale: 10n });
        // each: 1 * 6 * 10000 * 1 / (10 * 10000) = 0.6 -> 0; flooring the sum would give 1
        const result = computePoints([note({ value: 1n })], [a, b], null);
        expect(result.notes[0]?.perEpoch.map((p) => p.points)).toEqual([0n, 0n]);
        expect(result.claimable).toBe(0n);
    });

    it("apply each epoch's own cohort weights and cliff", () => {
        const sixX = epoch(0n, 0n, T0 + 10n, {
            cohortWeightsBps: [60_000, 40_000, 20_000, 10_000],
        });
        const crossed = epoch(1n, T0 + 10n, T0 + 20n, {
            cohortEdges: [T0, T0 + 1n, POINTS_COHORT_EDGE_SENTINEL + 2n],
            cohortWeightsBps: [60_000, 40_000, 20_000, 10_000],
        });
        const result = computePoints([note()], [sixX, crossed], null);
        // created exactly at edge0 -> tier 1 (4x) once the edge is published
        expect(result.notes[0]?.perEpoch.map((p) => p.points)).toEqual([60n * ONE, 40n * ONE]);
        expect(result.notes[0]?.cohortBps).toBe(40_000);
    });

    it("hold a note in activating inside the cliff, with no rate", () => {
        const withCliff = epoch(null, T0, T0 + 3n * DAY, {
            cliffSeconds: 7n * DAY,
        });
        const [n] = computePoints([note()], [], withCliff).notes;
        expect(n?.status).toBe("activating");
        expect(n?.activatesAt).toBe(T0 + 7n * DAY);
        expect(n?.estimated).toBe(0n);
        expect(n?.pointsPerDay).toBe(0n);
    });

    it("mark a spent note closed and stop its rate", () => {
        const [n] = computePoints([note({ spentAt: T0 + 20n })], [e0, e1], live).notes;
        expect(n?.status).toBe("closed");
        expect(n?.claimable).toBe(20n * ONE);
        expect(n?.estimated).toBe(0n);
        expect(n?.pointsPerDay).toBe(0n);
    });

    it("pay a declined note nothing and mark it ineligible", () => {
        const result = computePoints([note({ aspStatus: "declined" })], [e0, e1], live);
        expect(result.notes[0]?.status).toBe("ineligible");
        expect(result.total).toBe(0n);
        expect(result.pointsPerDay).toBe(0n);
    });

    it("report a pending note's published points as pending, never claimable", () => {
        const result = computePoints([note({ aspStatus: "pending" })], [e0, e1], live);
        const [n] = result.notes;
        expect(n?.claimable).toBe(0n);
        expect(n?.pending).toBe(30n * ONE);
        expect(n?.estimated).toBe(5n * ONE);
        expect(result).toMatchObject({
            claimable: 0n,
            pending: 30n * ONE,
            estimated: 5n * ONE,
            total: 35n * ONE,
        });
        expect(result.byTokenId[USDC_KEY]).toMatchObject({
            claimable: 0n,
            pending: 30n * ONE,
        });
    });

    it("keep an approved note's published points out of pending", () => {
        const [n] = computePoints([note()], [e0, e1], live).notes;
        expect(n?.pending).toBe(0n);
    });

    it("mark unknown and implausible timestamps as unknown-time with no points", () => {
        const notes = [
            note({ commitment: "0xa", createdAt: 19_000_000n }),
            note({ commitment: "0xb", spentAt: 0n }),
            note({ commitment: "0xc", spentAt: 12_345n }),
            note({ commitment: "0xd", spentAt: "unknown" }),
        ];
        const result = computePoints(notes, [e0, e1], live);
        expect(result.notes.map((n) => n.status)).toEqual([
            "unknown-time",
            "unknown-time",
            "unknown-time",
            "unknown-time",
        ]);
        expect(result.total).toBe(0n);
        expect(result.byTokenId[USDC_KEY]?.noteCount).toBe(4);
    });

    it("pay nothing for a tokenId without a rate", () => {
        const result = computePoints([note({ tokenId: ETH_KEY })], [e0, e1], live);
        expect(result.total).toBe(0n);
        expect(result.notes[0]?.pointsPerDay).toBe(0n);
    });

    it("aggregate by lowercased tokenId", () => {
        const notes = [note({ commitment: "0xa" }), note({ commitment: "0xb", tokenId: USDC_KEY })];
        const result = computePoints(notes, [e0, e1], live);
        expect(Object.keys(result.byTokenId)).toEqual([USDC_KEY]);
        expect(result.byTokenId[USDC_KEY]).toEqual({
            claimable: 60n * ONE,
            pending: 0n,
            estimated: 10n * ONE,
            total: 70n * ONE,
            pointsPerDay: 2n * DAY * ONE,
            noteCount: 2,
        });
    });

    it("return zeros when nothing is published and there is no live window", () => {
        const result = computePoints([note()], [], null);
        expect(result).toMatchObject({
            claimable: 0n,
            pending: 0n,
            estimated: 0n,
            total: 0n,
            pointsPerDay: 0n,
        });
        expect(result.notes[0]?.perEpoch).toEqual([]);
        expect(result.notes[0]?.activatesAt).toBeNull();
    });

    it("throw InvalidPointsEpochParams when published epochs do not tile", () => {
        const gap = epoch(1n, T0 + 11n, T0 + 30n);
        expect(() => computePoints([], [e0, gap], null)).toThrow(InvalidPointsEpochParams);
    });

    it("throw InvalidPointsEpochParams when the live window does not meet the last epoch", () => {
        expect(() => computePoints([], [e0], epoch(null, T0 + 9n, T0 + 20n))).toThrow(
            InvalidPointsEpochParams,
        );
    });

    it("throw InvalidPointsEpochParams when epoch 0 does not start at 0", () => {
        expect(() => computePoints([], [epoch(0n, T0, T0 + 10n)], null)).toThrow(
            "epoch 0 must start at windowStart 0",
        );
    });

    it("throw InvalidPointsEpochParams for a live window that ends before it starts", () => {
        expect(() => computePoints([], [e0, e1], epoch(null, T0 + 30n, T0 + 20n))).toThrow(
            "snapshotTime is before windowStart",
        );
    });

    it("throw InvalidPointsEpochParams for a published epoch without a number", () => {
        expect(() => computePoints([], [epoch(null, 0n, T0)], null)).toThrow(
            InvalidPointsEpochParams,
        );
    });

    it("throw InvalidPointsEpochParams for a duplicated epoch", () => {
        expect(() => computePoints([], [e0, e0], null)).toThrow(InvalidPointsEpochParams);
    });

    it.each([
        ["a zero rate scale", { rateScale: 0n }],
        ["a negative cliff", { cliffSeconds: -1n }],
        ["non-increasing edges", { cohortEdges: [T0, T0, T0 + 1n] as const }],
        ["increasing weights", { cohortWeightsBps: [10_000, 20_000, 10_000, 10_000] as const }],
        ["a weight above 6x", { cohortWeightsBps: [60_001, 10_000, 10_000, 10_000] as const }],
        ["a zero weight", { cohortWeightsBps: [10_000, 10_000, 10_000, 0] as const }],
        ["a negative rate", { rates: new Map([[USDC_KEY, -1n]]) }],
    ])("throw InvalidPointsEpochParams for %s", (_label, overrides) => {
        expect(() => computePoints([], [epoch(0n, 0n, T0, overrides)], null)).toThrow(
            InvalidPointsEpochParams,
        );
    });

    it("throw InvalidPointsInput for a negative value, naming the note by index only", () => {
        const commitment = h(0xdeadbeefn);
        const call = () => computePoints([note(), note({ commitment, value: -1n })], [e0], null);
        expect(call).toThrow(InvalidPointsInput);
        expect(call).toThrow("note at index 1 has a negative value");
        expect(call).not.toThrow(commitment);
    });
});

describe("liveEpochParams", () => {
    it("open the live window at the latest snapshot and close it at now", () => {
        const window = liveEpochParams(e1, T0 + 100n);
        expect(window).toMatchObject({
            epochNumber: null,
            windowStart: T0 + 30n,
            snapshotTime: T0 + 100n,
        });
        expect(window.rates).toBe(e1.rates);
    });

    it("never close the live window before it opens", () => {
        expect(liveEpochParams(e1, T0).snapshotTime).toBe(T0 + 30n);
    });
});

describe("epochParamsFromRateLeaves", () => {
    const PAD = BN254_SCALAR_MODULUS - 1n;
    const SNAPSHOT = 1_782_864_000n; // 2026-07-01T00:00:00Z
    const EDGES = SENTINELS.map(h);

    let hashService: PoseidonHashService;
    let merkleService: MerkleService;

    beforeAll(async () => {
        hashService = await PoseidonHashService.create();
        merkleService = new MerkleService({ hashService });
    });

    const pairs: [bigint, bigint][] = [
        [BigInt(USDC), 11574074074074074n],
        [BigInt(ETH_KEY), 34722222n],
        [PAD, 0n],
        [PAD, 0n],
    ];

    /** The tree root, computed independently of the code under test. */
    async function root(leaves: [bigint, bigint][]): Promise<Hex> {
        const hashes = leaves.map(([tokenId, rate]) => hashService.hash([h(tokenId), h(rate)]));
        return h(BigInt(await merkleService.computeRoot(hashes)));
    }

    async function served(
        leaves: [bigint, bigint][] = pairs,
        overrides: Partial<RateLeavesResponseDto> = {},
    ): Promise<{ epoch: PointsEpoch; rateLeaves: RateLeavesResponseDto }> {
        const rateRoot = await root(leaves);
        const epoch: PointsEpoch = {
            id: "1",
            epochNumber: h(6n),
            snapshotBlock: h(9012345n),
            snapshotTime: h(SNAPSHOT),
            aspRoot: h(1n),
            eligibilityRoot: h(2n),
            eligibilityIpfsCid: "bafy",
            eligibilityLeafCount: 1,
            eligibilityMerkleTreeId: null,
            spentNoteRoot: h(3n),
            spentNoteIpfsCid: "bafy",
            spentNoteLeafCount: 2,
            rateRoot,
            rateIpfsCid: "bafy",
            rateLeafCount: leaves.length,
            cliffSeconds: 604800,
            cohortEdges: EDGES,
            cohortWeights: [60000, 40000, 20000, 10000],
            cohortIpfsCid: null,
            tvlSeriesDigest: null,
            tvlSeriesLastSample: null,
            correctedAt: null,
            correctionTxHash: null,
            publishTxHash: "0xabc",
            createdAt: h(SNAPSHOT + 300n),
        };
        const rateLeaves: RateLeavesResponseDto = {
            epochNumber: h(6n),
            rateRoot,
            leaves: leaves.map(([tokenId, rate]) => [h(tokenId), h(rate)]),
            table: { program: { rateScale: "1000000000" } },
            rateScale: h(S),
            cliffSeconds: 604800,
            cohortEdges: EDGES,
            cohortWeights: [60000, 40000, 20000, 10000],
            ...overrides,
        };
        return { epoch, rateLeaves };
    }

    it("map the served epoch and verified rate leaves into epoch params", async () => {
        const { epoch, rateLeaves } = await served();
        const params = epochParamsFromRateLeaves(epoch, rateLeaves, T0, hashService);
        expect(params).toEqual({
            epochNumber: 6n,
            windowStart: T0,
            snapshotTime: SNAPSHOT,
            rateScale: S,
            rates: new Map([
                [USDC_KEY, 11574074074074074n],
                [ETH_KEY, 34722222n],
            ]),
            cliffSeconds: 604_800n,
            cohortEdges: SENTINELS,
            cohortWeightsBps: [60_000, 40_000, 20_000, 10_000],
        });
    });

    it("left-pad a small tokenId to 40 hex digits", async () => {
        const { epoch, rateLeaves } = await served([
            [255n, 7n],
            [PAD, 0n],
        ]);
        const params = epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService);
        expect([...params.rates.keys()]).toEqual([`0x${"0".repeat(38)}ff`]);
        expect(params.windowStart).toBe(0n);
    });

    it("read the rate scale from the payload, not a constant", async () => {
        const { epoch, rateLeaves } = await served(pairs, {
            rateScale: h(10n ** 27n),
        });
        const params = epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService);
        expect(params.rateScale).toBe(10n ** 27n);
    });

    it("accept the provider's parsed shapes as well as the served ones", async () => {
        const { epoch, rateLeaves } = await served();
        const parsedEpoch = PointsEpochSchema.parse(epoch);
        const parsedLeaves = RateLeavesResponseSchema.parse(rateLeaves);
        expect(epochParamsFromRateLeaves(parsedEpoch, parsedLeaves, null, hashService)).toEqual(
            epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService),
        );
    });

    it("throw InvalidPointsEpochParams when a rate was tampered with", async () => {
        const { epoch, rateLeaves } = await served();
        rateLeaves.leaves[0] = [h(BigInt(USDC)), h(11574074074074074n * 10n)];
        expect(() => epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService)).toThrow(
            "rate leaves do not recompute to rateRoot",
        );
    });

    it("throw InvalidPointsEpochParams when the leaves carry another root than the epoch", async () => {
        const { epoch, rateLeaves } = await served();
        const other = await served([
            [255n, 7n],
            [PAD, 0n],
        ]);
        expect(() => epochParamsFromRateLeaves(epoch, other.rateLeaves, null, hashService)).toThrow(
            "rate leaves root does not match the epoch",
        );
        expect(() => epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService)).not.toThrow();
    });

    it("throw InvalidPointsEpochParams for an epoch without a rate tree", async () => {
        const { epoch, rateLeaves } = await served();
        expect(() =>
            epochParamsFromRateLeaves({ ...epoch, rateRoot: null }, rateLeaves, null, hashService),
        ).toThrow("no rate tree published");
    });

    it.each<[string, [bigint, bigint][], Partial<RateLeavesResponseDto>]>([
        ["leaves for another epoch", pairs, { epochNumber: h(5n) }],
        ["no rate scale", pairs, { rateScale: null }],
        [
            "a conflicting duplicate tokenId",
            [
                [255n, 1n],
                [255n, 2n],
            ],
            {},
        ],
        ["two cohort edges", pairs, { cohortEdges: [h(1n), h(2n)] }],
        ["unsorted cohort edges", pairs, { cohortEdges: [h(3n), h(2n), h(1n)] }],
        ["a decimal epoch number", pairs, { epochNumber: "6" as Hex }],
    ])("throw InvalidPointsEpochParams for %s", async (_label, leaves, overrides) => {
        const { epoch, rateLeaves } = await served(leaves, overrides);
        expect(() => epochParamsFromRateLeaves(epoch, rateLeaves, null, hashService)).toThrow(
            InvalidPointsEpochParams,
        );
    });

    it("throw InvalidPointsEpochParams when no cliff was published", async () => {
        const { epoch, rateLeaves } = await served(pairs, { cliffSeconds: null });
        expect(() =>
            epochParamsFromRateLeaves(
                { ...epoch, cliffSeconds: null },
                rateLeaves,
                null,
                hashService,
            ),
        ).toThrow(InvalidPointsEpochParams);
    });
});
