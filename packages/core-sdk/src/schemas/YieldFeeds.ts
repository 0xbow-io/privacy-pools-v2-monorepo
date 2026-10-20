import { z } from "zod";

import { AddressSchema, DecimalRepresentationToHexSchema, HexSchema } from "./common.js";

/** A non-negative integer carried as a decimal string (bigint on the wire), parsed to `bigint`. */
const DecimalBigIntSchema = z
    .string()
    .regex(/^\d+$/, "Must be a non-negative decimal integer string")
    .transform((value) => BigInt(value));

/** An ISO-8601 timestamp, parsed to unix seconds. */
const IsoTimestampToSecondsSchema = z.string().transform((value, ctx) => {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Must be an ISO-8601 timestamp" });
        return z.NEVER;
    }
    return Math.floor(ms / 1000);
});

/**
 * One row of `GET /:chainId/public/yield-deposits`. The three value columns are nullable on the
 * wire (a row the indexer could not correlate); such a row carries no basis and the provider
 * drops it, which the computation then reports as `deposit-fact-missing` for that deposit.
 */
export const YieldDepositFactRowSchema = z.object({
    id: z.string(),
    txHash: HexSchema,
    blockTimestamp: IsoTimestampToSecondsSchema,
    outputCommitment: DecimalRepresentationToHexSchema,
    asset: AddressSchema,
    grossUnderlying: DecimalBigIntSchema.nullable(),
    noteShares: DecimalBigIntSchema.nullable(),
    totalSharesMinted: DecimalBigIntSchema.nullable(),
    vettingFeeShares: DecimalBigIntSchema.nullable().optional(),
});

/** One page of the deposit-facts feed. `lastSyncedId` is the id of the last row returned. */
export const YieldDepositsPageSchema = z.object({
    deposits: z.array(YieldDepositFactRowSchema),
    lastSyncedId: z.string(),
});

/** One row of `GET /:chainId/public/ppusdc-rate-history`. */
export const YieldRateSnapshotRowSchema = z.object({
    id: z.string(),
    exchangeRate: DecimalBigIntSchema,
    shareDecimals: z.number().int().nonnegative().nullable(),
    assetDecimals: z.number().int().nonnegative().nullable(),
    feeBps: z.number().int().nullable().optional(),
    observationBlock: DecimalBigIntSchema,
    observationTimestamp: IsoTimestampToSecondsSchema,
});

/** One page of the rate-history feed. `ppUsdcAddress` names the share the rows were read from. */
export const YieldRateHistoryPageSchema = z.object({
    ppUsdcAddress: AddressSchema,
    snapshots: z.array(YieldRateSnapshotRowSchema),
    lastSyncedId: z.string(),
});
