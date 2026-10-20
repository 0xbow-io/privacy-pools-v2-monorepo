import type { Hash, Hex, IHashService, IHTTPClient, ILogger } from "../internal.js";

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/**
 * Everything one accrual window pays under: a published epoch, or the live window since the latest
 * one. All times are unix seconds.
 */
export interface PointsEpochParams {
    /** The published epoch number, or `null` for the live estimate window. */
    epochNumber: bigint | null;
    /** The previous epoch's snapshotTime (0 for epoch 0). */
    windowStart: bigint;
    /** The epoch's snapshotTime; for the live window, now. */
    snapshotTime: bigint;
    /** S: the fixed-point scale the rates carry. */
    rateScale: bigint;
    /** Points-wei per base-unit-second scaled by S, keyed by lowercased tokenId. Absent = earns nothing. */
    rates: ReadonlyMap<string, bigint>;
    cliffSeconds: bigint;
    /** Strictly increasing; an unreached milestone is the sentinel 2^47 + tier. */
    cohortEdges: readonly [bigint, bigint, bigint];
    /** Basis points, non-increasing (e.g. 60000 / 40000 / 20000 / 10000). */
    cohortWeightsBps: readonly [number, number, number, number];
}

export type PointsAspStatus = "approved" | "pending" | "declined";

export interface PointsNoteInput {
    commitment: Hash;
    /** The note's tokenId as-is (on EVM the token address); matched against rates lowercased. */
    tokenId: string;
    /** Base units. */
    value: bigint;
    /** Unix seconds (the commitment leaf's block timestamp). */
    createdAt: bigint;
    /**
     * Unix seconds the note was spent; `null` if unspent; `"unknown"` if it is spent but the spend
     * time is not known yet (reported as `unknown-time`, never counted as held).
     */
    spentAt: bigint | null | "unknown";
    aspStatus: PointsAspStatus;
}

/** The fields the accrual formula reads. */
export interface PointsAccrualNote {
    tokenId: string;
    value: bigint;
    createdAt: bigint;
    spentAt: bigint | null;
}

/**
 * `unknown-time`: `createdAt` (or a set `spentAt`) is not a plausible unix timestamp, e.g. a
 * legacy export carrying a block number, or `spentAt` is `"unknown"`; such a note earns nothing
 * until its time is known.
 */
export type NotePointsStatus = "activating" | "accruing" | "closed" | "ineligible" | "unknown-time";

export interface NoteEpochPoints {
    /** `null` for the live estimate window. */
    epochNumber: bigint | null;
    /** Points-wei. */
    points: bigint;
}

export interface NotePoints {
    commitment: Hash;
    tokenId: string;
    /** Points-wei over the published epochs; 0n unless the note is ASP-approved. */
    claimable: bigint;
    /**
     * Points-wei over the published epochs of a note still pending ASP review: not claimable until
     * the note is approved and lands in an epoch's eligibility snapshot.
     */
    pending: bigint;
    /** Points-wei over the live window. */
    estimated: bigint;
    status: NotePointsStatus;
    /** createdAt + cliffSeconds of the current window, or null when unknown. */
    activatesAt: bigint | null;
    /** The note's cohort multiplier under the current window, in basis points (0 when unknown). */
    cohortBps: number;
    /** Points-wei per day at the live window's rate; 0n inside the cliff or when not accruing. */
    pointsPerDay: bigint;
    perEpoch: NoteEpochPoints[];
}

export interface PointsTokenSummary {
    claimable: bigint;
    pending: bigint;
    estimated: bigint;
    total: bigint;
    pointsPerDay: bigint;
    noteCount: number;
}

export interface PointsSummary {
    /** Points-wei over the published epochs, approved notes only: what claims will pay. */
    claimable: bigint;
    /** Points-wei over the published epochs of notes pending ASP review. */
    pending: bigint;
    /** Points-wei over the live window. */
    estimated: bigint;
    /** claimable + pending + estimated. */
    total: bigint;
    pointsPerDay: bigint;
    /** Keyed by lowercased tokenId. */
    byTokenId: Record<string, PointsTokenSummary>;
    notes: NotePoints[];
}

// ---------------------------------------------------------------------------
// Points data provider (ASP public points API)
// ---------------------------------------------------------------------------

/** One published points epoch, from `GET /:chainId/public/points/epochs`. */
export interface PointsEpoch {
    /** Feed row id (keyset cursor). */
    id: string;
    /** Per-pool epoch number (the on-chain PointsRegistry epoch id). */
    epochNumber: Hex;
    /** Block the epoch is complete through. */
    snapshotBlock: Hex;
    /** Unix seconds of the epoch snapshot (the accrual window's end). */
    snapshotTime: Hex;
    aspRoot: Hash;
    eligibilityRoot: Hash;
    eligibilityIpfsCid: string;
    eligibilityLeafCount: number;
    /** Id of the snapshotted association set, served by the ASP's association-set endpoints. */
    eligibilityMerkleTreeId: string | null;
    spentNoteRoot: Hash;
    spentNoteIpfsCid: string;
    /** Including the two boundary sentinels. */
    spentNoteLeafCount: number;
    /** Null for epochs published before the rate tree. */
    rateRoot: Hash | null;
    rateIpfsCid: string | null;
    rateLeafCount: number | null;
    cliffSeconds: number | null;
    cohortEdges: Hex[] | null;
    cohortWeights: number[] | null;
    cohortIpfsCid: string | null;
    tvlSeriesDigest: string | null;
    /** Unix seconds. */
    tvlSeriesLastSample: Hex | null;
    /** Unix seconds. */
    correctedAt: Hex | null;
    correctionTxHash: string | null;
    publishTxHash: string | null;
    /** Unix seconds the epoch row was created. */
    createdAt: Hex;
}

/** A rate-leaves response as the ASP serves it: leaves are `[tokenId, rate]` pairs. */
export type RateLeavesResponseDto = Omit<PointsRateLeaves, "leaves"> & {
    leaves: [Hex, Hex][];
};

/** One sorted spent-note tree leaf preimage. */
export interface SpentNoteLeaf {
    nullifierHash: Hash;
    /** Unix seconds (0 for the sentinels). */
    spentAt: Hex;
}

/** The complete sorted spent-note leaf set of one epoch. */
export interface SpentNoteLeaves {
    epochNumber: Hex;
    spentNoteRoot: Hash;
    leaves: SpentNoteLeaf[];
}

/** One rate tree leaf preimage. `tokenId = uint256(uint160(asset))`; padding leaves are included. */
export interface RateLeaf {
    tokenId: Hex;
    rate: Hex;
}

/** The complete rate tree of one epoch, with the parameters it was published with. */
export interface PointsRateLeaves {
    epochNumber: Hex;
    rateRoot: Hash;
    leaves: RateLeaf[];
    /** The audit table behind the leaves (program constants, prices, exchange rates). */
    table: Record<string, unknown>;
    /** S, the rates' fixed-point scale (`table.program.rateScale`), or null when not published. */
    rateScale: Hex | null;
    cliffSeconds: number | null;
    cohortEdges: Hex[];
    cohortWeights: number[];
}

export interface PointsCohortTier {
    tier: number;
    thresholdUsd8: Hex;
    weightBps: number;
    sealed: boolean;
    edgeUnix: Hex | null;
    sealedInEpoch: Hex | null;
    /** Unix seconds. */
    sealedAt: Hex | null;
    /** Unix seconds. */
    runFirstAt: Hex | null;
    /** Unix seconds. */
    runLastAt: Hex | null;
}

export interface PointsTvlSample {
    /** Unix seconds (UTC midnight). */
    at: Hex;
    totalUsd8: Hex;
    priced: boolean;
    unpricedReason: string | null;
    /** Highest milestone this sample clears, -1 for none. */
    tierCleared: number;
}

/** The campaign's TVL-milestone cohort schedule, every series page drained. */
export interface PointsCohorts {
    campaignKey: string;
    cliffSeconds: number | null;
    sampleIntervalSeconds: number;
    sustainSamples: number;
    seriesStartUnix: Hex;
    priceRule: string;
    thresholdsUsd8: Hex[];
    weightsBps: number[];
    includedPools: { chainId: string; poolConfigurationId: string }[];
    publishedEdges: Hex[];
    publishedWeights: number[];
    publishedInEpoch: Hex | null;
    cohortIpfsCid: string | null;
    /** False while the schedule is a derivation the operator can still redo: present it as an estimate. */
    pinnedOnChain: boolean;
    publishTxHash: string | null;
    tiers: PointsCohortTier[];
    baseWeightBps: number;
    seriesDigest: string | null;
    /** Unix seconds. */
    seriesLastSample: Hex | null;
    series: PointsTvlSample[];
}

/** Display-only aggregate points stats. */
export interface PointsStats {
    epochCount: number;
    latestEpochNumber: Hex | null;
    /** Unix seconds. */
    latestSnapshotTime: Hex | null;
    latestSpentNoteLeafCount: number | null;
    latestEligibilityLeafCount: number | null;
    latestRateLeafCount: number | null;
}

export interface HttpPointsDataProviderConfig {
    /** Base URL of the ASP HTTP API. */
    aspUrl: string;
    chainId: number;
    /** Entrypoint of the target pool, sent as `entrypoint=` on every request. */
    entrypointAddress: string;
    httpClient: IHTTPClient;
    /** Poseidon, to recompute served leaf sets' roots before trusting them. */
    hashService: IHashService;
}

export interface HttpPointsDataProviderDependencies {
    logger?: ILogger;
}
