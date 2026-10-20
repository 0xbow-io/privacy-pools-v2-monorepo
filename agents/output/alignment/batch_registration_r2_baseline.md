# Alignment Re-Baseline — Batch (#316) + Relayed-Registration (#310)

> NOTE: This content is the intended deliverable for
> `agents/output/alignment/batch_registration_r2_baseline.md`. It was written here
> because plan mode restricted writes to the plan file only. Copy verbatim on approval.

**Repo/commit:** `/Users/nh2/0xbow/v2-monorepo-audit`, branch `v2.0-features`, `git rev-parse HEAD` = `8acfdb710a921beeb68ff55cb777c72ef6f7d9bd`. PR base `v2.0` @ `d91112f2`.
**Intent source:** `gh pr view 316` + `gh pr view 310` (both fetched successfully — cubic auto-summaries + migration notes).
**Stable baseline:** base-v2 architecture doc UNCHANGED (`git diff v2.0..HEAD -- docs/tech-design/key-architectural-concepts.md` is empty). Re-aligned against base-v2 contracts `git show v2.0:.../PrivacyPoolRelay.sol|Keystore.sol|PoolVault.sol`.

**Methodology note / key context:** The contract-level surface of BOTH features (`registerAndRelay`, `relayBatch`, `setAuthPolicyWithSig`, shared `_setAuthPolicy`, leaf formula, `_MAX_BATCH`) ALREADY EXISTS in base `v2.0`. The `v2.0-features` branch adds only hardening on top (EIP-712 deadline, constructor root-history guard, idempotent front-run skip, zero-recipient guards) plus the SDK/relayer glue. So base-v2 IS a faithful, non-circular reference for these features, and the diffs (`git diff v2.0..HEAD`) isolate exactly what to scrutinize.

Verified base-v2 invariants (all still enforced per-item in both features):
- Context binding: `PoolVault.transact` requires `proof.context() == keccak256(abi.encode(transactParams, noteData)) % SNARK_SCALAR_FIELD` (PoolVault.sol:146-148) → every item's `PayoutRouting{recipient,feeRecipient,feeAmount,nativeGas}` + processor is proof-bound. No fee re-concentration possible.
- Processor gate: `transactParams.processor == msg.sender` (PoolVault.sol:143).
- Root gating: `isKnownRoot(stateRoot)`, `keystore.isKnownRoot(keyRegistryRoot)`, `associationSetRoot == aspRegistry.latestASPRoot()` (PoolVault.sol:354-356).
- Nullifier uniqueness: checked against live `$.spentNullifiers` storage and marked immediately (PoolVault.sol:170-173) → cross-item double-spend in one batch reverts even though all items share one pre-batch stateRoot snapshot.
- Value conservation / per-label lineage proven in-circuit per transact.

---

## FEATURE 1 — BATCH (#316)

| Behavior | Stable ref | Code ref | Verdict | Sev | Note |
|---|---|---|---|---|---|
| Each batch item is a full `transact` (all base gates apply) | PoolVault.transact 135-205 | PrivacyPoolRelay.sol relayBatch loop `POOL.transact(...)` ~150 | ALIGNED | — | Nullifier/context/root gating inherited per item |
| Per-item fee cap = `maxRelayFee` (NOT aggregate), + `feeAmount<=amountOut` | base `_relay` fee model | relayBatch `_payout.feeAmount<=_maxRelayFee` & `<=_amountOut` | ALIGNED | — | Matches PR "per-item normal single-tx fees" intent |
| One recipient + one feeRecipient for whole batch (item 0 reference) | new feature (no base equiv) | relayBatch `_InconsistentRecipient` check | ALIGNED | — | recipientAmount = ΣamountOut − Σfee |
| `_MAX_BATCH < rootHistorySize` coupling | comment in base (rootHistorySize=16) | HEAD adds constructor `require(_MAX_BATCH < _pool.rootHistorySize())` | EXTENSION | Low(+) | Hardening: runtime guard vs prior comment-only. Upholds snapshot validity |
| Zero-recipient handling in batch | base `_relay` had NO recipient!=0 guard | HEAD adds `_ZeroRecipient` in relayBatch + `_relay` | EXTENSION | Low(+) | Closes base-v2 gap (funds to address(0)); safe hardening |
| Item-0 decode reuse (`_i==0 ? _ref : decode`) | — | HEAD micro-opt | ALIGNED | — | Semantically identical, gas-only |
| `msg.value == Σ nativeGas` | base `_relay` NativeGasMismatch | relayBatch `_NativeGasMismatch` | ALIGNED | — | |
| SDK `computeBatchFees` per-item `min(maxRelayFee, cost+var)`, throws on fee>amountOut | contract per-item bounds | packages/sdk .../computeBatchFees.ts:40-54 | ALIGNED | — | No aggregate cap; sums may exceed maxRelayFee (intended) |
| SDK orchestrator binds signed routing per item, exact `feeAmount===expectedFee` | context binding | BatchWithdrawOrchestrator.ts:121-168,226-243 | ALIGNED (EXT) | Info | Client-side check STRICTER than contract; defensive, no divergence |
| SDK `selectNotesForFullWithdraw` value conservation | per-label lineage | selectNotesForFullWithdraw.ts:43-72 | ALIGNED | — | Partitions by label, per-lineage chunks by maxInputs |
| Relayer schema caps items <= MAX_BATCH (from sdk/batch-fee) | _MAX_BATCH=10 | relayer relay/evm/schemas.ts:205, evm.schemas.ts:28 | ALIGNED | — | Single source of MAX_BATCH |
| Relayer MAX_BATCH↔rootHistorySize fail-fast + on-chain MAX_BATCH() drift check | constructor invariant | evm.chain.service.ts:531-567 (called :501) | ALIGNED | — | Strict `<`, matches contract |
| Relayer per-item fee bounds mirror contract | contract | evm.relay.service.ts:215,220 | ALIGNED | — | No looser/tighter reject divergence |
| Relayer fee split relayer-authoritative, re-encoded from SIGNED PayoutRouting[] | context binding | evm.quote.service.ts:386-392; evm.relay.service.ts:172,228-236,261-270 | ALIGNED | — | Client cannot supply/re-concentrate split; totals recomputed + sig-verified |
| Relayer aggregate cap `totalFee <= maxRelayFee*itemCount` | contract has NO aggregate cap | evm.relay.service.ts:254 | EXTENSION | Info | Dead-safe: each item already ≤maxRelayFee so can't reject a contract-valid batch |
| Relayer per-item/`totalFee` checked vs UNSIGNED wire fields | — | evm.relay.service.ts:215,245 vs signed set chain.service.ts:258-267 | ALIGNED | Info | Safe: real feeAmounts live in signed `data`, totals recomputed+verified; tampering only self-rejects. Worth a clarifying comment |

**Feature 1 verdict: ALIGNED.** All base-v2 invariants upheld per-item; the deltas are pure hardening/defense-in-depth (constructor guard, zero-recipient, stricter client fee equality, relayer aggregate cap). No CONTRADICTION.

---

## FEATURE 2 — RELAYED-REGISTRATION (#310)

| Behavior | Stable ref | Code ref | Verdict | Sev | Note |
|---|---|---|---|---|---|
| Keystore leaf = `PoseidonT4([uint160(account), nk, authDigest])` | base `_setAuthPolicy` | Keystore.sol `_setAuthPolicy` (unchanged) | ALIGNED | — | Shared by direct + relayed path, keyed on `_account` |
| `_setAuthPolicy` reverts if already registered | base `Keystore_AuthPolicyAlreadySet` | Keystore.sol (unchanged) | ALIGNED | — | Direct-path semantics preserved |
| EIP-712 domain `PrivacyPoolsKeystore`/`1` | base `__EIP712_init` | Keystore.sol initialize/initializeEIP712 (unchanged) | ALIGNED | — | |
| EIP-712 typehash now includes `deadline` | base typehash had NO deadline | HEAD `SetAuthPolicy(...,uint256 deadline)` + `require(block.timestamp<=_deadline)` | EXTENSION | Med(+) | Staleness protection (C-8). Signature now binds deadline; matches task-stated intent |
| `registerAndRelay` resolves keystore off pool (not cached) | base comment | HEAD `IKeystore _keystore = POOL.keystore()` | ALIGNED | — | Targets exact tree `transact` reads |
| Idempotent front-run skip: skip if `nullifyingKeys(account)==nk` | base always called setAuthPolicyWithSig (would revert AlreadySet) | HEAD `if (nullifyingKeys(_account)!=_nullifyingKeyHash){...}` | EXTENSION | Low(+) | See analysis below — sound for fund-safety |
| Proof anchors to PREDICTED post-registration keystore root | base transact `keystore.isKnownRoot(keyRegistryRoot)` | PoolVault.sol:355 + SDK witness | ALIGNED | — | See analysis |
| SDK predicted-root witness inserts `Poseidon(account, Poseidon(nk), authDigest)` at next LeanIMT index | contract leaf + LeanIMT insert | WitnessPreparationService.ts:131-148,320-328; PoolSessionKeystore.ts:524-531 | ALIGNED | — | Same leaf feeds witness AND signed setAuthPolicyWithSig → predicted=actual by construction |
| SDK EIP-712 domain/typehash/deadline | contract | constant/PoolSessionKeystore.ts:9,12,19-26; keystoreEip712.ts:37-52 | ALIGNED | — | Domain+version+field order incl deadline match |
| SDK deadline threaded prepareRelayedRegistration→prepareRegisterAndWithdrawRelay | contract deadline | PoolSessionKeystore.ts:174-219; PoolSessionWithdraw.ts:124-155 | ALIGNED | — | Rejects unsigned registration; courtesy deadline<=now guard |
| Relayer forwards account sig unchanged, never re-signs; simulate-before-write | contract verifies sig | relayer relay/evm/schemas.ts:162-168; evm.chain.service.ts:457-477 | ALIGNED | — | Faithful pass-through of `registerAndRelay` args |
| Relayer no double-charge on skip | fee taken once from withdrawal | evm.relay.service.ts:109-112 | ALIGNED | — | Reuses withdrawal fee path; skip cannot double-charge |
| SDK client `relayRegisterAndWithdrawal` posts predicted-root proof to `/register-and-relay` | — | RelayerInteractor.ts:342-380 | ALIGNED | — | Asserts fee-commitment liveness pre-submit |

### Idempotent-skip soundness (expanded EXTENSION)
The skip checks only `nullifyingKeys[account] == nk` (nk is the only field stored in the `nullifyingKeys` mapping; authDigest is not). Analysis of the three ways `nullifyingKeys[account]` can already be set:
1. **Front-runner replays the account's OWN signed registration** (same account, nk, authDigest): produces the identical leaf → actual keystore root == predicted post-insertion root → the relayed proof's `keyRegistryRoot` is `isKnownRoot` → withdrawal lands. Skip is correct; bundle degrades to plain relay. This is the intended front-run resilience.
2. **Same nk but DIFFERENT authDigest already present** (only reachable via the account's own second authorization — an attacker cannot forge a different-authDigest signature): skip fires, but the witness predicted a leaf with the intended authDigest while the tree holds a different-authDigest leaf → predicted root != current root → `transact` reverts `PoolVault_UnknownKeystoreRoot`. Safe revert, relayer loses gas only. Self-inflicted, no fund risk.
3. **Different nk already present:** skip does NOT fire → `setAuthPolicyWithSig` runs → `_setAuthPolicy` hits `Keystore_AuthPolicyAlreadySet` → revert. Base semantics preserved.

In all cases fund-safety and keystore gating hold; the skip only avoids a redundant, guaranteed-revert insertion. Consistent with base-v2 keystore semantics. Verdict EXTENSION, Low.

**Feature 2 verdict: ALIGNED.** EIP-712 deadline and idempotent skip are sound hardening extensions; predicted-post-insertion-root anchoring is correct against the actual LeanIMT leaf formula and insert semantics; EIP-712 domain/typehash correct. No CONTRADICTION.

---

## OVERALL
- **BATCH (#316): ALIGNED** — 0 contradictions. Deltas from base-v2 are hardening/defense-in-depth.
- **RELAYED-REGISTRATION (#310): ALIGNED** — 0 contradictions. EIP-712 deadline + idempotent skip are sound.
- **No CONFIRMED CONTRADICTIONS in either feature.**
- Informational-only follow-ups (no code change required): (a) relayer per-item/`totalFee` checks read unsigned wire fields — safe because real amounts live in signed `data` and totals are recomputed+sig-verified; a one-line clarifying comment would help; (b) SDK exact `feeAmount===expectedFee` equality is intentionally stricter than the contract cap.
