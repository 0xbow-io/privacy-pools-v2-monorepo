import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { PointsEpochParams } from "../../../src/internal.js";
import { cliffOverlap, cohortBpsAt, notePointsForEpoch } from "../../../src/internal.js";

const EXPECTED_VECTOR_COUNT = 18;

const Decimal = z.string().regex(/^\d+$/, "must be a decimal integer string");
const VectorSchema = z.object({
    name: z.string().min(1),
    note: z.object({
        tokenId: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "must be a 20-byte address"),
        value: Decimal,
        createdAt: Decimal,
        spentAt: Decimal.nullable(),
    }),
    epoch: z.object({
        windowStart: Decimal,
        snapshotTime: Decimal,
        rateScale: Decimal,
        rate: Decimal.nullable(),
        cliffSeconds: Decimal,
        cohortEdges: z.tuple([Decimal, Decimal, Decimal]),
        cohortWeightsBps: z.tuple([Decimal, Decimal, Decimal, Decimal]),
    }),
    rateDerivation: z.record(z.string(), z.string()).optional(),
    expected: z.object({
        cliffOverlap: Decimal,
        cohortBps: Decimal,
        pointsWei: Decimal,
    }),
});
type Vector = z.infer<typeof VectorSchema>;

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/points-vectors.json");
const parsedFixture = z
    .object({ vectors: z.array(VectorSchema) })
    .safeParse(JSON.parse(readFileSync(FIXTURE, "utf8")));
if (!parsedFixture.success) {
    const issue = parsedFixture.error.issues[0];
    throw new Error(
        `points-vectors.json is malformed at ${issue?.path.join(".")}: ${issue?.message}`,
    );
}
const { vectors } = parsedFixture.data;

function noteOf(v: Vector) {
    return {
        tokenId: v.note.tokenId,
        value: BigInt(v.note.value),
        createdAt: BigInt(v.note.createdAt),
        spentAt: v.note.spentAt === null ? null : BigInt(v.note.spentAt),
    };
}

function epochOf(v: Vector): PointsEpochParams {
    const [e0, e1, e2] = v.epoch.cohortEdges.map(BigInt) as [bigint, bigint, bigint];
    const [w0, w1, w2, w3] = v.epoch.cohortWeightsBps.map(Number) as [
        number,
        number,
        number,
        number,
    ];
    return {
        epochNumber: 0n,
        windowStart: BigInt(v.epoch.windowStart),
        snapshotTime: BigInt(v.epoch.snapshotTime),
        rateScale: BigInt(v.epoch.rateScale),
        rates: new Map(
            v.epoch.rate === null ? [] : [[v.note.tokenId.toLowerCase(), BigInt(v.epoch.rate)]],
        ),
        cliffSeconds: BigInt(v.epoch.cliffSeconds),
        cohortEdges: [e0, e1, e2],
        cohortWeightsBps: [w0, w1, w2, w3],
    };
}

// Reference rate formulas, copied verbatim from asp-v2 apps/asp/src/points-rate-table.ts
// (roundHalfUp, tokenRate, shareRate). Only RateTableError is stubbed.
class RateTableError extends Error {
    constructor(
        public readonly tag: string,
        message: string,
    ) {
        super(message);
    }
}
const SECONDS_PER_DAY = 86_400n;

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
    if (denominator <= 0n) throw new RateTableError("rate-math", "denominator must be positive");
    if (numerator < 0n) throw new RateTableError("rate-math", "numerator must be non-negative");
    return (2n * numerator + denominator) / (2n * denominator);
}

interface TokenRateInput {
    pointsWeiPerUsdDay: bigint;
    rateScale: bigint;
    price: bigint;
    priceDecimals: number;
    assetDecimals: number;
}

function tokenRate(i: TokenRateInput): bigint {
    const numerator = i.pointsWeiPerUsdDay * i.rateScale * i.price;
    const denominator =
        SECONDS_PER_DAY * 10n ** BigInt(i.assetDecimals) * 10n ** BigInt(i.priceDecimals);
    return roundHalfUp(numerator, denominator);
}

interface ShareRateInput {
    pointsWeiPerUsdDay: bigint;
    rateScale: bigint;
    underlyingPrice: bigint;
    priceDecimals: number;
    underlyingDecimals: number;
    shareDecimals: number;
    assetsPerShareUnit: bigint;
}

function shareRate(i: ShareRateInput): bigint {
    const numerator = i.pointsWeiPerUsdDay * i.rateScale * i.underlyingPrice * i.assetsPerShareUnit;
    const denominator =
        SECONDS_PER_DAY *
        10n ** BigInt(i.underlyingDecimals) *
        10n ** BigInt(i.priceDecimals) *
        10n ** BigInt(i.shareDecimals);
    return roundHalfUp(numerator, denominator);
}

function derivedRate(d: Record<string, string>): bigint {
    if (d["kind"] === "erc4626") {
        return shareRate({
            pointsWeiPerUsdDay: BigInt(d["pointsWeiPerUsdDay"] ?? ""),
            rateScale: BigInt(d["rateScale"] ?? ""),
            underlyingPrice: BigInt(d["underlyingPrice"] ?? ""),
            priceDecimals: Number(d["priceDecimals"]),
            underlyingDecimals: Number(d["underlyingDecimals"]),
            shareDecimals: Number(d["shareDecimals"]),
            assetsPerShareUnit: BigInt(d["assetsPerShareUnit"] ?? ""),
        });
    }
    return tokenRate({
        pointsWeiPerUsdDay: BigInt(d["pointsWeiPerUsdDay"] ?? ""),
        rateScale: BigInt(d["rateScale"] ?? ""),
        price: BigInt(d["price"] ?? ""),
        priceDecimals: Number(d["priceDecimals"]),
        assetDecimals: Number(d["assetDecimals"]),
    });
}

function byName(name: string): Vector {
    const vector = vectors.find((v) => v.name === name);
    if (!vector) throw new Error(`missing vector ${name}`);
    return vector;
}

describe("points vectors", () => {
    it("carry exactly the expected vectors, each named once", () => {
        expect(vectors).toHaveLength(EXPECTED_VECTOR_COUNT);
        expect(new Set(vectors.map((v) => v.name)).size).toBe(EXPECTED_VECTOR_COUNT);
    });

    describe.each(vectors.map((v) => [v.name, v] as const))("%s", (_name, v) => {
        it("match cliffOverlap", () => {
            expect(cliffOverlap(noteOf(v), epochOf(v))).toBe(BigInt(v.expected.cliffOverlap));
        });

        it("match cohortBps", () => {
            const epoch = epochOf(v);
            expect(
                cohortBpsAt(BigInt(v.note.createdAt), epoch.cohortEdges, epoch.cohortWeightsBps),
            ).toBe(Number(v.expected.cohortBps));
        });

        it("match pointsWei", () => {
            expect(notePointsForEpoch(noteOf(v), epochOf(v))).toBe(BigInt(v.expected.pointsWei));
        });

        if (v.rateDerivation) {
            const derivation = v.rateDerivation;
            it("carry the rate the ASP's own formula derives", () => {
                expect(v.epoch.rate).toBe(derivedRate(derivation).toString());
            });
        }
    });

    describe("hand-checked values", () => {
        it("pay the brief's worked example 138,000 points less the rate residue", () => {
            const v = byName("brief-worked-example-usdc");
            // rate = roundHalfUp(1e18 * 1e9 * 1e8 / (86400 * 1e6 * 1e8)) = 11574074074074074
            // (the exact quotient is ...074.074, so it rounds down by 0.0740740...)
            expect(v.epoch.rate).toBe("11574074074074074");
            // 1e9 base units * rate * 60000 * (23 * 86400) / (1e9 * 10000) = rate * 6 * 1987200
            const points = 11574074074074074n * 6n * 1_987_200n;
            expect(v.expected.pointsWei).toBe(points.toString());
            // 138,000e18 minus 0.0740740... * 11,923,200 = 883,200 points-wei of residue
            expect(138_000n * 10n ** 18n - points).toBe(883_200n);
        });

        it("pay the same note 180,000 points in the next full epoch", () => {
            const v = byName("brief-worked-example-usdc-next-epoch");
            expect(BigInt(v.expected.pointsWei)).toBe(11574074074074074n * 6n * 2_592_000n);
            expect(180_000n * 10n ** 18n - BigInt(v.expected.pointsWei)).toBe(1_152_000n);
        });

        it("pay 1 ETH at 3,000 USD 540,000 points over 30 days at 6x", () => {
            const v = byName("eth-1-at-3000-twap");
            // rate = roundHalfUp(1e18 * 1e9 * 3000e8 / (86400 * 1e18 * 1e8)) = 34722222 (.22 dropped)
            expect(v.epoch.rate).toBe("34722222");
            // 1e18 * 34722222 * 60000 * 2592000 / (1e9 * 1e4) = 1e9 * 34722222 * 6 * 2592000
            expect(BigInt(v.expected.pointsWei)).toBe(10n ** 9n * 34_722_222n * 6n * 2_592_000n);
        });

        it("pay 1,000 ppUSDC at 1.0006 about 30,018 points at 1x", () => {
            const v = byName("ppusdc-share-erc4626");
            // rate = roundHalfUp(1e18 * 1e9 * 1e8 * 1000600 / (86400 * 1e6 * 1e8 * 1e18)) = 11581
            expect(v.epoch.rate).toBe("11581");
            // 1000e18 * 11581 * 10000 * 2592000 / (1e9 * 1e4) = 1e12 * 11581 * 2592000
            expect(BigInt(v.expected.pointsWei)).toBe(10n ** 12n * 11_581n * 2_592_000n);
        });

        it("keep every bit of a 240-bit numerator", () => {
            const v = byName("maximum-numerator");
            const max128 = (1n << 128n) - 1n;
            const max64 = (1n << 64n) - 1n;
            const max32 = (1n << 32n) - 1n;
            const numerator = max128 * max64 * 60_000n * max32;
            expect(numerator > 1n << 239n).toBe(true);
            expect(BigInt(v.expected.pointsWei)).toBe(numerator / (10n ** 9n * 10_000n));
        });
    });
});
