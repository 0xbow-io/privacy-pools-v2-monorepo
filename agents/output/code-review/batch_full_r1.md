# Code Review — Batch Withdrawal (#316)

- **Commit:** `c0183e212a91f4c9507d4d3b0e273b9d423555a6` (branch `v2.0-features`)
- **Base reference for conventions:** `v2.0` @ `d91112f2` (`packages/contracts/CLAUDE.md`, `packages/sdk/CLAUDE.md` confirmed present-and-unchanged in base v2; `packages/relayer/CLAUDE.md` authored during the audit — claims cross-checked against base-v2 relayer code and the single-withdraw path).
- **Scope:** contract `relayBatch` + interface; SDK orchestrator/session/fee-split/note-selection/types/errors/constant/external exports; relayer batch controller/schema/service/chain-service.
- **Lens:** conventions + coherence across the three layers. Security → Audit; spec → Alignment; coverage → Test-Gap.

## Verdict

**APPROVE (clean).** The three layers agree on wire shape, homogeneity constraints, `MAX_BATCH`, and the fee model. `_distribute` and the PayoutRouting ABI are shared, not copy-pasted; `computeBatchFees`/`MAX_BATCH` are single-sourced in the SDK and dogfooded by the relayer, with an on-chain `MAX_BATCH()` cross-check that fails fast on contract/SDK drift. No Blocker or Major findings. Six Nit/Minor items, all judgment calls or cosmetic; none block merge.

---

## Coherence check (the core of this review)

| Dimension | Contract `relayBatch` | Relayer `batchWithdrawal` | SDK orchestrator/session | Agree? |
|---|---|---|---|---|
| Wire shape | `relayBatch(TransactProof[], TransactParams[], NoteData[][])` (PrivacyPoolRelay.sol:140) | `simulateAndWriteRelayBatch` args `[proofArgs, transactParams, noteData]` (evm.chain.service.ts:556-563) | session sends `items[]` (proof+noteData+counts) + `signedBatchFeeCommitment`; relayer **rebuilds** `TransactParams[]` from the single signed `commitment.data` (evm.relay.service.ts:270-280) | ✅ single-sourced from the signed commitment |
| `MAX_BATCH` | `_MAX_BATCH = 10`, `MAX_BATCH()` getter (PrivacyPoolRelay.sol:28,212); `_count <= _MAX_BATCH` (147) | schema `.max(MAX_BATCH)` (schemas.ts:235) + chain-service reads on-chain `MAX_BATCH()` and asserts `== SDK MAX_BATCH` (evm.chain.service.ts:596-612) | `MAX_BATCH = 10` (constant/BatchWithdraw.ts:12); `groups.length > MAX_BATCH → BatchTooLarge` (BatchWithdrawOrchestrator.ts:83) | ✅ one value; runtime cross-check |
| Homogeneity (asset) | item0 fixes `_asset`; per-item `tokenIdOut() == _asset` → `InconsistentAsset` (151,164) | per-item `proofAsset === commitment.asset` (evm.relay.service.ts:245) | selection is per single `tokenId` | ✅ |
| Homogeneity (recipient/feeRecipient) | shared `_ref`; per-item `InconsistentRecipient` (167-171); `_ref.recipient != 0` → `ZeroRecipient` (155) | per-item `recipient/feeRecipient === routings[0]` (251-258) | up-front loop: `recipient == requested`, `feeRecipient == routings[0]` (BatchWithdrawOrchestrator.ts:121-136) | ✅ |
| Fee model | per-item cap `feeAmount ≤ maxRelayFee` and `≤ amountOut`; `_totalFee = Σ feeAmount`; one aggregate `_distribute` (172-194) | per-item caps + `Σ feeAmount == commitment.totalFee` + aggregate cap `≤ maxRelayFee·count` + EIP-712 sig over recomputed totals (289-314) | recomputes each item's standalone fee via `computeBatchItemFee` and asserts `routing.feeAmount === expectedFee` (BatchWithdrawOrchestrator.ts:145-157) | ✅ each item pays its standalone single-tx fee; contract only sums+caps |
| `nativeGas` / `msg.value` | `msg.value == Σ nativeGas` → `NativeGasMismatch` (182) | passes `value = Σ nativeGas` (evm.relay.service.ts:324) | each item's `nativeGas` bound into proof context (BatchWithdrawOrchestrator.ts:159,167) | ✅ |

Notes:
- **No fee-logic duplication.** The relayer quote path dogfoods the SDK `computeBatchFees` (evm.quote.service.ts:210); the batch fee ABI reuses the single-withdraw `encodeWithdrawalFeeSplit`/`decodeFeeSplit` machinery (`fee_abi.ts` — `decodeBatchFeeSplit` and single `decodeFeeSplit` share `feeSplitArrayParams`). `PAYOUT_ROUTING_ABI`/`PAYOUT_ROUTING_ARRAY_ABI` are the single SDK source.
- **Processor-address coupling** (SDK binds `processor = relayer.processorAddress`; relayer submits with `config.relayContractAddress()`) is the SAME cross-boundary assumption the single-relay path already makes; a mismatch reverts `ProofContextMismatch` at simulate, not silently. Not a batch-specific drift.
- **`_MAX_BATCH < rootHistorySize`** enforced at contract construction (58) AND re-checked by the relayer before submit (evm.chain.service.ts:590). Belt-and-suspenders, coherent.
- **Barrel-bypass** in `computeBatchFees.ts`/`batchFee.ts` (direct `../../errors/...` import instead of `internal.js`) is a **ratified deviation** — the `./batch-fee` CJS subpath precedent referenced by INTL-01 in `agents/deviations.md`. Not a finding.
- SDK two-layer JSDoc `@throws` is correct for the orchestrator + both interfaces (interface = base error only; impl = `@inheritdoc` + specific subclasses). `bigint` on `computeBatchItemFee`/fee args is the ratified INTL-03 deviation. Barrel imports elsewhere (orchestrator/session/types) correctly route through `internal.js`. Method ordering (public above private, caller before callee) holds. Test/DTO/schema conventions in scope conform (`zEvmRelayBatchRequest` bounds the array; `BatchWithdrawalRelayRequestDto extends createZodDto`; controller only delegates).

---

## Findings (all Nit/Minor — judgment calls unless noted)

### CR-1 — `MAX_BATCH()` mutability mismatch: interface `view` vs impl `pure` — Minor (confirmed inconsistency)
- **Where:** `IPrivacyPoolRelay.sol:246` declares `external view`; `PrivacyPoolRelay.sol:212` implements `external pure`.
- **Issue:** The getter returns a compile-time constant. The impl is correctly `pure`; the interface says `view`. This **compiles** (an implementation may be more restrictive than the interface: `view → pure` is allowed), so it is harmless — but the two disagree.
- **Fix:** declare the interface function `external pure` to match (a constant getter is genuinely pure), or keep `view` in both. Cosmetic.

### CR-2 — Duplicated per-item validation between `relayBatch` and `_relay` — Nit (DRY)
- **Where:** `PrivacyPoolRelay.sol:162-173` (batch loop) vs `_relay` `229-240`.
- **Issue:** The batch loop re-implements the same four guards `_relay` applies — `amountOut > 0` (`ZeroWithdrawal`), `feeAmount ≤ maxRelayFee` (`FeeExceedsMax`), `feeAmount ≤ amountOut` (`FeeExceedsWithdrawal`), and the item-0 `recipient != 0` (`ZeroRecipient`). **Not calling `_relay` per item is correct** — batch deliberately aggregates into ONE `_distribute` instead of N transfers, which is the whole point of the feature, and `_distribute` *is* shared. But the validation block could be lifted into a small `_validatePayout(...)`/`_checkItem(...)` internal reused by both paths.
- **Fix:** optional — extract the shared guards. Behavior-preserving refactor, not a defect.

### CR-3 — Flipped operands in the fee-vs-withdrawal guard — Nit (readability)
- **Where:** `_relay` writes `require(_withdrawnValue >= _payout.feeAmount, …)` (`240`); `relayBatch` writes `require(_payout.feeAmount <= _amountOut, …)` (`173`).
- **Issue:** Identical semantics, operands transposed between two functions in the same contract that raise the same error. Minor readability snag.
- **Fix:** harmonize the operand order across both.

### CR-4 — Magic number "5" hard-coded in interface NatSpec prose — Nit
- **Where:** `IPrivacyPoolRelay.sol:159` "Relays a batch of withdrawals (each spending up to 5 notes)".
- **Issue:** `5` is `MAX_INPUTS` (ProofService.ts). Prose can silently drift if the circuit's input cap ever changes.
- **Fix:** reword to "up to the circuit's max inputs" or drop the literal.

### CR-5 — `receive()` sits above the `EXTERNAL FUNCTIONS` banner — Nit (pre-existing, not batch-introduced)
- **Where:** `PrivacyPoolRelay.sol:65`, between the `CONSTRUCTOR` section and the `EXTERNAL FUNCTIONS` banner (`69`).
- **Issue:** `receive()` is an external entrypoint but not under the external-functions section header. Pre-dates this feature; flagged only for completeness.
- **Fix:** move it under the banner (or leave as-is — cosmetic).

### CR-6 — `IPoolSessionBatchWithdraw` interface `@throws` documents only one of two error domains — Nit (doc completeness)
- **Where:** `IPoolSessionBatchWithdraw.ts:23,33` — both methods' interface JSDoc has `@throws {BatchWithdrawBaseError}` only. The impl `PoolSessionBatchWithdraw.prepareBatchWithdraw` additionally surfaces `RelayerRequestFailed` and `FeeCommitmentExpired`, which extend **`RelayerInteractorBaseError`**, not `BatchWithdrawBaseError` (confirmed in `errors/RelayerInteractor.ts:15,29`).
- **Issue:** Per the two-layer rule the interface should list every *base* error the method can raise (bases, not subclasses). Here a second base domain is undocumented at the interface layer. Low-confidence: this may be an accepted pattern for cross-domain session methods.
- **Fix:** add `@throws {RelayerInteractorBaseError}` to the interface JSDoc for both methods.

---

## What I ran / inspected
- Read all in-scope files + direct deps (`fee_abi.ts`, `evm.quote.service.ts` batch block, `ProofService` constant, `errors/RelayerInteractor.ts`, `agents/deviations.md`).
- `grep` traced: `MAX_BATCH` single-sourcing + on-chain cross-check; `computeBatchFees` usage (quote service dogfoods it, orchestrator uses `computeBatchItemFee`); PayoutRouting ABI sharing between single and batch; `view`/`pure` mismatch on `MAX_BATCH()`; barrel-bypass ratification (INTL-01/03).
- Did **not** run `forge build`/`pnpm test` (heavy; out of scope for a convention+coherence pass). The CR-1 mutability claim is reasoned from Solidity's override/implement rules (view-interface implemented by pure-impl compiles), not from a compile I executed — stated as such.
