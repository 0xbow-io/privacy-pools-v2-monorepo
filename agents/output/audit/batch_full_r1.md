# Security Audit — Batch Withdrawal (#316) — `relayBatch`

- **Commit:** `c0183e21` (`c0183e212a91f4c9507d4d3b0e273b9d423555a6`), branch `v2.0-features`
- **Scope:** `PrivacyPoolRelay.relayBatch` + interface; SDK `BatchWithdrawOrchestrator` / `PoolSessionBatchWithdraw` / `computeBatchFees` / `selectNotesForFullWithdraw` / `constant/BatchWithdraw` / `errors/BatchWithdraw` / `batchFee`; relayer `evm.relay.service.batchWithdrawal` / `evm.chain.service.simulateAndWriteRelayBatch` / batch schema / `relay.controller @Post("batch")`.
- **Direct deps traced:** `PoolVault.transact` (context binding, nullifier marking, root validation, asset transfer), `RootBufferUpgradeable` (ring-buffer eviction / `isKnownRoot`), `ProofLibV2` (pubsignal accessors), `_relay`/`_distribute` (single-relay comparison), EIP-712 `RelayBatchWithdrawalCommitment`.
- **What I ran:** `forge test --match-contract PrivacyPoolRelayBatch` → **18 passed / 0 failed**. Manual code-path tracing for every threat-model item below; no separate PoC needed (existing suite already exercises each branch).

## Verdict

**Worst severity found: LOW.** No Critical/High/Medium. I could not construct any fund-loss, double-spend, fee-theft, fund-misrouting, or fund-lock exploit. The feature is soundly constructed with layered defenses: per-item proof-context binding of the full `PayoutRouting`, complete (all-items) homogeneity checks, a conservative root-buffer coupling, exact value conservation in the aggregate distribution, and independent client-side + relayer-side fee-fairness recomputation. Findings are one Low (upgrade-time liveness invariant) and four Info/defense-in-depth notes.

## Findings table

| ID | Severity | Title | Location |
|----|----------|-------|----------|
| B-1 | Low | Root-history coupling validated only at relay-contract construction; pool is UUPS-upgradeable | `PrivacyPoolRelay.sol:55-58` |
| B-2 | Info | On-chain `relayBatch` permits fee concentration on one item; fairness is client-side only | `PrivacyPoolRelay.sol:161-180` |
| B-3 | Info | Batch atomicity amplifies revert-griefing (1 bad item kills 10) | `PrivacyPoolRelay.sol:161-180` |
| B-4 | Info | Fee model charges each item the full standalone `relayCost` | `computeBatchFees.ts:40-54` |
| B-5 | Info | Reentrancy surface (ERC-20 transfer hook into the loop) — safe, documented | `PrivacyPoolRelay.sol:161-194` |

## Threat-model results (each explicitly resolved)

### 1. Shared-root snapshot soundness — SAFE
- Each `POOL.transact` validates its proof `stateRoot` via `isKnownRoot` (`PoolVault.sol:354`), marks nullifiers spent **immediately** (`PoolVault.sol:172-173`), and inserts commitments/nullifier leaves then `_updateRoot` (`PoolVault.sol:178-179`).
- **Intra-batch double-spend is impossible.** If two items spend the same nullifier, the second item's `require(!_nullifierSpent(...))` reverts; the batch is atomic, so the whole call reverts. No partial state.
- **Intra-batch note-creation dependency is impossible.** Item[k>0]'s proof anchors to a root already in the buffer at its execution point (the SDK anchors every item to the shared pre-batch snapshot R0). A commitment created by item[j<k] lives only in a *post-R0* tree, which item[k]'s R0-anchored proof cannot reference. Chaining to a fresher root is permitted by the primitive but does not enable double-spend (nullifiers are globally enforced) and the SDK never does it.
- **Off-by-one: none.** Ring buffer of `rootHistorySize` slots; `_updateRoot` overwrites oldest-first, so R0 (the newest pre-batch root) is evicted only after a full `rootHistorySize` wrap. The last item executes after at most `_MAX_BATCH − 1 = 9` inserts. With `10 < 16` (constructor `require`, `PrivacyPoolRelay.sol:58`), R0 survives with a wide margin (it would survive even at `rootHistorySize = 11`). The strict `<` is exactly the right, slightly conservative, bound. Confirmed sound.

### 2. Fee aggregation — SAFE (no under/over-pay, no rounding leak)
- Per item: `feeAmount <= maxRelayFee` (`:172`) and `feeAmount <= amountOut` (`:173`), so `_totalFee = Σfee ≤ Σamount = _totalAmountOut` → `_recipientAmount = _totalAmountOut − _totalFee` cannot underflow.
- **Exact conservation.** The pool transfers each item's `amountOut` to the relay contract (`PoolVault.sol:182-186`), so the relay holds exactly `_totalAmountOut` of the asset; it then distributes `_recipientAmount + _totalFee = _totalAmountOut`. No dust, no stuck residue. For the native path, ETH in (`_totalAmountOut` from pool + `msg.value`) equals ETH out (`recipientAmount + gasFunding + fee`), since `require(msg.value == _totalNativeGas)` (`:182`).
- **Each item's fee binds to its own proof context.** `context = keccak256(abi.encode(_transactParams, _noteData)) % FIELD` (`PoolVault.sol:147`) and `_transactParams.data` is the ABI-encoded `PayoutRouting` (recipient, feeRecipient, feeAmount, nativeGas). The relay re-decodes the *same* calldata it forwards to `transact`, so the fee the relay accounts is the fee the user proved. Any tamper → `PoolVault_ProofContextMismatch` revert (caught in relayer simulation).
- Aggregate is naturally bounded by `maxRelayFee × count` via the per-item cap; the relayer adds a redundant explicit aggregate cap (`evm.relay.service.ts:298`).

### 3. Homogeneity enforcement — SAFE (complete, no smuggling)
- The loop checks **every** item: `tokenIdOut == _asset` (`:164`) and `recipient == _ref.recipient && feeRecipient == _ref.feeRecipient` (`:168-171`) — not just item[0]. Item 0 reuses the already-decoded `_ref` (`:167`), which is the exact same calldata, so it is effectively checked against itself (trivially consistent) and against every other item.
- **No recipient/asset smuggling.** Funds are pooled and paid **once** to `_ref.recipient`; the per-item `PayoutRouting.recipient` is used only for the equality gate (and is bound in that item's proof context). `_asset` derives from the authentic, Groth16-verified `tokenIdOut` pubsignal. Item[k] cannot route funds elsewhere.

### 4. Context binding / standalone replay / reordering — SAFE
- The per-item context binds `PayoutRouting` **and** `processor`; `transact` also enforces `processor == msg.sender` (`PoolVault.sol:143`), pinning each proof to *this* relay contract.
- **Batch position / aggregate fee are deliberately NOT bound — and need not be.** Each item is independently valid and priced at its fair single-tx fee (`computeBatchItemFee` mirrors the single-`relay` math). Extracting one item and submitting it via `relay()` just executes that withdrawal at its own fair fee (no re-concentration gain — the SEC-3 escape-hatch is closed by construction). Replay is impossible (nullifiers spend on first inclusion). Reordering is a no-op (sum is order-independent, shared root, shared recipient).

### 5. Atomicity / griefing / front-running — SAFE (see B-3)
- Whole-batch revert on any bad item grieves the relayer, not users. The relayer simulates before writing (`evm.chain.service.ts:556-564`), so a reverting batch costs no on-chain gas; a poisoned item is rejected as `BadRequestException`.
- External nullifier front-running requires the note secret (only the owner can produce a spending proof), so a third party cannot pre-spend a batched nullifier. Residual: a user's *own* nullifier used concurrently elsewhere reverts the batch on-chain if not privately submitted — the standard, documented predicted-state/private-orderflow caveat, amplified 10× by batching. Recorded as B-3.

### 6. Access control — SAFE
- `relayBatch` is permissionless like `relay` (no role, `external payable`). `POOL.transact` carries `whenNotPaused` + `nonReentrant`, so pool pause halts batches. No new privileged surface. `receive()` still restricts ETH senders to the pool (`:65-67`).

---

## Per-finding detail

### B-1 (Low) — Root-history coupling checked only at construction; pool is upgradeable
**Location:** `PrivacyPoolRelay.sol:55-58` (`require(_MAX_BATCH < _pool.rootHistorySize(), ...)`).

**Scenario.** The `_MAX_BATCH < rootHistorySize` invariant is enforced **once**, at relay-contract deploy, reading the pool's value at that instant. `PoolVault` is UUPS-upgradeable (`_authorizeUpgrade`, `PoolVault.sol:410`) and `rootHistorySize` has no setter but lives in upgradeable ERC-7201 storage. A future pool upgrade that shrinks the root buffer below `_MAX_BATCH + 1` would silently break the snapshot-survival guarantee; near-max batches would then revert `PoolVault_UnknownStateRoot` when an early item's R0 is evicted before the last item runs.

**Impact.** Liveness only — a stale invariant causes reverts, never fund loss or double-spend. Additionally mitigated because the relayer re-reads the *live* `rootHistorySize` per pool and refuses the batch path (`assertBatchFitsRootHistory`, `evm.chain.service.ts:547,572-`). So the exploitable window requires a direct (non-relayer) caller against a downgraded pool, yielding only a revert.

**Fix (optional, defense-in-depth).** Either (a) re-read `POOL.rootHistorySize()` inside `relayBatch` and `require(_count < it)` at runtime (one extra SLOAD-via-call, cheap), or (b) document the "pool upgrades must not reduce `rootHistorySize` below `MAX_BATCH + 1`" invariant in the pool upgrade checklist. Given it is liveness-only and already relayer-guarded, this is discretionary.

### B-2 (Info) — On-chain `relayBatch` permits fee concentration; fairness is client-side
**Location:** `PrivacyPoolRelay.sol:161-180`; test `test_RelayBatch_WhenAssetIsNativeWhenFeeIsLoadedOnASingleItem` (passing) demonstrates it on-chain.

**Detail.** The contract enforces only `feeAmount <= maxRelayFee` and `feeAmount <= amountOut` per item — it does **not** require each item's fee to equal a fair per-item split. Fee fairness is enforced entirely off-chain: the SDK recomputes `expectedFee` from the *signed* fee model and asserts `routing.feeAmount === expectedFee` (`BatchWithdrawOrchestrator.ts:145-157`), and the relayer independently rechecks caps + aggregate (`evm.relay.service.ts:259-303`). This is safe for the intended flow because each item's fee is bound in the *user's own* proof context and capped on-chain by the real `maxRelayFee`; the user consents per item and reviews `quote.totalFee`. **Residual note:** a future/third-party client that builds proofs *without* the SDK's recompute-and-verify step could be induced to sign an unfair concentration (bounded by `maxRelayFee × count`). No fix required for this codebase; flagged so the client-side check is understood as load-bearing, not cosmetic.

### B-3 (Info) — Atomicity amplifies revert-griefing
**Location:** `PrivacyPoolRelay.sol:161-180` (atomic loop).

**Detail.** One un-includable item (e.g., a nullifier concurrently spent by the owner elsewhere, or a stale root under a shrunk buffer) reverts all 10. Mitigated by relayer simulate-before-write (no gas cost on rejection) and by nullifier secrecy (external actors cannot pre-spend). The only on-chain-gas loss requires the relayer to submit publicly and a batched note to be concurrently spent by its own owner. Mitigation is submission-layer (private orderflow / bundle simulation), matching the documented predicted-state guidance in the audit rubric. No code change; inherent to atomic batching.

### B-4 (Info) — Fee model charges full standalone `relayCost` per item
**Location:** `computeBatchFees.ts:40-54`.

**Detail.** Each item's fee includes the full single-tx `relayCost`, so a 10-item batch charges the user ~10× gas-cost in fees while the relayer pays ~1 tx of gas. This is the intended economic design (relayer batching incentive + anti-re-concentration parity with `relay()`), not a defect — a batch costs the user the same total as 10 separate relays. Documented for completeness; the user reviews `quote.totalFee` before proving.

### B-5 (Info) — Reentrancy surface is closed
**Location:** `PrivacyPoolRelay.sol:161-194`, `_distribute` (`:275-297`).

**Detail.** All value-moving external calls (`_distribute`) run **after** the transact loop (CEI). During the loop the only external calls are `POOL.transact`, which is `nonReentrant`; an ERC-777-style token hook firing inside `transact`'s `_transferAsset` that reentered `relayBatch` would hit the still-engaged pool guard on its inner `transact` and revert the whole call. Assets are also entrypoint-whitelisted. Native transfers into the relay go through `receive()`, which rejects non-pool senders. No exploitable reentrancy. No change needed.

## Notes / out of scope
- The batch **quote** path (`quoteBatch`, signing gated on `commit === true`) is outside the audited file set but the seed hotspot "always-signs DoS" is addressed at the batch **relay** schema layer: `items` is bounded `.min(1).max(MAX_BATCH)` (`schemas.ts:235`), so an unauthenticated relay request cannot force unbounded O(N) work before signature verification.
- EIP-712 `RelayBatchWithdrawalCommitment` does not carry `totalAmountSent/Received` on the wire; the relayer recomputes them from the submitted proofs and verifies the signature against the recomputation (`evm.chain.service.ts:239-273`), so tampering with any item's `amountOut` breaks verification. Correct.
