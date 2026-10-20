import type {
    NoteEpochPoints,
    NotePoints,
    NotePointsStatus,
    PointsAccrualNote,
    PointsEpochParams,
    PointsNoteInput,
    PointsSummary,
    PointsTokenSummary,
} from "../../internal.js";
import {
    InvalidPointsEpochParams,
    InvalidPointsInput,
    MIN_PLAUSIBLE_POINTS_TIMESTAMP,
} from "../../internal.js";

const BPS_DENOMINATOR = 10_000n;
const SECONDS_PER_DAY = 86_400n;
const MAX_COHORT_WEIGHT_BPS = 60_000;

/**
 * The cohort multiplier of a note created at `createdAt`: `weights[k]`, where `k` is the number of
 * edges at or before `createdAt`. A note created exactly at an edge is in the next (lower) tier.
 */
export function cohortBpsAt(
    createdAt: bigint,
    edges: readonly [bigint, bigint, bigint],
    weights: readonly [number, number, number, number],
): number {
    let tier = 0;
    for (const edge of edges) {
        if (edge <= createdAt) tier++;
    }
    return weights[tier] ?? 0;
}

/**
 * Seconds of the epoch window the note accrues for, after its cliff:
 * `max(0, min(end, snapshotTime) - max(createdAt + cliffSeconds, windowStart))`, where `end` is
 * `spentAt` for a spent note and `snapshotTime` otherwise.
 */
export function cliffOverlap(note: PointsAccrualNote, epoch: PointsEpochParams): bigint {
    const end = note.spentAt ?? epoch.snapshotTime;
    const to = end < epoch.snapshotTime ? end : epoch.snapshotTime;
    const activation = note.createdAt + epoch.cliffSeconds;
    const from = activation > epoch.windowStart ? activation : epoch.windowStart;
    return to > from ? to - from : 0n;
}

/**
 * Points-wei one note earns in one epoch, exactly as the claim pays it:
 * `floor(value * rate * cohortBps * cliffOverlap / (rateScale * 10000))`, floored once.
 * A tokenId absent from the epoch's rates earns nothing. Accrual math only: eligibility and
 * timestamp plausibility are applied by {@link computePoints}.
 */
export function notePointsForEpoch(note: PointsAccrualNote, epoch: PointsEpochParams): bigint {
    const rate = epoch.rates.get(note.tokenId.toLowerCase());
    if (rate === undefined) return 0n;
    const overlap = cliffOverlap(note, epoch);
    if (overlap === 0n) return 0n;
    const bps = BigInt(cohortBpsAt(note.createdAt, epoch.cohortEdges, epoch.cohortWeightsBps));
    return (note.value * rate * bps * overlap) / (epoch.rateScale * BPS_DENOMINATOR);
}

/**
 * Points of every note: the sum over the published epochs (claimable) plus the live window since
 * the latest one (estimated). PURE: no I/O, no clock.
 *
 * Only an approved note's published-epoch points are `claimable`; a note still pending ASP review
 * reports them as `pending`, since a claim pays only notes in the epoch's eligibility snapshot. A
 * declined note earns nothing (`ineligible`); a note whose `createdAt` or `spentAt` is unknown or
 * not a plausible unix timestamp earns nothing (`unknown-time`). Each epoch is a separate claim, so
 * each is floored on its own.
 *
 * @throws {InvalidPointsEpochParams} When an epoch's parameters are malformed, a published epoch
 *   has no epoch number, or the published epochs and the live window do not tile the timeline.
 * @throws {InvalidPointsInput} When a note's value is negative.
 */
export function computePoints(
    notes: PointsNoteInput[],
    published: PointsEpochParams[],
    live: PointsEpochParams | null,
): PointsSummary {
    const epochs = orderedEpochs(published, live);
    const current = live ?? epochs[epochs.length - 1] ?? null;

    const results = notes.map((note, index) =>
        computeNotePoints(note, index, epochs, live, current),
    );

    let claimable = 0n;
    let pending = 0n;
    let estimated = 0n;
    let pointsPerDay = 0n;
    const byTokenId: Record<string, PointsTokenSummary> = {};
    for (const result of results) {
        claimable += result.claimable;
        pending += result.pending;
        estimated += result.estimated;
        pointsPerDay += result.pointsPerDay;
        const key = result.tokenId.toLowerCase();
        const entry = (byTokenId[key] ??= {
            claimable: 0n,
            pending: 0n,
            estimated: 0n,
            total: 0n,
            pointsPerDay: 0n,
            noteCount: 0,
        });
        entry.claimable += result.claimable;
        entry.pending += result.pending;
        entry.estimated += result.estimated;
        entry.total += result.claimable + result.pending + result.estimated;
        entry.pointsPerDay += result.pointsPerDay;
        entry.noteCount += 1;
    }

    return {
        claimable,
        pending,
        estimated,
        total: claimable + pending + estimated,
        pointsPerDay,
        byTokenId,
        notes: results,
    };
}

/**
 * Checks one epoch's parameters.
 *
 * @throws {InvalidPointsEpochParams} On a non-positive rate scale, a negative time, cliff or rate,
 *   a snapshotTime before windowStart, epoch 0 not starting at 0, cohort edges that are not strictly increasing and positive, or cohort weights that are not
 *   non-increasing integers in (0, 60000].
 */
export function assertPointsEpochParams(epoch: PointsEpochParams): void {
    const label = epoch.epochNumber === null ? "live window" : `epoch ${epoch.epochNumber}`;
    const fail = (reason: string): never => {
        throw new InvalidPointsEpochParams(`${label}: ${reason}`);
    };
    if (epoch.rateScale <= 0n) fail("rateScale must be positive");
    if (epoch.windowStart < 0n) fail("windowStart must be non-negative");
    if (epoch.snapshotTime < epoch.windowStart) fail("snapshotTime is before windowStart");
    if (epoch.epochNumber === 0n && epoch.windowStart !== 0n) {
        fail("epoch 0 must start at windowStart 0");
    }
    if (epoch.cliffSeconds < 0n) fail("cliffSeconds must be non-negative");
    if (epoch.cohortEdges.length !== 3) fail("expected 3 cohort edges");
    if (epoch.cohortWeightsBps.length !== 4) fail("expected 4 cohort weights");
    epoch.cohortEdges.forEach((edge, tier) => {
        if (edge <= 0n) fail(`cohort edge ${tier} must be positive`);
        const previous = epoch.cohortEdges[tier - 1];
        if (previous !== undefined && edge <= previous) {
            fail("cohort edges must be strictly increasing");
        }
    });
    epoch.cohortWeightsBps.forEach((weight, tier) => {
        if (!Number.isInteger(weight) || weight <= 0 || weight > MAX_COHORT_WEIGHT_BPS) {
            fail(`cohort weight ${tier} must be an integer in (0, ${MAX_COHORT_WEIGHT_BPS}]`);
        }
        const previous = epoch.cohortWeightsBps[tier - 1];
        if (previous !== undefined && weight > previous) {
            fail("cohort weights must be non-increasing");
        }
    });
    for (const [tokenId, rate] of epoch.rates) {
        if (rate < 0n) fail(`rate for ${tokenId} must be non-negative`);
    }
}

function orderedEpochs(
    published: PointsEpochParams[],
    live: PointsEpochParams | null,
): PointsEpochParams[] {
    for (const epoch of published) {
        if (epoch.epochNumber === null) {
            throw new InvalidPointsEpochParams("a published epoch must carry its epoch number");
        }
        assertPointsEpochParams(epoch);
    }
    const epochs = [...published].sort((a, b) =>
        (a.epochNumber as bigint) < (b.epochNumber as bigint) ? -1 : 1,
    );
    for (let i = 1; i < epochs.length; i++) {
        const previous = epochs[i - 1] as PointsEpochParams;
        const epoch = epochs[i] as PointsEpochParams;
        if (epoch.epochNumber === previous.epochNumber) {
            throw new InvalidPointsEpochParams(`epoch ${epoch.epochNumber} appears twice`);
        }
        if (epoch.windowStart !== previous.snapshotTime) {
            throw new InvalidPointsEpochParams(
                `epoch ${epoch.epochNumber} windowStart ${epoch.windowStart} does not meet epoch ${previous.epochNumber} snapshotTime ${previous.snapshotTime}`,
            );
        }
    }
    if (live) {
        if (live.epochNumber !== null) {
            throw new InvalidPointsEpochParams("the live window must have a null epoch number");
        }
        assertPointsEpochParams(live);
        const last = epochs[epochs.length - 1];
        if (last && live.windowStart !== last.snapshotTime) {
            throw new InvalidPointsEpochParams(
                `live window windowStart ${live.windowStart} does not meet epoch ${last.epochNumber} snapshotTime ${last.snapshotTime}`,
            );
        }
    }
    return epochs;
}

function computeNotePoints(
    input: PointsNoteInput,
    index: number,
    epochs: PointsEpochParams[],
    live: PointsEpochParams | null,
    current: PointsEpochParams | null,
): NotePoints {
    // Errors name the note by index only: a commitment in an error message would travel wherever
    // the integrator ships errors, next to the user's IP and wallet.
    if (input.value < 0n) {
        throw new InvalidPointsInput(`note at index ${index} has a negative value`);
    }

    if (
        input.spentAt === "unknown" ||
        input.createdAt < MIN_PLAUSIBLE_POINTS_TIMESTAMP ||
        (input.spentAt !== null && input.spentAt < MIN_PLAUSIBLE_POINTS_TIMESTAMP)
    ) {
        return {
            commitment: input.commitment,
            tokenId: input.tokenId,
            claimable: 0n,
            pending: 0n,
            estimated: 0n,
            status: "unknown-time",
            activatesAt: null,
            cohortBps: 0,
            pointsPerDay: 0n,
            perEpoch: [],
        };
    }

    const note: PointsAccrualNote = {
        tokenId: input.tokenId,
        value: input.value,
        createdAt: input.createdAt,
        spentAt: input.spentAt,
    };
    const eligible = input.aspStatus !== "declined";
    const perEpoch: NoteEpochPoints[] = [];
    let published = 0n;
    for (const epoch of epochs) {
        const points = eligible ? notePointsForEpoch(note, epoch) : 0n;
        published += points;
        perEpoch.push({ epochNumber: epoch.epochNumber, points });
    }
    const approved = input.aspStatus === "approved";
    let estimated = 0n;
    if (live) {
        estimated = eligible ? notePointsForEpoch(note, live) : 0n;
        perEpoch.push({ epochNumber: null, points: estimated });
    }

    const activatesAt = current ? note.createdAt + current.cliffSeconds : null;
    const cohortBps = current
        ? cohortBpsAt(note.createdAt, current.cohortEdges, current.cohortWeightsBps)
        : 0;
    const status = noteStatus(note, eligible, current, activatesAt);

    let pointsPerDay = 0n;
    const liveRate = live?.rates.get(note.tokenId.toLowerCase());
    if (live && status === "accruing" && liveRate !== undefined) {
        const bps = BigInt(cohortBpsAt(note.createdAt, live.cohortEdges, live.cohortWeightsBps));
        pointsPerDay =
            (note.value * liveRate * bps * SECONDS_PER_DAY) / (live.rateScale * BPS_DENOMINATOR);
    }

    return {
        commitment: input.commitment,
        tokenId: input.tokenId,
        claimable: approved ? published : 0n,
        pending: approved ? 0n : published,
        estimated,
        status,
        activatesAt,
        cohortBps,
        pointsPerDay,
        perEpoch,
    };
}

function noteStatus(
    note: PointsAccrualNote,
    eligible: boolean,
    current: PointsEpochParams | null,
    activatesAt: bigint | null,
): NotePointsStatus {
    if (!eligible) return "ineligible";
    if (note.spentAt !== null) return "closed";
    if (!current || activatesAt === null || current.snapshotTime < activatesAt) return "activating";
    return "accruing";
}
