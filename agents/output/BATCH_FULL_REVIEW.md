# Batch Withdrawal (#316) — Full-Feature Review Synthesis

**Reviewed at:** commit `c0183e21` (branch `v2.0-features`), six lenses in parallel + hand
verification of every Medium+ finding against the code.

**Scope:** `PrivacyPoolRelay.relayBatch` (atomic, ≤`MAX_BATCH`=10 transacts, shared
recipient/asset/feeRecipient, one aggregate fee split across items, all anchored to a shared
pre-batch state-root snapshot); relayer `POST /batch`; SDK `PoolSessionBatchWithdraw` /
`BatchWithdrawOrchestrator` / `computeBatchFees` / `selectNotesForFullWithdraw`.

## Per-lens verdicts

| Lens | Verdict | Report |
|------|---------|--------|
| Security audit | **worst severity LOW** — no Crit/High/Med; no constructible exploit; 18/18 forge tests pass | `audit/batch_full_r1.md` |
| Code review + coherence | **APPROVE (clean)** — no Blocker/Major; three layers cohere on wire shape, homogeneity, MAX_BATCH, fee model | `code-review/batch_full_r1.md` |
| User-flow matrix + SDK comprehension | **DONE-WITH-GAPS** — 10/14 flows reachable; one ❌ (BW-2 self-submit) + three ⚠️ | `feature-check/batch_userflows_matrix.md` |
| Test-gap (matched to flows) | **no High** — best-tested surface; two Medium gaps | `test-gap/batch_full_r1.md` |

## Findings and dispositions (all hand-verified against the code)

| ID | Lens | Sev | Disposition |
|----|------|-----|-------------|
| **BW-2** | flow/SDK | (Y-1-class) | **BUILT** — SDK self-submit batch path (`selfSubmitBatchWithdraw`), user's own zero-fee `relayBatch`. SDK-only; `relayBatch` is already permissionless. |
| **GAP-1** | test-gap | Medium | **FIXED** — real-proof atomic-abort integration test: a mid-batch `InconsistentRecipient` revert unwinds items 0–1's REAL transacts (was mock-only). |
| **GAP-2** | test-gap | Medium | **FIXED** — MAX_BATCH boundary: exact-10 groups pass + 51 same-label → 11 chunks → `BatchTooLarge` (chunk overflow), at selection + orchestrator layers. |
| **GAP-3** | test-gap | Low | **FIXED** — `selectNotesForFullWithdraw` exact-`maxInputs` (5→1 group) boundary. |
| **BW-1** | flow | ⚠️ | **FIXED** — session fails fast on oversized selection BEFORE the relayer quote round-trip (+ test). |
| **CR-1** | code-review | Minor | **FIXED** — `IPrivacyPoolRelay.MAX_BATCH()` declared `pure` to match the impl. |
| **CR-3** | code-review | Nit | **FIXED** — harmonized the fee-vs-withdrawal guard operand order (`relayBatch` ↔ `_relay`). |
| **CR-4** | code-review | Nit | **FIXED** — dropped the hard-coded "5" from the relayBatch NatSpec. |
| **CR-6** | code-review | Nit | **FIXED** — added the `RelayerInteractorBaseError` `@throws` to the batch-session interface. |
| **B-1** | audit | Low | **Accepted** — `_MAX_BATCH < rootHistorySize` coupling checked only at relay construction; the pool is UUPS-upgradeable so a future buffer-shrink could break the snapshot guarantee. Liveness-only (reverts, never fund loss); the relayer re-checks it live (`assertBatchFitsRootHistory`). |
| **B-2..B-5** | audit | Info | **Verified safe** — B-2 fee-concentration is bound in the user's proof + capped on-chain (client check load-bearing but not fund-safety); B-3 atomicity revert-griefing mitigated by simulate-before-write + nullifier secrecy; B-4 full standalone `relayCost` per item is intended economics; B-5 reentrancy closed (CEI + `POOL.transact` nonReentrant). |
| **BW-3** | flow | ⚠️ | **Accepted** — batch is full-balance only (no partial multi-note subset); documented boundary. |
| **BW-4** | flow | ⚠️ | **Accepted** — the submit→revert race returns a `status=false` receipt (notes correctly not persisted); pre-submit simulate covers the common case. |
| **CR-2** | code-review | Nit | **Skipped** — extracting the shared per-item validation is a behavior-preserving refactor; the current form is clear and `_distribute` is already shared. |
| **CR-5** | code-review | Nit | **Skipped** — `receive()` placement predates this feature; out of scope. |

## Security posture

No Critical/High/Medium in any lens. The three batch-specific safety properties were each
verified concretely: (1) the shared pre-batch-root snapshot survives a full batch (10 < 16),
tested for real by `test_relayBatch_maxBatch_erc20` (10 real proofs) and no off-by-one; (2) no
intra-batch double-spend (nullifiers marked per-transact + atomic revert), now also proven by
the GAP-1 atomic-abort test; (3) homogeneity is enforced for **every** item (asset, recipient,
feeRecipient all checked in-loop), so no item can smuggle a divergent recipient/asset — funds
pool to one recipient. Fee conservation is exact and the SDK/relayer recompute-and-verify each
item's fair single-tx fee from the signed model, defeating fee re-concentration.

## Verification (this pass)

- Contracts: 31 single-relay + 23 batch (18 unit + 5 integration, incl. the new atomic-abort) tests pass; `forge build` green.
- SDK: 52 batch unit tests + 7 real-proof integration tests (incl. the new self-submit real-proof case) pass; `tsc --noEmit` clean.
