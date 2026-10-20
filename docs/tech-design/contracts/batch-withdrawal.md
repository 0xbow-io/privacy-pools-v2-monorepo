# Batch Withdrawal (`relayBatch`)

> Status: **Extension** (new behavior; no circuit change). Owner: contracts + sdk + relayer.
> Source-of-truth design doc for the "withdraw entire balance in one transaction" feature.

## Version History

| Version | Date       | Author | Notes |
|---------|------------|--------|-------|
| 0.1.0   | 2026-06-30 | —      | Initial design: `relayBatch` on `PrivacyPoolRelay`, single-recipient/single-asset, whole-fee-on-one fee split. |
| 0.2.0   | 2026-06-30 | —      | Fee protocol finalized as relayer-authoritative: per-item `PayoutRouting[]` encoded + signed into the batch commitment; `allocateBatchFee` shared (SDK exports, relayer imports). |
| 0.3.0   | 2026-06-30 | —      | Audit hardening (M-1 array length caps at `MAX_BATCH` on both sides; L-1 aggregate fee ceiling `Σfee ≤ maxRelayFee×N`; L-2 relayer fail-fast on `MAX_BATCH ≥ rootHistorySize`; L-3 orchestrator routing assertions + `BatchRoutingInvalid`; I-1 EIP-712 `verifyingContract`). Session-API exposure: `PoolSessionBatchWithdraw` / `PoolSession.prepareBatchWithdraw` derive quote amounts and proofs from one deterministic selection; `MAX_BATCH` re-exported from `@privacy-pools-v2/sdk/batch-fee`. See `agents/output/audit/AUDIT_batch_withdrawal.md` → Audit response. |
| 0.4.0   | 2026-06-30 | —      | Fee model reworked from "compute a batch total then split it" to **per-item normal single-tx fees, SDK-verified**. Each item's fee = what that transact would cost as a STANDALONE withdrawal (`min(maxRelayFee, relayCost + (feeBps>0 ? amountOut·feeBps/10000 : flatFee))`), so a greedy relayer that cherry-picks the fee-bearing proof and submits it via the single `relay()` earns only the fair per-item fee. The relayer signs `relayCost`/`feeBps`/`flatFee` into the batch commitment; the SDK recomputes each routing (`computeBatchItemFee`) and rejects any mismatch (`BatchRoutingInvalid`). `allocateBatchFee` retired → `computeBatchFees`/`computeBatchItemFee`. |
| 0.5.0   | 2026-07-09 | —      | Audit **H1 / R-H3** fee-cap fix (relayer `capFee` + SDK `computeBatchItemFee`): `maxRelayFee` is a nominal cap and `0` = "no maximum" (uncapped), so it is no longer read as a literal `0` ceiling that floored the fee to `0` (free relay). A **nonzero** `maxRelayFee < relayCost` now rejects the quote (relayer `BadRequestException`, SDK `AssetNotRelayable`) instead of signing a below-cost fee. `capFee` takes `relayCost`; returned fee is always `≥ relayCost`. No contract change (`RelaySwaps`/`MockPool` already treat `0` as uncapped); the core `PrivacyPoolRelay`/`PPRouter` `0`-sentinel divergence is tracked in `issues/FINDING-core-maxrelayfee-zero-sentinel.md`. |
| 0.5.1   | 2026-09-30 | —      | Doc-only: relayer nonce handling reworded — viem's `nonceManager` was replaced by the relayer's shared explicit nonce assignment (`EVMChainService.broadcast()`); batch relays use the same path. |

---

## 1. Motivation

The `transact` circuit spends **at most 5 input notes** per proof (compile-time limit;
25 NxM variants, 1x1…5x5 — see `circuits/circuits-benchmark.md`). A user holding more
than 5 notes cannot withdraw their full balance in a single relayed transaction today;
it takes one relayer round-trip (one on-chain tx) per ≤5-note group.

**Goal:** withdraw an entire single-asset balance to a single recipient in **one EVM
transaction**, by submitting **N transact proofs** (each spending ≤5 notes) batched into
one relayer call, with **one aggregated payout** and **one aggregated relayer fee**.

This is a contracts + SDK + relayer orchestration feature. It requires **no circuit
change**: each individual transact proof independently enforces every proven invariant
(per-label value conservation, context binding, nullifier uniqueness, root membership).

## 2. Key invariant that makes batching simple — shared snapshot roots

`PoolVault.transact` validates roots as follows (`PoolVault.sol:345-347`):

```solidity
require(isKnownRoot(_proof.stateRoot()), PoolVault_UnknownStateRoot());          // any root in buffer
require($.keystore.isKnownRoot(_proof.keyRegistryRoot()), PoolVault_UnknownKeystoreRoot()); // any known
require(_proof.associationSetRoot() == $.aspRegistry.latestASPRoot(), PoolVault_InvalidASPRoot()); // latest only
```

- **State root**: must be a *known* root in the circular buffer, **not** necessarily the
  latest. The input notes of every group already exist in the tree under the pre-batch
  root, so **all N proofs are generated against the same pre-batch state-root snapshot.**
- **Keystore root**: same — any known root. Shared snapshot.
- **ASP root**: must equal the *latest*. A single snapshot taken at batch-build time works
  as long as the ASP root does not advance before the batch lands (same constraint as a
  normal single withdrawal).

Because the groups spend **disjoint** notes, there is **no inter-transact dependency**:
no intermediate-root chaining, no shared nullifiers, no shared output commitments.

### 2.1 Batch-size bound (`N < rootHistorySize`)

Each `transact` inserts its leaves and advances the root buffer by **exactly one** root
(`RootBufferUpgradeable.sol:64-92`, one `_updateRoot` per call). The pre-batch snapshot
root therefore survives until the buffer write index wraps back to its slot — after
`rootHistorySize` insertions. Deployed `rootHistorySize = 16`
(`script/registries/ChainConfigRegistry.sol`, sepolia v7–v9).

If a batch exceeds this, the later transacts revert with `PoolVault_UnknownStateRoot`
and the **whole batch reverts atomically** — no state committed, no funds at risk (the
relayer catches it in `simulateContract` before sending). To give a clean error and keep
a safety margin, `relayBatch` caps batch size at a constant `MAX_BATCH = 10`, which must
remain strictly below the pool's deployed `rootHistorySize`.

## 3. On-chain design — `relayBatch` on `PrivacyPoolRelay`

No `PoolVault` change. `transact` is `nonReentrant`, but each `POOL.transact` is a
separate external call whose guard releases on return, so a loop of calls is safe.

```solidity
function relayBatch(
  ProofLibV2.TransactProof[] calldata _proofs,
  IPoolVault.TransactParams[] calldata _transactParams,
  IPoolVault.NoteData[][] calldata _noteData
) external payable;
```

### 3.1 Semantics

1. **Shape checks**: `_proofs.length == _transactParams.length == _noteData.length`;
   `n >= 1`; `n <= MAX_BATCH`.
2. **Per-item loop** (`i = 0..n-1`), decoding `PayoutRouting` from `_transactParams[i].data`:
   - `_proofs[i].amountOut() > 0` (reject empty withdrawals).
   - Asset consistency: `_proofs[i].tokenIdOut() == asset0` (the first item's asset).
   - Recipient consistency: `recipient[i] == recipient0`.
   - Fee-recipient consistency: raw `feeRecipient[i] == feeRecipient0` (compared before the
     zero→`msg.sender` default; resolved once after the loop).
   - Fee caps: `feeAmount[i] <= maxRelayFee` (fetched once for `asset0` from
     `ENTRYPOINT.assets(asset0).maxRelayFee`) **and** `feeAmount[i] <= _proofs[i].amountOut()`.
   - Accumulate `totalAmountOut += amountOut[i]`, `totalFee += feeAmount[i]`,
     `totalNativeGas += nativeGas[i]`.
   - `POOL.transact(_proofs[i], _transactParams[i], _noteData[i])` — funds land in this
     contract per call (as in single `relay`).
3. **Gas-funding check**: `msg.value == totalNativeGas`.
4. **Single aggregate payout** (`recipientAmount = totalAmountOut - totalFee`,
   `feeRecipient = feeRecipient0 != 0 ? feeRecipient0 : msg.sender`):
   - **Native asset**: `recipient.safeTransferETH(recipientAmount + msg.value)`; if
     `totalFee != 0`, `feeRecipient.safeTransferETH(totalFee)`.
   - **ERC-20**: `asset.safeTransfer(recipient, recipientAmount)`; if `totalFee != 0`,
     `asset.safeTransfer(feeRecipient, totalFee)`; if `msg.value != 0`,
     `recipient.safeTransferETH(msg.value)`.
   This mirrors `relay`'s per-asset branch, aggregated to one transfer pair.
5. **Event**: `RelayedBatch(asset, recipient, recipientAmount, feeRecipient, totalFee,
   gasFunding, count)`.

### 3.2 Atomicity & griefing

The batch is one EVM transaction: if any `transact` reverts (spent nullifier, stale ASP
root, capacity, bad proof), the **entire batch reverts**. There is no partial execution and
no trapped dust — the aggregate payout sends exactly `totalAmountOut` back out (recipient +
fee), leaving the relay contract's asset balance unchanged by the batch.

### 3.3 New errors / event (interface `IPrivacyPoolRelay`)

- `error PrivacyPoolRelay_BatchLengthMismatch();`  — array lengths differ.
- `error PrivacyPoolRelay_EmptyBatch();`           — `n == 0`.
- `error PrivacyPoolRelay_BatchTooLarge();`        — `n > MAX_BATCH`.
- `error PrivacyPoolRelay_InconsistentRecipient();`— recipient or feeRecipient differs across items.
- `error PrivacyPoolRelay_InconsistentAsset();`    — `tokenIdOut` differs across items.
- Reused: `PrivacyPoolRelay_ZeroWithdrawal`, `_ZeroRecipient`, `_FeeExceedsMax`,
  `_FeeExceedsWithdrawal`, `_NativeGasMismatch`. Constructor guards: `_RootHistoryTooSmall`,
  `_ZeroEntrypoint`; `receive()` guard `_OnlyPoolCanSendETH`.
- `event RelayedBatch(address indexed _asset, address indexed _recipient,
  uint256 _recipientAmount, address indexed _feeRecipient, uint256 _fee,
  uint256 _gasFunding, uint256 _count);`

A single-item batch (`n == 1`) is behaviorally equivalent to `relay` (modulo the
`RelayedBatch` vs `Relayed` event) — used as a regression guard.

## 4. Fee model — per-item normal single-tx fees, SDK-verified

### 4.1 Why not "one batch total, then split it"

A batch proof is **independently submittable** via the single `relay()`: `transact`'s
`processor == msg.sender` invariant holds for a single relay just as it does for `relayBatch`,
because both are `PrivacyPoolRelay`. So nothing forces a relayer to submit the whole batch —
it may cherry-pick and submit just one item's proof through `relay()` and pocket whatever fee
that item carries. Under the old model (compute one `totalFee`, then concentrate it — whole
fee on one item, greedy-spread otherwise) a greedy relayer would load the entire batch fee
onto a single proof and earn it for one transaction.

**Fix:** each item's fee is what that transact would cost **as a standalone withdrawal**, so
cherry-picking any one proof earns only the fair per-item fee. And the SDK **recomputes and
verifies** the split (from signed parameters) so a greedy relayer cannot re-concentrate it.

### 4.2 The per-item fee formula

Identical to the relayer's single-withdraw math
(`packages/relayer/.../quote/evm/fee.calculations.ts`), applied to each item:

```
fee_i = min(maxRelayFee, relayCost + (feeBps > 0 ? amountOut_i · feeBps / 10000 : flatFee))
totalFee = Σ fee_i
```

- `relayCost` — the **single-tx** relay gas cost converted to token units
  (`relayPriceInToken`), **not** batch gas. Same for every item.
- `feeBps` XOR `flatFee` — a bps asset sets `feeBps > 0` (variable fee proportional to each
  item's `amountOut`, `flatFee` unused); a flat asset sets `feeBps = 0` and charges `flatFee`
  **per item** (so an N-item batch pays N flat fees). Both use the same `applyBPS` floor and
  `capFee` min as a single withdrawal.
- `maxRelayFee` cap semantics (`capFee` / `computeBatchItemFee`) — `maxRelayFee` is a **nominal**
  ceiling in token base units, and `0` is the **"no maximum" sentinel** (uncapped), not a literal
  zero cap; `min(maxRelayFee, …)` therefore short-circuits to `relayCost + variable/flat` when
  `maxRelayFee == 0` (never flooring the fee to `0`). A **nonzero** `maxRelayFee < relayCost`
  cannot cover cost, so the item is **not relayable** — the relayer rejects the quote
  (`BadRequestException`) and the SDK throws `AssetNotRelayable`, rather than signing a
  below-cost fee. Post-guard the returned fee is always `≥ relayCost`.

### 4.3 Protocol

1. The SDK sends the per-item withdrawn `amounts[]` (in batch order) + `recipient` to
   `POST /quote/.../batch`.
2. The relayer computes `relayCost` (single-tx), `feeBps` and `flatFee` from asset config,
   then the per-item `fee_i` via **`computeBatchFees`** — a pure SDK function the relayer
   imports (dogfooded, single source of truth). It builds one
   `PayoutRouting{recipient, feeRecipient, feeAmount = fee_i, nativeGas}` per item, ABI-encodes
   the **array** into the commitment `data`, and signs an EIP-712
   `RelayBatchWithdrawalCommitment{data, asset, expiration, totalAmountSent,
   totalAmountReceived, relayCost, feeBps, flatFee}` — the signed fee-model parameters bind
   the split the relayer promised.
3. The SDK decodes `commitment.data → PayoutRouting[]` and, for each item, **recomputes**
   `expected = computeBatchItemFee({relayCost, feeBps, flatFee, amountOut, maxRelayFee})` from
   the signed parameters and asserts `routing.feeAmount == expected` and
   `routing.recipient == recipient` — else `BatchRoutingInvalid`. This is what stops a greedy
   relayer concentrating the fee (a re-concentrated routing no longer matches the recompute).
   It then builds each proof binding
   `transactParams[i] = {processor: relay, data: abi.encode(PayoutRouting[i])}`.
4. At relay time the SDK sends `{items:[{proof, noteData, counts}], signedBatchFeeCommitment}`.
   The relayer verifies the commitment, decodes the same `PayoutRouting[]`, rebuilds the
   identical `transactParams[]`, revalidates each `feeAmount ≤ maxRelayFee` and `≤ amountOut`
   and `Σ feeAmount == totalFee`, and submits `relayBatch`. (The relay path does not recompute
   the fee model — it re-derives and revalidates the per-item caps the contract enforces.)

**`computeBatchItemFee` / `computeBatchFees`** — pure; inputs `relayCost`, `feeBps`, `flatFee`,
per-item `amountOut`, `maxRelayFee`. Post-condition: each `fee_i ≤ maxRelayFee` (the `capFee`
min) and `fee_i ≤ amountOut_i` (else `InfeasibleBatchFee` — the item cannot cover its own fee),
exactly the per-item caps `relayBatch` enforces. Determinism guarantees the relayer (at quote)
and the SDK (at prepare) derive identical routings.

## 5. SDK & relayer surface (summary)

- **SDK**: `selectNotesForFullWithdraw` (partition all ACTIVE notes of an asset into
  single-label ≤5-note groups), `computeBatchFees` / `computeBatchItemFee` (pure; also imported
  by the relayer; per-item normal single-tx fee),
  `BatchWithdrawOrchestrator.prepareBatchWithdraw` (build N proofs against the shared
  snapshot, recomputing + verifying each item's fee against the signed fee model before binding
  the relayer's committed `PayoutRouting`; stage note updates for `persistBatchNoteUpdates`
  after confirm), and `RelayerInteractor.getBatchWithdrawalQuote` / `relayBatchWithdrawal`.
- **Relayer**: `POST /quote/:chainType/:chainId/batch` (per-item normal single-tx fee via
  `computeBatchFees`, per-item `PayoutRouting[]` encoded + `relayCost`/`feeBps`/`flatFee` signed
  into one `RelayBatchWithdrawalCommitment`), `POST /relay/:chainType/:chainId/batch` (verify the
  commitment, rebuild `transactParams[]`, revalidate caps + aggregate, then `relayBatch`).
  One on-chain tx; nonce handling is the relayer's shared explicit assignment (same `broadcast()` path as every other write).

## 6. Constraints respected

- Per-label value conservation: unchanged — each proof enforces it independently.
- Context binding & malleability protection: unchanged — each proof binds its own
  `(processor, data, noteData)`; `processor` must equal `msg.sender` (the relay contract).
- Nullifier / commitment uniqueness: groups are disjoint; no collisions within a batch.
- The 5-input limit is **not** bypassed — batching composes multiple ≤5-input proofs.
