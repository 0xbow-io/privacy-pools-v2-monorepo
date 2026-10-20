# Standards Audit — Batch Withdrawal Feature

> ⚠️ **Point-in-time snapshot (partly superseded).** Predates the per-item fee rework (v0.4.0);
> `allocateBatchFee` referenced here is **retired** (now `computeBatchFees`, per-item normal-tx
> fees). Source of truth: [`tech-design/contracts/batch-withdrawal.md`](../../../docs/tech-design/contracts/batch-withdrawal.md);
> latest audit: [`AUDIT_batch_full.md`](AUDIT_batch_full.md).

**Standard:** `docs/FEATURE_BEST_PRACTICES.md` (rules A1..G1)
**Agent:** `feature-standards-auditor` (also serving as the quality loop's TEST-GAP round)
**Feature:** "withdraw entire single-asset balance in one tx" — `relayBatch` (contract) + SDK batch orchestrator/session + relayer batch quote/relay paths.
**Diff scope:** branch `feat/batch-transactions`, `feat/ppusdc-yield..HEAD` (`dce2d7ce..069a6d7b`, 11 commits, 74 files, +5109/-86).
**Method:** read-only trace + ran every test suite. Verified-not-redone: `docs/AUDIT_batch_withdrawal.md` (security), `docs/REVIEW_batch_withdrawal.md` (code review), `docs/tech-design/contracts/batch-withdrawal.md` (design).

---

## Verdict: DONE-WITH-GAPS

The feature is soundly built and lands across all layers with a source-of-truth design doc. The
contract and SDK are well-covered (42 contract tests + 36 SDK tests, all green), the security
invariants the prior audit traced hold in the current code, and the two production-unit traps the
standard was distilled from are **closed in the audited tree**: the seconds-vs-ms expiry unit is
reconciled (TEST-4 PASS) and `MAX_BATCH` is single-sourced with a runtime contract↔SDK cross-check
(DRIFT-1 PASS). **No Critical/High finding.** The gaps are test-coverage, not code defects:
the relayer's security-critical batch **validation loop** and **batch quote path** have **no unit
tests** (only the chain.service crypto round-trip is covered); the contract lacks a `MAX_BATCH`
**boundary success** test; and the full-stack e2e is **authored but was not executed here** (no
docker; local anvil verifier/artifact mismatch) so TEST-3 is unverifiable, not passing.

---

## Rule table

| Rule | Result | One-line evidence |
|------|--------|-------------------|
| SPEC-1 | PASS | Design doc marks feature **Extension**, no circuit change (`batch-withdrawal.md:3,27`). |
| SPEC-2 | PASS | Source-of-truth doc with Version History (3 rows), the shared-snapshot-root invariant (§2), exact new sigs/errors/event (§3.3). |
| SPEC-3 | PASS | Doc cites `PoolVault.sol:345-347`, `RootBufferUpgradeable.sol:64-92`, `ChainConfigRegistry.sol` — real source, not a sibling port. |
| LAYER-1 | PASS | Contract + interface + SDK (orchestrator/session/factory/errors/schemas) + relayer (quote/relay/chain.service/dto/schemas) + docs all in the diff stat. |
| LAYER-2 | PASS | `node -e require('./dist/index.cjs')` → `BatchWithdrawOrchestrator`/`PoolSessionBatchWithdraw`/`allocateBatchFee` are `function`, `MAX_BATCH===10`; value-exported in `external.ts:23-26,55,60`; `PoolSession.prepareBatchWithdraw`+factory wiring present. |
| LAYER-3 | PASS | Design doc Version History bumped to 0.3.0 with audit-response cross-ref; AUDIT + REVIEW docs added. |
| TEST-1 | **GAP (Medium + Low)** | Contract batch unit 15 + SDK unit 36 strong; **relayer batch validation loop / quote path / zod caps untested** (Medium); contract lacks `MAX_BATCH`/`MAX-1` success boundary (Low). |
| TEST-2 | PASS | `BatchTransact.t.sol` — 3 **real-proof** on-chain tests, multi-item (3 ERC20 / 2 ETH), asserts aggregate payout + nullifier spends + state-root sync. Ran: 3 passed. |
| TEST-3 | **GAP (unverifiable)** | `batch.e2e.ts` (318 lines) authored, asserts real balances + `RelayedBatch`; **not executed here** (no docker / local verifier mismatch). Not confirmed passing. |
| TEST-4 | PASS | `assertFeeCommitmentLive` uses `Date.now()` (ms); fixtures use ms (`Date.now()+3_600_000` live, `Date.now()-1000` expired). The prior seconds/ms no-op is fixed; guard now fires. |
| TEST-5 | PASS | `MAX_BATCH` cap documented+justified in schemas/contract/design doc; no silent batch skips. (4 relayer suite skips are non-batch: `app.controller`, `rate_provider`.) |
| DRIFT-1 | PASS | `MAX_BATCH`: contract `_MAX_BATCH`, SDK constant, relayer imports SDK constant; runtime cross-check `relay.MAX_BATCH()===SDK MAX_BATCH` + `MAX_BATCH<rootHistorySize` in `assertBatchFitsRootHistory` (`evm.chain.service.ts:462-508`). |
| DRIFT-2 | PASS | `selectNotesForFullWithdraw` runs once in the session, passed via `params.groups` to the orchestrator (`PoolSessionBatchWithdraw.ts:72,93` → `BatchWithdrawOrchestrator.ts:74`); `allocateBatchFee` is one shared pure fn the relayer imports. |
| DRIFT-3 | PASS | `_distribute` extracted from `relay`; review confirms byte-for-byte parity; `PrivacyPoolRelay.t.sol` 24 single-relay tests stay green. |
| SEC-1 | PASS | Proof `context` binds `transactParams`; relayer rebuilds each item from its **own signed** `PayoutRouting[]` (`evm.relay.service.ts:170-180`), re-encoding identical bytes; real-proof integration passes. |
| SEC-2 | PASS | `_recipientAmount=_totalAmountOut-_totalFee` with `feeAmount<=amountOut` per item (`PrivacyPoolRelay.sol:127,139`), no division, no dust; native + ERC-20 branches both in `_distribute`. |
| SEC-3 | PASS | Per-item `feeAmount<=maxRelayFee` & `<=amountOut` incl. item 0 in loop (`:126-127`); relayer aggregate ceiling `Σfee<=maxRelayFee*N` (`evm.relay.service.ts:210`). |
| SEC-4 | PASS | EIP-712 `domain` = `{name,version,chainId,verifyingContract}` (`evm.chain.service.ts:52-58`); expiry enforced in ms on both sides. |
| SEC-5 | PASS | `.min(1).max(MAX_BATCH)` on `/quote` `amounts` and `/relay` `items` (`quote/evm/evm.schemas.ts:28`, `relay/evm/schemas.ts:166`). Residual: signature verify still after the (now MAX_BATCH-bounded) loop — audit M-1 accepted. |
| SEC-6 | PASS | `_distribute` runs after the loop; `POOL.transact` `nonReentrant`; any item revert → whole-batch atomic revert; relay holds no persistent state. |
| CONV-1 | PASS | `///` NatSpec in tag order, `PrivacyPoolRelay_`-prefixed errors, `struct PayoutRouting` in the interface, section headers, `require`+custom errors (`PrivacyPoolRelay.sol`, `IPrivacyPoolRelay.sol`). |
| CONV-2 | **GAP (Nit)** | Barrel imports via `internal.js` (2 documented CJS exceptions), public-above-private, DI config objects, Hex boundaries all OK; `persistBatchNoteUpdates` missing specific `@throws` (`BatchWithdrawOrchestrator.ts:176`). |
| CONV-3 | PASS | validation pipe → zod schema → service → chain.service pipeline; reuses SDK `allocateBatchFee` + `encodeWithdrawalFeeSplit` rather than reimplementing. |
| HON-1 | PASS | This report distinguishes authored (e2e) from passing; names what was not run and why. |

---

## Findings (GAPs expanded)

### GAP-1 (Medium) — Relayer batch validation loop & quote path have zero unit coverage
**Rule:** TEST-1. **Confidence:** High (ran the full relayer suite; enumerated every spec).
**Location:** `packages/relayer/relayer/src/relay/evm/evm.relay.service.ts:107-215` (`batchWithdrawal`);
`src/quote/evm/evm.quote.service.ts` batch quote path; `src/relay/evm/schemas.ts` / `quote/evm/evm.schemas.ts`
(`.min(1).max(MAX_BATCH)`); `src/chain.service/evm.chain.service.ts:462-508` (`assertBatchFitsRootHistory`).

**Observed:** The only batch relayer test is `evm.chain.service.batch.spec.ts` (4 tests: encode/decode
round-trip, sign+verify with recomputed totals, tampered-sent-total rejected, expired-commitment
throws — all pass). The `EvmQuoteService` spec (`evm.quote.service.spec.ts`) has **no** batch-quote
case. **Nothing** unit-tests `EvmRelayService.batchWithdrawal`, whose loop enforces the
security-critical guards: routings.length===items.length, per-item `feeAmount<=maxRelayFee` and
`<=amountOut`, cross-item recipient/feeRecipient consistency, `Σfee===committed totalFee`, the
aggregate cap `Σfee<=maxRelayFee*N`, and the post-loop signature verify. Likewise untested: the zod
`.max(MAX_BATCH)`/`.min(1)` rejection (the M-1 DoS cap) and the `MAX_BATCH<rootHistorySize` /
`relay.MAX_BATCH()===SDK MAX_BATCH` fail-fast (L-2/QUALITY-1).

**Impact:** The crypto round-trip passing gives false confidence that the `/relay/:chain/batch`
endpoint is covered; the actual request-validation surface (where a regression would silently drop a
fee cap or an aggregate bound) is unguarded by tests. No current bug — the code reads correct — but a
future edit to any guard would not be caught.

**Fix:** Add an `evm.relay.service.batch.spec.ts` (negative cases per guard: length mismatch,
`feeAmount>maxRelayFee`, `feeAmount>amountOut`, inconsistent recipient, `Σfee≠totalFee`, aggregate
over-cap, bad signature) and a batch-quote case in the quote-service spec; add a schema test asserting
`items`/`amounts` reject empty and `>MAX_BATCH`. See "Concrete missing tests" below.

### GAP-2 (Low) — Contract lacks a `MAX_BATCH` boundary-success test
**Rule:** TEST-1 (boundaries: 0, 1, MAX-1, MAX). **Confidence:** High (enumerated all 15 batch tests).
**Location:** `packages/contracts/test/unit/PrivacyPoolRelayBatch.t.sol`.

**Observed:** Batch unit tests cover 0 (`WhenBatchIsEmpty`), 1 (`WhenBatchHasASingleItem`), and MAX+1
(`WhenBatchExceedsMaxBatch` → revert). There is **no** test that a batch of exactly `MAX_BATCH` (10)
or `MAX_BATCH-1` (9) items succeeds. The standard's boundary set explicitly wants MAX-1 and MAX.

**Impact:** The upper success edge (the batch that most stresses the root-history margin, the very
invariant the design doc §2.1 relies on) is unproven at the unit level. Real-proof integration tops
out at 3 items.

**Fix:** Add `test_RelayBatch_WhenBatchHasMaxBatchItems` (10 items, mocked transacts, assert aggregate
payout + `RelayedBatch._count==10`). A real-proof 10-item integration test would be ideal but is
optional given fixture cost.

### GAP-3 (Medium, unverifiable) — Full-stack e2e authored but not executed
**Rule:** TEST-3. **Confidence:** High that it is authored; cannot assert it passes.
**Location:** `packages/relayer/e2e/src/relay/batch.e2e.ts` (318 lines).

**Observed:** The e2e drives SDK → relayer HTTP → chain and asserts real balances
(`recipientAfter-recipientBefore === totalAmountOut-totalFee`, fee delta, pool delta) and the
`RelayedBatch` event over a genuine 3-item multi-proof full-balance withdrawal. Per the invoking
brief and Directive 0, it was **not run locally** (no docker; local anvil deposit-verifier / circuit
artifact mismatch), so its pass is unobserved.

**Impact:** The end-to-end seam (the one that historically hid the LAYER-2 type-only-export and the
TEST-4 unit bug) is not confirmed for the batch path in this environment.

**Fix:** Run `batch.e2e.ts` in the CI harness (or a docker-backed local stack) and record the observed
pass before calling TEST-3 satisfied. Do not mark PASS on the authored file alone.

### GAP-4 (Nit) — Missing specific `@throws` on `persistBatchNoteUpdates`
**Rule:** CONV-2 (SDK CLAUDE.md §4: impl carries `@inheritdoc` + one `@throws` per specific error).
**Location:** `packages/sdk/src/services/poolSessions/BatchWithdrawOrchestrator.ts:176-184`.

**Observed:** The method has only `@inheritdoc`; it forwards to `core.persistNoteUpdates`, which can
surface a `NoteManagerBaseError` subclass. (Carried over verbatim from REVIEW QUALITY-4.)
**Fix:** Add the specific `@throws` (or a one-line note that it forwards the base error unchanged).

---

## Concrete missing test cases (TEST-GAP deliverable)

Contracts (`PrivacyPoolRelayBatch.t.sol` / `BatchTransact.t.sol`):
- **[Low] `MAX_BATCH` boundary success** — batch of exactly 10 (and 9) items succeeds; assert
  `RelayedBatch._count` and aggregate payout. (Currently only 0/1/MAX+1 exist.)
- **[Info] multi-item ERC-20 aggregate with fees spread across >1 item** at unit level (current
  multi-item cases load the whole fee on item 0; the greedy-spread payout path is unit-untested).
- **[Info] real-proof batch at MAX_BATCH** (optional, fixture-cost permitting).

Relayer (new `evm.relay.service.batch.spec.ts` + quote/schema specs):
- **[Medium] routings.length ≠ items.length** → 400.
- **[Medium] per-item `feeAmount > maxRelayFee`** → 400.
- **[Medium] per-item `feeAmount > proof.amountOut`** → 400.
- **[Medium] inconsistent recipient / feeRecipient across items** → 400.
- **[Medium] `Σfee ≠ committed totalFee`** → 400.
- **[Medium] aggregate `Σfee > maxRelayFee × itemCount`** → 400.
- **[Medium] tampered proof `amountOut` breaks signature verify** → 400 (service-level, not just chain.service).
- **[Medium] proof asset ≠ commitment asset / `amountOut==0`** → 400.
- **[Low] zod `items`/`amounts` reject empty (`min 1`) and `> MAX_BATCH` (`max`)** — the M-1 cap.
- **[Low] batch quote path** — `getBatchWithdrawalQuote` splits via `allocateBatchFee`, signs a
  `RelayBatchWithdrawalCommitment`; assert `Σrouting.fee===totalFee` and per-item caps.
- **[Low] `assertBatchFitsRootHistory`** — rejects when `MAX_BATCH ≥ rootHistorySize` and when
  `relay.MAX_BATCH() ≠ SDK MAX_BATCH` (mock the two reads).

E2E:
- **[Medium] execute `batch.e2e.ts`** in CI/docker and record the pass (converts GAP-3 to PASS).

---

## What I ran (observed results)

| Suite | Command | Result |
|-------|---------|--------|
| Contracts | `forge test --match-contract "PrivacyPoolRelay\|BatchTransact"` | **42 passed / 0 failed** — `PrivacyPoolRelayBatch` 15, `PrivacyPoolRelay` 24, `BatchTransact` (real-proof) 3. |
| SDK batch | `vitest run …/BatchWithdrawOrchestrator|allocateBatchFee|selectNotesForFullWithdraw|PoolSessionBatchWithdraw` | **36 passed / 0 failed** — allocate 8, select 6, session 10, orchestrator 12. |
| Relayer (full) | `npx jest` | **22 passed, 4 skipped** (26 total); 5 of 6 suites. Batch commitment suite (4) among the passes. |
| Relayer (batch) | `npx jest …/evm.chain.service.batch.spec.ts` | **4 passed** — encode/decode, sign+verify, tampered-sent reject, expired throw. |
| SDK runtime export | `node -e require('./dist/index.cjs')` + `./dist/batchFee.cjs` | orchestrator/session/`allocateBatchFee` = `function`; `MAX_BATCH===10` (LAYER-2 proof). |

Not run: `packages/relayer/e2e/src/relay/batch.e2e.ts` (no docker; local anvil verifier/artifact
mismatch) — TEST-3 marked unverifiable, not PASS.

---

## Standard changes (proposed — flagged for human ratification)

One durable, generalizable lesson this feature exposed that no existing rule captures: a passing
**crypto-primitive** spec (sign/verify/encode round-trip) masked that the **calling
request-validation function** that enforces the business caps had zero coverage. TEST-1 says "unit
coverage per function" but was silently not applied to the relayer service layer because the
crypto suite *looked* like batch coverage. Proposed addition appended to
`docs/FEATURE_BEST_PRACTICES.md` under Section C:

> **TEST-6 (PROPOSED) — Cover the validation function, not just the primitive it calls.** A green
> test over a shared crypto/encoding primitive (EIP-712 sign/verify, ABI round-trip) does NOT count
> as coverage of the endpoint/service function that *calls* it and layers the business guards (per-item
> + aggregate caps, consistency, Σ-equals-committed, length bounds). Each such guard needs its own
> negative unit test at the service layer. (batch: `evm.chain.service.batch.spec` passed while
> `EvmRelayService.batchWithdrawal`'s entire cap/consistency loop was untested.)

Rationale: prevents the "the crypto spec is green, therefore the endpoint is tested" false
confidence that GAP-1 is an instance of. Do not ratify without human sign-off.

---

## Post-audit confirmation (follow-up run)

- **TEST-6 — RATIFIED** (human-approved); PROPOSED marker removed from the standard.
- **GAP-1 — CLOSED.** Added `evm.relay.service.batch.spec.ts` (16 tests): one negative per
  validation guard + happy path (asserts `transactParams` rebuilt from signed routings) +
  zod `.max(MAX_BATCH)` caps + a boundary test empirically confirming the L-1 aggregate cap
  is unreachable (worst-case all-at-cap `Σfee == maxRelayFee × n`, exceeding requires
  breaching the per-item cap first). Relayer suite: 37 → **38 passed**.
- **GAP-2 — CLOSED.** Added `MAX_BATCH` (10) and `MAX_BATCH − 1` (9) batch success unit tests
  (contract batch unit suite now 17).
- **GAP-4 — CLOSED.** `persistBatchNoteUpdates` impl now documents `@throws {NoteManagerBaseError}`.
- **GAP-3 (TEST-3) — CONFIRMED PASSING.** The full-stack batch e2e was executed end-to-end
  against a **fresh local deploy whose Groth16 verifiers were built from the local circuit
  artifacts** (mainnet fork for deploy prerequisites only; all 27 verifiers + protocol
  contracts deployed fresh, so proofs match). Path: SDK real proofs → NestJS relayer HTTP
  (`getBatchWithdrawalQuote` + `relayBatchWithdrawal`) → on-chain `relayBatch`. Observed tx
  `0x613fc615a4e905876c86757617b95628c1374d0b4d307115c1b6ac22361301de`:
  `poolDelta = Σamountout (6e15)`, `recipientDelta = Σamountout − Σfee`, `feeRecipientDelta =
  Σfee`, `RelayedBatch` event `count = 3`. The permanent `packages/relayer/e2e/src/relay/
  batch.e2e.ts` remains the CI-runnable form; this run used a scratch harness (reverted).
- **New defect found + fixed during that run:** `PAYOUT_ROUTING_ABI` / `PAYOUT_ROUTING_ARRAY_ABI`
  were type-only exports (undefined at runtime for external consumers) — the same LAYER-2
  trap as the orchestrator. Now value-exported from `external.ts`; verified runtime-defined.
