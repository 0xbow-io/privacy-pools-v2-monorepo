# v2.0 Feature Effort — Retrospective (recurring-defect harvest)

**Commit:** 7d906db1

> **Scope.** Lessons harvested across the whole `v2.0-features` effort — the four-feature internal
> audit, the sequential quality loops, the remediation passes, and the INTL-05 SDK+relayer glue build.
> The goal: turn defects that **recurred or were nearly missed** into standing agent rules, so the next
> pass catches them by construction. **Additive only** — no existing guidance was removed.
>
> Companion artifacts: master findings register `output/security/SECURITY_FINDINGS.md`; deviations
> `agents/deviations.md`; the seed feedback `feedback_no_mock_only_testgap` (TEST-7, the win that
> prompted this harvest).

## How each rule was placed

Two constraints shaped placement: (1) each rule lives in its **single most-natural home** (the
CLAUDE.md warns against splitting one rule across many docs), and (2) a rule is added **only where the
angle is not already covered**. Notably, `AUDIT_AGENT` already flags schema field-mismatch ("fields the
server honors but the client can't send") and server-side fee floors — so those audit angles were *not*
duplicated; only the missing **test**, **review**, and **client-trust** angles were added.

## The rules (with the evidence that motivated them)

| Rule | Home | Evidence (what recurred / was nearly missed) |
|---|---|---|
| **TEST-8 — schema→wire survival test.** Every request/response type field must have a test proving it survives validation AND reaches the wire (POST body / decoded struct). | `TEST_GAP_AGENT` §6 | Zod strips undeclared keys silently. **F-1** lost `processorAddress`/`minUnderlyingOut` from the relayed yield withdrawal this way; the relayed `registration` leg would have dropped identically. A type-shaped unit test never catches it. |
| **TEST-9 — invariant efficacy.** Invariant assertions are only load-bearing inside `invariant_*`/`afterInvariant`; confirm each is load-bearing via a deliberate mutation. | `TEST_GAP_AGENT` §7 | **F-1 (invariant)** confirmed empirically that Foundry `fail_on_revert=false` **swallows** `assertEq`/`assertLe`/`require` in a *handler body* — the handler reverts, rolls back, the run stays green. A whole "invariant" suite can be inert. |
| **Type ⟺ schema parity.** Every type field has a matching Zod/DTO key; flag divergence (never `.passthrough`). | `CODE_REVIEW_AGENT` | Review-time counterpart to TEST-8 — catch the drop at the source, not just in tests. |
| **Single-source derivation across a boundary.** A value that must match on both sides of a verification boundary (proof vs. contract, predicted vs. actual, SDK vs. relayer) is derived in ONE place and reused. | `CODE_REVIEW_AGENT` | This build computes the predicted keystore leaf **only inside the witness builder**, so "proven == inserted" holds by construction — deliberately avoiding a duplicate-derivation drift bug. |
| **Counterparty-reported values × client sizing.** The client must recompute AND bind every payout quantity (fee split, slippage floor, change) from its OWN inputs; never size a security floor from a counterparty-reported field. | `SECURITY_INTERACTION_AGENT` | **SEC-3** (a relayer could re-concentrate a signed fee split via the single-`relay` escape hatch — a theft vector introduced by the F-1 fix itself) and **M-1** (`minUnderlyingOut` had to be sized from the caller's `amountOut − guard-bound committed fee`, not the relayer's unverified `amountReceived`). |
| **Predicted-state proof race.** A proof anchored to *predicted* (not current) on-chain state carries an intrinsic staleness race (any concurrent mutation invalidates it); require a submission-layer mitigation (private orderflow / bundle) — no on-chain fix exists. Verify the predicted-mode flag is load-bearing. | `AUDIT_AGENT` (proof-handling) + `SECURITY_INTERACTION_AGENT` (keystore-root freshness pair) | The INTL-05 `registerAndRelay` withdrawal anchors to the **predicted post-insertion keystore root**; weaponizable by cheap registration spam. The real-proof e2e asserts the flag is load-bearing (the withdrawal is unprovable without it). |
| **Front-run-robust atomic bundles.** A bundled "do X then act" entrypoint should idempotent-**skip** a satisfied step rather than revert, so a front-run of that step can't grief the bundle. | `AUDIT_AGENT` (Solidity) | `PrivacyPoolRelay.registerAndRelay` skips registration if the account is already registered with the intended key — so an attacker submitting the account's own registration first degrades the bundle to a plain relay instead of reverting it for zero gain. |

## Already codified before this harvest (kept, not re-added)

- **TEST-7 — no-mock-only sweep** (`TEST_GAP_AGENT` §2, `FEATURE_BEST_PRACTICES`): every mocked behavior
  needs a real (non-mocked) counterpart exercising the **same seam** — the "session method the mocked
  unit test drives but the e2e hand-rolls" clause already covers the real-seam refinement, so it was
  **not** duplicated here.
- `AUDIT_AGENT` wire-format-trust + server-side-floor lines (see placement note above).

## Deferred follow-ups (tracked in `deviations.md` INTL-05)

- **Yield-specific atomic register-and-withdraw** on `PoolSessionYieldWithdraw` (+ PPRouter routing for
  the atomic dispatch) — a mechanical mirror of the standard path; deferred to avoid a disproportionate
  DRY refactor of the just-hardened (M-1/SEC-3) yield session.
- **Standalone `POST .../register`** (`setAuthPolicyWithSig`) relayer endpoint — blocked on an
  unresolved economic question: a value-less registration carries no fee commitment, so relayer gas
  compensation is undefined (`relayed-key-registration.md` §6). The atomic path sidesteps this by
  absorbing registration gas into the withdrawal `feeAmount`.
