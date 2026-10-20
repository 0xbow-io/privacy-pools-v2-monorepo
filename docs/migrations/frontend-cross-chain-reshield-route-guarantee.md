# Frontend changes for cross-chain reshield (SDK 2026-09-24)

As of 2026-09-24. Companion to the SDK change on `v2.0` that sizes cross-chain deposits against
LI.FI's guaranteed delivery. Spec sections: `docs/tech-design/sdk/pool-session.md` 1.26.0,
`withdraw-and-swap.md` 1.11.0, `lifi-swap-quote-provider.md` 1.7.0, `yield-sessions.md`
§Landing as a share.

## What changed and why

The SDK now sizes a cross-chain reshield or swap-and-deposit against the amount LI.FI actually
guarantees to deliver on the destination chain, and refuses to sign when that guarantee cannot
cover the deposit.

Root cause: LI.FI ignores the `contractCalls[].fromAmount` we request and encodes its own route
minimum (`toAmountMin`) as the destination call's budget, on every chain and bridge (measured
2026-09-24 on mainnet → Optimism / Base / Arbitrum / BSC, Across and Stargate). For ERC-20 and
yield-share destinations the SDK handles this by itself; the frontend only has to drive two loops
it already knew about (refit, re-quote) and stop offering native-coin destinations, which can never
land through LI.FI (`Entrypoint.deposit{value}` needs an exact `msg.value`; three BSC losses on
2026-09-22/23).

## New SDK surface

All exported from `@privacy-pools-v2/sdk` (branch `v2.0`; rebuild `packages/sdk` before use).

| Item | Kind | What it is |
| --- | --- | --- |
| `NativeDestinationDepositUnsupported` | error, thrown by `prepareReshieldCrosschainQuote` and cross-chain `prepareSwapAndDeposit` | The destination deposit is a plain native-coin `Entrypoint.deposit{value}`. Thrown before any network call. Not retryable. |
| `DestinationDepositUnaffordable` | error (existed for Stargate, now thrown on every route) | Deposit cost exceeds the route's guaranteed delivery. Carries `affordableNoteValue` (hex): the note value that fits, already 1% under the guarantee. Retryable by refit. |
| `SwapAndDepositQuoteResult.toAmountMin` | optional string | LI.FI's guaranteed delivery for the route, output-token units. |
| `SwapAndDepositQuoteResult.destinationCallAmount` | optional string | The budget LI.FI encoded for our destination call. Informational for the frontend. |
| `decodeLiFiDestinationCallAmount(txData, depositCallData)` | util | Reads that budget from built LI.FI calldata. Not needed by the frontend. |
| `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` | constant (`500n`) | Pass it as the third argument of `prepareYieldSwapDeposit` for cross-chain share destinations (see Recommended). |

Behaviour changes with no API change:

- `estimateReshieldCrosschainAmount` makes one extra LI.FI call (a contractCalls probe) and can
  return a smaller `noteValue` than before on routes with a destination swap. Expect roughly
  2–3 s more latency.
- `estimateReshieldCrosschainAmount` throws `DepositBelowMinimum` earlier for small amounts,
  since the smaller sizing is checked against the destination Entrypoint minimum (10 ppUSDT
  shares on BSC, 0.02 BNB).

## Required: refit on `DestinationDepositUnaffordable`

`prepareReshieldCrosschainQuote` can now throw this on any route when LI.FI's fresh guarantee is
below the deposit cost the estimate sized (the two quotes are seconds apart and the guarantee
drifts). The error carries the value that fits. Rebuild the destination deposit with it and prepare
again; it converges in one pass in practice.

```ts
import {
  DestinationDepositUnaffordable,
  prepareYieldSwapDeposit,
  CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
} from "@privacy-pools-v2/sdk";

const estimate = await source.estimateReshieldCrosschainAmount({
  relayerInfo, amount, tokenId, outputToken, toChainId, slippage, denyExchanges: ["fly"],
});
let noteValue = BigInt(estimate.noteValue);
let totalDepositCost = BigInt(estimate.totalDepositCost);

for (let attempt = 0; attempt < 3; attempt++) {
  const target = dest.yieldFor(outputToken); // undefined for a plain ERC-20 output
  const depositResult = target
    ? await prepareYieldSwapDeposit(target, totalDepositCost, CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM)
    : await dest.prepareDeposit({ tokenId: outputToken, value: `0x${noteValue.toString(16)}` });
  try {
    return await source.prepareReshieldCrosschainQuote({
      relayerInfo, amount, tokenId, outputToken, toChainId, depositResult,
      totalDepositCost: totalDepositCost.toString(), slippage, denyExchanges: ["fly"],
    });
  } catch (e) {
    if (!(e instanceof DestinationDepositUnaffordable)) throw e;
    noteValue = BigInt(e.affordableNoteValue);
    // plain output: cost = value + vetting fee at the destination Entrypoint's bps
    // share output: the router prices the fee inside the shares; cost = the funding budget that buys them
    totalDepositCost = target
      ? await fundingBudgetFor(target, noteValue)
      : noteValue + (noteValue * vettingBps) / 10_000n;
  }
}
```

Notes:

- For a share output, `affordableNoteValue` is in shares. The funding budget for that many shares
  is `target.router.quote(shares).underlyingNeeded` plus the cross-chain headroom; simplest is to
  re-run `estimateReshieldCrosschainAmount` and take its `totalDepositCost`, which is what the
  swaps test suite does.
- `prepareYieldSwapDeposit` for a share output: pass `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM`
  explicitly. Its default is the 1 ppm same-chain headroom, which leaves the destination cap a
  hair above the router's price at sizing time; after a multi-minute bridge that reverts with
  `PPRouter_SlippageExceeded`. The bare `prepareYieldSwapDeposit(target, budget)` form is wrong
  for cross-chain.
- Each attempt generates a new destination proof (a few seconds). Show progress, not an error,
  while looping.

## Required: re-quote on transient errors

Four errors mean "this quote went stale, get a fresh one". All are thrown before anything is
signed; nothing has touched the pool. Wrap estimate → proof → prepare in a loop (the swaps suite
uses up to 12 attempts) and show "refreshing quote", not a failure. At high mainnet gas (0.9 gwei
on 2026-09-24) the first one fires several times per reshield.

| Error | How to recognise it | Cause |
| --- | --- | --- |
| `InvalidTransactParams` | message contains `LiFi needs` and `available after fee` | The relayer fee moved between the preliminary and committed quotes (`assertLifiBudget`). |
| `InvalidYieldAmount` | message contains `moved while sizing` | BSC share sizing read two blocks apart; Aave accrual between them. |
| `SwapQuoteFailed` | message contains `422` and `Market conditions have changed` | LI.FI backend transient, about 20% of contractCalls quotes on 2026-09-23. |
| `DestinationDepositUnaffordable` | instance check | Handled by the refit above; re-running the estimate is an equivalent refit. |

Do not retry `relayReshieldCrosschain` or anything after it: once RelaySwaps executes there is
nothing to retry. Do not retry `NativeDestinationDepositUnsupported`, `DepositBelowMinimum`,
`AssetNotSupported`, or any layout / allowlist error; those are final for that input.

## Required: native-coin destinations

Remove the native coin (BNB on BSC, ETH on Optimism / Base / Arbitrum) from the destination-token
choices of every **cross-chain** reshield and cross-chain swap-and-deposit. Same-chain flows are
unaffected. Yield shares whose router is in native mode (ppETH's `depositExactSharesNative`) stay
allowed; the SDK exempts them.

Reason: LI.FI's Executor sends its own guaranteed delivery as `msg.value`; `Entrypoint.deposit`
requires `msg.value` to equal the proof's amount exactly; the two never match, so the bridged
tokens land at the fallback wallet instead of a note. The SDK now throws
`NativeDestinationDepositUnsupported` from `prepareReshieldCrosschainQuote` /
`prepareSwapAndDeposit` before any network call, so funds are safe either way, but showing the
option and then erroring is bad UX. If the option is left visible, map the error to copy such as
"Cross-chain deposits into BNB are not available yet. Choose ppUSDT."

This stays until a native-deposit adapter contract ships on the destination chains (accept
`msg.value >=` exact, forward exact, refund the rest). Track that separately; no frontend work
until it exists.

## Recommended

- **Minimum amounts, shown up front.** With destination-swap routes the note is now sized from
  LI.FI's guarantee (about 3–5% under the plain quote) and the relayer fee scales with mainnet gas
  (about 2.2 USDC per reshield at 0.9 gwei). A 12 USDC reshield into BSC ppUSDT fails
  `DepositBelowMinimum` (10 shares) at that gas price; 20 USDC passes. Compute the floor before
  the user commits: `estimateReshieldCrosschainAmount` already throws, so run it on amount change
  and surface "minimum ~X USDC at current gas" instead of a generic error.
- **Expect more dust.** The difference between what LI.FI delivers and what the deposit consumes
  goes to `fallbackAddress` on the destination chain (measured 1.20 USDT on a 20 USDC reshield).
  Keep `fallbackAddress` = the user's wallet on the destination chain, as today, and say so in the
  confirmation screen.
- **Slippage for stable → stable.** The guarantee is `expected × (1 − slippage)` on the
  destination DEX step. The SDK default cross-chain slippage is 3%; the swaps suite uses 5%.
  Consider 1% for USDC → USDT routes to shrink the dust; keep the default for volatile pairs.
- **`denyExchanges: ["fly"]`** on every cross-chain quote (fly's calldata carries a deadline
  shorter than bridge latency and reverts on arrival; one of the 09-23 losses). Consider also
  `bitget`: its BSC calldata expired after ~10 minutes in fork tests; `okx` and `1inch` did not.
- **Testing:** `packages/swaps/test/mainnet-prod-crosschain-reshield-ethereum-to-bsc.integration.test.ts`
  with `DRY_RUN=1` exercises the exact prod path (prod relayer, prod ASP, real LI.FI, real proofs,
  no transaction) and is the reference implementation of both loops above.

## Testing stack: new processor addresses

The testing-stack RelaySwaps were redeployed on 2026-09-24 at v2.0 HEAD, and the testing relayer
(`https://relayer-v2-testing-149184580131.us-east1.run.app`) already runs the matching build and
advertises them in `GET /v1/details`. The testing frontend must use these as
`relayerInfo.processorAddress`; the previous instances have a different routing layout and any
swap or reshield against them fails with `PoolVault_ProofContextMismatch`.

| Chain | RelaySwaps (new, 2026-09-24) | Replaces |
| --- | --- | --- |
| Mainnet (1) | `0x1aB4008b96B1791EC693304aB8855b86Fe093724` | 0x3f63F745… |
| Optimism (10) | `0x581Bc5D58597c0602f05C4f58E88418D27920980` | 0x2d3BDa64… |
| BSC (56) | `0xbe16948700c538D71599dB99Df604a2EA9a7e61a` | 0xBF65B029… |

Prefer reading them from the relayer's `/v1/details` (`chains[].contracts.relaySwaps`, or
`PoolSessionBuilder.withRelayerDetails`) over hard-coding. Production is unchanged:
`0xd0395c08DD8eA7671a7A65bDca8E473e8E8260a8` on mainnet and BSC.

## Checklist

- [ ] Upgrade to the SDK build that exports `NativeDestinationDepositUnsupported` and
      `SwapAndDepositQuoteResult.destinationCallAmount`
- [ ] Cross-chain reshield: refit loop on `DestinationDepositUnaffordable` (share and plain outputs)
- [ ] Cross-chain swap-and-deposit: same refit loop
- [ ] Re-quote loop for the four transient errors, with "refreshing quote" UI; never retry after
      `relayReshieldCrosschain`
- [ ] Pass `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` to every cross-chain `prepareYieldSwapDeposit`
- [ ] Hide native coins as cross-chain destination tokens; map `NativeDestinationDepositUnsupported`
      to copy as a fallback
- [ ] Show the minimum amount at current gas before the user commits; handle `DepositBelowMinimum`
- [ ] `denyExchanges: ["fly"]` on every cross-chain quote
- [ ] Testing frontend: switch `processorAddress` to the 2026-09-24 RelaySwaps (or read `/v1/details`)
- [ ] Verify with one dry run against the testing relayer and one against prod before release
