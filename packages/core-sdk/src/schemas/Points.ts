import { z } from "zod";

import type { Hex, IHashService, IHTTPClient } from "../internal.js";
import { BN254_SCALAR_MODULUS } from "../internal.js";

/**
 * Every integer the points API serves (roots, leaves, epoch and block numbers, unix-second
 * timestamps) is a 32-byte big-endian `0x` value; normalized to lowercase.
 */
const Hex32Schema = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/, "Must be a 0x-prefixed 32-byte hex value")
    .transform((value) => value.toLowerCase() as Hex);

/** A BN254 field element: a root, leaf preimage or tokenId. */
const FieldElementSchema = Hex32Schema.refine((value) => BigInt(value) < BN254_SCALAR_MODULUS, {
    message: "Must be a BN254 field element",
});

const CountSchema = z.number().int().nonnegative();

/** A field newer ASP versions add: accepted when absent and normalized to `null`. */
function optionalNullable<T extends z.ZodTypeAny>(schema: T) {
    return schema
        .nullable()
        .optional()
        .transform((value): z.output<T> | null => value ?? null);
}

/** A spent-note leaf as served (`[nullifierHash, spentAt]`) or as parsed, so parsing is idempotent. */
const SpentNoteLeafSchema = z.union([
    z
        .tuple([FieldElementSchema, Hex32Schema])
        .transform(([nullifierHash, spentAt]) => ({ nullifierHash, spentAt })),
    z.object({ nullifierHash: FieldElementSchema, spentAt: Hex32Schema }),
]);

/** A rate leaf as served (`[tokenId, rate]`) or as parsed, so parsing is idempotent. */
const RateLeafSchema = z.union([
    z.tuple([FieldElementSchema, Hex32Schema]).transform(([tokenId, rate]) => ({ tokenId, rate })),
    z.object({ tokenId: FieldElementSchema, rate: Hex32Schema }),
]);

/** Validates the points data provider constructor config. */
export const HttpPointsDataProviderConfigSchema = z.object({
    aspUrl: z
        .url("Must be a valid URL")
        .refine((url) => url.startsWith("http://") || url.startsWith("https://"), {
            message: "URL must use http or https protocol",
        }),
    chainId: z.number().int().positive("Chain ID must be a positive integer"),
    entrypointAddress: z.string().min(1, "entrypointAddress must not be empty"),
    httpClient: z.custom<IHTTPClient>(
        (value) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { get?: unknown }).get === "function",
        "httpClient must implement get()",
    ),
    hashService: z.custom<IHashService>(
        (value) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as { hash?: unknown }).hash === "function",
        "hashService must implement hash()",
    ),
});

/** One row of `GET /:chainId/public/points/epochs` (and the body of `/epochs/latest`). */
export const PointsEpochSchema = z.object({
    id: z.string().regex(/^\d+$/, "Must be a decimal row id"),
    epochNumber: Hex32Schema,
    snapshotBlock: Hex32Schema,
    snapshotTime: Hex32Schema,
    aspRoot: FieldElementSchema,
    eligibilityRoot: FieldElementSchema,
    eligibilityIpfsCid: z.string(),
    eligibilityLeafCount: CountSchema,
    eligibilityMerkleTreeId: z.string().nullable(),
    spentNoteRoot: FieldElementSchema,
    spentNoteIpfsCid: z.string(),
    spentNoteLeafCount: CountSchema,
    rateRoot: optionalNullable(FieldElementSchema),
    rateIpfsCid: optionalNullable(z.string()),
    rateLeafCount: optionalNullable(CountSchema),
    cliffSeconds: optionalNullable(CountSchema),
    cohortEdges: optionalNullable(z.array(Hex32Schema)),
    cohortWeights: optionalNullable(z.array(CountSchema)),
    cohortIpfsCid: optionalNullable(z.string()),
    tvlSeriesDigest: optionalNullable(z.string()),
    tvlSeriesLastSample: optionalNullable(Hex32Schema),
    correctedAt: optionalNullable(Hex32Schema),
    correctionTxHash: optionalNullable(z.string()),
    publishTxHash: z.string().nullable(),
    createdAt: Hex32Schema,
});

/** One page of the epochs feed. `lastSyncedId` is the id of the last row returned. */
export const PointsEpochsPageSchema = z.object({
    epochs: z.array(PointsEpochSchema),
    lastSyncedId: z.string().regex(/^\d+$/, "Must be a decimal row id"),
});

/** `GET /:chainId/public/points/epochs/:n/spent-note-leaves`. */
export const SpentNoteLeavesResponseSchema = z.object({
    epochNumber: Hex32Schema,
    spentNoteRoot: FieldElementSchema,
    leaves: z.array(SpentNoteLeafSchema),
});

/** `GET /:chainId/public/points/epochs/:n/rate-leaves`. */
export const RateLeavesResponseSchema = z.object({
    epochNumber: Hex32Schema,
    rateRoot: FieldElementSchema,
    leaves: z.array(RateLeafSchema),
    table: z.record(z.string(), z.unknown()),
    rateScale: Hex32Schema.nullable().refine((value) => value === null || BigInt(value) > 0n, {
        message: "rateScale must be positive",
    }),
    cliffSeconds: CountSchema.nullable(),
    cohortEdges: z.array(Hex32Schema),
    cohortWeights: z.array(CountSchema),
});

const CohortTierSchema = z.object({
    tier: z.number().int().nonnegative(),
    thresholdUsd8: Hex32Schema,
    weightBps: CountSchema,
    sealed: z.boolean(),
    edgeUnix: Hex32Schema.nullable(),
    sealedInEpoch: Hex32Schema.nullable(),
    sealedAt: Hex32Schema.nullable(),
    runFirstAt: Hex32Schema.nullable(),
    runLastAt: Hex32Schema.nullable(),
});

const CohortSampleSchema = z.object({
    at: Hex32Schema,
    totalUsd8: Hex32Schema,
    priced: z.boolean(),
    unpricedReason: z.string().nullable(),
    tierCleared: z.number().int(),
});

/** One page of `GET /:chainId/public/points/cohorts`. */
export const PointsCohortsPageSchema = z
    .object({
        campaignKey: z.string(),
        cliffSeconds: CountSchema.nullable(),
        sampleIntervalSeconds: CountSchema,
        sustainSamples: CountSchema,
        seriesStartUnix: Hex32Schema,
        priceRule: z.string(),
        thresholdsUsd8: z.array(Hex32Schema),
        weightsBps: z.array(CountSchema),
        includedPools: z.array(z.object({ chainId: z.string(), poolConfigurationId: z.string() })),
        publishedEdges: z.array(Hex32Schema),
        publishedWeights: z.array(CountSchema),
        publishedInEpoch: Hex32Schema.nullable(),
        cohortIpfsCid: z.string().nullable(),
        pinnedOnChain: z.boolean(),
        publishTxHash: z.string().nullable(),
        tiers: z.array(CohortTierSchema),
        baseWeightBps: CountSchema,
        seriesDigest: z.string().nullable(),
        seriesLastSample: Hex32Schema.nullable(),
        seriesHasMore: z.boolean(),
        seriesNextSince: z.string().min(1).nullable(),
        series: z.array(CohortSampleSchema),
    })
    .refine((page) => !page.seriesHasMore || page.seriesNextSince !== null, {
        message: "seriesHasMore requires a seriesNextSince cursor",
    });

/** `GET /:chainId/public/points/stats`. */
export const PointsStatsResponseSchema = z.object({
    epochCount: CountSchema,
    latestEpochNumber: Hex32Schema.nullable(),
    latestSnapshotTime: Hex32Schema.nullable(),
    latestSpentNoteLeafCount: CountSchema.nullable(),
    latestEligibilityLeafCount: CountSchema.nullable(),
    latestRateLeafCount: optionalNullable(CountSchema),
});
