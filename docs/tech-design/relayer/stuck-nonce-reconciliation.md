# Stuck-Nonce Reconciliation

Detection and automatic recovery for a relayer EVM signer nonce that broadcast but will
never confirm (evicted from the mempool, or simply stuck unconfirmed past a timeout). See
[evm-sdk/relayer-interactor.md](../evm-sdk/relayer-interactor.md) for the client-facing
contract this protects (a relayer-returned transaction hash is not guaranteed to be the
hash that mines).

## Overview

**History / root cause.** The relayer's EVM signer used to use viem's shared `nonceManager`
singleton, which trusts its own in-memory cache over a live RPC read whenever the RPC's
`pending` count doesn't exceed it — a deliberate guard against normal propagation lag, but
one with no way to tell that apart from a transaction that is permanently gone. Once a
broadcast evicts from the mempool with nothing else watching for it, every later write on
that signer piles up behind the gap indefinitely (2026-09-25 mainnet incident, resolved
manually via a cancel-tx sweep; again 2026-09-30, nonces 98–100: the cache handed out 99
while the chain expected 98).

**Explicit nonce assignment (current).** `nonceManager` is no longer used: the signer is a
plain `privateKeyToAccount(pkey)` and every broadcast (`writeWithGasCap`,
`sendRawTransaction`, the generic `writeContract`) goes through the private
`EVMChainService.broadcast()`. Gas estimation and the gas-cap check run first, outside any
lock; then, under `withSignerLock(chainId, signer)` (an in-process per chain+signer promise
mutex), it runs `checkAndFixStuckNonce` (which returns the RPC `pending` count as a hint),
resolves fees (`resolveBroadcastFees`, see the tip floor below), and `sendWithAssignedNonce`
sends with an explicit `nonce`:

- **Nonce choice (`nextNonce`).** The RPC `pending` count — unless this process itself
  assigned that nonce or a later one within `NONCE_LOCAL_TRUST_MS`, in which case last + 1
  (covers `pending` lagging a broadcast this process just made). Past that window the chain
  wins, so an accepted-then-evicted nonce is refilled by the next write instead of leaving a
  permanent gap. If the nonce read fails entirely, the broadcast goes out with viem choosing
  the nonce (untracked; logged at `warn`).
- **Retry.** Once, at `max(nonce + 1, fresh pending)`, when the node reports the nonce taken
  (`nonce too low`, `nonce has already been used`, `replacement transaction underpriced`, or
  viem `NonceTooLowError`). Any other error is not retried.
- **Tip floor.** With `MIN_PRIORITY_FEE_WEI` > 0 and a base fee on the latest block,
  `maxPriorityFeePerGas = max(eth_maxPriorityFeePerGas, floor)` (the floor alone if that call
  fails) and `maxFeePerGas = 2 × baseFee + tip`; otherwise viem picks fees as before.
  Best-effort: if the latest-block base-fee read fails, it logs a `warn` and falls back to
  viem-picked fees (floor not applied) rather than failing the relay.
  Motivation: on 2026-09-30 Alchemy mainnet returned `eth_maxPriorityFeePerGas = 0x0`, and
  zero-tip transactions got evicted. Quote pricing (`getGasPrice`) is unchanged, so with a
  floor set the broadcast can cost slightly more than was quoted.

`checkAndFixStuckNonce` (`packages/relayer/relayer/src/chain.service/stuck-nonce.ts`) closes
this by tracking, per chain, the real broadcast time of every outstanding nonce and
cancelling the oldest one (a 0-value self-transfer at that exact nonce) once it's been
outstanding past a timeout — either still visible in the mempool ("present", more patience)
or not ("absent", less). It runs from three independent triggers, all calling the same
underlying logic:

1. **Reactive** — inside `broadcast()`'s signer lock, before every real write
   (`EVMChainService.writeWithGasCap`, `.sendRawTransaction`, `.writeContract`). Zero added latency on a healthy chain (one cheap
   `getTransactionCount` pair); this alone caught nothing on 2026-09-30 when 8.5 hours
   passed with no mainnet write traffic to trigger it.
2. **Periodic** — `StuckNonceReconcilerService`, a singleton (not request-scoped) that
   re-runs the same check on a fixed interval per chain, independent of request traffic.
   `reconcileChain` wraps the check in the same `withSignerLock`, so a cancel from a tick
   never races a live write for the same nonce.
   Cloud Run throttles CPU to near-zero between requests by default, so this timer isn't
   guaranteed to tick during a genuinely idle stretch (and the instance can scale to zero
   entirely) — it helps when the service is getting *any* traffic, but isn't a hard
   guarantee on its own.
3. **Externally triggered** — `POST /internal/reconcile-nonces` (`ReconcileController`),
   guarded by a shared-secret header, meant to be hit by a GCP Cloud Scheduler job on a
   fixed cadence. A real incoming HTTP request always gets CPU allocated by Cloud Run
   regardless of throttling settings, so this is the reliable backstop for trigger #2.

```mermaid
sequenceDiagram
    participant Req as A relay write request
    participant Timer as StuckNonceReconcilerService (interval)
    participant Sched as Cloud Scheduler
    participant Ctrl as ReconcileController
    participant Check as checkAndFixStuckNonce (stuck-nonce.ts)
    participant Chain as EVM chain (RPC)

    Req->>Req: estimate gas + cap check (outside the lock)
    Req->>Check: withSignerLock(chainId, signer): before broadcasting
    Timer->>Check: withSignerLock: every STUCK_NONCE_RECONCILE_INTERVAL_MS
    Sched->>Ctrl: POST /internal/reconcile-nonces (X-Reconcile-Token)
    Ctrl->>Check: reconcileAllChains() (each chain under withSignerLock)

    Check->>Chain: getTransactionCount(latest), getTransactionCount(pending)
    Check->>Check: floor = latest; look up outstandingNonces[chainId][floor]
    alt floor not tracked, no gap
        Check-->>Check: nothing outstanding
    else floor tracked, elapsed < absent timeout
        Check-->>Check: too early, wait
    else stale (absent past timeout, or present past the longer timeout)
        Check->>Chain: getGasPrice(); sendTransaction(0-value self-transfer at floor nonce)
        Check->>Check: record floor as latest assignment + outstanding at now
    end
    Check-->>Req: pending count (nonce hint)
    Req->>Chain: resolveBroadcastFees; send with explicit nonce = nextNonce(pending)
    Req->>Req: record nonce as latest assignment + outstanding at now
```

## `outstandingNonces`: a real per-nonce broadcast-time map

Module-level in `stuck-nonce.ts`, shared by all three triggers: `Map<EvmChainId,
Map<Nonce, BroadcastTimeMs>>` (both `Nonce` and `BroadcastTimeMs` are branded `number`s,
same convention as `Wei`/`Gas`/`BPS` in `quote/evm/unit.types.ts` and `EvmChainId` itself —
a nonce and a millisecond timestamp share a runtime representation and must never be
silently swapped).

This replaced an earlier, coarser design (a single per-chain `{floorNonce, since}`
watermark, "since" meaning "when this floor was first observed", not the real broadcast
time) for two reasons, both found investigating the 2026-09-30 incident:

- **The watermark-clearing bug.** The old gate treated `pending <= latest` as proof nothing
  was outstanding and unconditionally cleared its own tracking on that basis. Once a stuck
  tx fully evicts from the mempool, `pending` collapses back down to equal `latest` even
  though the gap is still real (later-queued nonces sit behind it as non-contiguous
  "queued" and aren't counted) — so the old code silently forgot the gap existed and the
  auto-fix never fired. Reproduced live: mainnet nonces 98–100 sat stuck 8+ hours with zero
  detection. Fixed by anchoring "is this still the same gap" to `latest` alone (the only
  monotonic signal), not to `pending`.
- **Timing precision.** A per-nonce map lets every successful broadcast record its own
  *real* broadcast time (`recordOutstandingNonce`, called by `sendWithAssignedNonce`
  immediately after a successful send, at the nonce actually used) rather than
  approximating it as "whenever a check next happened to notice this floor" — which could
  lag the real broadcast by however long until the next write or tick ran.

Recording semantics:

- A successful broadcast **overwrites** its nonce's entry with the broadcast time — a fresh
  broadcast at a nonce (e.g. a refill of an evicted one) restarts that nonce's clock rather
  than inheriting the stale time.
- Writes at other nonces never touch a stuck floor's clock.
- Seeding paths only fill a missing entry: `checkAndFixStuckNonce`'s first observation of an
  untracked floor, and the boot-seed (which runs against an empty map).
- An accepted cancel records its nonce as this process's latest assignment and as
  outstanding at now, so the triggering write (same lock) takes the next nonce even if
  `pending` hasn't caught up. A latest assignment is never lowered while still trusted:
  if this process assigned a higher nonce within `NONCE_LOCAL_TRUST_MS`, a cancel at a
  lower floor nonce leaves it in place (a cancel at 160 cannot hide a 161 sent seconds
  earlier).

Pruned of any nonce below the current confirmed floor on every check (reactive or
periodic) — confirmed nonces are no longer outstanding by definition.

## Boot-seeding: elapsed zero, not epoch zero

On process start, `outstandingNonces` is empty. `StuckNonceReconcilerService
.onApplicationBootstrap()` reads each configured chain's `latest`/`pending` once and, for
any gap found, seeds **every** nonce in that range (not just the floor — covers a
multi-nonce pileup like 98/99/100) at timestamp `Date.now()`.

Deliberately "now", not epoch zero: a restart has no way to know how old an
already-outstanding nonce actually is — it could have been broadcast moments before the
process restarted and be about to confirm normally. Seeding at "now" gives it the same
treatment as any nonce newly observed during ordinary operation (the full
`STUCK_ABSENT_TIMEOUT_MS`/`STUCK_PRESENT_TIMEOUT_MS` window from the moment of discovery),
not an immediate cancel. Under-reacting costs a bounded delay; seeding at epoch zero would
risk voiding a transaction that was about to confirm fine on its own.

## The externally-triggered endpoint

`POST /internal/reconcile-nonces`, guarded by `ReconcileAuthGuard`: a shared-secret header
(`X-Reconcile-Token`) compared against `RECONCILE_TRIGGER_SECRET` via a constant-time
digest comparison, not an OIDC-token/`run.invoker` IAM model. Deliberate: the account
operating this project's GCP resources has `roles/editor`, which covers creating the
secret, deploying a new Cloud Run revision, and creating the Scheduler job, but not
`setIamPolicy` — granting a Scheduler service account `run.invoker` needs an Owner. A
static shared secret needs no IAM changes at all. The endpoint's blast radius if the secret
ever leaked is low regardless: it only ever runs the same safe, idempotent, timeout-gated
reconciliation logic every other trigger already runs, never an arbitrary action.

Creating the actual Cloud Scheduler job, the Secret Manager secret, and wiring the env var
into the Cloud Run revision are live GCP infrastructure actions, done separately from and
after the code change that adds this endpoint.

## Constants

Single global env vars, per-chain overridable with the `_EVM_${chainId}` suffix (same
chain-type-namespaced convention PR #459 introduced for `ChainConfigWrapper`'s own
per-chain overrides — an EVM chain and a chain of some other type can be configured with
the same numeric id, so the chain type has to be part of the key). This convention —
and the equivalent one for in-memory cache/state keys (`outstandingNonces`,
`stuckNonceFixInFlight`, `lastAssigned`, and every other module-level cache keyed by chain
id across the relayer) — is centralized in the shared `chainKey(chainType, id)` helper
(`src/config/chain-key.ts`), reused by `stuck-nonce.ts`, `EvmChainConfigWrapper`,
`EVMChainService`, and `EvmContractService` rather than each reinventing it.

| Env var | Default | Meaning |
| --- | --- | --- |
| `STUCK_ABSENT_TIMEOUT_MS` | 120,000 (2 min) | A floor nonce absent from the pending-block view for this long is treated as evicted. |
| `STUCK_PRESENT_TIMEOUT_MS` | 600,000 (10 min) | A floor nonce still visible but unmined for this long is treated as stuck anyway, with more patience. |
| `CANCEL_GAS_BUMP_MULTIPLIER` | 2 | Fee multiplier on the cancel broadcast over current network gas price. With `MIN_PRIORITY_FEE_WEI` > 0 the cancel's `gasPrice` is `CANCEL_GAS_BUMP_MULTIPLIER × max(eth_gasPrice, 2 × baseFee + floor)`, so it can replace a floored original (a replacement must beat both of its fee caps). |
| `MIN_PRIORITY_FEE_WEI` | 0 (off) | Tip floor for every broadcast: `maxPriorityFeePerGas = max(eth_maxPriorityFeePerGas, floor)`, `maxFeePerGas = 2 × baseFee + tip`. At 0 (or on a chain with no base fee) viem picks fees as before. |
| `NONCE_LOCAL_TRUST_MS` | 30,000 (30 s) | How long this process's own last nonce assignment outranks a lower RPC `pending` count in `nextNonce`. Past it, the chain wins (an evicted nonce gets refilled). |
| `STUCK_NONCE_RECONCILE_INTERVAL_MS` | 60,000 (1 min) | How often `StuckNonceReconcilerService`'s in-process timer re-checks each chain. |
| `RECONCILE_TRIGGER_SECRET` | — (unset fails closed) | Shared secret the Cloud Scheduler-triggered endpoint expects in `X-Reconcile-Token`. |

## Known gaps

- The in-process timer's own reliability is bounded by how often the service happens to
  receive *any* traffic (not just mainnet writes) — Cloud Run's default CPU throttling
  means it isn't a hard guarantee on its own. The Cloud Scheduler-triggered endpoint is the
  intended backstop for this, but its live infra isn't provisioned as part of the code
  change that added the endpoint.
- The signer lock and local nonce state (`lastAssigned`, `outstandingNonces`) are per
  process. Multiple Cloud Run instances sharing one signer key can still collide on a
  nonce — run with `max-instances=1` or give each instance its own key.
- No safe way to reproduce a real mainnet mempool eviction end-to-end in prod — correctness
  of the fix path rests on unit tests (`evm.chain.service.stuck-nonce.spec.ts`,
  `stuck-nonce-reconciler.service.spec.ts`) plus review.

---

**Version History**

| Version | Change |
| --- | --- |
| 1.2.0 | 2026-10-02 — `chainKey()` extracted to a shared helper (`src/config/chain-key.ts`), replacing this file's own local `chainKey`/`CHAIN_TYPE_TAG`; reused by `EvmChainConfigWrapper`'s `envKey()` and every other chain-id-keyed cache in the relayer (gas price, public clients, in-flight nullifiers, asset config) so the namespacing convention has one implementation instead of several independently-reinvented ones. |
| 1.1.0 | 2026-09-30 — viem `nonceManager` removed: all broadcasts go through `EVMChainService.broadcast()` (per chain+signer lock, explicit nonce via `nextNonce`/`NONCE_LOCAL_TRUST_MS`, one retry on nonce conflicts, `MIN_PRIORITY_FEE_WEI` tip floor); periodic reconciler runs under the same lock; cancel records its nonce as the latest assignment (never lowering a still-trusted higher one) and respects the floor; base-fee read failure falls back to viem fees; per-process known gap. |
| 1.0.0 | 2026-09-30 — Initial doc. Consolidates the reactive stuck-nonce detection/fix from PR #441 (previously undocumented beyond code comments) with the watermark-clearing bug fix, the per-nonce `outstandingNonces` map replacing the floor-only watermark, the periodic in-process reconciler, and the Cloud Scheduler-triggered backstop endpoint. |
