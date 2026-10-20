import type { Hex } from "../internal.js";
import { InvalidTransactParams } from "../internal.js";

/**
 * Upper bound (basis points of the net withdrawal) on the swap input dust —
 * `net − lifiFromAmount`, swept to `dustRecipient` (relayer by default for reshield,
 * recipient for same-chain withdraw). Sized above the legitimate slack (reshield's ~1%
 * under-sizing buffer + slippage, or withdraw's fee over-estimate buffer) so honest quotes
 * never trip it, but low enough that a fee-under-quoting relayer cannot shift meaningful
 * value from the capped fee into uncapped dust (review M-1).
 */
export const SWAP_DUST_TOLERANCE_BPS = 300n;

/**
 * Which side of {@link assertLifiBudget} a fixed swap input violates against `net`, if any:
 * `"exceedsNet"` (input above the budget) or `"dust"` (leftover above SWAP_DUST_TOLERANCE_BPS).
 * The one predicate assertLifiBudget enforces, shared so a caller choosing a route cannot drift.
 */
export function lifiBudgetViolation(lifiFrom: bigint, net: bigint): "exceedsNet" | "dust" | undefined {
    if (lifiFrom > net) return "exceedsNet";
    if (net - lifiFrom > (net * SWAP_DUST_TOLERANCE_BPS) / 10000n) return "dust";
    return undefined;
}

/**
 * Asserts a LiFi fixed-input swap fits within the budget left after the relayer fee, and
 * that the leftover dust stays within tolerance.
 *
 * Both the reshield (output-driven, deposit target fixed) and withdraw (input-driven with a
 * fee over-estimate) paths freeze a LiFi `fromAmount` and later fund the processor with
 * `net = amount − feeAmount`. This check enforces the two-sided invariant they share:
 *
 * - **budget:** `lifiFromAmount ≤ net` — the router can pull its fixed input; otherwise the
 *   input `transferFrom` reverts before the trade (`RelaySwaps_SwapFailed`).
 * - **dust:** `net − lifiFromAmount ≤ SWAP_DUST_TOLERANCE_BPS` — the leftover swept to
 *   `dustRecipient` (the relayer by default) is bounded, so a relayer that under-quotes the
 *   fee cannot inflate `net` and shift value from the capped fee into uncapped dust.
 *
 * Must be re-checked against the committed fee, which may exceed the preliminary one.
 *
 * @throws {InvalidTransactParams} If the LiFi input exceeds the net amount, or the dust
 * exceeds the tolerance.
 */
export function assertLifiBudget(lifiFromAmount: string, amount: Hex, feeAmount: string): void {
    const netSwapAmount = BigInt(amount) - BigInt(feeAmount);
    const lifiFrom = BigInt(lifiFromAmount);
    const violation = lifiBudgetViolation(lifiFrom, netSwapAmount);
    if (violation === "exceedsNet") {
        throw new InvalidTransactParams(
            `LiFi needs ${lifiFromAmount} input but only ${netSwapAmount} available after fee. Reduce the amount or retry.`,
            // The swap INPUT token, which on a yield-share note is the wrapper's
            // underlying rather than the note's own share token, and never the
            // output token the caller picked.
            {
                code: "lifiInputExceedsNet",
                side: "spent",
                values: { required: lifiFrom, available: netSwapAmount },
            },
        );
    }
    // M-1: the swap consumes only `lifiFrom`, so the leftover `net − lifiFrom` is swept to
    // `dustRecipient` — which defaults to the relayer (reshield) or recipient (same-chain
    // withdraw). Without an upper bound this dust is unbounded: a relayer that under-quotes
    // `feeAmount` inflates `net` and shifts that value from the maxRelayFee-capped,
    // SDK-checked fee into uncapped dust it collects. Cap the dust so the leak can never
    // exceed a small fraction of the withdrawal; a grossly over-provisioned `amount` (real
    // dust > tolerance) is rejected so the caller re-sizes instead of silently forfeiting
    // value.
    const dust = netSwapAmount - lifiFrom;
    const maxDust = (netSwapAmount * SWAP_DUST_TOLERANCE_BPS) / 10000n;
    if (violation === "dust") {
        throw new InvalidTransactParams(
            `Swap input dust ${dust} (net ${netSwapAmount} − LiFi input ${lifiFrom}) exceeds the ${SWAP_DUST_TOLERANCE_BPS} bps tolerance (${maxDust}); the withdrawal amount is over-provisioned for this swap and the excess would be swept to the dust recipient. Reduce the amount or pass an explicit dustRecipient to reclaim it.`,
            // Same input-token denomination as the budget branch above. The bps
            // tolerance is a ratio, so it stays out of `values`.
            {
                code: "swapInputDust",
                side: "spent",
                values: {
                    dust,
                    net: netSwapAmount,
                    swapInput: lifiFrom,
                    maxDust,
                },
            },
        );
    }
}
