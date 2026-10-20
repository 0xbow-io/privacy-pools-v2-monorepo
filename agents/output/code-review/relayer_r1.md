# Relayer Quality Loop — Round 1 (combined alignment / code-review / audit)

- **Commit (HEAD at report time):** `727cf5ae6f09039e1fb0053f2956284e3d99c178`, branch `audit/v2.0-features`
  (HEAD was `44f4208d` when this review started; it advanced during the session via concurrent agents on the same branch. My edits are staged in the working tree, uncommitted.)
- **Date:** 2026-07-08
- **Scope:** `packages/relayer` ONLY. V2.0 features that touched the relayer: **batch transactions** (`#2398d737`) and the relayer-side **yield plumbing** (`processorAddress`, `minUnderlyingOut`, PPRouter path). Stealth / relayed-registration added no core relayer logic. Did not touch `packages/contracts`; built (did not edit) `packages/sdk` to resolve the `@privacy-pools-v2/sdk/batch-fee` subpath.
- **Lenses:** convention-alignment (CONV-3), code-review, security-audit — one combined report.
- **What I ran:**
  - `pnpm build` in `packages/sdk` (dist was absent → jest could not resolve the workspace subpath).
  - `npx jest` (full relayer suite): **72 passed, 4 skipped** (14 suites) — up from 53 baseline (+19 new tests).
  - `npx eslint` on all changed/new files: clean.
  - `npx tsc -p tsconfig.build.json --noEmit`: exit 0.

---

## Verdict

**PASS with fixes applied.** The two batch-quote / minUnderlyingOut security issues are fixed relayer-side and covered by new tests. The batch relay path is sound: the per-item PayoutRouting split is EIP-712-signed by the relayer (`data` is part of the signed message), so the client cannot forge fees. Remaining findings are LOW / defense-in-depth / cross-package. Two items are proposed and **deferred as CROSS-PACKAGE** (SDK schema/e2e rewire).

Severity counts: **SEC 2 (both FIXED)** · **MED 1 (cross-package, deferred)** · **LOW 6 (2 fixed, 4 report-only)**.

---

## Findings

### SEC-1 — Batch quote endpoint signed a commitment unconditionally — FIXED
`evm.quote.service.ts::quoteBatch` (pre-fix) destructured only `{ asset, recipient, amounts }` and **always** called `createBatchWithdrawalFeeCommitment` → `signRelayBatchWithdrawalCommitment` (EIP-712). The single-withdraw `quote()` gates signing on `commit === true` (`evm.quote.service.ts:162-173`). The batch DTO/schema already carried a `commit` field (`evm.schemas.ts` `zEvmBatchQuoteRequest` extends `zEvmShieldedQuoteRequest`), so an unauthenticated `POST /v1/quote/evm/:id/batch` forced the relayer signer to do EIP-712 work on every call regardless of intent.
**Fix:** `quoteBatch` now reads `commit` and returns the fee estimate WITHOUT a commitment when `commit !== true`; `zBatchWithdrawalQuoteResponse.feeCommitment` made `.optional()`. The pure `computeBatchFees` path is bounded (`amounts` capped at `MAX_BATCH` by the request schema), so the non-committing path is cheap. Covered by a new test in `evm.quote.service.spec.ts` ("returns the fee estimate without signing when commit is false").
Files: `quote/evm/evm.quote.service.ts`, `quote/evm/evm.schemas.ts`.

### SEC-2 — `minUnderlyingOut` hardcoded `0n` on the PPRouter redeem leg — FIXED (relayer-side)
`evm.relay.service.ts:70` (pre-fix) hardcoded `const minUnderlyingOut = 0n`, giving zero slippage protection on the Aave redeem leg of `PPRouter.withdrawToUnderlying`. The self-submit SDK path computes a real floor. The relayer genuinely cannot derive an underlying-denominated floor itself (the fee commitment binds only pp-share amounts; no redeem-rate quote is available here).
**Fix:** accept an optional **client-supplied** `minUnderlyingOut` on the relay withdrawal request (`zEvmRelayWithdrawalRequest.minUnderlyingOut = zNonNegativeBigInt.optional()`), thread it through `withdrawal()` (`request.minUnderlyingOut ?? 0n`), and document it in the DTO (`@ApiProperty`). Backward-compatible (defaults to `0n`; a too-high floor simply reverts in the `simulateContract` step, costing the relayer no gas). Covered by `evm.relay.service.processor.spec.ts` (forwards client floor; defaults to `0n`) and `evm.chain.service.processor.spec.ts` (router branch passes the floor as the trailing `withdrawToUnderlying` arg).
Files: `relay/evm/schemas.ts`, `relay/evm/evm.relay.service.ts`, `dto/evm.relay.dto.ts`.
**CROSS-PACKAGE follow-up (proposed, not forced):** the SDK's `RelayerInteractor` should compute this floor from a redeem-rate quote and populate the field, so users get protection by default instead of opt-in. That is an SDK enhancement.

### MED-1 — Batch e2e does NOT exercise the SDK orchestrator (stale "SDK bug") — REPORT-ONLY (cross-package)
`e2e/src/relay/batch.e2e.ts` (header lines 18-37) and `e2e/src/proofs/proof.service.ts:~700-730` carry a ~100-line reimplementation of `BatchWithdrawOrchestrator.prepareBatchWithdraw`, justified by a claim that `BatchWithdrawOrchestrator` / `selectNotesForFullWithdraw` are "declared as value exports in `dist/index.d.ts` but ABSENT from the runtime bundle (`src/external.ts` only re-exports them via `export type *`)".
**This claim is now STALE/FALSE.** In the current SDK source, `BatchWithdrawOrchestrator` is a **value** export (`packages/sdk/src/external.ts:23`, inside the `export { … } from "./internal.js"` value block) and `selectNotesForFullWithdraw` is value-exported at `external.ts:89`. Both are also re-exported from `services/poolSessions/index.ts`. So the e2e's own batch proof-building is untested against the real SDK orchestrator — the batch e2e validates a relayer-local reimplementation, not `prepareBatchWithdraw`.
**Proposed (defer, cross-package):** rewire `batch.e2e.ts` to import and drive `BatchWithdrawOrchestrator.prepareBatchWithdraw` + `selectNotesForFullWithdraw` from `@privacy-pools-v2/sdk`, and delete the `generateBatchWithdrawalItem` reimplementation in `proof.service.ts`. Touches the e2e harness + relies on the SDK export surface; coordinate with the SDK team.

### LOW-1 — Batch relay does not recompute the split via `computeBatchItemFee` — REPORT-ONLY
`evm.relay.service.ts::batchWithdrawal` validates `feeAmount <= maxRelayFee`, `feeAmount <= amountOut`, `Σfee == totalFee`, and an aggregate cap, then verifies the EIP-712 signature. It does NOT recompute each item's fee from the signed `(relayCost, feeBps, flatFee)` via the SDK's `computeBatchItemFee` (which IS exported on `@privacy-pools-v2/sdk/batch-fee`). This is weaker than the SDK client and the quote side.
**Impact: low.** The signed `RelayBatchWithdrawalCommitment` message includes `data` (the ABI-encoded `PayoutRouting[]`), so the split is signature-bound and relayer-authoritative — a client cannot alter fees without breaking verification. The missing recompute is defense-in-depth / consistency only. Recommend adding a `computeBatchItemFee` cross-check for parity with the quote side.

### LOW-2 — Duplicated PayoutRouting ABI + fee math — REPORT-ONLY
`relay/evm/fee_abi.ts` re-declares the `PayoutRouting` tuple (single + `tuple[]`) and the relay side re-implements the per-item checks, instead of importing the SDK's `PAYOUT_ROUTING_ABI` / `PAYOUT_ROUTING_ARRAY_ABI` (value-exported from the SDK barrel) and `computeBatchItemFee` (`@privacy-pools-v2/sdk/batch-fee`). The existing `fee_abi.golden.spec.ts` drift test is a symptom of the duplication. Consolidating onto the SDK subpath would remove the drift surface. Cross-package-ish (import change); low urgency.

### LOW-3 — Trust model of `allowed_processors` — ASSESSED, acceptable
The `allowed_processors` allowlist (`chain-config.ts::isAllowedProcessor`, case-insensitive) is the ONLY guard before `simulateContract` + `writeContract` on an arbitrary `processorAddress` with `value: nativeGas` from the relayer signer. Assessment: **acceptable** given (a) the processor is also bound into the proof `context` (per `evm.chain.service.ts:387-395`), (b) `nativeGas` originates from the signed fee commitment, and (c) every call is simulated before write (a revert throws `BadRequestException`, no gas spent). Residual risk is operator misconfiguration — any address placed in `allowed_processors` can be a call target receiving `value`. Recommend documenting the allowlist-curation requirement for operators. The reject path is now covered by `evm.relay.service.processor.spec.ts`.

### LOW-4 — EIP-712 domain gained `verifyingContract` — CONFIRMED intended + code-documented
`evm.chain.service.ts:48-59` adds `verifyingContract` (the relay address) to the domain, binding every commitment to a specific relay deployment (audit I-1). This is a **breaking change**: signatures issued before it are no longer verifiable. Intended and documented in-code. Practical impact is bounded because commitments are short-lived (`quoteExpirationMs`) and expire quickly. Recommend a one-line note in the relayer changelog/release notes so integrators re-quote after upgrade. No code change needed.

### LOW-5 — Starknet batch request/response mistyped as placeholder — REPORT-ONLY
`relay/relay.interface.ts:43-44,49-50` type the Starknet batch request/response as `StarknetRelayWithdrawalRequest` / `StarknetRelayWithdrawalResponse` (TODO-marked "batch not supported on Starknet"), and `SOLANA` reuses the Starknet placeholder throughout. Harmless while batch is EVM-only, but the placeholder types will silently mis-shape any future Starknet/Solana batch wiring. Left as-is (clearly TODO-marked); flag for the Starknet/Solana ports.

### LOW-6 — `BatchWithdrawalRelayRequestDto` empty body + non-invalidated caches — REPORT-ONLY
- `dto/evm.relay.dto.ts:102` `BatchWithdrawalRelayRequestDto extends createZodDto(zEvmRelayBatchRequest) {}` has no `@ApiProperty` — Swagger fields are derived from zod by nestjs-zod (intentional, per the DTO comment), but this is inconsistent with sibling DTOs that add explicit `@ApiProperty` (e.g. `EvmBatchWithdrawalQuoteRequestDto`). Left as-is: hand-writing `@ApiProperty` for the nested proof/commitment types risks producing *wrong* Swagger metadata; the auto-derivation is the safer single source of truth.
- `evm.chain.service.ts:91,95` module-level `rootHistorySizeCache` / `relayMaxBatchCache` are never invalidated. They cache effectively-immutable per-deployment values (`rootHistorySize`, `MAX_BATCH`), so staleness only matters across a contract upgrade within a live process — acceptable, but worth a comment noting a restart is required after such an upgrade.

---

## Convention alignment (CONV-3) notes

The relayer follows CONV-3 consistently: validation pipe → zod schema → service → chain service; `zXxx` schema naming; `XxxDto extends createZodDto(zXxx)` with `@ApiProperty`; `FATLoggerService` injected first; `BadRequestException` for client errors; `Scope.REQUEST` services; colocated `*.spec.ts`; jest + `jest-mock-extended`. The dangling CONV-3 reference to `packages/relayer/CLAUDE.md` is now resolved (created — see below). No convention violations required a code fix beyond the two security fixes.

---

## Files edited / added

**Edited (source):**
- `relayer/src/quote/evm/evm.quote.service.ts` — SEC-1 commit gate in `quoteBatch`.
- `relayer/src/quote/evm/evm.schemas.ts` — `zBatchWithdrawalQuoteResponse.feeCommitment` → optional.
- `relayer/src/relay/evm/schemas.ts` — SEC-2 optional `minUnderlyingOut` on the withdrawal request.
- `relayer/src/relay/evm/evm.relay.service.ts` — SEC-2 thread `request.minUnderlyingOut ?? 0n`.
- `relayer/src/dto/evm.relay.dto.ts` — SEC-2 `@ApiProperty` for `minUnderlyingOut`.

**Edited (test):**
- `relayer/src/quote/evm/evm.quote.service.spec.ts` — SEC-1 commit-false test + `!` on now-optional `feeCommitment`.

**Added (test — new untested surfaces):**
- `relayer/src/relay/relay.controller.spec.ts` — RelayController delegation (withdrawal/transfer/batch + error propagation).
- `relayer/src/quote/quote.controller.spec.ts` — QuoteController delegation (transfer/send=NOT_EXACT/receive=IS_EXACT/batch).
- `relayer/src/relay/evm/evm.relay.service.processor.spec.ts` — `isAllowedProcessor` reject path + `minUnderlyingOut` threading + default relay path.
- `relayer/src/chain.service/evm.chain.service.processor.spec.ts` — `withdrawToUnderlying` router branch (address / functionName / floor arg) + default relay branch + revert wrapping.

**Added (docs):** `packages/relayer/CLAUDE.md`.

No commits made. `packages/sdk` was built (dist regenerated) but its source was not edited by me (the SDK source changes shown in `git status` are concurrent agents' work).
