/**
 * Dedicated, dependency-light public entry for the batch fee split.
 *
 * The relayer dogfoods {@link computeBatchFees} to compute each item's normal
 * single-tx fee for the per-item `PayoutRouting[]` it signs. It is exposed on its
 * own subpath (`@privacy-pools-v2/core-sdk/batch-fee`) so a CommonJS consumer (the
 * NestJS relayer's ts-jest runner) can import the pure functions without pulling
 * the full SDK barrel and its ESM-only crypto dependencies.
 */
// Direct-path imports (not via internal.js) are intentional here: this entry
// must stay free of the barrel's ESM-only crypto side-effects so a CommonJS
// consumer can require it. computeBatchFees.ts only depends on the zero-import
// errors/BatchWithdraw.js, so the resulting bundle is pure.
export { computeBatchFees, computeBatchItemFee } from "./services/poolSessions/computeBatchFees.js";
export type {
    ComputeBatchFeesArgs,
    ComputeBatchItemFeeArgs,
} from "./services/poolSessions/computeBatchFees.js";

// MAX_BATCH lives in a zero-import constant module, so re-exporting it here keeps
// this entry crypto-free while letting the CommonJS relayer import the per-batch
// cap (array length bound) from the same dependency-light subpath.
export { MAX_BATCH } from "./constant/BatchWithdraw.js";
