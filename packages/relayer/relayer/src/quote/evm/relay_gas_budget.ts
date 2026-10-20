import { Gas } from "./unit.types";

/**
 * Gas budgets the relayer prices each on-chain action at (EvmQuoteService) AND caps the
 * broadcast at (EVMChainService.writeWithGasCap). One module so quote and cap cannot drift:
 * the fee a user pre-pays is derived from these numbers, and the relayer refuses to sign a
 * transaction whose gas estimate exceeds `budget × relay_gas_cap_multiplier`.
 *
 * Why the cap exists: PrivacyPoolRelay pays native recipients with Solady `safeTransferETH`,
 * which forwards all remaining gas. A recipient contract whose `receive()` spins until gas
 * runs out makes `eth_estimateGas` return ~the block limit; without a cap viem would put
 * that on the transaction and the relayer would pay ~45× the priced gas for a fixed fee.
 */
/*
 * Calibration (2026-09-25): execution gas of every relayed op on our PoolVaults, prod (mainnet,
 * BSC) + testing stacks (mainnet, Optimism, Arbitrum), 185 relays, collected with
 * `scripts/relay-gas-samples.ts`. Budgets are the observed p90 for the ONE-input-note case,
 * rounded up. The quote does not know the input-note count (each extra input adds ~170-250k),
 * keystore registration, or same- vs cross-chain, so where two variants share a quote the
 * budget covers the more expensive one. Re-run the sampler and `scripts/relayer-profitability.ts`
 * after contract or circuit changes.
 *
 *   op (1 input)                     p50     p90     max     budget
 *   shielded transfer                799k    835k    874k    850k
 *   relay (plain)                    737k    764k    764k    } 1,050k (quote can't tell them apart)
 *   registerAndRelay                 956k   1044k   1044k    }
 *   PPRouter yield withdraw         1046k   1085k   1085k   1,100k
 *   RelaySwaps same-chain           1421k   1740k   2229k   } 1,750k
 *   RelaySwaps cross-chain           978k   1417k   1834k   }
 *   executeUnwrapped (same-chain)   2038k   2157k   2157k   1,750k + 450k unwrap surcharge
 *   relayBatch, per item (4 items)   611k    —       —        650k
 */
export const RELAY_GAS_BUDGET = {
    /// Shielded transfer: PoolVault.transact with the relayer as processor (1 input, 2 outputs).
    shieldedTransfer: Gas(850_000n),
    /// Single withdrawal through PrivacyPoolRelay.relay / registerAndRelay / relayAndAnnounce.
    /// Covers registerAndRelay (keystore registration + relay, ~1.04M at p90): the withdrawal
    /// quote cannot tell the two apart, and a plain relay (~0.76M at p90) priced here only
    /// overpays; the reverse under-prices every registering withdrawal.
    relay: Gas(1_050_000n),
    /// Per-item budget of a relayBatch (N transacts in one call share the call overhead).
    relayBatchItem: Gas(650_000n),
    /// PPRouter.withdrawToUnderlying (a yield-share withdrawal: transact + redeem + unwrap).
    yieldRelay: Gas(1_100_000n),
    /// RelaySwaps.execute (withdraw + DEX aggregator / bridge call). Same-chain routes are the
    /// expensive ones (the DEX runs on this chain); cross-chain is cheaper but not quotable apart.
    relaySwap: Gas(1_750_000n),
    /// RelaySwaps.executeUnwrapped surcharge: redeeming a yield share before the swap.
    yieldUnwrapSurcharge: Gas(450_000n),
    /// B2 — marginal gas for the extra in-contract gas swap plus its two ERC-20 approvals
    /// (approve gasSwapMaxInput, reset to 0). Added to relaySwap only when the request
    /// carries swapValue > 0, so the user pre-pays the extra relayer gas; the LZ fee itself
    /// is NOT added to feeAmount — it comes from the reshielded principal via the gas swap.
    b2GasSwapSurcharge: Gas(160_000n),
    /// Approximate value of an extraGas send (1 ETH send + what the relayer operator needs
    /// to swap the ERC20 fee back to eth later).
    extraGasTx: Gas(30_000n),
    /// Gas the extraGas top-up funds; transformed into native units at fund-swap time.
    extraGasFund: Gas(600_000n),
} as const;

/// Whole-batch budget: N single relays (relayBatch spends N transacts in one call).
export function relayBatchGasBudget(itemCount: number): Gas {
    return Gas(RELAY_GAS_BUDGET.relayBatchItem * BigInt(Math.max(1, itemCount)));
}

/// Single-withdrawal budget: a yield share leaves through its PPRouter (redeem + unwrap).
export function relayGasBudget(yieldShare: boolean): Gas {
    return yieldShare ? RELAY_GAS_BUDGET.yieldRelay : RELAY_GAS_BUDGET.relay;
}

/// RelaySwaps budget: base swap, plus the B2 gas-swap surcharge when swapValue > 0, plus the
/// unwrap surcharge when the input is a yield share (executeUnwrapped).
export function relaySwapGasBudget(b2Active: boolean, yieldShareInput = false): Gas {
    let budget = RELAY_GAS_BUDGET.relaySwap;
    if (b2Active) budget = Gas(budget + RELAY_GAS_BUDGET.b2GasSwapSurcharge);
    if (yieldShareInput) budget = Gas(budget + RELAY_GAS_BUDGET.yieldUnwrapSurcharge);
    return budget;
}

/// The broadcast ceiling for a priced action. Throws on a non-positive multiplier so a
/// mis-set config can never silently disable the cap.
export function relayGasCap(budget: Gas, multiplier: bigint): Gas {
    if (multiplier <= 0n) throw new Error(`relay_gas_cap_multiplier must be >= 1, got ${multiplier}`);
    return Gas(budget * multiplier);
}

/// Headroom added on top of eth_estimateGas for the broadcast gas limit, in basis points.
/// The estimate is the minimum gas that succeeds against the *previous* block's state; the
/// yield-router and RelaySwaps paths cost a fixed ~0.8% more once included (mainnet nonces
/// 19, 53, 57, 88, 107-109 ran out of gas with the bare estimate, each short by 9.6k-17k).
/// Unused gas is refunded, so the headroom only costs anything on a reverting call.
export const RELAY_GAS_HEADROOM_BPS = 500n;

/// The gas limit a broadcast is sent with: the estimate plus RELAY_GAS_HEADROOM_BPS, never
/// above the cap. The over-cap refusal still compares the raw estimate, so the headroom
/// cannot turn a refused call into a relayed one; at most it hands a hostile gas-burning
/// recipient 5% over its own estimate, bounded by the cap either way.
export function relayGasLimit(estimate: bigint, cap: Gas): Gas {
    const padded = (estimate * (10_000n + RELAY_GAS_HEADROOM_BPS)) / 10_000n;
    return Gas(padded > cap ? cap : padded);
}
