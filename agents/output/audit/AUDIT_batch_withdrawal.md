# Security Audit — Batch Withdrawal Feature

> ⚠️ **Point-in-time snapshot (partly superseded).** Predates the per-item fee rework (v0.4.0):
> the "whole-fee-on-one" split and `allocateBatchFee` referenced here are **retired** — the
> current model is per-item normal-tx fees, SDK-verified. See
> [`tech-design/contracts/batch-withdrawal.md`](../../../docs/tech-design/contracts/batch-withdrawal.md) §4 (source
> of truth) and [`AUDIT_batch_full.md`](AUDIT_batch_full.md) (latest). Findings/fixes below remain
> accurate as of their date.

**Scope:** `relayBatch` (contract) + relayer `/quote|/relay .../batch` paths + SDK batch orchestrator/fee-split.
**Commit:** `aea37eda664da4d474592a7113188064bb829b10` (branch `feat/batch-transactions`)
**Method:** Read-only trace of the batch path against the audited single-item `relay` baseline and the pool's proof-context binding. No code modified.

---

## Executive summary

The batch feature is soundly constructed. The core protection — the pool binds
`keccak256(abi.encode(_transactParams, _noteData))` into every proof's `context`
public signal (`PoolVault.sol:146-149`) — means **the relayer cannot alter
recipient, feeRecipient, feeAmount, nativeGas, or asset of any item without
causing an on-chain `PoolVault_ProofContextMismatch` revert.** The relayer
rebuilds each item's `TransactParams` from *its own signed routings*, never from
client-supplied params, and the contract enforces every per-item cap that the
single-item `relay` enforces. I found **no Critical/High** issue: no fund-loss,
no fee-theft, and no reentrancy path.

The findings below are **one Medium (relayer availability / DoS)** plus several
Low/Informational items (config coupling, aggregate-cap semantics, integration
ordering contract). I did not manufacture a high-severity finding where the code
does not support one.

Confirmed-safe invariants (traced, not assumed):

- **No trapped funds / no dust.** `_recipientAmount = _totalAmountOut − _totalFee`
  with per-item `feeAmount ≤ amountOut` enforced (`PrivacyPoolRelay.sol:127`), so
  the subtraction cannot underflow and there is no division anywhere. The pool
  transfers exactly `Σ amountOut` to the relay; `_distribute` pays out exactly
  `_recipientAmount + _totalFee (+ msg.value)`. The "relay holds no funds" invariant
  holds for both native and ERC-20 branches.
- **msg.value accounting.** `require(msg.value == _totalNativeGas)`
  (`PrivacyPoolRelay.sol:136`) with `_totalNativeGas = Σ nativeGas`. Native branch
  forwards `msg.value` into the recipient transfer; ERC-20 branch forwards it as ETH.
  Balanced.
- **Per-item caps, not just aggregate.** Every item (including item 0, which is
  visited in the loop at `_i = 0`) is checked `feeAmount ≤ maxRelayFee` and
  `feeAmount ≤ amountOut` (`PrivacyPoolRelay.sol:126-127`). `maxRelayFee` cannot be
  bypassed by a crafted split.
- **Consistency for all items.** Same asset (`:119`) and same recipient+feeRecipient
  (`:122-125`) enforced against `_proofs[0]`/`_ref` for every item. Mismatch reverts.
- **Root buffer bound is correct.** A batch of N pushes exactly N roots
  (`PoolVault.sol:179`, one `_updateRoot` per transact). Every item proves against
  the pre-batch snapshot `R0`; `isKnownRoot` scans `rootHistorySize` entries
  (`RootBufferUpgradeable`), so `R0` survives iff `N ≤ rootHistorySize`.
  `MAX_BATCH = 10` with a deployed history of 16 leaves comfortable margin; at
  `N > rootHistorySize` the effect is a clean `PoolVault_UnknownStateRoot` revert
  (no fund risk).
- **Reentrancy.** `_distribute` runs only after the loop; the relay holds no
  persistent storage; `POOL.transact` is `nonReentrant` with nullifier/commitment
  double-spend guards. A recipient reentering `relayBatch` starts an independent
  batch with fresh `msg.value` and fresh valid proofs — no cross-item/cross-call
  state to corrupt. Matches the single-item baseline.
- **Duplicate proof / empty / length-mismatch.** Empty rejected
  (`:103`), length mismatch rejected (`:105`), duplicate proof in a batch reverts
  via `PoolVault_NullifierAlreadySpent` (atomic revert).
- **Relayer fee protection.** `Σ feeAmount == committed totalFee` enforced
  (`evm.relay.service.ts:188`); the EIP-712 signature is verified over
  `totalAmountSent`/`totalAmountReceived` recomputed from the proofs
  (`:194-208`), so tampering with any item's `amountOut` breaks verification.
  `data` (the `PayoutRouting[]`) is inside the signed struct, so a tampered `data`
  fails signature verification.

---

## Findings

### M-1 (Medium) — Unbounded batch array + signature checked after O(N) work → relayer DoS

**Files:**
- `packages/relayer/relayer/src/relay/evm/schemas.ts:162` — `items: z.array(zEvmRelayBatchItem).min(1)` (no `.max`)
- `packages/relayer/relayer/src/quote/evm/evm.schemas.ts:25` — `amounts: z.array(...).min(1)` (no `.max`)
- `packages/sdk/src/schemas/RelayerInteractor.ts:91` — `amounts: z.array(z.string())` (no `.min`/`.max`)
- `packages/relayer/relayer/src/relay/evm/evm.relay.service.ts:115-208` — full O(N) loop runs *before* signature verification at `:199`

**Impact.** The `POST /relay/:chain/batch` endpoint accepts an arbitrarily long
`items` array (and a matching-length attacker-supplied `commitment.data`). The
service `decodeBatchFeeSplit`s the attacker bytes and runs the entire per-item
validation loop — ABI decode/encode, `getAddressFromBigInt`, array builds — for
all N items, and only *afterwards* verifies the relayer signature (`:199`). An
**unauthenticated** attacker can therefore force O(N) CPU/allocation and a giant
`eth_call` simulate payload with N unbounded, before the request is rejected for a
bad signature. This is an availability/resource-exhaustion vector, not a fund
issue.

Secondarily, `quoteBatch` has no cap either, so the relayer will happily *sign* a
batch commitment for `> MAX_BATCH` items that can never execute on-chain
(`PrivacyPoolRelay_BatchTooLarge`) — a self-inflicted broken-quote.

**Confidence:** High (the missing caps and the post-loop signature check are both
directly in the read code).

**Fix.** Add `.max(MAX_BATCH)` to `zEvmRelayBatchRequest.items`,
`zEvmBatchQuoteRequest.amounts`, and `BatchWithdrawalQuoteParamsSchema.amounts`
(import the shared `MAX_BATCH`). Cheapest and most robust. Additionally, move the
`verifyRelayBatchWithdrawalCommitment` call (or at least a length/`routings.length`
sanity gate) *before* the per-item loop so unauthenticated requests are rejected
before expensive work.

---

### L-1 (Low) — Aggregate fee cap is `MAX_BATCH × maxRelayFee`, not `maxRelayFee`

**File:** `packages/contracts/src/contracts/PrivacyPoolRelay.sol:126-130`

The contract caps each item at `maxRelayFee` but does not bound the *sum*. A batch
can therefore charge up to `MAX_BATCH × maxRelayFee` (10× the per-withdrawal cap) in
total. The user does bind each `feeAmount` into its proof (informed consent), and
the split originates from the relayer's signed quote, so this is not theft — but a
user/integrator who treats `maxRelayFee` as an absolute per-operation ceiling can be
overcharged by up to 10×. No client-side assertion of `quote.totalFee ≤ userMax` was
found in the SDK path.

**Confidence:** High that the semantics are as described; Low severity (design
choice, requires user to accept the quote).

**Fix.** Document the aggregate-cap semantics explicitly, and add a client-side
`totalFee` ceiling check in `BatchWithdrawOrchestrator`/caller (compare
`Σ routing.feeAmount` against a user-supplied max before generating proofs).

---

### L-2 (Low) — Relay hardcodes `MAX_BATCH = 10` without reading the pool's `rootHistorySize`

**File:** `packages/contracts/src/contracts/PrivacyPoolRelay.sol:36`

`_MAX_BATCH` is a compile-time constant whose safety depends on the deployed pool's
`rootHistorySize` (must be `≥ MAX_BATCH`). The relay never reads
`POOL.rootHistorySize()`, so if the relay is ever pointed at (or the pool upgraded
to) a history smaller than 10, near-max batches revert with
`PoolVault_UnknownStateRoot`. Revert-only, no fund risk, but a latent deploy-time
coupling that isn't machine-checked.

**Fix.** Either assert `_MAX_BATCH < POOL.rootHistorySize()` in the constructor, or
add a deployment invariant test that fails if the pool history ever drops at/below
`MAX_BATCH`.

---

### L-3 (Low) — Cross-side item ordering is an unenforced integration contract

**Files:** `packages/sdk/src/services/poolSessions/allocateBatchFee.ts:33-68`,
`BatchWithdrawOrchestrator.ts:78-137`, `selectNotesForFullWithdraw.ts:38-68`

`allocateBatchFee` returns the split in `amounts[]` input order; the orchestrator
pairs `routings[i]` with `groups[i]` from `selectNotesForFullWithdraw`. Correctness
therefore requires the caller to pass `quoteBatch.amounts` in *exactly* the
`selectNotesForFullWithdraw` order (sorted label, then sorted commitment). There is
no single SDK method that derives both from one source, so a caller that computes
quote `amounts` in a different order gets `feeAmount` sized for `amounts[i]` applied
to a different `group[i]`. Worst case is a **guaranteed on-chain revert**
(`feeAmount > amountOut` or a context mismatch) — not fund loss, because the
per-item caps and proof-context binding catch it — but it is a silent broken-feature
seam.

**Fix.** Provide one SDK helper that runs `selectNotesForFullWithdraw` once and
feeds both the quote-`amounts` and `prepareBatchWithdraw`, guaranteeing identical
ordering, or assert the pairing (e.g. `routing.feeAmount ≤ group.amountOut`) inside
`prepareBatchWithdraw` with a descriptive error instead of relying on the on-chain
revert.

---

### I-1 (Informational) — EIP-712 domain omits `verifyingContract`

**File:** `packages/relayer/relayer/src/chain.service/evm.chain.service.ts:47-52`

The `RelayBatchWithdrawalCommitment` domain is `{name, version, chainId}` with no
`verifyingContract`. `chainId` prevents cross-chain replay and the commitment is the
relayer's own self-signature (verified by the same relayer), so this is not
exploitable in the current single-relayer/single-relay-contract deployment. It is
noted only because two relayer deployments sharing a signer key on the same chain
would produce interchangeable commitments. This matches the pre-existing single-item
`RelayWithdrawalCommitment` behavior (baseline), not a batch regression. The
relay-contract binding is instead enforced through the proof `context` (processor is
bound), so a mis-targeted commitment still cannot execute.

---

### I-2 (Informational) — Simulate/write TOCTOU is amplified for batches

**File:** `packages/relayer/relayer/src/chain.service/evm.chain.service.ts:417-444`

`simulateAndWriteRelayBatch` simulates then writes (same pattern as the single-item
path), which protects the relayer from paying gas on a batch that fails at simulate
time. However, if state changes between simulate and write (most realistically an ASP
root update, which invalidates *all* items via `PoolVault_InvalidASPRoot`), the whole
batch reverts on-chain and the relayer eats the gas of the larger reverted tx. This
is inherent to relaying and identical in kind to the single-item path, just larger in
magnitude. No fix required; monitor ASP-root update cadence.

---

## Conclusion

The batch path preserves every invariant the audited single-item `relay` holds, and
the proof-context binding closes the fee-theft / misrouting attack surface. The only
material issue is **M-1** (add array length caps + verify signature before the loop),
which is an availability hardening, not a fund-safety bug. L-1..L-3 are worth
addressing for defense-in-depth and integration robustness. No Critical/High finding
is warranted by the code as written.

---

## Audit response

Applied against the batch feature after the audit. Each finding is marked
**Resolved** or **Accepted**, with the exact change and any part deliberately not
implemented (Directive 0: honest about scope).

### M-1 — Unbounded batch array — **Resolved (length caps); signature reorder not done**

Array length caps of `MAX_BATCH` were added at every entry the audit named, so the
per-item O(N) work is now bounded to `N ≤ MAX_BATCH` on both sides:

- SDK: `BatchWithdrawalQuoteParamsSchema.amounts` and `BatchWithdrawalRelayParamsSchema.items`
  now carry `.max(MAX_BATCH)` (`packages/sdk/src/schemas/RelayerInteractor.ts`).
- Relayer: `zEvmRelayBatchRequest.items` (`src/relay/evm/schemas.ts`) and
  `zEvmBatchQuoteRequest.amounts` (`src/quote/evm/evm.schemas.ts`) now carry
  `.max(MAX_BATCH)`, importing the shared `MAX_BATCH` from `@privacy-pools-v2/sdk/batch-fee`.

`MAX_BATCH` is exported from the dependency-light `@privacy-pools-v2/sdk/batch-fee`
subpath (alongside `allocateBatchFee`) so the CommonJS relayer imports the same
constant it already dogfoods for the fee split — single source of truth.

Not implemented: moving `verifyRelayBatchWithdrawalCommitment` *before* the per-item
loop. The length cap already bounds the pre-signature work to `MAX_BATCH` items, which
is the primary mitigation; reordering the signature check remains an available
follow-up if the residual `O(MAX_BATCH)` cost is ever a concern.

### L-1 — Aggregate fee cap — **Resolved (relayer aggregate bound)**

`EvmRelayService.batchWithdrawal` now asserts the explicit whole-batch ceiling
`Σ feeAmount ≤ maxRelayFee × items.length` after summing the per-item fees, rejecting
with a 400 otherwise (`src/relay/evm/evm.relay.service.ts`). The pre-existing per-item
`feeAmount ≤ maxRelayFee` and `≤ amountOut` checks are unchanged. The audit's optional
SDK-side `quote.totalFee ≤ userMax` check was not added; the aggregate ceiling is
enforced authoritatively at the relayer instead.

### L-2 — `MAX_BATCH` vs `rootHistorySize` coupling — **Resolved (fail-fast, cached)**

The relayer now reads `POOL.rootHistorySize()` and rejects the batch path if
`MAX_BATCH ≥ rootHistorySize` (`EVMChainService.assertBatchFitsRootHistory`, called
from `simulateAndWriteRelayBatch`). The read is cached module-level (per pool address)
so it hits chain state at most once per process. A `rootHistorySize()` view fragment
was added to the relayer's pool ABI (`src/sdk/pool_vault.abi.ts`).

### L-3 — Cross-side item ordering — **Resolved (assertion + single-source session API)**

Two changes:

1. `BatchWithdrawOrchestrator.prepareBatchWithdraw` now asserts, per item, that
   `routing.recipient === recipientAddress` and `routing.feeAmount ≤ group.amountOut`,
   throwing the new `BatchRoutingInvalid` error instead of letting a misordered/mismatched
   routing surface as an opaque on-chain `PoolVault_ProofContextMismatch` / fee-cap revert.
2. A new session-level `PoolSessionBatchWithdraw.prepareBatchWithdraw` derives the quote
   `amounts` and the orchestrator's proof build from the **same** deterministic
   `selectNotesForFullWithdraw` selection, so a caller can no longer supply
   differently-ordered amounts. It is reachable via `PoolSession.prepareBatchWithdraw`,
   mirroring `prepareWithdraw`.

### I-1 — EIP-712 domain omits `verifyingContract` — **Resolved**

The relayer's commitment `domain(...)` now includes `verifyingContract` set to the relay
contract address (`src/chain.service/evm.chain.service.ts`), binding every commitment to
the specific relay deployment. Sign and verify use the same domain, and the SDK never
verifies these signatures, so the single-withdrawal commitment sign/verify still
round-trips (its spec test passes).

### I-2 — Simulate/write TOCTOU amplified for batches — **Accepted (inherent)**

No code change. As the audit notes, this is inherent to relaying and identical in kind
to the single-item path (an ASP-root update between simulate and write reverts the whole
batch and the relayer eats the reverted-tx gas). It is a monitoring concern (ASP-root
update cadence), not a correctness or fund-safety bug.
