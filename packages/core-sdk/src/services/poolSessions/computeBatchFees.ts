// Direct import (not via internal.js barrel) is intentional: it keeps the
// `@privacy-pools-v2/core-sdk/batch-fee` build entry free of the barrel's ESM-only
// crypto side-effects so the CommonJS relayer (ts-jest) can dogfood this pure
// function. BatchWithdraw.js has zero imports, so nothing heavy is pulled in.
import { AssetNotRelayable, InfeasibleBatchFee } from "../../errors/BatchWithdraw.js";

/** Inputs for computing one batch item's standalone (normal single-tx) fee. */
export interface ComputeBatchItemFeeArgs {
    /** The single-tx relay gas cost, converted to token units (same for every item). */
    relayCost: bigint;
    /** The proportional fee rate in basis points; `0` selects the flat-fee model. */
    feeBps: bigint;
    /** The flat fee, in token units; used only when `feeBps === 0`. */
    flatFee: bigint;
    /** This item's withdrawn value (its `amountOut`). */
    amountOut: bigint;
    /** The per-item nominal maximum relay fee cap (asset `maxRelayFee`); `0` = no maximum (uncapped). */
    maxRelayFee: bigint;
}

/** Inputs for computing every batch item's standalone fee, in selection order. */
export type ComputeBatchFeesArgs = Omit<ComputeBatchItemFeeArgs, "amountOut"> & {
    /** Each item's withdrawn value (its `amountOut`), in selection order. */
    amountOuts: bigint[];
};

/**
 * Computes the fee a single batch item pays as if it were a STANDALONE withdrawal:
 * `min(maxRelayFee, relayCost + (feeBps > 0 ? amountOut·feeBps/10000 : flatFee))`.
 *
 * This mirrors the relayer's single-tx fee math byte-for-byte (`applyBPS` floor +
 * `capFee` min), so a relayer that cherry-picks and submits one proof of a batch
 * via the single `relay()` earns only the fair per-item fee — it can never
 * re-concentrate the whole batch fee onto one item.
 *
 * @param args - The shared relay cost / fee model plus this item's `amountOut`.
 * @returns The fee this item pays, in token units.
 * @throws {AssetNotRelayable} When a nonzero `maxRelayFee` is below `relayCost`.
 * @throws {InfeasibleBatchFee} When the computed fee exceeds the item's own `amountOut`.
 */
export function computeBatchItemFee(args: ComputeBatchItemFeeArgs): bigint {
    const { relayCost, feeBps, flatFee, amountOut, maxRelayFee } = args;

    // applyBPS floor: (amount * bps) / 10000n. feeBps === 0 selects the flat fee.
    const variableFee = feeBps > 0n ? (amountOut * feeBps) / 10_000n : flatFee;
    const rawFee = relayCost + variableFee;
    // capFee: min(fee, maxRelayFee). `maxRelayFee == 0` is the "no maximum" sentinel
    // (Entrypoint asset config), so it must NOT floor the fee to 0; a nonzero cap
    // below relayCost cannot cover cost, so the item is not relayable.
    let fee: bigint;
    if (maxRelayFee === 0n) {
        fee = rawFee;
    } else if (maxRelayFee < relayCost) {
        throw new AssetNotRelayable(maxRelayFee.toString(), relayCost.toString());
    } else {
        fee = rawFee < maxRelayFee ? rawFee : maxRelayFee;
    }

    if (fee > amountOut) {
        throw new InfeasibleBatchFee(fee.toString(), amountOut.toString());
    }

    return fee;
}

/**
 * Maps {@link computeBatchItemFee} over every item so each pays its own
 * standalone single-tx fee. The sum of the returned values is the batch total.
 *
 * @param args - The shared relay cost / fee model plus the per-item `amountOuts`.
 * @returns The fee for each item, in the same order as `amountOuts`.
 * @throws {InfeasibleBatchFee} When any item's fee exceeds its own `amountOut`.
 */
export function computeBatchFees(args: ComputeBatchFeesArgs): bigint[] {
    const { relayCost, feeBps, flatFee, amountOuts, maxRelayFee } = args;
    return amountOuts.map((amountOut) =>
        computeBatchItemFee({ relayCost, feeBps, flatFee, amountOut, maxRelayFee }),
    );
}
