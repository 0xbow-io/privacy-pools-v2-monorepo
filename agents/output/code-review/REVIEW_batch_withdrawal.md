# Code Review — Batch Withdrawal Feature

> ⚠️ **Point-in-time snapshot (partly superseded).** Predates the per-item fee rework (v0.4.0);
> `allocateBatchFee` referenced here is **retired** (now `computeBatchFees`, per-item normal-tx
> fees). Source of truth: [`tech-design/contracts/batch-withdrawal.md`](../../../docs/tech-design/contracts/batch-withdrawal.md);
> latest audit: [`AUDIT_batch_full.md`](../audit/AUDIT_batch_full.md).

**Scope:** `feat/ppusdc-yield..HEAD` (branch `feat/batch-transactions`)
**Base:** `020e55d8` → **HEAD:** `babfab56`
**Focus:** correctness bugs + code quality (convention, DRY, dead code, edge cases, naming, error handling).
Security findings are covered separately in `docs/AUDIT_batch_withdrawal.md` and are **not** re-litigated here.

## Summary

The feature is well-structured and, in the load-bearing correctness paths, faithful:

- **Contract** (`PrivacyPoolRelay.relayBatch` / `_distribute`): the `_distribute` refactor is behavior-identical to the old inline `relay` code, and `relayBatch` is a correct generalization (accumulators, fee/asset/recipient invariants, zero-default fee recipient, native + ERC-20 payout, gas-funding forwarding). No off-by-one, wrong accumulator, or value-conservation error found. Balances reconcile in both asset branches.
- **ABI encoding is consistent end-to-end.** The SDK `PAYOUT_ROUTING_ABI` (single tuple) and `PAYOUT_ROUTING_ARRAY_ABI` (tuple[]) are byte-identical to the relayer's `feeSplitParams` / `feeSplitArrayParams`. The orchestrator re-encodes each routing with the single-tuple ABI and the relayer re-encodes with `encodeWithdrawalFeeSplit` — identical bytes — so the on-chain proof `context` matches on both the client-built and relayer-rebuilt `transactParams`. Verified `prepareTransact` uses the passed `transactParams` (nullish-coalesce at `TransactOrchestrator.ts:148`) and hashes it into context, so `feeRecipient` flows through correctly.
- **Relay path rebuilds `transactParams` from the signed commitment**, not client input; proofs/noteData come from the client and are bound by the on-chain context check. Ordering (`routings[i]` ↔ `items[i]`) is positional and consistent with the SDK's deterministic selection order.
- **`allocateBatchFee`** is correct: Σ(split) == totalFee in the whole-on-one, greedy, single-item, and tie branches; capacity `min(maxRelayFee, amountOut)` matches the on-chain per-item caps; `InfeasibleBatchFee` guards the overflow-of-capacity case. No bigint edge issue.
- **`selectNotesForFullWithdraw`** grouping (by label, ≤MAX_INPUTS chunks), deterministic ordering (sorted labels + commitments), and zero/non-active filtering are correct. `MAX_BATCH` overflow is capped by the caller (`BatchWithdrawOrchestrator.ts:73`), not silently emitted.
- **`persistBatchNoteUpdates`** is only called post-confirmation (`PoolSessionBatchWithdraw.ts:120-126`, gated on `txReceipt.status`).

One real (low-impact) logic bug and several quality items follow.

---

## Findings

### BUG-1 — Client-side quote-expiry guard is a silent no-op (seconds vs. milliseconds)
**Severity:** Bug (low impact — relayer remains authoritative on expiry)
**Files:**
- `packages/sdk/src/utils/RelayerQuotes.ts:115-122` (`assertFeeCommitmentLive`, expects **Unix seconds**)
- `packages/relayer/relayer/src/quote/evm/evm.quote.service.ts:287,322,361` (`expiration = Number(new Date()) + this.ExpirationTime`) with `ExpirationTime = quoteExpirationMs()` (`:46-48`) → **milliseconds**
- New batch call sites relying on the guard: `PoolSessionBatchWithdraw.ts:85` and `:106`, `RelayerInteractor.ts:313`

**What's wrong:** The relayer emits `expiration` as a millisecond Unix timestamp (`Number(new Date())` = `Date.now()` in ms, plus a ms TTL) and checks it internally in ms (`evm.chain.service.ts:205` `Date.now() > expiration`) — internally consistent. But `assertFeeCommitmentLive` compares the value against `Math.floor(Date.now()/1000)` (seconds). A ms value (~1.75e12) is ~1000× larger than `nowSeconds` (~1.75e9), so `expirationSeconds <= nowSeconds` is **never** true and the function never throws.

**Why it matters:** The batch flow's documented intent — "Fail fast on an already-expired quote before the expensive proof loop" (`PoolSessionBatchWithdraw.ts:84`) — does not hold; neither the pre-proof check (`:85`) nor the pre-submit re-check (`:106`) nor `RelayerInteractor.relayBatchWithdrawal`'s guard (`:313`) can actually fire. The JSDoc `@throws {FeeCommitmentExpired}` on these methods is effectively unreachable. Users still get correct end-state (the relayer rejects an expired commitment authoritatively), but wasted proof generation on an expired quote is not prevented.

**Note on provenance:** This is a **pre-existing** unit mismatch — `PoolSessionWithdraw.ts:96` and `PoolSessionTransfer.ts:140` feed the same ms-valued expiration to the same guard. The batch feature did not introduce the root cause, but it adds three more call sites that depend on a guard that cannot fire.

**Recommended fix:** Reconcile the unit in one place. Either divide by 1000 when populating `feeCommitment.expiration` for the SDK boundary, or change `assertFeeCommitmentLive` to compare in ms (`Date.now()`), consistent with the relayer. Fix the single-flow sites in the same change so all four flows agree.

---

### QUALITY-1 — `MAX_BATCH` is defined in three places with no runtime reconciliation between contract and SDK
**Severity:** Quality (drift risk)
**Files:**
- `packages/contracts/src/contracts/PrivacyPoolRelay.sol:36` (`_MAX_BATCH = 10`, plus `MAX_BATCH()` getter `:159`)
- `packages/sdk/src/constant/BatchWithdraw.ts:12` (`MAX_BATCH = 10`)
- Relayer imports the SDK constant (`@privacy-pools-v2/sdk/batch-fee`) in `evm.schemas.ts:2`, `relay/evm/schemas.ts:3`, `evm.chain.service.ts:26`

**What's wrong:** SDK↔relayer is correctly single-sourced (relayer imports the SDK constant). But the **contract's** `_MAX_BATCH` and the **SDK's** `MAX_BATCH` are two independent literals that must agree by hand. The contract even exposes a `MAX_BATCH()` getter (`:159`, with a comment saying it exists specifically to be read), yet nothing in the SDK or relayer ever reads it. `assertBatchFitsRootHistory` (`evm.chain.service.ts:462-482`) validates `MAX_BATCH < pool.rootHistorySize()` but never checks `MAX_BATCH === relay.MAX_BATCH()`.

**Why it matters:** If the contract's `_MAX_BATCH` is ever changed and redeployed without updating the SDK constant (or vice versa), the two silently diverge. A too-large SDK cap surfaces only as an on-chain `PrivacyPoolRelay_BatchTooLarge` revert after N proofs are generated; a too-small SDK cap silently under-batches. The getter was added for exactly this cross-check but is dead.

**Recommended fix:** Have `assertBatchFitsRootHistory` (or startup) also read `relay.MAX_BATCH()` and assert equality with the imported SDK `MAX_BATCH`, mirroring the existing rootHistorySize fail-fast. Otherwise the `MAX_BATCH()` getter is unused surface area and should be justified as external-tooling-only.

---

### QUALITY-2 — `selectNotesForFullWithdraw` is run twice with an async gap in between (TOCTOU → `BatchRoutingMismatch`)
**Severity:** Quality
**Files:** `packages/sdk/src/services/poolSessions/PoolSessionBatchWithdraw.ts:71` and `BatchWithdrawOrchestrator.ts:71`

**What's wrong:** The session computes `groups` to derive quote `amounts`, then `await`s relayer selection and `getBatchWithdrawalQuote`, then the orchestrator re-runs `selectNotesForFullWithdraw` against `noteManager` to re-derive `groups`. If note state changes during the awaits (a concurrent deposit/transact/discovery updating the ACTIVE set), the two selections diverge and the orchestrator throws `BatchRoutingMismatch` (routings.length ≠ groups.length) — after the quote was fetched.

**Why it matters:** It is handled (throws, not silent), but it is redundant work and a fragile seam: the amounts the relayer signed can become stale relative to what the orchestrator re-selects. The class comment (`BatchWithdrawOrchestrator.ts`) frames the re-run as an intentional decoupling for standalone use, which is reasonable — but the session already has the exact `groups`.

**Recommended fix:** Either pass the already-computed `groups` from the session into the orchestrator (single selection, no drift window), or document the re-selection contract explicitly and keep the mismatch guard. If decoupling must stay, a comment noting the deliberate re-read at the orchestrator call site would prevent future "why twice?" churn.

---

### QUALITY-3 — Batch `msg.value` (gas-funding) validation runs after all `POOL.transact` external calls
**Severity:** Nit
**File:** `packages/contracts/src/contracts/PrivacyPoolRelay.sol:136`

**What's wrong:** `relay` validates `msg.value == _payout.nativeGas` *before* `POOL.transact` (`:71`). `relayBatch` validates `msg.value == _totalNativeGas` *after* the whole transact loop (`:136`), because `_totalNativeGas` is loop-accumulated. Functionally identical (atomic revert), but a wrong `msg.value` burns all N transacts' gas before reverting.

**Why it matters:** Purely a fail-fast/gas-on-revert nicety, not a correctness or safety issue (the batch is atomic either way). Callers pay gas on a reverting tx regardless.

**Recommended fix (optional):** If desired, do a cheap pre-pass to sum `nativeGas` from the decoded routings and validate `msg.value` before the transact loop. Given routings are decoded twice already this adds cost; acceptable to leave as-is with the current comment.

---

### QUALITY-4 — Implementation JSDoc missing specific `@throws` on `persistBatchNoteUpdates`
**Severity:** Nit (convention)
**File:** `packages/sdk/src/services/poolSessions/BatchWithdrawOrchestrator.ts:166-175`

**What's wrong:** Per `packages/sdk/CLAUDE.md` §4, an implementation method must carry `@inheritdoc` **plus one `@throws` per specific exception**. `persistBatchNoteUpdates` has only `@inheritdoc IBatchWithdrawOrchestrator.persistBatchNoteUpdates`; it delegates to `core.persistNoteUpdates`, which can throw a `NoteManagerBaseError` subclass. The interface (correctly) documents only the base error.

**Why it matters:** Minor doc-convention drift; the method is a thin forward.

**Recommended fix:** Add the specific `@throws` for whatever `core.persistNoteUpdates` surfaces (e.g. the concrete note-manager error), or note that it forwards the base error unchanged.

---

## Areas checked and found clean

- **`_distribute` refactor** — byte-for-byte behavior parity with the pre-refactor inline `relay` payout (native: recipient gets `amount + gasFunding`, fee paid separately; ERC-20: token transfers then gas ETH forwarded). No regression.
- **Accumulators / value conservation** in `relayBatch` — `_recipientAmount = _totalAmountOut - _totalFee` cannot underflow (per-item `feeAmount <= amountOut` enforced), sums reconcile against pool inflow + `msg.value` in both asset branches.
- **`allocateBatchFee`** — Σ==totalFee in all branches incl. ties and single-item; capacity model matches on-chain caps.
- **ABI parity** — SDK ↔ relayer single- and array-tuple encodings identical; proof context binds correctly for both client-built and relayer-rebuilt `transactParams`.
- **Ordering** — amounts ↔ routings ↔ items are positionally consistent, backed by the deterministic `selectNotesForFullWithdraw`.
- **Zod caps** — `.min(1).max(MAX_BATCH)` applied on both quote `amounts` and relay `items` (SDK schemas `RelayerInteractor.ts:96,127` and relayer `evm.schemas.ts:28`, `relay/evm/schemas.ts:166`).
- **`inputNullifierNumber` / `outputCommitmentNumber`** — not dead in the batch path; consumed by `validatePublicSignalsLength` in the per-item schema (`relay/evm/schemas.ts:87-94,120-129`).
- **Fee model** — batch `quoteBatch` (`batchGas = relayTxCost * N`, `batchPriceInToken + feeBody`) mirrors the single-flow `calculateFlatFee` (`relayCost + flatFeeAmount`, `capFee`) scaled to N, with the per-item `maxRelayFee` cap intentionally deferred to `allocateBatchFee` / the contract. Documented and consistent.
- **Barrel-import deviations** — the two direct-path imports (`batchFee.ts:5,14` and `schemas/RelayerInteractor.ts:8`) are documented in-code with valid reasons (CJS bundle purity; module load-order), matching the SDK CLAUDE.md allowance.
- **EIP-712 domain** — `verifyingContract` added to `domain(...)` uniformly across sign/verify for all three commitment types; batch commitment type added correctly.
