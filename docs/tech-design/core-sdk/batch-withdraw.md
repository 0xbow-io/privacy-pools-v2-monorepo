# SDK — Batch Withdrawal

SDK-side design + public API for "withdraw an entire single-asset balance in one
transaction" — chain-neutral in core-sdk, implemented for EVM (`PrivacyPoolRelay.relayBatch`) and
Stellar (`relay.relay_batch`). Pairs with the cross-cutting design doc
[`../contracts/batch-withdrawal.md`](../contracts/batch-withdrawal.md) (contract + relayer +
protocol) — read that for the on-chain `relayBatch` semantics, the shared-snapshot-root
invariant, and the fee protocol. This doc covers only the SDK surface.

## Version History

| Version | Date       | Notes |
|---------|------------|-------|
| 0.1.0   | 2026-07-01 | Initial SDK batch-withdraw doc (per-item fee model, relayer-authoritative split, SDK-verified). |
| 0.2.0   | 2026-07-10 | Add the self-submit batch path (`selfSubmitBatchWithdraw` / `prepare` + `execute`): a gas-paying user builds and submits their own zero-fee `relayBatch`, no relayer (review BW-2). |
| 0.3.0   | 2026-07-30 | Verify-before-persist (audit AW-L-02 / #1070). `relayBatchWithdraw` and `executeSelfSubmitBatch` parse the confirmed receipt's PoolVault-emitted `Transacted` logs and require every spent nullifier to be confirmed before marking notes SPENT — defeating a relayer that returns an unrelated successful tx hash. Verify-and-WARN, not a hard gate (warn + skip persist; `discoverNotes()` backstops). `BatchPrepareResult` / `SelfSubmitBatchPrepareResult` gain `spentNullifiers`; `persistBatchNoteUpdates` gains an optional `verification`. |
| 0.4.0   | 2026-08-14 | `persistBatchNoteUpdates`'s `verification` argument is now **required**, not optional (AW-L-02 / #1070 follow-up). As an optional public parameter it let a caller skip the receipt-log gate entirely and persist SPENT on unverified evidence, which is unrecoverable because `SPENT` is terminal. |
| 0.5.0   | 2026-08-14 | `prepareBatchWithdraw` now explicitly awaits `warmMerkleCaches()` before requesting the relayer's quote, via a new `IBatchWithdrawOrchestrator.warmMerkleCaches()` passthrough method (delegates to `ITransactOrchestrator.warmMerkleCaches()`) — additive interface method, no breaking change. |
| 0.6.0   | 2026-10-01 | Chain-neutral batch + Stellar support. `IRelayBatchCodec.encodeRelayBatch(relayAddress, items, asset)` takes the asset and returns a Promise; `ITransactOrchestrator.encodeRelayBatch` is async with `asset`; `BatchWithdrawOrchestratorConfig.emptyAddress` (self-submit fee recipient; defaults to EVM's zero address). New §2b Stellar: `StellarRelayBatchCodec` → `relay.relay_batch(relayer = owner, asset, items)`, `StellarPayoutRoutingCodec.decodeArray` / `encodeArray`, `StellarPreparedTxVerifier` accepts `relay_batch`, `StellarRelayerInteractor` batch quote/relay, relayer `quoteBatch` / `batchWithdrawal`. |
| 0.5.1   | 2026-09-24 | Doc-only. §5: `KeystoreNotRegistered` / `RegistrationCheckFailed` (`PoolSessionKeystoreBaseError`, not a batch/transact-base error) can surface from the witness-building step when the owner has no on-chain keystore registration (fail-fast precheck in `prepareTransact`). |

## 1. Why

The `transact` circuit spends at most 5 input notes per proof. A user with more than 5
notes cannot withdraw their whole balance in one relayed transaction. The SDK partitions
all active notes of an asset into ≤5-note groups (one proof each) and the relayer submits
them as a single `relayBatch` (EVM) / `relay_batch` (Stellar) — one aggregate payout, one
recipient, one asset.

## 2. Public API (via `PoolSession`)

The ergonomic entry mirrors `prepareWithdraw` / `relayWithdraw`. It is **quote-first**: the
session selects notes, requests one aggregate quote, generates one proof per group bound to
the relayer's signed per-item fee, and submits.

Before requesting that quote, `prepareBatchWithdraw` explicitly awaits `warmMerkleCaches()`
(`IBatchWithdrawOrchestrator.warmMerkleCaches()`, a passthrough that `BatchWithdrawOrchestrator`
delegates to its internal `ITransactOrchestrator.warmMerkleCaches()`) — same rationale as
cross-chain reshield, see [pool-session.md](pool-session.md) §Cross-Chain Reshield.

```typescript
// 1. Prepare — selects notes, quotes, builds N proofs (no on-chain, no local mutation).
const batch = await session.prepareBatchWithdraw({
  tokenId: "0xTokenAddress",          // asset whose full active balance is withdrawn
  recipientAddress: "0xRecipient",    // single recipient for the whole batch
});

// 2. Relay — submits one relayBatch via the relayer; marks notes spent on confirm.
const receipt = await session.relayBatchWithdraw(batch);
```

Signatures:
- `PoolSession.prepareBatchWithdraw(params: BatchWithdrawSessionParams): Promise<PrepareBatchWithdrawResult>`
  — `BatchWithdrawSessionParams = { tokenId: Address; recipientAddress: Address }`.
  `PrepareBatchWithdrawResult = BatchPrepareResult & { relayerInfo; quote }`.
- `PoolSession.relayBatchWithdraw(params: PrepareBatchWithdrawResult): Promise<TxReceipt>`.

Both throw `PoolSessionTransactBaseError` when the batch-withdraw delegate is not configured
(needs `poolVaultInteractor` + `aspClient` in `PoolSessionConfig`).

### 2a. Self-submit (no relayer)

The relayed path above binds every proof to a relayer's signed quote. A user who prefers to
pay their own gas uses the **self-submit** path instead: since `relayBatch` is permissionless
on-chain, the SDK builds one **zero-fee** full-withdrawal proof per group (`feeAmount = 0`,
empty `feeRecipient`, `nativeGas = 0`) and submits the atomic `relayBatch` as the caller's own
transaction. No quote, no relayer. The "empty" fee recipient is
`BatchWithdrawOrchestratorConfig.emptyAddress` — EVM's zero address by default; a chain whose
routing codec cannot encode that supplies its own (Stellar: `STELLAR_EMPTY_ADDRESS`).

```typescript
// One-shot: prove every group and submit the user's own relayBatch.
const receipt = await session.selfSubmitBatchWithdraw({
  tokenId: "0xTokenAddress",
  recipientAddress: "0xRecipient",
  relayContractAddress: "0xPrivacyPoolRelay",  // the relayBatch target
});
```

Signatures:
- `PoolSession.selfSubmitBatchWithdraw(params: SelfSubmitBatchParams): Promise<TxReceipt>` —
  `SelfSubmitBatchParams = { tokenId: Address; recipientAddress: Address; relayContractAddress: Address }`.
- `PoolSession.prepareSelfSubmitBatch(params): Promise<SelfSubmitBatchPrepareResult>` and
  `executeSelfSubmitBatch(prepared): Promise<TxReceipt>` — the split prepare/submit halves,
  mirroring `prepareWithdraw` / `executeWithdraw`. `SelfSubmitBatchPrepareResult` carries the
  ready-to-sign `relayBatch` transaction (`to`, `callData`, `value`) plus the note-state deltas.

The batch transaction is built by `await TransactOrchestrator.encodeRelayBatch(relayAddress, items, asset)`,
which reshapes each item's proof into the on-chain `TransactProof` tuple exactly as a single
`transact` does — just in array form — and delegates to the chain's
`IRelayBatchCodec.encodeRelayBatch(relayAddress, items, asset): Promise<TTx>`. The codec is
asynchronous (a chain that must simulate before signing builds the call against the RPC here) and takes the asset explicitly (Soroban's `relay_batch` needs it; an item's `tokenIdOut` is a
one-way hash of it). EVM's codec encodes `PP_RELAY_BATCH_ABI` and ignores `asset` (derived on-chain).

### 2b. Stellar

Same public API and fee model; the chain pieces are:

- **`StellarRelayBatchCodec`** — builds (and simulates) `relay.relay_batch(relayer, asset, items)`
  for the self-submit path. The submitting account (the session owner, wired by
  `createStellarPoolSession`) is the `relayer`; each item is the contract's `BatchItem` struct whose
  `routing` is the `PayoutRouting` its proof committed to, decoded from the item's
  `transactParams.data` with the same codec that encoded it.
- **`StellarPayoutRoutingCodec.encodeArray` / `decodeArray`** — the batch commitment's `data` is the
  concatenation of one 128-byte routing per item (`recipient StrKey (56 B) ‖ fee_recipient StrKey (56 B)
  ‖ fee_amount u128 LE (16 B)`).
- **`StellarPreparedTxVerifier`** accepts `relay_batch` as the `relayBatch` target function.
- **`StellarRelayerInteractor.getBatchWithdrawalQuote` / `relayBatchWithdrawal`** —
  `POST /v1/quote/stellar/:chainId/batch` and `POST /v1/relay/stellar/:chainId/batch`; `extraGas`
  is rejected (no native-gas leg).
- **Relayer** — `quoteBatch` prices each item with the same `computeBatchFees` (`relayCost = 0`, no
  gas oracle on Soroban; flat stroop fee — in shares for a yield share — or the asset's bps, capped at
  `max_relay_fee`) and signs the commitment under the `"ppv2-stellar-batch-v1"` domain tag;
  `batchWithdrawal` re-checks every item against it (`tokenIdOut` == the asset's field hash, uniform
  recipient/fee recipient, per-item cap and `fee <= amountOut`, Σ fees == `totalFee`) before
  submitting `relay_batch`. See [relayer/stellar-relayer.md](../relayer/stellar-relayer.md).

## 3. Internals (public, but lower-level)

Exposed for consumers building outside a `PoolSession`; all value-exported at runtime.

- **`selectNotesForFullWithdraw({ notes, tokenId, maxInputs })`** → `BatchWithdrawGroup[]` —
  partitions active notes by `label` (deposit lineage) then chunks each lineage into
  ≤`maxInputs` (5) groups. Single-label groups keep per-label value conservation trivial
  (one 0-value change note per group). Deterministic ordering.
- **`BatchWithdrawOrchestrator.prepareBatchWithdraw({ tokenId, recipientAddress, relayAddress, quote, groups? })`**
  → `BatchPrepareResult` — builds one proof per group against a single pre-batch snapshot,
  **recompute-and-verifies** each item's fee from the quote's signed `relayCost`/`feeBps`/
  `flatFee` (rejecting a relayer that concentrates the fee — see §4), and binds each item's
  `PayoutRouting` into its proof `context`. Read-only on note state;
  `persistBatchNoteUpdates(spentNotes, changeNotes, txHash, verification?)` commits once after
  confirm. `BatchPrepareResult` / `SelfSubmitBatchPrepareResult` also carry `spentNullifiers`
  (each item's `proof.publicSignals[0:nInputs]`), which the session threads into `verification`
  so persistence can confirm the batch's `Transacted` logs before marking SPENT — see below.
- **Receipt log verification before persisting SPENT (AW-L-02 / #1070)** — both the relayed
  `relayBatchWithdraw` and the self-submit `executeSelfSubmitBatch` parse the confirmed receipt's
  `Transacted` logs (via `IPoolVaultInteractor.extractSpentNullifiers`) and require every spent
  nullifier to appear in a log emitted by the expected PoolVault before persisting SPENT. The
  `verification` argument on `persistBatchNoteUpdates` is **required**, so the gate cannot be
  skipped by a caller passing nothing. This
  stops a relayer returning the hash of an unrelated successful tx from marking spendable notes
  spent. Verify-and-WARN, not a hard gate: on a mismatch the SDK warns and persists nothing,
  leaving `discoverNotes()` as the backstop. Only `Transacted` is parsed — the aggregate
  `RelayedBatch` event carries no nullifiers.
- **`computeBatchFees` / `computeBatchItemFee`** — the pure per-item fee function, shared
  with the relayer (imported via `@privacy-pools-v2/sdk/batch-fee`), so both sides derive
  identical fees.
  Let `baseFee_i = relayCost + (feeBps>0 ? amountOut_i·feeBps/10000 : flatFee)`.
  Then `fee_i = maxRelayFee > 0 ? min(maxRelayFee, baseFee_i) : baseFee_i`.
  `maxRelayFee = 0` means uncapped — the fee is never floored to `0`. A **nonzero**
  `maxRelayFee < relayCost` throws `AssetNotRelayable` rather than signing below cost.
- **`IRelayerInteractor.getBatchWithdrawalQuote` / `relayBatchWithdrawal`** — the HTTP client
  for `POST /v1/quote/.../batch` and `POST /v1/relay/.../batch` (EVM `RelayerInteractor`, Stellar
  `StellarRelayerInteractor`).
- **`IBatchWithdrawOrchestrator.warmMerkleCaches()`** — passthrough implemented by
  `BatchWithdrawOrchestrator`, delegating to its internal `ITransactOrchestrator`'s
  `warmMerkleCaches()`. Lets `PoolSessionBatchWithdraw.prepareBatchWithdraw()` explicitly await
  both leaf caches before the quote request starts the fee commitment's expiration clock.
- **`MAX_BATCH`** — the batch-size cap (10), single-sourced; cross-checked against the relay
  contract's `MAX_BATCH()` on the relayer side.

## 4. Fee verification (why the SDK recomputes)

Each proof's `context` binds its `PayoutRouting` (recipient, feeRecipient, feeAmount,
nativeGas). Because a batch proof is independently submittable via the single `relay()`, a
greedy relayer that concentrated the whole batch fee onto one item could cherry-pick that
proof and pocket the full fee for one transact. The fix: each item is charged a **normal
single-tx fee**, and the SDK **recomputes** each item's fee from the relayer's *signed*
`relayCost`/`feeBps`/`flatFee` and rejects any routing that doesn't match
(`BatchRoutingInvalid`). So a concentrated split never gets proofs generated for it.

## 5. Errors (all value-exported for `instanceof`)

`BatchWithdrawBaseError` (base), `EmptyBatchSelection` (no active notes),
`BatchTooLarge` (> `MAX_BATCH` groups), `InfeasibleBatchFee` (an item's fee exceeds its own
`amountOut`), `BatchRoutingMismatch` (routing count ≠ group count),
`BatchRoutingInvalid` (a routing's recipient/fee doesn't match the recomputed single-tx fee).

The witness-building step (`TransactOrchestrator.prepareTransact`, shared by every group) additionally runs the keystore-registration precheck: `KeystoreNotRegistered` (or `RegistrationCheckFailed` when the read fails) can surface from `prepareBatchWithdraw` / `prepareSelfSubmitBatch` when the session owner has no on-chain keystore registration. These are `PoolSessionKeystoreBaseError`s — **not** `BatchWithdrawBaseError` or `PoolSessionTransactBaseError` — so callers catching only the batch base error will not see them. See [pool-session.md](pool-session.md#keystore-registration-precheck).

## 6. Tests

- Unit: `computeBatchFees`, `selectNotesForFullWithdraw`, `BatchWithdrawOrchestrator`
  (incl. a greedy-concentration rejection), `PoolSessionBatchWithdraw` (quote→prepare→relay
  ordering), `RelayerInteractor` batch client.
- Real-proof: `BatchWithdrawOrchestrator.integration.test.ts` (artifact-gated).
- Full stack: `packages/relayer/e2e/src/relay/batch.e2e.ts` (SDK → relayer HTTP → chain).
