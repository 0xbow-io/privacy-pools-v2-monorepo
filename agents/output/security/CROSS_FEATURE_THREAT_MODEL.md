# Cross-Feature Threat Model — v2.0 (relayed-registration × yield × batch × stealth)

**Branch:** `audit/v2.0-features` (base `d91112f2`). **Date:** 2026-07-08.
**Method:** interaction grid → per-pair scenario → classify **CONFIRMED / PLAUSIBLE / REFUTED /
BY-DESIGN**. Single-feature findings live in `agents/output/audit/contracts_r1.md`,
`.../code-review/{sdk,relayer}_r1.md`, `.../security/STEALTH_REVIEW_AND_DIFF.md`; this file covers
only what emerges from **composition**. Items needing an executable proof are marked **[PoC]** and
are verified in `SECURITY_FINDINGS.md` once the contracts agent frees `forge`.

> Honesty (Directive 0): scenarios marked REFUTED were traced to the code that prevents them (cited).
> Scenarios marked PLAUSIBLE are not yet reproduced. Nothing here is claimed exploitable without a
> cited path.

## The features, as attack surface
- **Relayed registration** — `Keystore.setAuthPolicyWithSig` (permissionless, EIP-712) +
  `PrivacyPoolRelay.registerAndRelay` (register-then-relay in one tx).
- **Yield** — `PPRouter.withdrawToUnderlying` acts as the PoolVault transact `processor`; `PPYieldToken`
  (ERC-4626 over aUSDC); `PPYieldTokenZap`.
- **Batch** — `PrivacyPoolRelay.relayBatch` loops `POOL.transact` N≤10 times, then one `_distribute`.
- **Stealth** — SDK-only; withdrawal recipient is a stealth address; ERC-5564 announcement off-chain.

## Interaction grid (rows act on columns)
| ↓acts / →on | PoolVault/root buffer | Keystore | Yield (PPRouter/Zap) | Relayer signer | ERC-4626 shares |
|---|---|---|---|---|---|
| **Batch** | S1 root-window | S2 keystore-root freshness | **S3 REFUTED** (processor mutually exclusive) | S4 fee aggregate | — |
| **Relayed-reg** | — | S5 sig replay/deadline | — | S6 register+relay atomicity | — |
| **Yield** | S7 ppUSDC as pool asset | — | S8 donation/inflation | S9 processor allowlist | S8 |
| **Stealth** | — | — | S10 stealth×yield delivery | S11 stealth×relayer linkage | — |

---

## S1 — Batch × root ring buffer (BY-DESIGN, verify bound)
`relayBatch` does N≤`_MAX_BATCH`(10) `POOL.transact` calls; each calls `_updateRoot` once
(`PoolVault.sol:179`). Every item's proof was built against the **pre-batch** state root; correctness
relies on all N historical roots still being in the ring buffer when item N validates. `_MAX_BATCH=10`
is a hard constant *documented* as "kept strictly below the deployed `rootHistorySize` (16)"
(`PrivacyPoolRelay.sol:23-26`) but **nothing on-chain enforces `_MAX_BATCH < rootHistorySize`** — a
deploy that set `rootHistorySize ≤ 10` would let a late batch item validate against an evicted root or
fail. Relayer added a runtime cross-check (`assertBatchFitsRootHistory`, good) but the contract itself
has no guard. → **Finding (Medium): add a constructor/read-time invariant** `_MAX_BATCH <
POOL.rootHistorySize()`. Tracked in `contracts_r1.md`. Not a composition bug per se, but it's the
batch↔pool coupling, so noted here.

## S2 — Batch × keystore-root freshness (REFUTED for theft, PLAUSIBLE for griefing)
Each batched `transact` verifies its own `keystoreRoot` via `isKnownRoot`. Independent items with
independent proofs; no shared keystore mutation inside `relayBatch`. An attacker cannot make item j's
keystore assumption depend on item i. **No theft path.** Residual: if any item's `keystoreRoot` was
evicted from the keystore's own bounded buffer between proof-gen and inclusion, that item reverts and
(because the loop is not try/catch) the **whole batch reverts** — a griefing/DoS surface under
contention, not a fund risk. PLAUSIBLE griefing; document.

## S3 — Batch × Yield router (REFUTED — architecturally impossible)
Headline concern was "a `relayBatch` item with `processor = PPRouter` composes the batch loop with the
Aave redeem leg / `minUnderlyingOut=0` / router reentrancy." **Refuted by the processor check:**
`relayBatch` calls `POOL.transact(...)` itself, so inside `transact` `msg.sender ==
PrivacyPoolRelay` and the guard `require(_transactParams.processor == msg.sender)`
(`PoolVault.sol:143`) forces every batched item's processor to be the relay contract. But
`PPRouter.withdrawToUnderlying` requires `_transactParams.processor == address(this)` (the router,
`PPRouter.sol:176`) and calls `transact` itself. **The two are mutually exclusive: a yield-router
withdrawal can never be a `relayBatch` item.** So `minUnderlyingOut=0`-in-a-batch and
router-reentrancy-into-the-batch-loop do not exist. This is the single most important interaction
result — it collapses the batch×yield surface to zero. (Confirmation: `relayBatch` never references
PPRouter; `PPRouter` is only reachable via its own external entrypoint.)

## S4 — Batch × relayer signer / fee aggregate (BY-DESIGN)
Per-item `feeAmount ≤ maxRelayFee`, so aggregate ≤ `N×maxRelayFee`. Each item's `PayoutRouting`
(incl. `feeAmount`, `recipient`) is bound into that item's proof `context`
(`keccak(abi.encode(_transactParams,_noteData))`, `PoolVault.sol:147`) — user-authorized — and the
relayer additionally EIP-712-signs the batch total (relayer agent confirmed `data` is inside the signed
message, so a client cannot forge the split). Documented as accepted design (batch-withdrawal.md VH
0.3.0, "L-1 aggregate fee ceiling"). **No over-charge beyond what both user and relayer signed.**

## S5 — Relayed-registration signature replay / no deadline (PLAUSIBLE → see contracts_r1)
`setAuthPolicyWithSig` has **no nonce, no deadline**; its only replay bound is the one-time
`nullifyingKeys[_account]==0` guard. Composition angle: a captured EIP-712 signature stays valid
**forever until the account first registers**. If a user signs registration for key-material A, later
decides to register key-material B instead, a party holding the A-signature can **front-run** and lock
in A (the sig commits to `authDigest`+`nullifyingKeyHash`, so it can only register *what the user once
signed* — not attacker-chosen material). Impact = the user is bound to a stale-but-self-authored key,
and must `ragequit`/rotate to recover. **Resolved by contracts_r1 (L-2): cross-chain / cross-deployment
replay is NOT possible** — `EIP712Upgradeable` recomputes the domain separator with `block.chainid` +
`verifyingContract`. The real residual is that `nullifyingKeyHash` is immutable once set
(`updateAuthPolicy` changes only `authDigest`), so a stale sig permanently binds the abandoned NKH.
**Rated Low** (self-inflicted, no third-party exploit). Recommended (SDK-coordinated): add a
`deadline`/nonce to the typehash so users can invalidate stale sigs.

## S6 — Relayed-registration atomicity (REFUTED — correct by construction)
`registerAndRelay` resolves the keystore live off the pool (`POOL.keystore()`, not a cached ref,
`PrivacyPoolRelay.sol:83`) so the registration targets exactly the tree `transact` will read, then
relays a proof anchored to the post-registration root. Ordering is correct; no TOCTOU between the two
steps within the tx. Residual griefing = another registration landing between the user's proof-gen and
this tx changes the keystore root → the relay proof's `keystoreRoot` may be evicted → revert (same
class as S2). Not a fund risk.

## S7 — Yield: ppUSDC as a pool asset (PLAUSIBLE — needs value-conservation check)
ppUSDC (non-rebasing ERC-4626 share) is registered as an ordinary pool `tokenId`. The pool enforces
per-label value conservation in *share units*, but ppUSDC's **share↔underlying rate rises over time**.
A note minted at rate r0 and withdrawn at rate r1>r0 is worth more underlying, though the same share
count. This is intended (that's the yield), but it means **the airdrop `value×time` model and any
per-asset accounting that assumes a stable unit must treat ppUSDC specially** (flagged in the airdrop
review too). No pool-invariant break found — the pool only ever moves shares — but any consumer that
compares ppUSDC share-amounts to USDC amounts across time is exposed. Document as an assumption, not a
bug.

## S8 — Yield donation / first-depositor inflation (donation = OPEN Medium; inflation = downgraded Low)
`PPYieldTokenZap` computes amounts from `A_TOKEN.balanceOf(address(this))` (`depositUnderlying` wraps
the whole balance; `withdraw` reads live balance), so **anyone can donate aTokens and the next caller's
`_receiver` collects them** — a griefing/last-caller-wins surface on a stateless router (**contracts_r1
C-7, OPEN Medium**). Separately, `DeployYieldFork.s.sol` **deploys the wrapper directly, bypassing the
factory** (no dead-share seed) — **downgraded to Low by contracts_r1 (L-6):** `_decimalsOffset =
18 − assetDecimals = 12` for USDC gives 10^12 virtual shares, which **independently** makes
first-depositor inflation economically infeasible (attacker must donate `> V·10^12` to grief a victim
depositing `V`); the dead-share seed is defense-in-depth on top. Noted here because both compose with
any feature routing value through the zap.

## S9 — Yield × relayer processor allowlist (BY-DESIGN, defense-in-depth)
The relayer's `withdrawToUnderlying` branch calls an address from `allowed_processors`. The processor is
**bound into the user's proof context** (part of `_transactParams`), so the relayer cannot substitute a
different processor than the user proved; the allowlist + `simulateContract`-before-write is
defense-in-depth. `minUnderlyingOut` was `0n` (no slippage floor) — **fixed relayer-side** this pass
(client-supplied floor). Acceptable trust model (relayer agent concurred). Residual: SDK can't yet send
`processorAddress` (F-1) so the *self-submit* path is the only fully-wired one — a **wiring gap, not a
security hole**.

## S10 — Stealth × yield delivery (PLAUSIBLE — see STEALTH_REVIEW)
Yield withdrawals resolve to underlying USDC via `PPRouter`; stealth delivery wants an unlinkable
recipient. Composing them means the stealth address is the `_payout.recipient` of a
`withdrawToUnderlying`, i.e. it receives **USDC**, and the ERC-5564 announcement must encode enough for
the recipient to find it. Open question the stealth review addresses: does the router's
`redeemToUnderlying(_recipientShares, _payout.recipient)` reveal anything (amount, aToken dust to
`_receiver`) that narrows the stealth anonymity set? Delegated to `STEALTH_REVIEW_AND_DIFF.md`.

## S11 — Stealth × relayer linkage (PLAUSIBLE — see STEALTH_REVIEW)
The stealth withdrawal **bundle has no relayer schema** — it terminates at the SDK boundary. So a
stealth withdrawal is actually submitted as an ordinary `PrivacyPoolRelay.relay` with
`_payout.recipient = stealthAddress`. The relayer therefore sees the stealth address in clear (it's a
public field) and, if the same actor also broadcasts the ERC-5564 announcement, **timing/tx-graph
correlation between the relay tx and the announcement** could link them. Whether the SDK's
`composeWithdrawalBundle` + `discoveryBinding` mitigate this (e.g. by decoupling announcement from the
withdraw tx) is the crux — delegated to the stealth review. This is the highest-value stealth
composition question.

---

## Verification queue — status after the contracts pass
1. **S3 mutual-exclusion — RESOLVED by analysis.** `relayBatch` calls `POOL.transact` as itself, and
   `PPRouter.withdrawToUnderlying` requires `_transactParams.processor == address(this)` (`PPRouter.sol:176`)
   + calls `transact` itself; the two entrypoints cannot overlap. A dedicated PoC is unnecessary
   (the `PoolVault_InvalidProcessor` guard at `PoolVault.sol:143` is the mechanism).
2. **Zero-recipient burn — FIXED, so moot.** contracts_r1 C-1 added `PrivacyPoolRelay_ZeroRecipient`
   guards in `_relay` + `relayBatch`; a zero recipient now reverts instead of burning. Tests added.
3. **S8 inflation — DOWNGRADED to Low** by the 10^12 decimals offset (contracts_r1 L-6); no PoC needed.
   Donation griefing (C-7) remains OPEN Medium.
4. **S5 domain — RESOLVED.** contracts_r1 L-2 confirmed `EIP712Upgradeable` binds `block.chainid` +
   `verifyingContract`; cross-chain/cross-deployment replay is not possible. Residual: NKH immutability.
5. **S2/S6 griefing — OPEN (Low, liveness).** Revert-all-on-one-stale-root under a racing registration
   remains a plausible griefing surface; not fund-affecting. A PoC is optional (documented, low severity).

Net: the two fund-safety footguns are **fixed** (zero-recipient, root-history coupling); the remaining
cross-feature items are Low/liveness or single-contract OPEN findings tracked in contracts_r1.
