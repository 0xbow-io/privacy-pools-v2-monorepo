# Consolidated Findings Register — v2.0 Feature Audit

**Branch:** `audit/v2.0-features` (base `d91112f2`). **Date:** 2026-07-08.

> **Remediation pass (2026-07-08, branch `v2.0-features`, PR base `v2.0`).** Closed the non-stealth OPEN
> findings: H-1, C-6/L-6, N-2, C-7, C-8, F-1, MED-1, the TEST invariant/coverage gaps, the E2E orchestrator
> test, and TREE (conforming bulloak trees) — each committed with its hash below and its suite re-run green.
> C-9 remains BENIGN. Airdrop AIR-1/2/3 remain pre-implementation design-blockers.
>
> **Stealth M-1/M-2 CLOSED (2026-07-09, branch `v2.0-features`).** Previously deferred; now built + audited.
> M-2 (canonical scheme reachable) and M-1 (atomic announce+withdraw transport with on-chain address
> binding) are landed across contracts/relayer/SDK with real-proof coverage; L-1 (announcer address)
> verified. A fresh confirmatory audit found **no Critical/High/Medium**; two Low doc/deploy hardenings
> (L-A NatSpec scope, L-B deploy canonical-guard) were applied. See rows below + `audit/stealth_m1_m2_r1.md`,
> `code-review/stealth_m1_m2_r1.md`. Also verified this pass: no dead/outdated stealth code on the branch
> (the multischeme fix is integrated as dispatchers; base `v2.0` had only the outdated single-scheme).
> A subsequent **stealth full-feature review** (six lenses, `STEALTH_FULL_REVIEW.md`) found no High/Med;
> fixes: G-1 SDK relay bridge, TG-1 canonical independent-recipe cross-check, TG-G2/G3, L-C scan-null, + Lows.
>
> **Yield #315 full-feature review (2026-07-10, `YIELD_FULL_REVIEW.md`).** Six lenses over the 6 yield
> contracts + factories + SDK + relayer. Security audit found **no Critical/High/Medium** (213 tests; the
> prior H-1/L-6/M-3 gaps confirmed resolved; ERC-4626 rounds in the vault's favor, fee base yield-only
> capped 20%, admin can't seize/freeze/renounce, Aave leg atomic-reverts). Fixes applied — **Y-1** (SDK
> `PPYieldTokenZapInteractor.encodeRedeemToUnderlying` — the loose-ppShare→USDC exit, esp. after ragequit,
> is now SDK-reachable), **C1** (`PPYieldToken._pendingFees` delegates to `FeeCalculator`), **C2** (relayer
> PPRouter ABI pinned to the canonical signature by a golden drift-test; literal single-source import
> deferred pending a jest-safe SDK subpath — see deviations), **TG-2** (relayer parse-survival test),
> **C4** (`IWithdrawalRelayRequest` gains `minUnderlyingOut`). Accepted-Low residuals: **L-1**
> (`minUnderlyingOut` outside proof context but unexploitable — deterministic ~1:1 exit, already deferred),
> **L-2** (post-Aave-loss fee over-charge — negligible/bad-debt-only, high-water-mark deferred), **L-3**
> (degenerate-tiny-withdrawal liveness, funds safe), **TG-3** (`PPRouter_BelowMinUnderlying` fork test —
> revert is unit-tested, arithmetic backend-independent). Y-2 (register+yield atomic) = INTL-05 deferral;
> Y-3/Y-4 = ops/SDK split + operator config. See `audit/yield_full_r1.md`, `code-review/yield_full_r1.md`,
> `test-gap/yield_full_r1.md`, `feature-check/yield_userflows_matrix.md`.
>
> **Batch #316 full-feature review (2026-07-10, `BATCH_FULL_REVIEW.md`).** Six lenses over
> `PrivacyPoolRelay.relayBatch` + relayer `POST /batch` + the SDK batch stack. Security audit found
> **no Critical/High/Medium** and no constructible exploit (18/18 forge tests): the shared pre-batch
> root snapshot survives a full batch with no off-by-one, no intra-batch double-spend (nullifiers
> marked per-transact + atomic revert), homogeneity checked for EVERY item (no recipient/asset
> smuggling), exact fee conservation with SDK/relayer recompute-verify defeating fee re-concentration.
> Built — **BW-2** (SDK self-submit batch: a gas-paying user's own zero-fee `relayBatch`, SDK-only since
> `relayBatch` is permissionless). Fixes — **GAP-1** (real-proof atomic-abort integration test: a
> mid-batch revert unwinds earlier REAL transacts, was mock-only), **GAP-2/GAP-3** (MAX_BATCH boundary:
> exact-10 pass + same-label chunk-overflow reject + exact-5 selection), **BW-1** (session fails fast
> before the relayer quote), **CR-1/CR-3/CR-4/CR-6** (MAX_BATCH() `pure`, guard operand order, NatSpec
> "5"→circuit-max, batch-session `@throws`). Accepted: **B-1** (Low — root-buffer-shrink coupling
> checked only at construction; liveness-only, relayer re-checks live), B-2..B-5 (Info), BW-3
> (full-balance-only scope), BW-4 (revert-race receipt). See `audit/batch_full_r1.md`,
> `code-review/batch_full_r1.md`, `test-gap/batch_full_r1.md`, `feature-check/batch_userflows_matrix.md`.
>
> **Relayed key-registration #310/INTL-05 full-feature review (2026-07-10, `RELAYED_REG_FULL_REVIEW.md`).**
> Independent six-lens review over `Keystore.setAuthPolicyWithSig` + `PrivacyPoolRelay.registerAndRelay`
> + the SDK predicted-post-insertion keystore-root witness + relayer `POST /register-and-relay`, covering
> the state left by the concurrent `feature/harvest-relayed-registration` work. Security audit found **no
> Critical/High/Medium** and no soundness break: a wrong predicted keystore root can only REVERT the atomic
> tx (the pool accepts only real known roots + Groth16 proves membership independently), replay is blocked
> by the one-time `nullifyingKeys` guard + the EIP-712 domain, EIP-1271 is supported, and `registerAndRelay`
> is atomic with a safe front-run idempotent-skip. Coherence all PASS (SDK EIP-712 payload exactly matches
> `Keystore.sol`; predicted index single-sourced); no undocumented user-flow gaps. 81 unit + 4 real-proof
> integration tests pass. Fixes — **RR-1** (SDK `submitRelayedRegistration` now throws a clear
> `RelayerRequestFailed` up front instead of POSTing to a nonexistent `/register` — the INTL-05-deferred
> standalone endpoint), **RR-2** (relayer `PP_RELAY_ABI` gains the 4 missing errors + `_announcer` ctor arg),
> **RR-3** (deleted the dead `decodeContractError`), **G1** (register-path real-revert-data test), **G2**
> (register ABI-drift golden, selectors from compiled artifacts). Accepted: **G3** (relayer→contract register
> wire mock-only — funds-safety covered by the contract's own real-proof `RegisterAndRelay.t.sol`; a fork e2e
> belongs to the `packages/relayer/e2e/` owner), **L-1** (predicted-root staleness = griefing-only), **L-2**
> (unpermissioned `initializeEIP712` reinitializer — non-exploitable; gating reverted to avoid churning the
> keystore test/tree surface the concurrent instance owns), **L-3** (no nonce). See `audit/relayed_reg_full_r1.md`,
> `code-review/relayed_reg_full_r1.md`, `test-gap/relayed_reg_full_r1.md`, `feature-check/relayed_reg_userflows_matrix.md`.

> **Second-pass adversarial review of the remediation (2026-07-08).** A fresh multi-lens pass audited the
> remediation itself (never independently reviewed) + whole-branch PR-readiness. New findings, all fixed:
> **SEC-3 (High)** — `prepareYieldWithdrawRelay` (F-1) bound the relayer's `PayoutRouting` verbatim but
> skipped the recipient/fee/asset verification the plain relayed-withdraw path enforces (supplying
> `transactParams` makes `params.recipient` dead), a theft vector under a malicious relayer → FIXED
> (`0533bf6c`, shared `assertPayoutRoutingMatchesQuote` guard + a new `prepareYieldWithdrawRelay` test
> suite that had none). **L-1 (Low)** — `SET_AUTH_POLICY_TYPEHASH()` getter NatSpec still showed the
> pre-`deadline` type → FIXED (`e41c72fc`). **DOC (Low)** — broken relative links in HANDOFF + relocated
> batch reports → FIXED (`9b29da3b`). The four fixes (C-6/7/8, N-2), the ABI/selector compatibility, the
> F-1 SDK→relayer chain (incl. processor allowlist), and test-refactor coverage integrity were all
> traced clean. Informational (left as-is): the non-spec `future-ideas/relayed-key-registration.md`
> planning doc still shows the pre-deadline signature; some historical audit reports reference the now-
> split `PPRouter.t.sol`.
Single severity-ranked register across all lenses (alignment / code-review / audit / test-gap /
cross-feature security / plan reviews). Each row links its source report. **Status:** FIXED (applied +
verified) · HARDENED (mitigated this pass) · OPEN (documented, decision/scope for the team) ·
BY-DESIGN / BENIGN (examined, not a defect) · DESIGN-BLOCKER (pre-implementation, airdrop).

> Honesty (Directive 0): "FIXED" rows were re-run and observed passing. "OPEN" rows are real gaps left
> for the team — some are deliberate scope calls (e.g. adding a full yield real-proof E2E), not oversights.

## Critical / High
| ID | Sev | Area | Finding | Status | Source |
|---|---|---|---|---|---|
| C-1 | High | contracts/relay | Zero-recipient burns withdrawal+gas (`_relay`,`relayBatch`) — no `recipient!=0` guard | **FIXED** (guard + error + tests) | contracts_r1 C-1 |
| BUILD | High | contracts/test | 3 integration tests never compiled as merged (batch + yield real-proof E2E) | **FIXED** | PHASE0 F-0.1 |
| H-1 | High | contracts/test | Yield real-proof tests exercise **vendored copies**, not `src/` — zero real-proof E2E of deployed yield source | **FIXED** (`0385644d` — repointed to `src/`, 9 vendored files removed; 5 real-proof yield tests pass) | contracts_r1 H-1 |
| C-6→L-6 | High→**Low** | contracts/deploy | `DeployYieldFork` bypasses factory dead-share seed (first-depositor inflation) — **downgraded**: 10^12 decimals offset neutralizes it | **FIXED** (`98cbb1e2` — deploy via `PPYieldTokenFactory.createWrapper`) | contracts_r1 L-6 |
| AIR-1 | Blocker | airdrop/design | Mint entrypoint enables theft from other depositors unless escrow is asset-isolated | **DESIGN-BLOCKER** | AIRDROP_DESIGN_REVIEW |
| AIR-2 | Blocker | airdrop/design | Sorted-nullifier-tree completeness is a **safety** property (omission → over-claim → insolvency), treated as trusted | **DESIGN-BLOCKER** | AIRDROP_DESIGN_REVIEW |
| AIR-3 | Blocker | airdrop/design | Claim nullifier forgeable without keystore binding → double-claim | **DESIGN-BLOCKER** | AIRDROP_DESIGN_REVIEW |

## Medium
| ID | Sev | Area | Finding | Status | Source |
|---|---|---|---|---|---|
| C-2 | Med | contracts/relay | `_MAX_BATCH ≥ rootHistorySize` unenforced (evicts shared pre-batch root) | **FIXED** (constructor guard) | contracts_r1 C-2 / threat S1 |
| C-4 | Med | contracts/test | 2 Entrypoint deposit fuzz failures — **test-harness bug** (forge 1.4.1 value-keyed `vm.mockCall`), not a fee asymmetry | **FIXED** (TestUtils; value assert kept) | contracts_r1 C-4 / PHASE0 F-0.4 |
| SEC-1 | Med | relayer | Batch-quote signed a commitment unconditionally (unauthenticated signer DoS) | **FIXED (HARDENED)** (gated on `commit`) | relayer_r1 SEC-1 |
| SEC-2 | Med | relayer | `minUnderlyingOut=0` — no Aave-redeem slippage floor on relayed path | **FIXED (HARDENED)** (client floor) | relayer_r1 SEC-2 |
| SEL | Med | contracts/CI | 46 yield tests silently unselected by CI globs | **FIXED** (renamed) | PHASE0 F-0.2/3 |
| F-1 | Med | sdk↔relayer | Relayed-yield `processorAddress` unreachable via SDK (relayer honors it, SDK strips it) | **FIXED** (`37964f22` — optional field+schema; `prepareYieldWithdrawRelay` session; +4 tests) | sdk_r1 F-1 |
| M-2 | Med | sdk/stealth | Canonical EIP-5564 scheme unreachable via orchestrator (`resolveRecipient` only returns FluidKey) | **FIXED** (`5695e717` — `canonical` RecipientIdentifier → `CanonicalMetaAddress` 0x0001; +tests) | STEALTH_REVIEW M-2 |
| M-1 | Med | sdk/stealth/contracts/relayer | Discovery binding advisory (no atomic announce+withdraw transport) | **FIXED** (no aggregator needed — `PrivacyPoolRelay.relayAndAnnounce` `c574ab0c` relays then announces atomically + enforces `stealthAddress==recipient` on-chain; relayer `f9e9d71c`; SDK `relayWithAnnounce` `ed03e8e4`; real-proof integration + e2e) | STEALTH_REVIEW M-1 |
| L-1 | Low | sdk/stealth | Pinned `CANONICAL_ANNOUNCER_ADDRESS` unverified vs live ERC-5564 deployment | **FIXED** (`3622c843` — verified vs EIP-5564 spec + Etherscan; +value-assertion test) | STEALTH_REVIEW L-1 |
| L-A | Low | contracts/stealth | relayAndAnnounce NatSpec overclaimed ("provably describes THIS withdrawal") — only the address is bound on-chain | **FIXED** (this pass — NatSpec + doc scoped to address-only binding; other announcement fields forwarded-not-proven, front-run only affects recoverable discovery) | audit/stealth_m1_m2_r1 L-A |
| L-B | Low | contracts/deploy | Constructor zero-guards announcer but canonicity delegated to deploy | **FIXED** (this pass — `_resolveAnnouncer` reverts if canonical singleton absent on a non-local chain rather than pinning a stand-in) | audit/stealth_m1_m2_r1 L-B |
| TG-1 | Low(gap) | relayer/e2e | No anvil e2e for `/relay-and-announce` (relayer↔contract ABI drift uncaught) | **RESIDUAL** (accepted — ABI just-added + matches; contract behavior covered by the Solidity real-proof integration test; consistent with the pre-existing `withdrawToUnderlying` e2e gap) | code-review/stealth_m1_m2_r1 TG-1 |
| C-7 | Med | contracts/yield | `PPYieldTokenZap` `balanceOf`-donation griefing (last-caller-wins) | **FIXED** (`bc11b95b` — balance-delta accounting; +3 griefing regressions) | contracts_r1 C-7 |
| C-8 | Med | contracts/keystore | `setAuthPolicyWithSig` no nonce/deadline (stale-sig binds abandoned NKH) — cross-chain replay ruled out | **FIXED** (`de84cd72` — EIP-712 `deadline` + `Keystore_SignatureExpired`; threaded through `registerAndRelay`; no SDK sig-path exists) | contracts_r1 L-2 / threat S5 |
| C-9 | Med | contracts/keystore | `initializeEIP712()` unpermissioned `reinitializer(2)` — benign but consumes version 2 | **OPEN (Low)** / BENIGN | contracts_r1 L-1 |
| TEST | Med | contracts/test | No fuzz/invariant handler for `relayBatch` or `registerAndRelay`; no invariants for `PPRouter`/`Zap`/factories | **FIXED** (`e4904d9e` batch+register handlers; `4d6bba40` yield invariants) | contracts_r1 M-3 |
| E2E | Med | sdk/batch | `BatchWithdrawOrchestrator.prepareBatchWithdraw` has no real-proof coverage (invariant proven, orchestrator bypassed) | **FIXED** (`ecb0344c` — real-proof orchestrator integration test) | USER_FLOW_MATRIX |
| MED-1 | Med | relayer/e2e | Batch e2e reimplements the now-exported SDK orchestrator (stale "SDK bug" claim) | **FIXED** (`80c27865` — drives SDK `prepareBatchWithdraw`; dup deleted) | relayer_r1 MED-1 |

## Low / Informational / Convention
| ID | Sev | Area | Finding | Status | Source |
|---|---|---|---|---|---|
| STEALTH | High(latent)→FIXED | sdk/stealth | schemeId 0x0001 collision (FluidKey under canonical ID) | **FIXED** (multischeme merge; verified no regression) | STEALTH_REVIEW |
| C-10 | Low | contracts/yield | `PPYieldToken` owner powers (rewardsController target, rescueToken, fee≤20% no timelock, totalAssets clamp) | **BENIGN** (trusted 2-step admin) / note | contracts_r1 L-4 |
| INTL-04 | Low | contracts/yield | `PPYieldTokenZap` no reentrancy guard — ratified accepted risk (stateless) | **BY-DESIGN** (deviations.md) | contracts_r1 L-5 |
| INTL-01/02 | Low | sdk/stealth | `./stealth` sub-package barrel/naming exemption | **BY-DESIGN** | sdk_r1 F-3 |
| INTL-03 | Low | sdk/yield | `bigint` on yield public API (vs `Hex`) | **BY-DESIGN** | sdk_r1 |
| N-2 | Low | contracts/yield | `PPRouter._fee` re-implements `FeeCalculator.calcFee` (drift hazard, identical today) | **FIXED** (`86660f05` — delegates to `FeeCalculator.calcFee`) | contracts_r1 N-2 |
| F-2 | Low | sdk/stealth | Stealth JSDoc dangling refs (`docs/DESIGN.md`, `quint/*`, fictitious rubric) | **FIXED** | sdk_r1 F-2 |
| L-3 | Low | contracts/keystore | Keystore inheritance reorder — storage-layout safe (verified) | **BENIGN** | contracts_r1 L-3 |
| TREE | Low | contracts/test | 2/8 yield `.tree` missing (`PPRouter`,`PPYieldTokenFactory`); `PrivacyPoolRelayBatch.tree` pre-existing bulloak non-conformance | **FIXED** (`8c3f5994` — `PPYieldTokenFactory.tree` (helper-after-test + regroup); `PPRouter.t.sol` split into 3 per-contract files over a shared base, 42 tests renamed to bulloak-canonical, 3 conforming trees. All 4 pass `bulloak check`; 58 tests still pass. Also conformed the pre-existing `PrivacyPoolRelayBatch.tree` (`496a2d02` — flat two-block form dodges bulloak-0.9.2's single-header fold), so the full `lint:bulloak` sweep is now green.) | contracts_r1 §tree |
| DOC | Low | docs | No `docs/tech-design/contracts/` yield doc; `user-flows.md` had no feature flows; anvil key committed; `TESTING_GUIDE` missing | **FIXED** (yield doc, flows, key, guide) | doc-sync |

## Examined & cleared (not defects)
- **Batch × Yield composition = zero surface** — processor mutual-exclusion (`PoolVault_InvalidProcessor`). (threat S3)
- **Aggregate batch fee (≤ N×maxRelayFee)** — each item's fee is proof-context-bound + relayer-signed. (threat S4, contracts_r1)
- **First-depositor inflation via factory** — dead-share seed + 10^12 offset. (contracts_r1)
- **Stealth × batch/yield** — stealth bundle dies at SDK boundary; composes with neither. (STEALTH_REVIEW C)
- **10-item batch gas** — bounded, real-proof integration passes within block gas. (contracts_r1)

## Where the evidence lives
`agents/output/audit/{PHASE0_build_and_selection,contracts_r1}.md` ·
`agents/output/code-review/{sdk,relayer}_r1.md` ·
`agents/output/security/{CROSS_FEATURE_THREAT_MODEL,STEALTH_REVIEW_AND_DIFF}.md` ·
`agents/output/feature-check/{USER_FLOW_MATRIX,AIRDROP_DESIGN_REVIEW}.md` ·
migrated: `agents/output/audit/AUDIT_{batch_full,batch_standards,batch_withdrawal,yield}.md`.
