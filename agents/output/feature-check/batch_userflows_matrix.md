# Batch Withdrawal (#316) — User-Flow Matrix & SDK-Comprehension Check

- **Feature:** Batch full-balance withdrawal — many small single-asset notes → one recipient in one atomic `relayBatch` tx (≤ `MAX_BATCH` = 10 transacts), one aggregate fee split per item.
- **Commit audited:** `c0183e21` (branch `v2.0-features`)
- **Method:** Traced every conceivable batch flow SDK method → relayer endpoint → contract fn, and verified each reachability claim against an actual export / public method (Directive 0: no assumed exports).

## Entry-point surface (verified reachable through public SDK)

| Symbol | Kind | Export evidence |
|---|---|---|
| `PoolSession.prepareBatchWithdraw` / `.relayBatchWithdraw` | ergonomic session API | `packages/sdk/src/services/poolSessions/PoolSession.ts:325,338`; delegate wired in `PoolSessionFactory.ts:173-189` (gated on `transactCore`); `PoolSession` exported `external.ts:5` |
| `PoolSessionBatchWithdraw` | session delegate class | exported in the `export {…} from "./internal.js"` block, `external.ts:26` |
| `BatchWithdrawOrchestrator` | low-level orchestrator | exported `external.ts:23` |
| `selectNotesForFullWithdraw` | note partitioner | exported `external.ts:91` |
| `computeBatchFees` / `computeBatchItemFee` | pure fee fn | exported `external.ts:88` AND on dependency-light subpath `@privacy-pools-v2/sdk/batch-fee` (`packages/sdk/src/batchFee.ts:14`, `package.json` exports `./batch-fee`) |
| `MAX_BATCH` (=10) | cap constant | exported `external.ts:79`; single-sourced `constant/BatchWithdraw.ts`; cross-checked on-chain `PrivacyPoolRelay.sol:58` and by relayer |
| `RelayerInteractor.getBatchWithdrawalQuote` / `.relayBatchWithdrawal` | HTTP client | `RelayerInteractor.ts:177,434`; `RelayerInteractor` exported `external.ts:33` |
| Batch errors (`BatchWithdrawBaseError`, `EmptyBatchSelection`, `BatchTooLarge`, `InfeasibleBatchFee`, `BatchRoutingMismatch`, `BatchRoutingInvalid`) | value-exported for `instanceof` | `external.ts:97-104` |
| Relayer `POST /v1/quote/.../batch` | batch quote endpoint | `quote.controller.ts:109-117` (`getBatchQuote` → `quoteService.quoteBatch`) |
| Relayer `POST /v1/relay/.../batch` | batch relay endpoint | `relay.controller.ts:120-130` (`batchWithdrawal` → `relayService.batchWithdrawal`) |
| Contract `PrivacyPoolRelay.relayBatch(proofs[],params[],noteData[][])` | on-chain settle | `PrivacyPoolRelay.sol:140` (`external payable`, permissionless — no access modifier) |

## The matrix

| # | User flow | Code path (SDK → relayer → contract) | Reachable via public SDK | Verdict |
|---|---|---|---|---|
| 1 | Full balance fits in **1 transact** (≤5 notes) | `prepareBatchWithdraw` → `selectNotesForFullWithdraw` yields 1 group → 1 proof → `POST /batch` → `relayBatch` (count=1) | Yes. Still routed through `relayBatch`, not `relay()` — works but 1 extra loop-iteration of overhead vs single `relay()`. | ✅ |
| 2 | Full balance needs **N transacts** (N≤10) | groups=N (`selectNotesForFullWithdraw.ts:64` chunks per-label by `MAX_INPUTS`=5), N proofs bound to signed routings, `relayBatch` loops N (`PrivacyPoolRelay.sol:161-180`) | Yes | ✅ |
| 3 | Balance **exceeds MAX_BATCH** (e.g. 51 notes / >10 groups) | `selectNotesForFullWithdraw` returns >10 groups; **session quotes first**, then `BatchWithdrawOrchestrator` throws `BatchTooLarge` (`BatchWithdrawOrchestrator.ts:83-85`); contract also guards `PrivacyPoolRelay.sol:147` | **Rejected, not chunked.** No SDK helper splits a >MAX_BATCH balance into multiple sequential batches → user has **no ergonomic full-withdraw path** for such a balance. | ⚠️ **BW-1** |
| 4 | **Relayed** batch (relayer pays gas) | `relayBatchWithdraw` → `RelayerInteractor.relayBatchWithdrawal` → `POST /batch` → `evm.relay.service.batchWithdrawal` → `simulateAndWriteRelayBatch` → `relayBatch` | Yes | ✅ |
| 5 | **Self-submit** batch (user pays gas, no relayer) | Contract `relayBatch` is permissionless (`.sol:144`), so a gas-paying user *could* submit a zero-fee batch on-chain — **but the SDK has no method to build/submit one.** `PoolSessionBatchWithdraw` only exposes the relayer route; contrast `PoolSessionWithdraw.withdraw`/`executeWithdraw` → `core.submit(tx)` (`PoolSessionWithdraw.ts:233,241,253`) which DOES self-submit. Batch proofs require a relayer-**signed** quote (`PoolSessionBatchWithdraw.ts:77-94`), so there is no quote-free build path. | **No self-submit path** — asymmetric with single withdraw. | ❌ **BW-2** |
| 6 | Get a **standalone batch quote** | `RelayerInteractor.getBatchWithdrawalQuote` (public, `RelayerInteractor.ts:177`) → `POST /quote/.../batch` → `quoteBatch` | Yes (also bundled inside `prepareBatchWithdraw`) | ✅ |
| 7 | **Fee agreement** SDK ↔ relayer ↔ contract | Relayer signs per-item `PayoutRouting[]` using the *same* `computeBatchItemFee` the SDK imports via `@…/sdk/batch-fee`; orchestrator **recompute-and-verifies** each `routing.feeAmount === expectedFee` (`BatchWithdrawOrchestrator.ts:145-157`); contract caps `feeAmount ≤ maxRelayFee` and `≤ amountOut` (`.sol:172-173`). Identical `min(maxRelayFee, relayCost + variable)` math (`computeBatchFees.ts:44-47`). | Yes — one shared source, SDK-verified | ✅ |
| 8 | **Partial** withdrawal (subset / chosen amount) | Batch is **full-balance only** (`getNotes({ACTIVE, tokenId})` grabs everything, `PoolSessionBatchWithdraw.ts:71`). Partial is served by regular `PoolSessionWithdraw` (single transact, ≤5 notes). A partial that needs >5 notes but not the whole balance has no batch path. | Full-balance: yes. Partial-multi-note: not a batch feature. | ⚠️ **BW-3** (scope note) |
| 9 | **Single-note "batch"** (1 item) | Same as flow 1 — always `relayBatch`, never degrades to `relay()` | Yes | ✅ |
| 10 | **Mixed assets** in one batch (should reject) | Impossible to construct: session filters notes by one `tokenId` before selection (`PoolSessionBatchWithdraw.ts:71`); relayer rejects (`evm.relay.service.ts`); contract enforces `PrivacyPoolRelay_InconsistentAsset` (`.sol:164`) | Prevented pre-submit | ✅ |
| 11 | **Differing recipients** (should reject) | Single `recipientAddress`; orchestrator validates every routing recipient + feeRecipient up front (`BatchWithdrawOrchestrator.ts:121-136`); contract enforces `PrivacyPoolRelay_InconsistentRecipient` (`.sol:168-171`) | Prevented pre-submit | ✅ |
| 12 | **Change / remainder** notes after selection | Each group is single-label full-spend → one 0-value change note (`selectNotesForFullWithdraw.ts` doc §; `outputCommitmentNumber = changePendingNotes.length`, `BatchWithdrawOrchestrator.ts:190`); persisted once post-confirm via `persistBatchNoteUpdates` (`.ts:212`) | Handled | ✅ |
| 13 | **Failure recovery** — a nullifier spent between quote & submit (whole batch reverts) | Relayer pre-simulates (`simulateAndWriteRelayBatch`) → revert surfaces as HTTP error → `RelayerRejected` thrown (usable). If it lands on-chain and reverts (race), `relayBatchWithdraw` returns a receipt with `status=false` and does **not** persist (notes stay ACTIVE) — `PoolSessionBatchWithdraw.ts:122`. | Usable error surfaced; on-chain-revert race returns a falsy receipt rather than a thrown typed error (minor). | ⚠️ **BW-4** (minor) |
| 14 | **Quote lapses during proof gen** | `assertFeeCommitmentLive` checked at prepare (`.ts:86`) AND again at relay (`.ts:108`); throws `FeeCommitmentExpired` | Yes | ✅ |

## Findings

- **BW-2 (❌ missing-from-SDK, the Y-1-class finding) — no self-submit batch path.** `relayBatch` is permissionless on-chain (`PrivacyPoolRelay.sol:144`), and single withdrawals expose a self-submit path (`PoolSessionWithdraw.withdraw` → `core.submit`, `.ts:253`), but `PoolSessionBatchWithdraw` offers **only** the relayer route — batch proofs are hard-bound to a relayer-signed quote at prepare time (`.ts:77-94`), with no quote-free build path. A user who wants to pay their own gas to batch-withdraw their full balance has no SDK method. This is a real user flow (self-custody / relayer-down) with a code path (the contract fn) that is unreachable through the public SDK — the exact shape of yield's Y-1. *Fix:* a `prepareSelfSubmitBatch` that builds zero-fee (or self-fee-recipient) `PayoutRouting[]` locally and a `submitBatch` that calls `relayBatch` directly, mirroring the single-withdraw self-submit. Confirm whether this omission is intentional (log as INTL) or a gap.

- **BW-1 (⚠️) — >MAX_BATCH balances hard-reject with no chunking.** A balance whose selection yields >10 groups (up to ~51 same-label notes, or fewer notes spread across many labels since each label starts a fresh chunk) throws `BatchTooLarge` with no SDK orchestration to split it across multiple sequential ≤10-group batches. The user is left to manually withdraw. Also minor: the session requests the relayer quote *before* the `MAX_BATCH` check (`PoolSessionBatchWithdraw.ts:77` precedes the orchestrator's `.ts:83` guard), wasting a relayer round-trip on an always-doomed batch — a cheap pre-check on `groups.length` would fail fast.

- **BW-3 (⚠️, scope note) — batch is all-or-nothing full-balance.** No partial/subset batch; a partial withdrawal needing >5 input notes (more than one transact but not the whole balance) has no path. Likely intentional (feature is "withdraw the whole single-asset balance"), but not documented as a deliberate boundary — worth an explicit note in `docs/tech-design/sdk/batch-withdraw.md` or `deviations.md`.

- **BW-4 (⚠️, minor) — on-chain-revert race returns a falsy receipt, not a typed error.** The pre-submit simulate covers the common case with a thrown `RelayerRejected`; only the submit→revert race falls through to a `status=false` receipt. Acceptable (notes correctly not persisted), but a caller must inspect `receipt.status` rather than catch.

## Verdict

**DONE-WITH-GAPS.** The relayed full-balance batch flow is coherent and fully reachable end-to-end (SDK session → `POST /batch` → `relayBatch`), with fees single-sourced and SDK-verified, and all the reject-cases (mixed asset, divergent recipient, oversized, expired, empty) guarded at SDK, relayer, and contract layers. One ❌ (**BW-2**, self-submit batch unreachable — a genuine Y-1-analog) and three ⚠️ (oversized-balance no-chunking, full-balance-only scope, revert-race receipt).
