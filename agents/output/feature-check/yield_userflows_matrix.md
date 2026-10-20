# Yield (ppUSDC / Aave) — User-Flow Matrix + SDK Comprehension

- **Repo HEAD:** `b7910a6cffbfddd2f3594c7203ec0686cb3cea1c` branch `v2.0-features`
  (build tree at `/Users/nh2/0xbow/v2-monorepo-audit`)
- **Date:** 2026-07-10
- **Feature:** #315 Aave-yield (ppUSDC) module — `PPYieldToken` / `PPYieldTokenZap` / factories /
  `PPRouter` + the SDK yield sessions/interactors + the relayer PPRouter routing path.
- **Builds on (not re-done here):** `agents/output/audit/contracts_r1.md` (H-1/L-4/L-5/L-6/N-2),
  `agents/output/audit/AUDIT_yield.md` (GAP-1..4), the yield alignment baseline, and
  `agents/deviations.md` (INTL-03/04/05/06 + the `minUnderlyingOut=0` candidate). This doc covers
  **flow coverage + public-API reachability only** — no re-analysis of the crypto/econ invariants.

## Method / legend

- **Reachable:** **Y** = invocable through the public SDK (`PoolSession.yield.*`, `RelayerInteractor`)
  with no hand-construction; **partial** = reachable but the integrator must hand-bridge/hand-assemble
  types or accept a degraded result; **N** = exists on-chain but not exposed by any SDK code.
- **Path:** *self* = user self-submits the prepared tx; *relay* = submitted via a relayer; *admin* =
  `onlyOwner`; *deploy* = factory/deploy-script; *passive* = no tx (accrual / view); *permissionless*.
- The SDK yield surface is exactly: `PoolSession.yield = { deposit, withdraw, token, router }`
  (`types/Yield.ts:58` `YieldSessions`), wired in `PoolSessionFactory.ts:244-261` only when a
  `yieldDeployment` is configured, and re-exported from `external.ts:48-51`. The **write** surface is
  two session methods (`prepareYieldDeposit`, `prepareYieldWithdraw` + `prepareYieldWithdrawRelay`) plus
  `PPYieldTokenInteractor.encodeRedeem`; everything else on the interactors is **read-only**. The SDK
  ABIs (`constant/Yield.ts`) contain ONLY: `depositExactShares`, `withdrawToUnderlying`, `quote`,
  `quoteWithdraw`, `exchangeRate`, `previewDeposit`, `previewRedeem`, `redeem` (ERC-4626), `assets` —
  **no** admin, factory, zap, or `skim` fragments exist anywhere in the SDK.

---

## Flow matrix

| # | Flow | Actor | Path | Code path (file:fn chain) | SDK entrypoint | Reachable? | Notes |
|---|------|-------|------|---------------------------|----------------|-----------|-------|
| **DEPOSIT — wrap USDC → ppUSDC and shield (one router tx)** |
| 1 | Self-submit yield deposit (approve + `depositExactShares`) | depositor | self | `PoolSessionYieldDeposit.prepareYieldDeposit` → base `deposit.prepareDeposit` (tokenId=ppUSDC) → decode `Entrypoint.deposit` calldata → `router.quote` → re-encode `PP_ROUTER_DEPOSIT_ABI` → `PPRouter.depositExactShares` → `ZAP.buyFixedYieldToken` (Aave `supply`+`VAULT.mint`) → `ENTRYPOINT.deposit` (shield) | `yield.deposit.prepareYieldDeposit` | **Y** | Returns `{approvalTx, depositTx, pendingNote,…}`; caller submits both. Deposits are never relayed (needs payer's own USDC + approval) — correct that no relay variant exists. |
| 2 | Size ppUSDC shares from a USDC budget | depositor | (read) | `sharesForUnderlying` → `yieldToken.previewDeposit` → discount by `DEPOSIT_SHARES_DISCOUNT_BPS` | `yield.deposit.sharesForUnderlying` | **Y** | |
| 3 | Deposit spend-cap sizing (`maxUnderlyingIn` = quote +`DEPOSIT_SLIPPAGE_BPS`) | depositor | self | `prepareYieldDeposit` → `router.quote` → pad → `PP_ROUTER_ABI.quote`→`ZAP.quoteBuy` | via #1 | **Y** | Approval sized to the padded cap (audit GAP-4 nit: leaves ≤ slippage headroom allowance). |
| 4 | Deposit slippage exceeded (`underlyingIn > maxUnderlyingIn`) | depositor | self | `PPRouter.depositExactShares` L130 `PPRouter_SlippageExceeded`; zap L97 `PPYieldTokenZap_SlippageExceeded` | via #1 (on-chain revert) | **Y** | SDK pads the cap; a large rate move between prep and submit surfaces this revert. |
| 5 | Deposit zero value | depositor | self | SDK `parseShareValue` `InvalidYieldAmount`; contract `PPRouter_ZeroValue` (L121) | via #1 | **Y** | SDK rejects pre-proof; contract guards defensively. |
| 6 | Deposit asset ≠ ppUSDC (proof.tokenId mismatch) | depositor | self | `PPRouter.depositExactShares` L119 `PPRouter_AssetMismatch` | via #1 | **Y (defensive)** | SDK always sets `tokenId = deployment.ppUSDC`, so this revert is unreachable through the SDK by construction; it guards a hand-crafted proof. |
| 7 | Base calldata not `Entrypoint.deposit` | depositor | self | `prepareYieldDeposit` decode-guard `UnexpectedDepositCalldata` | via #1 | **Y** | Defends the decode/re-encode seam. |
| 8 | Deposit shares stranded (deviating entrypoint) | depositor | self | `PPRouter.depositExactShares` L149 `PPRouter_SharesStranded` | via #1 | **Y (defensive)** | Not user-triggerable; guards a misbehaving entrypoint. |
| 9 | Aave supply cap / pool error during supply | depositor | self | `ZAP.buyFixedYieldToken`→`POOL.supply` reverts (Aave error 51 etc.) | via #1 | **Y (chain)** | Bubbles up atomically; SDK cannot pre-detect. |
| 10 | Insufficient wrap (aReceived < aNeeded) | depositor | self | zap L108 `PPYieldTokenZap_InsufficientWrap` | via #1 | **Y (defensive)** | `_SUPPLY_ROUNDING_BUFFER=2` makes this effectively unreachable. |
| **WITHDRAW — unshield ppUSDC and unwrap → USDC (one router tx)** |
| 11 | Self-submit yield withdraw (`withdrawToUnderlying`) | withdrawer | self | `PoolSessionYieldWithdraw.prepareYieldWithdraw` → encode `PayoutRouting` → `orchestrator.prepareTransact` (processor=router) → decode `PoolVault.transact` → `router.quoteWithdraw` → re-encode `PP_ROUTER_WITHDRAW_ABI` → `PPRouter.withdrawToUnderlying` → `POOL_VAULT.transact` (pays shares to router) → `ZAP.redeemToUnderlying` (recipient + fee legs) | `yield.withdraw.prepareYieldWithdraw` | **Y** | Returns a single `withdrawTx`; caller submits. |
| 12 | **Relayed yield withdraw** | withdrawer + relayer | relay | SDK `prepareYieldWithdrawRelay` → `assertPayoutRoutingMatchesQuote` (anti-tamper) → bind `signedFeeCommitment.data` → `orchestrator.prepareTransact` → returns `WithdrawalRelayParams{processorAddress=router, minUnderlyingOut}` → `RelayerInteractor.relayWithdrawal` POST `/withdrawal` (spreads both fields via `WithdrawalRelayParamsSchema` L149-150) → relayer `relay.controller.ts:withdrawal` → `evm.relay.service.ts:61-85` (allowlist + thread fields) → `evm.chain.service.ts:400-424` branch `processorAddress!==undefined` → `PPRouter.withdrawToUnderlying(…, minUnderlyingOut)` | `yield.withdraw.prepareYieldWithdrawRelay` + `RelayerInteractor.relayWithdrawal` | **Y** | **Fully glued end-to-end** — the SDK output type IS the relayer input type; no hand-bridging (contrast the stealth G-1 gap). Operator-config-gated only (see Gap Y-4). |
| 13 | Relayed-withdraw anti-tamper (relayer can't swap recipient/fee) | withdrawer | relay | `prepareYieldWithdrawRelay` L209-244: assert `commitment.asset==ppUSDC`, `amountSent==amountOut`, `fee≤amountOut`, `assertPayoutRoutingMatchesQuote(recipient, fee, nativeGas=0)` | via #12 | **Y** | Mirrors `PoolSessionWithdraw.relayWithdraw`; binds signed routing to caller intent. |
| 14 | Recipient slippage floor (`minUnderlyingOut`) | withdrawer | self+relay | `prepareYieldWithdraw`/`Relay` → `router.quoteWithdraw(recipientShares)` × `(1-slippageBps)`; contract L202 `PPRouter_BelowMinUnderlying` | via #11/#12 | **Y** | SDK sizes the floor from the caller's own `amountOut-fee`, never the relayer's `amountReceived` (L266-271). Supersedes the stale `minUnderlyingOut=0` deviation note — the relayer forwards the SDK value (defaults 0 only if omitted). |
| 15 | Withdraw zero amountOut / zero recipient | withdrawer | self+relay | SDK `parsePositive`→`InvalidYieldAmount`, `BigInt(recipient)==0`→`InvalidYieldAddress`; contract `PPRouter_ZeroWithdrawal` (L163), `PPRouter_ZeroRecipient` (L176) | via #11/#12 | **Y** | SDK rejects pre-proof both paths. |
| 16 | Fee > amountOut | withdrawer | self+relay | SDK L75 `feeShares>amountOutShares`→`InvalidYieldAmount`; contract L179 `PPRouter_FeeExceedsWithdrawal` | via #11/#12 | **Y** | |
| 17 | Fee > asset `maxRelayFee` (fee cap) | withdrawer | self+relay | contract L178 `PPRouter_FeeExceedsMax` (`ENTRYPOINT.assets(asset).maxRelayFee`) | via #11/#12 (on-chain revert) | **partial** | SDK does **not** pre-check `maxRelayFee`; documented in `prepareYieldWithdraw` `@remarks` ("an over-max fee wastes the proof build"). Reachable but only as a wasted-proof revert. |
| 18 | Dust-fee waiver (fee redeems to 0 USDC → waived to recipient) | withdrawer | self+relay | contract L186-188 `_payableFee = (fee!=0 && previewRedeem(fee)!=0) ? fee : 0` | via #11/#12 | **Y (automatic)** | On-chain robustness; no SDK action. Prevents a dust fee reverting the whole withdraw on `PPYieldToken_ZeroAssets`. |
| 19 | Native-gas forwarding + mismatch guard | withdrawer | self+relay | SDK sets `withdrawTx.value = nativeGasHex == payout.nativeGas`; contract L177 `PPRouter_NativeGasMismatch`, L211-213 forward to recipient | via #11 | **Y** | Relayed path pins `nativeGas=0` (L243) — no extra-gas on yield. |
| 20 | Wrong processor / tokenIdOut ≠ ppUSDC / shares-not-received | withdrawer | self+relay | contract L167 `PPRouter_AssetMismatch`, L170 `PPRouter_InvalidProcessor`, L194 `PPRouter_SharesNotReceived` | via #11/#12 | **Y (defensive)** | SDK always sets processor=router & tokenId=ppUSDC; these guard hand-crafted/deviating input. |
| 21 | Base calldata not `PoolVault.transact` | withdrawer | self | decode-guard `UnexpectedWithdrawCalldata` | via #11 | **Y** | Defends the decode/re-encode seam. |
| 22 | Fee-commitment expired (relayed) | withdrawer | relay | `assertFeeCommitmentLive(expiration)` (SDK L199 + `RelayerInteractor` L274; relayer re-checks) | via #12 | **Y** | |
| **ATOMIC REGISTER + YIELD WITHDRAW (fresh unfunded recipient)** |
| 23 | Register keystore + relayed **yield** withdraw in one tx | withdrawer + relayer | relay | on-chain: `PrivacyPoolRelay.registerAndRelay` + a PPRouter route — **but the yield-specific atomic variant is NOT built** | — (no `PoolSessionYieldWithdraw.prepareRegisterAndYieldWithdrawRelay`) | **N** | **INTL-05 deferral**: the standard `prepareRegisterAndWithdrawRelay` exists; the **yield** mirror (+ PPRouter routing for atomic dispatch) is explicitly deferred. See Gap Y-2. |
| **HOLD-ppUSDC / DIRECT ERC-4626 EXIT (no pool)** |
| 24 | Redeem held ppUSDC → aUSDC (ERC-4626 `redeem`) | holder | self | `PPYieldTokenInteractor.encodeRedeem` → `PP_YIELD_TOKEN_REDEEM_ABI` → `PPYieldToken.redeem` (→ aToken to receiver) | `yield.token.encodeRedeem` | **partial** | Yields the **aToken (aUSDC)**, not USDC — the holder still needs a separate Aave `withdraw` the SDK does not wrap. Guards zero receiver/owner. |
| 25 | Unwrap held ppUSDC → USDC in one shot | holder | self | on-chain `PPYieldTokenZap.redeemToUnderlying(shares, receiver)` | — (no zap interactor) | **N** | The one-call ppUSDC→USDC unwrap exists on-chain but has **no SDK interactor**. See Gap Y-1. |
| 26 | Wrap USDC → ppUSDC **without shielding** (`depositUnderlying`) | holder | self | on-chain `PPYieldTokenZap.depositUnderlying` | — | **N** | Standalone unshielded wrap — no SDK path. Low value for a privacy-pool user (no privacy), so a benign gap; noted for completeness. |
| 27 | Exact-mint ppUSDC without shielding (`buyFixedYieldToken`) | holder | self | on-chain zap `buyFixedYieldToken` | — (only called internally by `PPRouter`) | **N** | Not exposed as a standalone; reachable only inside #1. `quoteBuy` is surfaced only indirectly via `router.quote`. |
| **RAGEQUIT (emergency exit)** |
| 28 | Ragequit a ppUSDC note → ppUSDC shares to owner | owner | self | base `PoolSession...Ragequit` (tokenId-agnostic) → owner receives ppUSDC shares | base `PoolSessionRagequit` | **Y** (base) → then **partial** to reach USDC | Ragequit is asset-agnostic and works for ppUSDC. But it exits to **ppUSDC shares**, then the holder faces #24/#25 to reach USDC — i.e. the post-ragequit unwrap inherits Gap Y-1. |
| **YIELD ACCRUAL + FEE (passive / admin)** |
| 29 | Yield accrues (aToken rebases → exchange rate ↑, net of fee) | — | passive | `PPYieldToken.totalAssets` = `balanceOf(asset) - _currentFees` (clamped ≥0, L216-220); `_pendingFees` on balance increase | `yield.token.exchangeRate` / `previewRedeem` (read) | **Y (read)** | Value observable; audit L-4 covers the clamp/fee semantics. |
| 30 | Admin claim accrued fee (`claimFees` / `claimFees(recipient)`) | owner | admin | `PPYieldToken.claimFees` `onlyOwner nonReentrant` → `_checkpoint` → transfer aToken | — | **N** | No SDK/ABI surface. Owner ops done via direct contract call / ops tooling — outside the SDK's user-facing scope, but flagged (Gap Y-3). |
| 31 | Set fee bps (≤ `MAX_FEE_BPS` 20%) | owner | admin | `setFeeBps` L96 `PPYieldToken_FeeTooHigh` on >2000; checkpoints yield at OLD rate first (no retroactive fee) | — | **N** | Gap Y-3. Fee-cap revert only reachable by the owner (no SDK). |
| 32 | Pause / unpause (gate deposit/mint) | owner | admin | `pause`/`unpause`; `maxDeposit`/`maxMint` return 0 while paused → ERC-4626 revert on deposit | — | **N** | Gap Y-3. A deposit-while-paused (#1) reverts via `maxDeposit=0`; the SDK does not read `paused()` to pre-warn. |
| 33 | Set rewards controller / claim Aave rewards | owner | admin | `setRewardsController`; `claimRewards` `onlyOwner nonReentrant` → `IAaveRewardsController.claimAllRewards` | — | **N** | Gap Y-3. Audit L-4 confirms it cannot move the vault's aUSDC/ppUSDC. |
| 34 | Rescue a non-underlying token | owner | admin | `rescueToken` L148-152; L149 `PPYieldToken_CannotRescueAsset` blocks `asset()` | — | **N** | Gap Y-3. Backing (aToken) can never be rescued. |
| 35 | Renounce ownership (disabled) | owner | admin | `renounceOwnership` overridden to always revert `PPYieldToken_RenounceDisabled` (L197-199) | — | **N** | Correctly-unsupported by design (admin must remain, 2-step transferable). |
| **FACTORY / DEPLOYER** |
| 36 | `createWrapper` (deploy ppUSDC + dead-share seed) | factory owner | deploy | `PPYieldTokenFactory.createWrapper` `onlyOwner` → validate `aToken.POOL()==POOL`, uniqueness, `_seedAssets!=0` → deploy → seed `_DEAD` via real `POOL.supply` | — (deploy scripts `DeployLocalYield`/`DeployYieldFork`) | **N** | Deploy-time; not an SDK flow. Anti-inflation seed + `10^12` offset (audit "benign"). |
| 37 | `createZap` / `createRouter` | factory owner | deploy | `PPYieldTokenZapFactory.createZap` / `PPRouterFactory.createRouter` `onlyOwner` (router ctor re-validates the `(vault,underlying)` pair) | — | **N** | Deploy-time. Note audit L-6: `DeployYieldFork` deploys `PPYieldToken` **directly**, bypassing the factory dead-share seed. |
| 38 | Factory reverts (zero seed / non-Aave aToken / already-deployed) | factory owner | deploy | `PPYieldTokenFactory_ZeroSeed`, `_NotAavePoolAToken`, `_AlreadyDeployed` (+ zap/router analogs) | — | **N** | Deploy-time guards. |
| **ROUTER DUST** |
| 39 | Skim router aToken dust → dust recipient | anyone | permissionless | `PPRouter.skim` (no-op-safe, emits only on real sweep) | — | **N** | Permissionless keeper op (≤2 wei per deposit); trivial, no SDK need. |
| **QUOTES / VIEWS (read)** |
| 40 | Deposit quote (`quote`), withdraw quote (`quoteWithdraw`) | any | read | `PPRouterInteractor.quote`/`quoteWithdraw` → `PP_ROUTER_ABI` | `yield.router.quote` / `quoteWithdraw` | **Y** | |
| 41 | `previewDeposit` / `previewRedeem` / `exchangeRate` | any | read | `PPYieldTokenInteractor` → `PP_YIELD_TOKEN_ABI` | `yield.token.*` | **Y** | |

---

## Gaps — flows not fully SDK-reachable (missing glue named)

### Y-1 (Medium, M-2-class) — No SDK interactor for the one-call ppUSDC → USDC unwrap (`PPYieldTokenZap`), so a holder of loose ppUSDC (esp. after ragequit) cannot exit to USDC through the SDK.

`PPYieldTokenZap` exposes `depositUnderlying`, `buyFixedYieldToken`, and **`redeemToUnderlying`**
on-chain, but the SDK has **no zap interactor at all** (grep for `ZapInteractor` /
`redeemToUnderlying` / `PPYieldTokenZap` in `src/` returns nothing outside tests). The only
SDK-exposed loose-share exit is `PPYieldTokenInteractor.encodeRedeem`, which calls the **ERC-4626
`redeem`** and returns the **aToken (aUSDC)** — not the underlying USDC (Flow 24). This matters for two
real flows:
- **Post-ragequit exit (Flow 28):** ragequit is asset-agnostic and yields ppUSDC shares; converting
  those to USDC needs `zap.redeemToUnderlying`, which is unreachable. The user is left with aUSDC via
  `encodeRedeem` and must hand-build an Aave `withdraw`.
- **Any "I hold ppUSDC, give me USDC" flow outside the shielded withdraw** (Flow 25).

**Missing glue (named):** a `PPYieldTokenZapInteractor` (mirroring `PPYieldTokenInteractor`) with
`encodeRedeemToUnderlying(shares, receiver)` and `encodeDepositUnderlying(...)`, plus its address in
`YieldDeployment` (which today has no `zap` field — `types/Yield.ts:26-41`), wired into `YieldSessions`.
Until then the shielded router path (#11/#12) is the *only* SDK way to turn ppUSDC into USDC.

### Y-2 (Medium, M-2-class, documented deferral) — Atomic register-and-relay is not available for the yield path (Flow 23).

`PoolSessionWithdraw.prepareRegisterAndWithdrawRelay` + `RelayerInteractor.relayRegisterAndWithdrawal` +
`PrivacyPoolRelay.registerAndRelay` make the fresh-unfunded-recipient flow reachable **for the standard
withdrawal**. The **yield** mirror — a `PoolSessionYieldWithdraw.prepareRegisterAndYieldWithdrawRelay`
plus PPRouter routing for the atomic dispatch — is **explicitly deferred** (deviations.md **INTL-05**,
follow-up (1)). So a first-time recipient who wants their keystore registered atomically *and* a yield
(USDC) withdraw in one relayer tx cannot do it through the SDK; they must register first, then withdraw.
**Missing glue:** the yield variant of the register-and-relay session method + the corresponding relayer
`register-and-relay` dispatch to `PPRouter.withdrawToUnderlying`.

### Y-3 (Low, design-boundary) — No admin/owner op is represented in the SDK (Flows 30-34).

`claimFees`, `setFeeBps`, `pause`/`unpause`, `setRewardsController`/`claimRewards`, `rescueToken` are all
`onlyOwner` and have **no SDK encoder or ABI fragment**. This is a deliberate scope boundary (the SDK is
the depositor/withdrawer surface, not an ops console), and the deviations file does not treat it as a
gap. Flagged only so the boundary is explicit: protocol operators must drive these via direct contract
calls / separate ops tooling. Not a defect.

### Y-4 (Low, deployment-config, not code) — The relayed yield path is code-complete but gated on operator config.

The relayer routes to `PPRouter.withdrawToUnderlying` only if the router is in `allowed_processors`
(fail-closed, empty in the shipped `relayer.config.example.json`) and only issues a ppUSDC fee
commitment if ppUSDC is in `supported_assets` (also absent from the example). No code change needed —
an operator must add both entries. Confirmed by the relayer trace (`evm.relay.service.ts:62-66`,
`evm.quote.service.ts:111` → `chain-config.ts:69-77`).

### Non-gaps (correctly unsupported by design)
- **Standalone unshielded wrap / exact-mint (Flows 26/27):** `depositUnderlying` / `buyFixedYieldToken`
  as user-facing ops give a privacy-pool user no privacy benefit; only used internally by the router.
  Benign omission.
- **Stealth × yield (from the stealth matrix, Flows 30/31 there):** intentionally not composed —
  `relayAndAnnounce` is standard-relay only (no `processorAddress`), deviations.md **INTL-06(b)** /
  STEALTH_REVIEW **C-3**. Not a yield gap.
- **Renounce ownership (Flow 35):** disabled on purpose (`PPYieldToken_RenounceDisabled`).
- **No relayed *deposit*:** deposits need the payer's own USDC + approval; a relay variant would be
  meaningless. Correct that only self-submit deposit exists.

---

## Verdict

The yield feature's **core user surface is fully reachable through the SDK** — the depositor
(self-submit wrap+shield, Flows 1-10), the withdrawer **both self-submit and relayed** (Flows 11-22),
and all read/quote flows (40-41) are **Y**, with the SDK guarding the decode/re-encode seams and the
relayed-path anti-tamper binding. Crucially, **the relayed yield-withdraw path has NO analog of the
stealth G-1 gap**: `PoolSessionYieldWithdraw.prepareYieldWithdrawRelay` emits exactly the
`WithdrawalRelayParams{processorAddress, minUnderlyingOut}` that `RelayerInteractor.relayWithdrawal`
serializes and the relayer branches on to call `PPRouter.withdrawToUnderlying` with the SDK-supplied
floor — verified end-to-end (SDK schema L149-150 → relayer `evm.chain.service.ts:400-424`). The
`minUnderlyingOut=0` deviation candidate is effectively superseded: the SDK does size and forward a
real floor.

**Reachability gaps (all M-2-class or design-boundary, none new-critical):**
- **Y-1 (Medium):** no SDK interactor for `PPYieldTokenZap.redeemToUnderlying` — a holder of loose
  ppUSDC (notably after **ragequit**) cannot one-call exit to USDC via the SDK; `encodeRedeem` only
  reaches aUSDC. Missing `PPYieldTokenZapInteractor` + a `zap` address in `YieldDeployment`.
- **Y-2 (Medium, documented INTL-05 deferral):** the atomic **register + yield-withdraw** variant is not
  built (only the standard-asset one is). Missing the yield register-and-relay session method + relayer
  dispatch.
- **Y-3 (Low, boundary):** no admin op (`setFeeBps`/`pause`/`claimFees`/`rescueToken`/`claimRewards`) is
  SDK-represented — deliberate ops/SDK split, flagged for explicitness.
- **Y-4 (Low, config):** relayed path is code-complete but the shipped relayer example config enables
  neither the PPRouter processor nor the ppUSDC asset (operator must add both).

Correctly-unsupported (not defects): stealth×yield (C-3 / INTL-06), standalone unshielded wrap,
renounce, and relayed deposit.
