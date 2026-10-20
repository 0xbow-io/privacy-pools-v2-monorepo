# Test-Gap Report — Batch Withdrawal (#316)

- **Commit:** `c0183e21` (branch `v2.0-features`)
- **Scope:** `PrivacyPoolRelay.relayBatch` (contract) · `POST /batch` (relayer) ·
  `PoolSessionBatchWithdraw` / `BatchWithdrawOrchestrator` / `computeBatchFees` /
  `selectNotesForFullWithdraw` (SDK)
- **Method:** TEST_GAP_AGENT.md — no-mock-only sweep (TEST-7), schema→wire (TEST-8),
  real-proof check, error-path parity, boundary matrix.

## Verdict

**Strong coverage — NO High-severity gaps.** The batch feature is one of the better-tested
surfaces in the repo: every contract revert has a unit test, `relayBatch` has a *real-proof*
integration suite (incl. MAX_BATCH=10 against a real root buffer), the SDK orchestrator has a
real-Groth16 e2e that binds per-index nullifier/routing/context, fee math is exhaustively
unit-tested (cap, floor, flat, InfeasibleBatchFee, per-item independence), and the relayer
guard/sign/verify paths run **real EIP-712 crypto** (not mocked) in two specs. Residual gaps
are one Medium invariant (atomic-abort never run with real proofs), one Medium boundary (the
*pass* side of the MAX_BATCH cap), and Low items (session mock-only, exact-maxInputs boundary,
nativeGas real-proof, the two-fixture TEST-8 seam).

## What is already covered (so we don't re-flag it)

| Surface | Coverage | Evidence |
|---|---|---|
| Contract reverts (all 12) | Unit, mocked verifier | `PrivacyPoolRelayBatch.t.sol:144-414` (Empty, TooLarge, LengthMismatch×2, ZeroWithdrawal, ZeroRecipient, InconsistentAsset, InconsistentRecipient×2, FeeExceedsMax, FeeExceedsWithdrawal, NativeGasMismatch) |
| `RootHistoryTooSmall` (constructor) | Unit | `PrivacyPoolRelay.t.sol:94-98` (mocked `rootHistorySize <= MAX_BATCH` reverts) |
| Shared pre-batch-root invariant | **Real proof** | `BatchTransact.t.sol:82-95` (`test_relayBatch_maxBatch_erc20` — 10 real proofs, all anchored to the SAME snapshot even as each `transact` pushes a new root; asserts re-sync) |
| Aggregate-fee split | Unit + real proof | `PrivacyPoolRelayBatch.t.sol:420-521`; `BatchTransact.t.sol:150-184` (exact aggregate payout/fee) |
| Invariant | Load-bearing | `HandlerRelay.sol:187-311` `handler_guided_relayBatch` + global `invariant_relayStateRootConsistent` / `invariant_relaySplitConsistent` / PP2-5/9/11 (`Invariant.t.sol:177-205`) |
| `computeBatchItemFee` / `computeBatchFees` | Unit | `computeBatchFees.test.ts:10-127` (bps, floor, flat, **cap at maxRelayFee**, InfeasibleBatchFee, per-item cap, single-item) |
| `selectNotesForFullWithdraw` | Unit | `selectNotesForFullWithdraw.test.ts:28-112` (0-active→throw, zero-value/non-active ignore, same-label 1 group, 6→5+1 chunk, multi-label, deterministic) |
| `BatchWithdrawOrchestrator` reverts | Unit (fake core) | `BatchWithdrawOrchestrator.test.ts:287-388` (RoutingMismatch, RoutingInvalid×3 incl. greedy fee-concentration, EmptyBatchSelection, **BatchTooLarge @ 11**) |
| Orchestrator `prepareBatchWithdraw` | **Real proof** | `BatchWithdrawOrchestrator.realproof.integration.test.ts` (3 items verify against tx_1x1 VK; one shared stateRoot == seeded Merkle root; per-index nullifier/routing/context binding; A&C share value to prove distinctness isn't a free side-effect) |
| Relayer guards | Unit (mocked verify) | `evm.relay.service.batch.spec.ts:141-306` (all rejects + worst-case per-item cap) |
| Relayer sign/verify | **Real EIP-712** | `evm.chain.service.batch.spec.ts:52-174` (encode/decode round-trip, sign+verify, tamper×2, expiry) |
| Quote→relay real-signed flow | **Real EIP-712** | `evm.batch.quote-flow.spec.ts` (real quote signature verified by real relay path; RPC-only neutralized; tamper rejected) |
| Wire schema (TEST-8) | Zod parse + SDK emit | `schemas.batch-wire.spec.ts` (flatten shape → `zEvmRelayBatchRequest`; MAX_BATCH caps; superRefine rejects) + `RelayerInteractor.test.ts:1016-1053` (SDK emits `{...proof.proof, publicSignals}` + commitment passthrough to POST body) |

---

## Gaps

### GAP-1 — relayBatch atomic-abort never exercised with real proofs — **Medium** (TEST-7)
- **Path:** `PrivacyPoolRelay.sol:161-180` — the item loop calls `POOL.transact(...)` (real state
  mutation: nullifier spend + leaf insert) *before* validating item N's asset/recipient/fee. A
  revert on item N (e.g. `InconsistentAsset`) must atomically unwind items `0..N-1`'s **real**
  transacts.
- **Flow:** Batch withdrawal × (revert permutation) — the "one item diverges mid-batch" cells.
- **Why a gap:** The only tests of a mid-batch revert are unit
  (`PrivacyPoolRelayBatch.t.sol:223-262`, InconsistentAsset/Recipient) where item 0's `transact`
  is a `vm.mockCall` no-op — so nothing real is ever rolled back. The integration suite
  (`BatchTransact.t.sol`) and the invariant handler (`HandlerRelay.sol`, which self-seeds exactly
  `_count` notes so batches always succeed) only ever submit *successful* batches. This is a
  **no-mock-only violation**: the atomic-abort behavior is mock-only. The known-gaps history
  records the analogous `registerAndRelay` atomic-abort was closed with real integration; the
  `relayBatch` counterpart was not.
- **Concrete test to add** (`BatchTransact.t.sol`, real proofs):
  `test_relayBatch_midBatchRevert_rollsBackEarlierTransacts` — deposit 3 real notes, build 3 real
  proofs against the shared snapshot, corrupt item 2's `tokenIdOut` to a different asset, submit,
  `vm.expectRevert(InconsistentAsset)`, then assert (a) `spentNullifiers[item0.nullifier] == 0`
  (unspent), (b) `commitments[item0.output] == 0`, (c) pool balance unchanged, (d) on-chain root
  == pre-batch mirror root. Add a second variant reverting on the last item (N=MAX_BATCH) to
  confirm the deepest partial state also unwinds.

### GAP-2 — MAX_BATCH boundary: the *pass* side (exactly 10 groups) is untested — **Medium** (boundary)
- **Path:** `BatchWithdrawOrchestrator.ts:83` (`if (groups.length > MAX_BATCH) throw`) and
  `selectNotesForFullWithdraw.ts`.
- **Flow:** Full-withdraw note-selection, boundary permutation (MAX-1 / MAX / MAX+1).
- **Why a gap:** Only the *fail* side is tested — `BatchWithdrawOrchestrator.test.ts:372` uses **11
  distinct labels** → 11 groups → `BatchTooLarge`. The exact-boundary **10 groups → success** is
  never asserted at the orchestrator/selection level. The task's requested `50` (→10 groups, must
  pass) and `51` (→11 groups, must fail) note-selection cases are both absent; the only overflow
  path tested is distinct-label, not chunk-produced (51 same-label notes @ maxInputs=5 → 11 chunks
  → `BatchTooLarge`), so the chunking overflow branch is unexercised.
- **Concrete tests to add** (`selectNotesForFullWithdraw.test.ts` + orchestrator):
  (a) `partition 50 same-label notes into exactly MAX_BATCH groups` — 50 notes @ maxInputs=5 → 10
  groups of 5, `groups.length === 10`; (b) orchestrator `accept a selection of exactly MAX_BATCH
  groups` — 10 groups reaches `prepareTransact` (no throw); (c) `throw BatchTooLarge when a single
  lineage chunks past MAX_BATCH` — 51 same-label notes → 11 groups → `BatchTooLarge` (distinct from
  the 11-distinct-label case).

### GAP-3 — selectNotesForFullWithdraw exact-maxInputs boundary untested — **Low** (boundary)
- **Path:** `selectNotesForFullWithdraw.ts` chunking loop.
- **Why a gap:** Tests cover 3 (`< cap`, one group) and 6 (`> cap`, 5+1). The exact boundary
  `N == maxInputs` (one full group, zero stragglers, remainder 0) is skipped — the classic
  off-by-one where a `> ` vs `>= ` slip would still pass both existing cases.
- **Test to add:** `place exactly maxInputs same-label notes into a single full group` — 5 notes
  @ maxInputs=5 → `groups.length === 1`, `inputCommitments.length === 5`.

### GAP-4 — PoolSessionBatchWithdraw is mock-only (session never runs for real) — **Low** (TEST-7)
- **Path:** `PoolSessionBatchWithdraw.ts:62-131` (`prepareBatchWithdraw` / `relayBatchWithdraw`).
- **Why a gap:** The top-level session entrypoint's glue — select-once → quote per-group amounts →
  expiry check → delegate with the *same* `groups` → map items to relay params → submit →
  persist-on-success — is exercised **only** with a fake orchestrator
  (`PoolSessionBatchWithdraw.test.ts`). The real-proof e2e drives `BatchWithdrawOrchestrator` one
  layer down, bypassing the session (the exact "session method the mocked unit test drives but the
  e2e hand-rolls" pattern from the TEST-7 origin note). Lower severity: the load-bearing
  QUALITY-2 fix (groups selected once and *passed* to the orchestrator, line 93) is unit-verified,
  and the orchestrator real-proof test verifies per-index alignment. Genuinely closing this needs
  a live relayer quote (environment-gated) — file as gated/known, don't claim an unrun pass.
- **Test to add (gated):** extend the orchestrator real-proof harness to drive
  `PoolSessionBatchWithdraw.prepareBatchWithdraw` with a stub relayer returning a self-signed quote
  over the session-selected amounts, then assert the returned `items` verify and `amounts[i]`
  aligns with `groups[i]`.

### GAP-5 — TEST-8 seam closed by two hand-built fixtures, not one real serialize→parse — **Low** (TEST-8 residual)
- **Path:** SDK `RelayerInteractor.relayBatchWithdrawal` flatten (`schemas/RelayerInteractor.ts`)
  → relayer `zEvmRelayBatchRequest` (`relay/evm/schemas.ts`).
- **Why a gap:** The seam is bridged by two independent fixtures — the SDK test asserts the *emit*
  shape, the relayer test asserts *parse* of a hand-reconstructed copy — because jest can't
  transform the SDK's `@noble/ciphers` ESM. No single test runs the *actual* SDK serialization
  through the *actual* zod schema; only `batch.e2e.ts` (docker, excluded from the default PR gate)
  does. Drift between the two hand-built fixtures would not fail CI (flag as
  **real-but-unrun-in-CI**). Secondary: `schemas.batch-wire.spec.ts` asserts the *items* parse but
  does not assert the commitment's string fee-model fields (`totalFee`/`maxRelayFee`/`relayCost`/
  `feeBps`/`flatFee`) survive to `parsed.signedBatchFeeCommitment` — a Zod-strip on any of those
  would go unnoticed by this spec.
- **Tests to add:** (a) in `schemas.batch-wire.spec.ts`, assert
  `parsed.signedBatchFeeCommitment.{totalFee,maxRelayFee,relayCost,feeBps,flatFee}` are all present
  post-parse (field-survival); (b) note `batch.e2e.ts` as the sole true serialize→parse crossing
  and keep it in the release gate.

### GAP-6 — relayBatch nativeGas>0 (extraGas) never run with real proofs — **Low** (TEST-7)
- **Path:** `PrivacyPoolRelay.sol:182` (`msg.value == _totalNativeGas`) + gas forwarding in
  `_distribute`.
- **Why a gap:** nativeGas accumulation/forwarding is unit-tested only
  (`PrivacyPoolRelayBatch.t.sol:392-454`, mocked transact); the real-proof integration
  (`BatchTransact.t.sol`) hardcodes `nativeGas: 0` in `_buildBatchRelayItem` (line 205). Low
  because nativeGas is pure distribution arithmetic and does not touch proof verification.
- **Test to add:** a `BatchTransact.t.sol` variant with per-item `nativeGas > 0`, funding
  `{value: totalGas}`, asserting the recipient receives `recipientAmount + totalGas`.

---

## Priority order
1. **GAP-1** (Medium) — real-proof atomic-abort; the one batch-specific safety property proven only through mocks.
2. **GAP-2** (Medium) — MAX_BATCH pass-side + chunk-overflow boundary (the requested 50/51 cases).
3. **GAP-3 / GAP-6** (Low) — selection and nativeGas boundaries.
4. **GAP-4 / GAP-5** (Low, environment-gated) — session mock-only and the two-fixture wire seam; document as real-but-unrun-in-CI rather than claim covered.
