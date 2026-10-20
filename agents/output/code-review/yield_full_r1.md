# Yield Feature — Full Code Review + Coherence (r1)

- **Commit:** `b7910a6cffbfddd2f3594c7203ec0686cb3cea1c` (branch `v2.0-features`)
- **Date:** 2026-07-10
- **Scope:** the whole yield feature (#315) — contracts `PPYieldToken`, `PPYieldTokenZap`, `PPYieldTokenFactory`, `PPYieldTokenZapFactory`, `PPRouter`, `PPRouterFactory` + their `I*` interfaces + `abstracts/FeeCalculator.sol`; SDK `PoolSessionYield{Deposit,Withdraw}` + `PPRouterInteractor`/`PPYieldTokenInteractor` + yield types/schemas; relayer yield routing (`evm.relay.service`, `evm.chain.service`, DTO/schemas, `sdk/pprouter.abi.ts`).
- **Style reference:** pinned to BASE v2 (`packages/{contracts,sdk}/CLAUDE.md` verified present+unchanged in base; relayer CLAUDE.md validated against base-v2 relay code).
- **Builds on:** `agents/output/code-review/sdk_r1.md` and `agents/output/audit/contracts_r1.md` / `agents/output/audit/AUDIT_yield.md`.
- **What I ran:** static reads of all cited files; greps for fee-math reuse, ABI provenance, type⟺schema parity, single-source derivation, unused symbols. Did NOT re-run forge/vitest/jest — prior audit run (AUDIT_yield.md) recorded 142 `PPYieldToken*` + 42 `PPRouter` unit + 3 real-proof integration green at an earlier commit; I did not re-verify at `b7910a6` (honesty note).

**Verdict: PASS-WITH-MINOR.** No correctness bug and no coherence defect that breaks the feature. The feature hangs together internally and integrates coherently with the base pool/relay stack. Findings are two Low convention/simplification items (fee-math reuse; relayer ABI re-vendoring) plus three nits. The one Medium cross-package gap flagged in `sdk_r1.md` (F-1, relayed-yield `processorAddress` unreachable through the SDK) is **now CLOSED at this commit** — verified below.

---

## Findings

### C1 — LOW (simplification / convention) — `PPYieldToken` re-implements the bps fee formula instead of reusing `FeeCalculator`
- **Where:** `packages/contracts/src/contracts/PPYieldToken.sol:284` (`_pendingFees`: `((_balance - lastCheckpointBalance) * feeBps) / MAX_BPS`) and `:39` (`MAX_BPS = 10_000`).
- **Defect:** The shared `abstracts/FeeCalculator.sol` (`calcFee(amount, bps) = amount*bps/10_000`, `MAX_FEE_BPS = 10_000`) is the project's single source for bps fee math — `Entrypoint.sol:72/114` and `PPRouter.sol:275` both use it, but `PPYieldToken` inlines the identical formula and duplicates the denominator constant. Two copies of the same math can drift.
- **Fix:** `_fees = FeeCalculator.calcFee(_balance - lastCheckpointBalance, feeBps);`. `MAX_BPS` is public-via-interface (part of the API) so keep the getter, but define it as `FeeCalculator.MAX_FEE_BPS` (or alias) rather than a fresh literal. Purely internal; no behavior change.

### C2 — LOW (coherence / convention) — relayer re-vendors the PPRouter ABI instead of importing the SDK's exported one
- **Where:** `packages/relayer/relayer/src/sdk/pprouter.abi.ts` (defines `PP_ROUTER_ABI` `withdrawToUnderlying` fragment), consumed by `evm.chain.service.ts:407`.
- **Defect:** The SDK **value-exports** the same fragment as `PP_ROUTER_WITHDRAW_ABI` (`packages/sdk/src/external.ts:62`; def `src/constant/Yield.ts:144`). Relayer CLAUDE.md rule 7 ("Dogfood the SDK, don't reimplement" — ABIs from the SDK) and the known relayer hotspot (PayoutRouting ABI re-implemented) both apply. The two fragments are shape-equivalent today (viem encodes by position, so the differing `_proof`/`proof` param names and the relayer's extra `internalType` are harmless), but a future signature change to `withdrawToUnderlying` must be mirrored in two places or the relay leg silently mis-encodes.
- **Fix:** import `PP_ROUTER_WITHDRAW_ABI` from `@privacy-pools-v2/sdk` in `evm.chain.service.ts` and delete `src/sdk/pprouter.abi.ts` (mirrors how the batch/PayoutRouting ABIs are meant to be sourced).

### C3 — NIT (coherence / dead state) — `PPRouter.POOL` immutable is set but never read
- **Where:** `packages/contracts/src/contracts/PPRouter.sol:45` (+ constructor `:98`).
- **Defect:** Self-documented at `:43-44` — the Aave interaction moved into the zap, so `POOL` is retained but unused; the router is otherwise protocol-agnostic. It is passed by `PPRouterFactory.createRouter` and validated only via the zap's `(VAULT, UNDERLYING)` pair, not via `POOL`. Deliberate, tracked in BACKLOG; noting for completeness — a fully protocol-agnostic router drops this immutable and its constructor arg.
- **Fix:** none required (accepted); remove `POOL` when the router is made protocol-agnostic.

### C4 — NIT (coherence) — chain-agnostic `IWithdrawalRelayRequest` omits `minUnderlyingOut`
- **Where:** `packages/relayer/relayer/src/relayer.types.ts:150-153` declares `processorAddress?` but not `minUnderlyingOut`, while the concrete evm request (zod `relay/evm/schemas.ts:149,179-180`, type `relay/evm/types.ts:65,67`, DTO `dto/evm.relay.dto.ts:74`) and the service (`evm.relay.service.ts:77`) all carry it.
- **Defect:** The two yield-routing fields are introduced together everywhere except the base operations interface, which lists only one. No wire-drop (the evm schema declares `minUnderlyingOut`, so it survives parse), but the interface is inconsistent with its evm realization.
- **Fix:** add `minUnderlyingOut?: bigint;` (or the wire type) to `IWithdrawalRelayRequest` alongside `processorAddress?` so the abstract contract matches the concrete one.

### C5 — INFO (coherence) — zap exposes two deposit entrypoints; only the exact-output one is wired
- **Where:** `PPYieldTokenZap.depositUnderlying` (`:68`) vs `buyFixedYieldToken` (`:89`). `PPRouter.depositExactShares` uses only `buyFixedYieldToken`; `depositUnderlying` has no non-test caller in `contracts/src` or `sdk/src`.
- **Defect:** none — `depositUnderlying` is a legitimate public convenience (approximate-input) surface, documented as the counterpart of the exact-output variant. Flagged only so a reader knows the router flow never exercises it.

---

## Coherence — confirmed good (no action)

- **sdk_r1 F-1 CLOSED at this commit.** Type⟺schema parity on the yield relay leg now holds: `WithdrawalRelayParams` type carries `processorAddress?: Address` + `minUnderlyingOut?: Hex` (`src/types/RelayerInteractor.ts:241,249`) and `WithdrawalRelayParamsSchema` declares both as `.optional()` (`src/schemas/RelayerInteractor.ts:149-150`); `PoolSessionYieldWithdraw.prepareYieldWithdrawRelay` sets `processorAddress = deployment.ppRouter` + `minUnderlyingOut` (`PoolSessionYieldWithdraw.ts:283-284`); relayer honors both end-to-end (`evm.relay.service.ts:62,77` allowlist + floor → `evm.chain.service.ts:388,400-418` router branch). The Medium gap from `sdk_r1.md` is no longer present.
- **Single-source derivation across boundaries.** Deposit: `PPRouter._quote` is the sole source for both `quote()` and `depositExactShares` (`PPRouter.sol:129,244,265`), and it delegates underlying sizing to `ZAP.quoteBuy` — the exact figure `buyFixedYieldToken` pulls (`PPYieldTokenZap.sol:96,143`); quoted == executed by construction. Withdraw: `minUnderlyingOut` is sized from `router.quoteWithdraw(recipientShares)` and enforced on-chain at `PPRouter.sol:202-205`. No duplicated derivation that can drift.
- **Value conservation on withdraw.** `_recipientShares + _payableFee == _sharesOut` in every branch incl. the dust-fee waiver (`PPRouter.sol:186-208`); one `forceApprove(ZAP, _sharesOut)` covers both redeem legs; a defensive baseline check asserts exactly `_sharesOut` shares arrived (`:194`).
- **Factory family is uniform.** All four factories: `Ownable` + immutable `POOL` + `mapping(... ) public xFor` + `address[] internal _allX` + `AlreadyDeployed`/`ZeroAddress`/`NotAavePoolAToken` guards + `xCount`/`allX(i)` views + `aToken.POOL() == POOL` genuineness anchor. The dead-share seed lives **only** in `PPYieldTokenFactory` — correct: the zap/router factories are stateless deployers with nothing to inflate. (The task's "dead-share pattern uniform across factories" is a mischaracterization; the implemented invariant — seed only where shares exist — is the right one.)
- **Processor-as-alternate-relay is consistent with `PrivacyPoolRelay`.** `PPRouter.withdrawToUnderlying` decodes `PayoutRouting` from `transactParams.data` bound into the proof `context`, requires `processor == address(this)`, forwards `_transactParams` verbatim to `POOL_VAULT.transact`, and mirrors the native-gas forwarding — plus a *stricter* `recipient != 0` guard (INTL-14 footgun removal). The relayer allowlists `processorAddress` (`isAllowedProcessor`, `evm.relay.service.ts:62`) and correctly **forbids** it on the batch path (`relay/evm/schemas.ts:206` — yield×batch mutually exclusive), matching `yield.md`'s "a yield withdrawal can never be a `relayBatch` item".
- **No re-implemented ERC-4626.** `PPYieldToken` extends OZ `ERC4626` and overrides only `totalAssets`, `_deposit`, `_withdraw`, `_decimalsOffset`, `maxDeposit`, `maxMint` (for the fee/pause/decimals-offset behavior); the share↔asset math is the base library's.
- **ppShare as an opaque pool asset.** Registered as a `tokenId`; the core Entrypoint/PoolVault are unchanged; value-conservation is enforced over shares, not underlying — as the doc states.
- **`yield.md` line refs verified accurate** (`PPRouter.sol:170` processor==self; `:178-184` fee-cap + dust-waiver; `totalAssets` clamp at `PPYieldToken.sol:219`).

## Accepted deviations (not flagged, per instruction)
- **INTL-03** — SDK yield public API uses `bigint` (not `Hex`). Confirmed consistent across `PoolSessionYield{Deposit,Withdraw}` + `PPRouterInteractor` + `Yield` types.
- **INTL-04** — `PPYieldTokenZap` has no reentrancy guard (stateless; balance-delta accounting closes the donation-griefing vector — `PPYieldTokenZap.sol:78-80,104-114,128-130`).
