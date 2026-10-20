import type {
    IHashService,
    PointsEpoch,
    PointsEpochParams,
    PointsRateLeaves,
    RateLeavesResponseDto,
} from "../../internal.js";
import {
    assertPointsEpochParams,
    InvalidPointsEpochParams,
    POINTS_MAX_TOKEN_ID,
    PointsEpochSchema,
    RateLeavesResponseSchema,
    rateTreeRoot,
} from "../../internal.js";

/**
 * The accrual parameters of one published epoch, from its epoch row and rate leaves — as the ASP
 * serves them or as {@link IPointsDataProvider} returns them; both are re-validated.
 *
 * The rate leaves are trusted only once they recompute to the epoch's `rateRoot`. Rate-leaf
 * tokenIds (`uint256(uint160(asset))`) become lowercased 0x-prefixed 40-hex addresses so they match
 * note tokenIds; padding leaves are dropped.
 *
 * @param previousSnapshotTime - The preceding epoch's snapshotTime, or null for the first epoch.
 * @param hashService - Poseidon, to recompute the rate tree root.
 * @throws {InvalidPointsEpochParams} When an input fails validation, the leaves are for another
 *   epoch, the epoch has no rate tree, the leaves do not recompute to the epoch's `rateRoot`, the
 *   epoch carries no rate scale, cliff or cohort schedule, a tokenId has two rates, or the result
 *   fails {@link assertPointsEpochParams}.
 */
export function epochParamsFromRateLeaves(
    epochInput: PointsEpoch,
    rateLeavesInput: PointsRateLeaves | RateLeavesResponseDto,
    previousSnapshotTime: bigint | null,
    hashService: IHashService,
): PointsEpochParams {
    const epoch = parse(epochInput, PointsEpochSchema, "epoch");
    const rateLeaves = parse(rateLeavesInput, RateLeavesResponseSchema, "rate leaves");
    const epochNumber = BigInt(epoch.epochNumber);
    const label = `epoch ${epochNumber}`;
    if (BigInt(rateLeaves.epochNumber) !== epochNumber) {
        throw new InvalidPointsEpochParams(
            `${label}: rate leaves are for epoch ${BigInt(rateLeaves.epochNumber)}`,
        );
    }
    if (epoch.rateRoot === null) {
        throw new InvalidPointsEpochParams(`${label}: no rate tree published`);
    }
    if (BigInt(rateLeaves.rateRoot) !== BigInt(epoch.rateRoot)) {
        throw new InvalidPointsEpochParams(`${label}: rate leaves root does not match the epoch`);
    }
    if (rateTreeRoot(rateLeaves.leaves, hashService) !== BigInt(epoch.rateRoot)) {
        throw new InvalidPointsEpochParams(`${label}: rate leaves do not recompute to rateRoot`);
    }

    if (rateLeaves.rateScale === null) {
        throw new InvalidPointsEpochParams(`${label}: no rateScale published`);
    }
    const cliffSeconds = rateLeaves.cliffSeconds ?? epoch.cliffSeconds;
    if (cliffSeconds === null) {
        throw new InvalidPointsEpochParams(`${label}: no cliffSeconds published`);
    }
    const edges = rateLeaves.cohortEdges.length > 0 ? rateLeaves.cohortEdges : epoch.cohortEdges;
    const weights =
        rateLeaves.cohortWeights.length > 0 ? rateLeaves.cohortWeights : epoch.cohortWeights;
    const [e0, e1, e2] = edges ?? [];
    const [w0, w1, w2, w3] = weights ?? [];
    if (edges?.length !== 3 || e0 === undefined || e1 === undefined || e2 === undefined) {
        throw new InvalidPointsEpochParams(`${label}: expected 3 published cohort edges`);
    }
    if (
        weights?.length !== 4 ||
        w0 === undefined ||
        w1 === undefined ||
        w2 === undefined ||
        w3 === undefined
    ) {
        throw new InvalidPointsEpochParams(`${label}: expected 4 published cohort weights`);
    }

    const rates = new Map<string, bigint>();
    for (const leaf of rateLeaves.leaves) {
        const tokenId = BigInt(leaf.tokenId);
        const rate = BigInt(leaf.rate);
        if (tokenId >= POINTS_MAX_TOKEN_ID) continue;
        const key = `0x${tokenId.toString(16).padStart(40, "0")}`;
        const existing = rates.get(key);
        if (existing !== undefined && existing !== rate) {
            throw new InvalidPointsEpochParams(`${label}: tokenId ${key} has two rates`);
        }
        rates.set(key, rate);
    }

    const params: PointsEpochParams = {
        epochNumber,
        windowStart: previousSnapshotTime ?? 0n,
        snapshotTime: BigInt(epoch.snapshotTime),
        rateScale: BigInt(rateLeaves.rateScale),
        rates,
        cliffSeconds: BigInt(cliffSeconds),
        cohortEdges: [BigInt(e0), BigInt(e1), BigInt(e2)],
        cohortWeightsBps: [w0, w1, w2, w3],
    };
    assertPointsEpochParams(params);
    return params;
}

/**
 * The live estimate window after the latest published epoch: the same rates, cliff and cohort
 * schedule, accruing from its snapshotTime to `nowSeconds` (never before it).
 */
export function liveEpochParams(latest: PointsEpochParams, nowSeconds: bigint): PointsEpochParams {
    return {
        ...latest,
        epochNumber: null,
        windowStart: latest.snapshotTime,
        snapshotTime: nowSeconds > latest.snapshotTime ? nowSeconds : latest.snapshotTime,
    };
}

function parse<T>(
    input: unknown,
    schema: {
        safeParse(
            raw: unknown,
        ):
            | { success: true; data: T }
            | { success: false; error: { issues: { message: string }[] } };
    },
    what: string,
): T {
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
        throw new InvalidPointsEpochParams(
            `${what} failed validation: ${parsed.error.issues[0]?.message ?? "invalid"}`,
        );
    }
    return parsed.data;
}
