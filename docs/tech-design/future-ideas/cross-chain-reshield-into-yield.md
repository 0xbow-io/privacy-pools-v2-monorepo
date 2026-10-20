# Cross-Chain Reshield Into Yield

Status: IMPLEMENTED 2026-09-18 (`feat/swap-router-redeposit`, SDK-only: `utils/YieldSwapOutput.ts`, `yieldDepositTargets` / `destinationYieldDepositTargets`, `CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM` = 500 ppm; spec now in `sdk/yield-sessions.md` §Landing as a share). Originally: planned extension (not spec). Author: Claude, 2026-09-09.

Scope note (2026-09-10): this doc covers the **deposit / output** direction only — a plain
source token landing *as* a `ppUSDC`/`ppUSDT` note on the destination chain (P5 of
`relayswaps-yield-unwrap.md`). The reverse direction — spending a yield-share note through a
cross-chain reshield, landing as plain USDC — is **built** (`PoolSessionReshieldCrosschain`
`yieldWrappers`, 2026-09-10) via `RelaySwaps.executeUnwrapped`; see
`relayswaps-yield-unwrap.md` §6 and `sdk/withdraw-and-swap.md` §Cross-Chain Reshield. The
`Underlying` relayer quoter and the boot-time zap discovery this doc's §4 called for also
shipped. What remains unbuilt is §1–§3 here: the `getSwapAndDepositQuote` token/amount
decoupling so a destination `PPRouter.depositExactShares` call can pull the underlying while
the note stays share-denominated.

## Problem

`PoolSessionReshieldCrosschain` (withdraw source chain → bridge/swap via LiFi → deposit on
the destination chain) has no path to a yield-wrapped destination asset. Its only notion of
"deposit on arrival" is a plain `Entrypoint.deposit(proof, noteData, aspCiphertext)` call,
built by a standard `PoolSessionDeposit` and embedded as the LiFi `contractCalls` target. A
destination note denominated in `ppUSDC` needs `PPRouter.depositExactShares(proof, noteData,
aspCiphertext, maxUnderlyingIn)` instead — a different contract, pulling a different token,
with a share/underlying exchange-rate dependency the plain path never has to reason about.

Neither `docs/tech-design/sdk/withdraw-and-swap.md` nor `yield-sessions.md` mentions
cross-chain at all, so this is a scope **extension**, not a bug — nothing here contradicts
existing spec, but it needs sign-off before implementation per the repo's Spec Guardian rule.

This gap was hit for real on 2026-09-04: it-004 Mainnet migrated plain USDC/USDT to
`ppUSDC`/`ppUSDT`, and a BSC→Mainnet dust-rescue reshield had nowhere to land (see
`dust_Collector_deploy_handoff.md`, "PAUSED" section). It will recur on any corridor where
the destination Entrypoint's only enabled asset is yield-wrapped.

## Why this is more tractable than it first looks

The concrete failure logged in the handoff doc — a 404 from LiFi on `contractCalls` trying to
bridge into raw native ETH and feed it to a payable call — is not this problem. That failure
is specific to the native-ETH sentinel as `fromTokenAddress`. A router deposit needs USDC
(an ordinary ERC-20) pulled via `transferFrom`, which is exactly the shape
`Entrypoint.deposit` already uses successfully today, and exactly the shape LiFi's
`contractCalls` executor already knows how to fund (approve `toContractAddress` for
`fromAmount`, then call `toContractCallData`) — see
`packages/sdk/src/services/LiFiSwapQuoteProvider.ts`, `getSwapAndDepositQuote`. Nothing new is
needed from LiFi. The work is entirely in how the SDK sizes and threads the numbers, plus a
relayer pricing gap that exists independent of cross-chain.

## Design

### 1. Decouple "bridge-delivery token" from "note-denomination token"

`SwapAndDepositQuoteRequest`/`getSwapAndDepositQuote` currently assume the destination call
pulls exactly `outputToken`, sized at `depositAmount`
(`LiFiSwapQuoteProvider.ts:181-189`: `contractCalls[0].fromTokenAddress = params.toToken`,
`fromAmount = params.depositAmount`). For a yield destination these must diverge: the note's
`tokenId`/`outputToken` is `ppUSDC` (shares), but the contract call needs to pull
**underlying** (USDC), sized at `maxUnderlyingIn`.

Add optional fields to `SwapAndDepositQuoteRequest` — e.g. `contractCallToken` and
`contractCallAmount` — that override what gets fed into `contractCalls[0]` when present,
defaulting to today's behavior (`toToken`/`depositAmount`) when absent. This keeps the
non-yield path byte-identical and adds one small, well-scoped seam for the yield path.

### 2. Share/underlying-aware sizing in `PoolSessionReshieldCrosschain`

Three spots in `prepareReshieldCrosschainQuote`/`estimateReshieldCrosschainAmount` currently
reason in `outputToken` units and need a yield-aware branch:

- **`estimateReshieldCrosschainAmount`**: the DEX-quote leg (`swapQuoteProvider.getSwapQuote`)
  should target underlying (USDC), not `ppUSDC` — LiFi has no direct market for the share
  token. The resulting USDC-denominated `noteValue` estimate then needs converting to shares
  via the vault's live rate, the same conversion `PoolSessionYieldDeposit.sharesForUnderlying`
  already performs for the same-chain case (`packages/sdk/src/services/poolSessions/PoolSessionYieldDeposit.ts:52-61`,
  including its `DEPOSIT_SHARES_DISCOUNT_BPS` safety margin). Reuse that helper rather than
  re-deriving the conversion.
- **`prepareReshieldCrosschainQuote`**: needs a router-sized `maxUnderlyingIn`, via the same
  `PPRouter.quote(sharesValue)` call `PoolSessionYieldDeposit.prepareYieldDeposit` already
  makes (`PoolSessionYieldDeposit.ts:96-100`), but with wider headroom than that method's
  `DEPOSIT_SLIPPAGE_BPS`. The same-chain deposit executes within roughly one block of the
  quote; a cross-chain bridge leaves the Aave rate exposed for the bridge's full transit time
  (minutes, sometimes longer under congestion). Model this the same way B2 already models
  LayerZero-fee drift — a named headroom constant, sized from observed bridge latency, not
  copied from the same-chain constant.
- **Destination affordability** (`DestinationDepositUnaffordable`, around line 540): compares
  `totalDepositCost` against the Stargate-decoded `destBudget`. *(Superseded 2026-09-24: the gate
  now runs on every route, reading the budget LiFi encoded for our destination call via
  `decodeLiFiDestinationCallAmount` — the Stargate decoder is only the last fallback; see
  `sdk/pool-session.md` §Cross-Chain Reshield.)* For a yield destination this
  must compare `maxUnderlyingIn` (underlying units, what the bridge actually needs to deliver)
  against `destBudget`, not `totalDepositCost` (share units) — mixing the two here would
  silently accept routes that can never actually execute on arrival, the same class of bug the
  code's own comments flag for the non-yield cross-asset case (`estimateReshieldCrosschainAmount`'s
  `cappedMinOutput` comment references a real prior incident of exactly this unit confusion).

`assertLifiBudget` and the B2 gas-swap sizing (`sizeB2GasSwap`) both currently work in
`outputToken` units for the same reason and need the same underlying-vs-shares audit — B2 and
yield are orthogonal features that can compose (a Mainnet-destination yield reshield needs
both the gas-swap slice and the router-quote slice carved out of the same source budget), so
get the unit bookkeeping right once rather than patching around it twice.

### 3. A yield-aware `depositResult`

`prepareReshieldCrosschainQuote` currently assumes `depositResult` came from a plain
`PoolSessionDeposit.prepareDeposit` (`{ to, callData, pendingNote }`, validated against the
destination Entrypoint address directly). `PoolSessionYieldDeposit.prepareYieldDeposit`
already returns a superset of this (`pendingNote`, `depositTx.{to,data}` targeting the
destination `PPRouter`, plus `maxUnderlyingIn`/`underlyingNeeded`/`sharesValue`) — built
against a `PoolSessionYieldDeposit` instance constructed for the **destination** chain (same
pattern the class already uses for `destinationEntrypointInteractor`: a destination-chain
`IPPRouterInteractor`/`IPPYieldTokenInteractor` pair, constructed the same way as any other
destination-chain interactor).

The cleanest seam: let `depositResult` accept either shape, or add a thin
`toReshieldDepositResult()` adapter on `PreparedYieldDeposit` that also surfaces
`maxUnderlyingIn` for `prepareReshieldCrosschainQuote` to consume per §2. The target-address
check (`depositResult.to === destinationEntrypointAddress`) needs a parallel branch checking
against the destination `PPRouter` address instead when the deposit is a yield deposit.

### 4. Relayer: an underlying-rate quoter

Independent of cross-chain, the relayer's `RateProvider` enum
(`packages/relayer/relayer/src/rate_provider/rate_types.ts`) has no option that understands an
ERC-4626 share↔underlying exchange rate — only `Uniswap | Cowswap | Curve | Test | Mock`.
Anything that needs to price a `ppUSDC`-denominated amount in USD or convert it to/from a fee
(same-chain relayed yield withdrawal fee sizing, dust-rescue pricing of leftover `ppUSDC`
dust, or a cross-chain reshield whose *source* asset is `ppUSDC`) currently has no quoter to
select. Note this contradicts an earlier session note (`dust_Collector_deploy_handoff.md`)
that attributed a `quoter: "Underlying"` option to a branch `fat/swaps/relayer-support-yield`
— that branch does not exist in the repo today under that name, and no such quoter exists on
any branch found by history search. Treat it as not built, not merely unmerged.

A new quoter (e.g. `RateProvider.UNDERLYING`) would read the vault's live `previewRedeem`/
exchange rate and compose it with the underlying's existing quoter rather than duplicating
price-source logic — mirroring how `allowed_processors` already anticipates `PPRouter` as a
same-chain transact processor (`evm.config.schemas.ts:63-65`) without yet having the pricing
side to match.

## Sequencing

This splits into two independently shippable workstreams — build in either order, but ship
Workstream A before attempting a real cross-chain-into-yield run:

**Workstream A — same-chain-adjacent, unblocks pricing generally**
1. `RateProvider.UNDERLYING` quoter in the relayer, composing an ERC-4626 vault's live rate
   with its underlying's existing quoter.
2. Dust-rescue pricing (`usd-worth.ts`) and same-chain relayed-yield-withdrawal fee sizing
   pick it up for `ppUSDC`/`ppUSDT`.

**Workstream B — the cross-chain-into-yield path itself**
1. `SwapAndDepositQuoteRequest` gains the `contractCallToken`/`contractCallAmount` override
   (§1) — additive, no behavior change for existing callers.
2. `PoolSessionReshieldCrosschain` gains yield-aware sizing in `estimate`/`prepare` (§2),
   gated on the deposit result being a yield deposit.
3. `depositResult` accepts a yield-deposit shape (§3), sourced from a destination-chain
   `PoolSessionYieldDeposit`.
4. Wire a destination-chain `IPPRouterInteractor`/`IPPYieldTokenInteractor` pair into
   `PoolSessionReshieldCrosschainConfig`, mirroring the existing
   `destinationEntrypointInteractor` pattern.
5. B2 (Mainnet-destination LayerZero fee) + yield composition audit (§2, last paragraph) —
   only needed once a Mainnet-destination yield corridor is actually exercised.

## Test plan

- **Unit** — `PoolSessionReshieldCrosschain` gets a yield-deposit-result test matrix parallel
  to its existing plain-deposit tests: correct `maxUnderlyingIn` sizing from a mocked
  `PPRouter.quote`, correct `contractCallToken`/`contractCallAmount` override reaching the
  mocked `swapAndDepositQuoteProvider`, and the `DestinationDepositUnaffordable` path
  re-checked against `maxUnderlyingIn` rather than `totalDepositCost`.
- **Unit** — `LiFiSwapQuoteProvider.getSwapAndDepositQuote` test confirming the override
  fields land in `contractCalls[0]` and that omitting them reproduces today's exact request
  shape (regression guard for the non-yield path).
- **Unit** — relayer `RateProvider.UNDERLYING` quoter: rate composition against a mocked vault
  `previewRedeem`, and a boot-validator case rejecting a config that names it for a non-4626
  asset.
- **Integration (fork)** — extend the existing yield fork e2e (`packages/sdk/scripts/e2e-yield/`)
  with a same-chain-only "reshield into yield" case first (bridge leg mocked/skipped, isolating
  the router-deposit composition) before attempting a real two-chain fork test.
- **Live smoke, once fork-green** — a single small-value BSC→Mainnet run against it-004's real
  `ppUSDC`, following the existing dust-rescue sketch pattern
  (`packages/swaps/test/live-relayer-bsc-to-mainnet-*`), gated the same way prior live runs
  were: `DRY_RUN_ESTIMATE` first, real run only after a clean estimate.

## Open questions / risks

- **Headroom sizing for `maxUnderlyingIn` over bridge transit time** is the one genuinely new
  risk parameter here (not a reuse of an existing constant) — needs either a conservative fixed
  bps pulled from observed bridge latencies (Across/Stargate typically clear in minutes) or a
  per-bridge-tool lookup. Underestimating it reproduces the same "dies in prepare, no funds
  moved" failure mode as the current `assertLifiBudget` trips; overestimating it wastes
  principal reserved against a rate move that didn't happen.
- **`skim()` interaction**: each router deposit leaves ≤2 wei of aToken dust in the router,
  swept lazily. Irrelevant per-transaction but worth confirming the dust-rescue service doesn't
  try to attribute that dust to the wrong recipient once yield destinations are live.
- **Yield notes can't join `relayBatch`** (per `yield_contracts_analysis.md` §6b) — out of
  scope here since cross-chain reshield doesn't batch today, but worth flagging before anyone
  tries to combine this with future batched cross-chain work.
- **Split-flow workaround remains available** as a fallback for any corridor where this full
  integration isn't ready: bridge to plain USDC via the already-proven path, then a separate
  same-chain `PoolSessionYieldDeposit` call. Non-atomic (an intermediate plain-USDC state
  exists), so it doesn't fit the atomic dust-rescue pattern, but it unblocks manual/relayer-
  operated flows immediately without waiting on Workstream B.

## Non-goals for v1

- Native-input B2 composition with yield (B2 already defers native-input gas-swap funding
  entirely; compounding that with yield is not worth solving before the ERC20-input case ships).
- A yield-to-yield corridor (source note already `ppUSDC`, destination also yield-wrapped) —
  solve underlying→yield first; yield→underlying (withdraw side) is a separate, symmetric
  problem not addressed by this doc.
