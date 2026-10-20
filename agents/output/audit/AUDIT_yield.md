# AUDIT — Aave-yield (ppUSDC) module + yield consolidation

**Auditor:** feature-standards-auditor
**Date:** 2026-07-02
**Standard:** `/Users/nh2/0xbow/v2-monorepo/docs/FEATURE_BEST_PRACTICES.md` (rules A–G)
**Feature:** Aave-yield (ppUSDC) module — contracts + SDK — plus the consolidation that merged the
canonical yield contracts into the monorepo.
**Repo / branch:** `v2-monorepo-pprouter-withdraw` @ `feat/yield-consolidation`
**Diff scope:** `feat/pprouter-withdraw-integration..HEAD` (12 commits; 71 files, +7628/-150).

---

## Verdict: DONE-WITH-GAPS

The feature is authored to the standard and **the code I could run is green**: SDK typecheck + lint
+ 1168 vitest cases pass; the yield contract suites I ran pass (142 PPYieldToken*-family + 42 PPRouter
unit + 3 PPUSDCYieldMock integration, the last with **real Groth16 proofs**); all 23 new yield runtime
value symbols resolve from the built `dist/index.cjs`. Security invariants on `PPRouter` /
`PPYieldToken` / `PPYieldTokenZap` hold under an adversarial read.

The gaps are **deferrals, honestly documented in the spec, not defects**: no full-stack SDK→relayer→chain
e2e (TEST-3); no genuine-transact-proof test of the SDK **withdraw** re-encode (TEST-2, partial — the
deposit re-encode *does* have one, and the on-chain router withdraw *is* proven with real proofs);
relayer auto-glue is out of repo. None are Critical/High. Two honesty caveats below (provenance of the
"byte-identical" consolidation claim; full-586 forge run cited but not re-run by me).

### GAPs by severity
- **Critical:** 0
- **High:** 0
- **Medium:** 1 — TEST-3 full-stack e2e not ported (documented deferral).
- **Low:** 2 — TEST-2 SDK-withdraw real-transact-proof deferred (GAP-2); DRIFT-3 consolidation
  "byte-identical vs yield-repo canonical" is unverifiable here (GAP-3, honesty caveat).
- **Nit:** 1 — DEPOSIT approval leaves standing router allowance headroom (GAP-4).

---

## Rule table

| ID | Result | Evidence (one-line) |
|----|--------|---------------------|
| SPEC-1 | PASS | Classified EXTENSION; `docs/tech-design/sdk/yield-sessions.md` states base `sdk-tech-design.md` has no yield/ppUSDC/PPRouter surface. |
| SPEC-2 | PASS | Design doc `yield-sessions.md` exists (EXTENSION), lists components, flows, new errors, deliberate deviations. Version-history: see GAP note. |
| SPEC-3 | PASS | PPRouter binds the **real** `IEntrypoint`/`IPoolVault`/`ProofLibV2` (not the yield repo's mirror ifaces); consolidation deleted the vendored copies (merge plan Phase 1). |
| LAYER-1 | PASS (partial) | Contract + SDK + docs land together; relayer layer intentionally out of repo (documented, LAYER note). |
| LAYER-2 | PASS | `PoolSession.yield` getter + `IPoolSession.yield` (PoolSession.ts:80/85, IPoolSession.ts:32); factory auto-wires when `yieldDeployment` set (PoolSessionFactory.ts:221-246). |
| LAYER-3 | PASS | `yield-sessions.md` authored; `sdk-tech-design.md` touched; merge plan + consolidation-status docs added. |
| LAYER-4 | PASS | Built `dist/index.cjs`, enumerated all 23 new value symbols (4 classes, 5 error classes, 5 ABIs, 4 bps consts, 2 deployment objs, 3 helpers) → every `typeof !== "undefined"`. |
| TEST-1 | PASS | Per-function happy/error/boundary units: e.g. PoolSessionYieldWithdraw.test.ts has 31 cases incl. fee>amountOut, non-positive amountOut, slippage>100%, zero recipient, negative nativeGas, malformed hex, unexpected-calldata. |
| TEST-2 | GAP (Low) | Deposit re-encode has a REAL-Groth16 test (PoolSessionYieldDeposit.realproof.integration.test.ts, 2 pass); on-chain router deposit+withdraw proven real (PPUSDCYieldMock.t.sol). **SDK withdraw** re-encode uses field-magnitude values, not a genuine transact proof — deferred + documented. |
| TEST-3 | GAP (Medium) | No SDK→relayer→chain full-stack e2e. Gated smoke/wrapper-local suites exist but skip in default env (8 skipped). Honestly documented as deferred; not claimed passing. |
| TEST-4 | PASS | Fixtures use production units: shares 18dp, USDC 6dp (yield-wrapper-local test asserts 1e6→1e6 round-trip); bps math in `10_000n` denominator matches contract `MAX_BPS`. |
| TEST-5 | PASS | The 8 skips are `describe.skipIf` gated on `YIELD_E2E`/`YIELD_LOCAL_PPUSDC`/artifact presence, each with an in-file rationale (no silent cap). |
| TEST-6 | PASS | Service-layer negative units cover each guard (fee cap, fee≤amountOut, slippage range, zero recipient, calldata shape), not just the ABI primitive. |
| DRIFT-1 | N/A | No compile-time constant must equal live on-chain state across the SDK boundary: SDK reads fees via `quote()`/`quoteWithdraw()`; its bps consts are SDK-only sizing margins. `10_000` denominator is conceptually shared but not load-bearing across sides. |
| DRIFT-2 | PASS | `PPRouter._quote` is the single source for both `quote()` view and `depositExactShares` execution (PPRouter.sol:264-275) — quoted == executed by construction. |
| DRIFT-3 | GAP (Low) | Consolidation replaced the **stale** base-branch vendored helper with the canonical zap-based router (new guards + zap delegation) — behavior intentionally changed, and the new code is tested. "Byte-identical to the yield-repo canonical source" is unverifiable here (repo archived/out of scope). |
| SEC-1 | PASS | PayoutRouting bound in proof `context`; router forwards `_transactParams` verbatim to `POOL_VAULT.transact`, which reverts on context mismatch (PPRouter.sol:178-184, 199). |
| SEC-2 | PASS | Withdraw conserves shares: `recipientShares + payableFee == sharesOut` in every branch incl. dust-fee waiver; single approval of `sharesOut` covers both redeems; deposit asserts share balance returns to baseline (PPRouter.sol:155, 194-215). |
| SEC-3 | PASS | Per-item caps enforced incl. the fee leg: `feeAmount ≤ maxRelayFee` and `sharesOut ≥ feeAmount` (PPRouter.sol:185-186). Single-item flow — no aggregate loop to multiply. |
| SEC-4 | PASS | Replay/expiry inherited from the unmodified transact/relay layer; router adds no new signed surface. Domain binding via the proof context. |
| SEC-5 | PASS | No unbounded pre-auth work: single-item, no arrays looped before the vault verifies the proof. |
| SEC-6 | PASS | `nonReentrant` (ReentrancyGuardTransient) on both externals + on `PPYieldToken._deposit/_withdraw/claimFees/claimRewards`; one failing leg reverts the whole tx atomically; Aave aToken has no transfer hooks. |
| CONV-1 | PASS | Contracts use single-line `///` NatSpec in tag order, contract-prefixed custom errors + `require`, structs in interfaces, section headers, SCREAMING_SNAKE immutables. |
| CONV-2 | PASS | SDK imports via `internal.js`; public-above-private ordering; DI via one config object (+ optional deps); `@inheritdoc` + specific `@throws`. `bigint`-not-`Hex` deviation is documented in yield-sessions.md. |
| CONV-3 | N/A | Relayer layer intentionally not built in this repo (documented). |
| HON-1 | PASS | Spec explicitly names what is not implemented (withdraw real-proof, relayer glue, empty `YIELD_DEPLOYMENTS`). This report distinguishes authored vs run, and flags unverifiable provenance. |

---

## Findings (expanded)

### GAP-1 (Medium) — TEST-3 full-stack e2e not ported
- **Location:** SDK yield sessions; `test/services/yield-smoke.integration.test.ts` (3 skipped),
  `yield-wrapper-local.integration.test.ts` (5 skipped).
- **Impact:** No observed SDK→relayer HTTP→chain assertion of real recipient balances for the yield
  path. The gated suites are on-chain-read smoke tests only; the deposit→withdraw-with-real-proofs e2e
  lives in reference scripts, not an automated harness.
- **Fix (minimal):** Port a fork e2e that runs the `run-wrapper-local.sh` deploy then drives a full
  `prepareYieldDeposit`→submit→`prepareYieldWithdraw`→submit cycle asserting USDC deltas; or confirm it
  runs in the CI harness. Until then keep it flagged (it is).
- **Confidence:** High. This is a documented deferral, not a silent gap — the rule is simply not met.

### GAP-2 (Low) — TEST-2 SDK withdraw re-encode lacks a genuine transact proof
- **Location:** `PoolSessionYieldWithdraw.prepareYieldWithdraw`; withdraw unit test line 206
  ("field-element-magnitude" values through the real `uint256[][]` ABI, not a real proof).
- **Impact:** The decode-`PoolVault.transact`→re-encode-`withdrawToUnderlying` mechanism is exercised
  with realistic-magnitude field elements but not a real witness. Residual risk is low: the *identical*
  decode/re-encode mechanism is proven with a real Groth16 proof on the deposit side, and the on-chain
  router withdraw is proven with real proofs in `PPUSDCYieldMock.t.sol`
  (`test_routerWithdraw_deliversPrincipalPlusYield_andFee`, PASS).
- **Fix:** Add a real-transact-proof SDK test once the full transact witness harness (notes +
  Merkle/keystore/ASP proofs) is available — same gating as GAP-1.
- **Confidence:** High.

### GAP-3 (Low, honesty caveat) — "byte-identical" consolidation claim unverifiable in scope
- **Location:** `src/contracts/PPRouter.sol` (was `test/integration/helpers/ppusdc/PPRouter.sol` on base).
- **What I verified:** Diffing the base-branch vendored copy against HEAD, the router **differs**
  substantially — the canonical version delegates Aave supply/mint to `PPYieldTokenZap`
  (`buyFixedYieldToken` / `redeemToUnderlying` / `quoteBuy`), adds a `PPRouter_ZeroRecipient` guard, adds
  a dust-fee-waiver (`_payableFee`), and renames `PPRouter_WrongAsset`→`PPRouter_AssetMismatch`. Per the
  merge plan this is expected: the base copy was **stale** and the consolidation pulled the yield repo's
  canonical source. So DRIFT-3's "behavior-preserving refactor" does **not** describe this change — it is
  a deliberate swap to a different, more complete implementation.
- **Impact:** The context handed to me ("PPRouter logic byte-identical") is only true relative to the
  *yield-repo canonical source*, which is archived/out of scope — I could not diff against it. The new
  logic **is** covered by passing tests (PPRouter unit 42/42; PPUSDCYieldMock 3/3 real-proof), so the
  deployed behavior is exercised regardless of provenance.
- **Fix:** If provenance assurance is required, diff `src/contracts/PPRouter.sol` against the archived
  `yield-pprouter-withdraw` canonical file. Not blocking.
- **Confidence:** High on the observed diff; the byte-identity-vs-canonical claim is **unverified**.

### GAP-4 (Nit) — deposit approval leaves standing router allowance
- **Location:** `PoolSessionYieldDeposit.prepareYieldDeposit` approvalTx (approves `maxUnderlyingIn` =
  quote +10%); PPRouter pulls only the exact `_underlyingIn`.
- **Impact:** After a deposit, up to ~10% USDC allowance to the router lingers. Standard ERC-20 residual
  allowance; router pulls only the exact quote, so no over-spend. Purely hygiene.
- **Fix:** Optional — size the approval to the exact `underlyingNeeded` (removes slippage headroom) or
  document that callers may zero it. Not required.
- **Confidence:** High.

---

## Proposed standard additions (flagged for human ratify)

1. **VENDOR-1 — Consolidating a vendored/stale copy is not a refactor.** When a feature *replaces* a
   previously-vendored copy of a contract with a canonical source, DRIFT-3's "prove branch-by-branch
   equivalence" does not apply — the two are expected to differ. The audit obligation instead is:
   (a) diff against the *canonical source of truth* (not the stale copy) to confirm byte-identity or
   enumerate intended changes, and (b) confirm the canonical version's own tests were ported and pass.
   State explicitly which artifact "byte-identical" is measured against.
   *(Origin: this audit — the base-branch PPRouter helper was stale; the "byte-identical" claim was true
   only vs the archived yield repo, which was out of scope to diff.)*

---

## What I ran (observed results)

| Command | Result |
|---|---|
| `npm run typecheck` (packages/sdk) | exit 0 |
| `npm run lint` (packages/sdk) | exit 0 |
| `npx vitest run` (packages/sdk) | **1168 passed, 8 skipped** (61 files pass / 2 gated-skip). Incl. PoolSessionYieldDeposit.realproof.integration (2 pass), PoolSessionYieldWithdraw (31), PoolSessionYieldDeposit (20), PPRouterInteractor (11), PPYieldTokenInteractor (10), PoolSessionFactory.yield (4), constant/Yield (12). |
| `npm run build` + `node -e` enumerate `dist/index.cjs` | all 23 new yield value symbols resolve (LAYER-4). |
| `forge test --match-path 'test/*/PPYieldToken*.t.sol'` | **142 passed / 0 failed / 0 skipped** (8 suites: unit, admin, decimals, factory, zapfactory, integration, invariant incl. `invariant_Solvency` 1000×500k calls, 0 reverts). |
| `forge test --match-path test/unit/PPRouter.t.sol` | **42 passed / 0 failed** (3 contracts in file). |
| `forge test --match-path test/integration/PPUSDCYieldMock.t.sol` | **3 passed / 0 failed** — shield/unshield via router with **REAL Groth16 proofs** (deposit + withdraw + fee + yield). |
| Full `forge test` (586 pass / 0 fail / 1 skip, 45 suites) | **Cited from session context — I did NOT re-run it.** |
| `git diff` base vendored PPRouter vs HEAD canonical | Differs as described in GAP-3 (expected). |

**Honesty note (Directive 0):** Everything marked PASS above I either ran and observed, or read the exact
code path. The full-586 forge run is cited as provided context, not re-run by me. The "PPRouter
byte-identical to yield-repo canonical" claim is **unverified** — the canonical repo was out of scope;
I verified only that the deployed logic is tested and green.
