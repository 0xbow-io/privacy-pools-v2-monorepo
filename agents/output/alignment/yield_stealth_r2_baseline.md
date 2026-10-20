# Alignment Re-Run (R2): YIELD (#315) + STEALTH (#317) vs. STABLE baseline references

**Commit (`git rev-parse HEAD`):** `1ec7ae4fae9a1b8d9355455b1ff4c3ab36b2e8f0`
**Branch:** `v2.0-features` · **PR base:** `v2.0` @ `d91112f2`

## Why this re-run exists (anti-circularity)
`docs/tech-design/contracts/yield.md` and `docs/tech-design/sdk/stealth.md` were **empty (1 line) in base `v2.0`** — they were authored FROM the shipped code during this effort. Aligning code to them proves nothing. This run re-aligns to references that **pre-exist the features and cannot have been retrofitted**:

1. **Base-v2 architecture / invariants** — `docs/tech-design/key-architectural-concepts.md` (verified **byte-identical** between `v2.0` and HEAD: `git diff v2.0..HEAD` on that file is empty, so it is a genuine stable reference), and the canonical base-v2 relay `packages/contracts/src/contracts/PrivacyPoolRelay.sol` + `IPrivacyPoolRelay.PayoutRouting` (both confirmed present in `v2.0`).
2. **Original feature intent** — **intent source used: GitHub PR bodies** via `gh pr view 315/317` (cubic auto-summaries authored from the diff at the PR head; used as the statement of intended scope). Cross-checked against feature commit subjects `git log v2.0..HEAD`.

## Scope reviewed
- **Yield contracts:** `src/contracts/PPRouter.sol`, `PPYieldToken.sol`, `PPYieldTokenZap.sol` (+ factories, surface only).
- **Yield SDK:** `services/poolSessions/PoolSessionYieldDeposit.ts`, `payoutRoutingGuard.ts` (shared theft-guard used by `PoolSessionYieldWithdraw`).
- **Stealth SDK:** `stealth/{bundle,discoveryBinding,derive-canonical,resolve}.ts`, `stealth/internal/entropy.ts`.

---

## YIELD (#315)

| Behavior | Stable ref | Code ref | Verdict | Sev | Note |
|---|---|---|---|---|---|
| Pool-layer value conservation is denominated in the pp-share (ppUSDC) ERC-20; yield appreciation is **external** to the pool (wrapper exchange rate) | key-arch §3.1 (per-label conservation); pool treats `tokenId` as opaque ERC-20 | `PPYieldToken.sol:20-25` "shielding/unshielding a fixed share amount leaks no value delta"; `PPRouter.sol:143` inserts leaf for `_value` | ALIGNED | — | The crux the circular `yield.md` would rubber-stamp — it **does** hold: pool conservation is in ppUSDC units, unaffected by rate drift. |
| Deposit shields **exactly** the committed `_value`; `_total = _value + vettingFee` pulled by entrypoint | base deposit fee model (vetting fee in pool asset) | `PPRouter.sol:128-130,144-149,265-267`; SDK builds a **standard** deposit proof, identical context, only re-targets calldata (`PoolSessionYieldDeposit.ts:71-107`) | ALIGNED | — | Commitment value and proof public signals are byte-identical to a plain ppUSDC deposit. |
| Relayed withdraw: fee cap `feeAmount ≤ ENTRYPOINT.assets(tokenIdOut).maxRelayFee`; `feeAmount ≤ amountOut`; `msg.value == nativeGas` | `PrivacyPoolRelay._relay` L186-188, L182 | `PPRouter.sol:178-179,177` | ALIGNED | — | Fee cap & native-gas checks mirror the canonical relay exactly (denominated in pp-shares). |
| PayoutRouting is read from proof-bound `context` (`transactParams.data`), not a mutable relayer field | `PrivacyPoolRelay._relay` (payout from `transactParams.data`, bound by proof context) | `PPRouter.sol:172-173`; SDK pre-authorization guard `payoutRoutingGuard.ts:27-64` asserts recipient/feeAmount/nativeGas == caller intent | ALIGNED | — | SEC/theft-guard fix (`0533bf6c`) present and shared with the plain path. |
| Nullifier uniqueness / keystore & ASP root gating unchanged | key-arch §2, §3.3 | `PPRouter.sol:193` delegates verification to `POOL_VAULT.transact` | ALIGNED | — | Router is a pass-through processor; touches no proof-verification logic. |
| `ragequit` fund-safety failsafe still reachable | key-arch §3.6 (funds never seizable) | `PPYieldToken` redeem path never gated by `pause` (`maxDeposit/maxMint` gate deposits only, L203-211) | ALIGNED | — | Ragequit pays ppUSDC to owner; owner redeems via wrapper `redeem` independently of the router — never pausable. |
| Withdraw enforces `recipient != 0` | `PrivacyPoolRelay` intentionally does **not** (INTL-14 footgun) | `PPRouter.sol:174-176` | EXTENSION | Info | Stricter than canonical, documented as footgun removal. Improvement, not a divergence. |
| Dust-fee waiver: a fee whose `previewRedeem` rounds to 0 is redirected to recipient instead of reverting | canonical relay always pays exact `feeAmount` | `PPRouter.sol:186-188` | EXTENSION | Low | Value-conserving (all shares reach recipient); prevents a `ZeroAssets` revert. Not in `PrivacyPoolRelay`. |
| New per-asset admin (Ownable2Step): `setFeeBps ≤ 20%`, `claimFees`, `pause`, `rescueToken`, `setRewardsController`, `claimRewards` | base pool has **no** per-asset admin/trust role | `PPYieldToken.sol:96-153,282-293` | EXTENSION | Low | Expands the trust surface beyond base v2. Bounded & non-seizing (see below) — does not violate §3.6, but is a new trust assumption the circular `yield.md` would not scrutinize. |
| Ops surface `skim`/dust, factories, rewards not in PR summary | PR #315 lists router+wrapper+zap+factories+sessions | `PPRouter.sol:229-236`, `PPYieldToken.sol:113-143` | EXTENSION | Info | Minor scope expansion over the PR summary; reasonable ERC-4626 wrapper ops. |

### Expanded EXTENSION findings (yield)

**Y-E1 — New trusted per-asset admin (trust-surface extension, Low).**
`PPYieldToken` introduces an `Ownable2Step` admin absent from the base-v2 pool trust model. Adversarial analysis of whether it can breach §3.6 ("user funds can never be destroyed or seized"):
- `setFeeBps` is capped at `MAX_FEE_BPS = 2000` (20%) and applies **only to the yield delta since the last checkpoint** (`_pendingFees`, L282-286), never to principal. A front-run `setFeeBps(2000)` before a large withdrawal captures at most 20% of *accrued yield*, never principal.
- `pause` gates `deposit`/`mint` only (`maxDeposit`/`maxMint` → 0, L203-211); `redeem`/`withdraw` are never pausable, so principal is always exitable.
- `rescueToken` explicitly forbids the underlying asset (L149), so backing cannot be pulled.
- `renounceOwnership` is disabled (L197-199), so the role can't be stranded.

**Conclusion:** bounded and non-seizing — **upholds** the fund-safety invariant. Flagged only because it is a genuinely new trust assumption the self-authored `yield.md` would rubber-stamp without comparison to base v2.

**Y-E2 — `recipient != 0` and dust-fee waiver (Info/Low).** Both are deliberate, documented deviations from `PrivacyPoolRelay` (INTL-14). Neither weakens an invariant; the waiver keeps value conservation (recipient receives the waived shares).

### YIELD verdict: **ALIGNED.**
No CONTRADICTION against the stable references. Every base-v2 invariant (value conservation, nullifier uniqueness, keystore/ASP gating, fee-cap model, ragequit fund-safety) is upheld. Divergences are all EXTENSIONS — stricter guards, a dust-fee convenience, and a bounded non-seizing yield-admin role. The circular `yield.md` would have rubber-stamped the pp-share conservation model and the new admin trust surface; both were re-checked here against base v2 and hold.

---

## STEALTH (#317)

Stable-reference note: base v2 has **no** EIP-5564 stealth-address concept, so the applicable stable references are (a) the EIP-5564 / ScopeLift scheme-1 recipe the code cites, and (b) key-arch §3.4's *principle* "the sender never learns the [recipient's spending] secret." The module is a standalone SDK add-on and touches **no** pool/circuit/keystore code — it cannot contradict an on-chain invariant.

| Behavior | Stable ref | Code ref | Verdict | Sev | Note |
|---|---|---|---|---|---|
| Sender derives stealth address by point addition `spending_pub + hash·G`; never derives the stealth private key | key-arch §3.4 principle "sender never learns the secret"; EIP-5564 scheme 1 | `derive-canonical.ts:119-127,137-138` (metaAddress dropped, no priv computed) | ALIGNED | — | Correct EIP-5564 asymmetry; recipient-exclusive spend. Actually **improves** on §3.4's cold-start "undelivered secrets" locking factor — recipient recovers the key from the announcement, no sender→recipient secret delivery. |
| CSPRNG-only ephemeral entropy, no seed parameter | PR #317 "CSPRNG-only"; STLTH-13 / DEV-13 | `entropy.ts:16-42` (handle bound at load; `null` → hard refuse), `derive.ts:31-35` (no seed arg) | ALIGNED | — | No deterministic fallback path exists. |
| Announce metadata = 1-byte view tag; scheme ids canonical `0x0001` / FluidKey `0xfffe` | PR #317 | `derive-canonical.ts:128-135`, `SCHEME_CANONICAL`/`SCHEME_FLUIDKEY` | ALIGNED | — | Matches PR + commit `1111d13d`. |
| `composeWithdrawalBundle` binds withdrawal destination == announcement stealth address (STLTH-18) | PR #317 | `bundle.ts:49-66` | ALIGNED | — | Throws on decoupling; recipient re-verifies at recovery. |
| `verifyAnnouncementBindsToWithdrawal` requires same-tx and matching destination | PR #317 | `discoveryBinding.ts:47-67` (BIND-01: rejects foreign-tx withdrawals) | ALIGNED | — | Closes the false-positive-accept vector. |
| `resolveRecipient({kind:"raw"})` validates an uncompressed spending pubkey (curve membership) | PR #317 | `resolve.ts:26-45` | ALIGNED | — | Raw 65-byte key → FluidKey scheme; ENS/ERC-6538 explicitly deferred (STLTH-05). Matches "more modes will follow." |

### STEALTH verdict: **ALIGNED.**
No CONTRADICTION. The module matches the EIP-5564 recipe it cites and the PR-stated scope, preserves the "sender never learns the recipient's secret" principle, and — being off-chain and touching no pool/circuit/keystore code — bends no base-v2 on-chain invariant. No finding the circular `stealth.md` would have hidden.

---

## Bottom line for spot-check
- **YIELD: ALIGNED** — 0 confirmed contradictions. Notable EXTENSIONS to verify if desired: (Y-E1) new bounded, non-seizing per-asset admin in `PPYieldToken.sol:96-153` (fee ≤20% of yield only, redeem never pausable, underlying un-rescuable); (Y-E2) `recipient != 0` (`PPRouter.sol:174-176`) and dust-fee waiver (`PPRouter.sol:186-188`) diverge from `PrivacyPoolRelay` by design.
- **STEALTH: ALIGNED** — 0 confirmed contradictions. Off-chain module; upholds the sender-never-learns-secret principle (`derive-canonical.ts:119-138`) and CSPRNG-only entropy (`entropy.ts:16-42`).
- **No CONFIRMED contradiction to escalate.** The circular spec-alignment's two biggest blind spots — the pp-share value-conservation model and the new yield-admin trust surface — were re-checked against base v2 here and both hold.
