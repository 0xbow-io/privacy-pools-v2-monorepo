# Airdrop Module — Design & Security Review

**Date:** 2026-07-08
**Type:** design-stage review (no code exists yet — reviewing `airdrop/docs/DESIGN.md` v0.1, converged 2026-06-02)
**Reviewer scope:** design soundness + security + verification of the DESIGN §9 "V2 substrate" citations against the *current* `v2-monorepo` (`v2.0` branch, HEAD `d91112f2`, which now includes yield #315, batch #316, stealth #317 — all landed after the design was written).
**Source of truth:** `/Users/nh2/0xbow/v2-monorepo` (cited inline as `path:line`).

> **Honesty note (Directive 0):** Throughout, "design says X" = a claim in DESIGN.md; "verified X" = I read the cited v2 code and confirmed it. Where I could not verify a design-internal claim (e.g. the not-yet-written claim circuit) I mark it Open-question, not fact.

---

## 1. Readiness verdict

**The design is directionally sound and the core reward-model math is correct, but it is NOT build-ready as written.** Three things must be closed first, all concentrated in the parts the design itself flags as hardest (§4 mint, §5 solvency, and the operator trees):

1. **The sanctioned mint entrypoint (§4) is a solvency-and-theft hole against the *core* pool, not just the airdrop.** Because amounts are hidden, the pool cannot check at mint time that a reward note is backed by remaining escrow, and (as designed) the reward note lives in the *same* vault/asset balance as everyone else's deposits. An over-mint therefore lets reward-note holders withdraw *other depositors'* funds. This is the single most dangerous addition and is currently defended only by "operator sets the rate conservatively." **Blocker.**

2. **The sorted nullifier tree's completeness is SAFETY-critical, but the design files it under the same "weakly-verified, omission = liveness only" umbrella as the eligibility tree.** An omitted nullifier lets a *spent* note take the *open* path and over-claim `T − createdAt` instead of `spentAt − createdAt` → escrow over-draw → (via #1) pool insolvency. The "no on-chain verification; correctness established off-chain by a scan anyone can run" stance (§3.1 blockquote) makes the operator fully trusted for a solvency-critical property. **Blocker (must be re-framed and hardened).**

3. **The claim circuit must bind the nullifying key to the note owner via keystore inclusion (exactly as `Transact.circom` does), or the per-note claim nullifier is forgeable → double-claim.** The §3.3 signal sketch omits `keystoreRoot` and the keystore Merkle path. Without it, an attacker computes two different claim nullifiers for the same note using two different `nullifyingKey` values → double-drain. **Blocker for the circuit phase.**

The good news: none of the three is a dead end. The reward-model conservation invariant is genuinely correct (I checked the split/withdraw cases), the non-membership construction is viable, and the substrate citations are — surprisingly, given the intervening feature merges — almost all still exact.

---

## 2. Substrate-citation verification table (DESIGN §9 vs current v2 code)

| DESIGN §9 claim | Cited loc | Verified against current v2 | Status |
|---|---|---|---|
| `commitment = Poseidon(precommitment, label)` | `Deposit.circom:49-76` | `Deposit.circom:64-68` | ✅ exact |
| `precommitment = Poseidon(noteAddressHash, tokenId, value, metadata=0)` | same | `Deposit.circom:49-56`; `metadata=0` at :55 | ✅ exact |
| `label = Poseidon(precommitment, depositSecret)` | same | `Deposit.circom:58-62` | ✅ exact |
| `noteAddressHash = Poseidon(ownerAddress, noteSecret)` | same | Declared as private input w/ that comment `Deposit.circom:23`; computed form in `Transact.circom:177-178` (`Poseidon(2)`) | ✅ consistent |
| `metadata` 4th input hardcoded 0, future hook | — | `Deposit.circom:55`, `NoteCommitment.circom:44` (param, passed 0 by callers `Transact.circom:252`) | ✅ exact |
| `nullifierHash = Poseidon(privateNullifyingKey, commitment)` | `Transact.circom:226-233` | `Transact.circom:229-233` | ✅ exact |
| `commitments[hash] = block.timestamp` (createdAt) | `PoolVault.sol:122,166` | `PoolVault.sol:122` (deposit), `:166` (transact outputs) | ✅ exact |
| `spentNullifiers[hash] = spentAt` on transact/ragequit | `PoolVault.sol:173,220` | `PoolVault.sol:173` (transact), `:220` (ragequit) | ✅ exact |
| Timestamped leaves `Poseidon(LEAF_TAG, hash, block.timestamp)` for commitment & nullifier | `PoolVault.sol:124,167,174,223` | `PoolVault.sol:124,167,174,223`, via `PoseidonT4.hash([TAG, hash, ts])` | ✅ exact (see precision note ↓) |
| LEAF_TAG constants | `utils/Constants.sol:15-22` | `COMMITMENT_LEAF_TAG` :15, `NULLIFIER_LEAF_TAG` :21 | ✅ present in range |
| ASP gate `associationSetRoot == latestASPRoot()` (latest-only) | `PoolVault.sol:347` | Actual `PoolVault.sol:356` (and `:354` state-root known-check) | ⚠️ **drifted +9 lines** (claim still true) |
| No note-minting; release path `_transferAsset` | `PoolVault.sol:392-398` | Actual `_transferAsset` at `PoolVault.sol:401-407` (ETH `safeTransferETH` / ERC20 `safeTransfer`, no mint) | ⚠️ **drifted +9 lines** (claim still true) |
| "No note-minting exists" | — | Confirmed: only "mint" in `packages/contracts/src` is `PPYieldToken.maxMint` (ERC-4626 share mint, `PPYieldToken.sol:209`), NOT a pool-note insert. Pool only inserts commitments behind a Deposit/Transact Groth16 proof. | ✅ verified true |

**Citation-drift summary:** 9 of 11 line citations are still *exact* despite yield/batch/stealth landing in between; 2 drifted by +9 lines (ASP gate 347→356, `_transferAsset` 392→401) but both underlying claims remain true. **No claim was falsified.** Two precision nits below.

**Precision nit A (Minor):** §9 writes the timestamped leaf as "`Poseidon(LEAF_TAG, hash, block.timestamp)` … for **both** commitment and nullifier leaves." There is **not one `LEAF_TAG`** — there are **two distinct domain tags** (`COMMITMENT_LEAF_TAG`, `NULLIFIER_LEAF_TAG`, `Constants.sol:15,21`) and the hash is `PoseidonT4` (3 field inputs). This matters for the airdrop's tree builder: the nullifier snapshot leaves must be derived from the nullifier set, not confused with the commitment-tagged leaves.

**Precision nit B (Minor):** §3.1 calls the sorted nullifier tree "a *faithful copy* of the pool's on-chain nullifier **leaves**." It is not a copy of the on-chain LeanIMT leaves — those are `PoseidonT4([NULLIFIER_LEAF_TAG, nullifier, ts])` in append order. The airdrop tree re-hashes the nullifier **set** into a *different* leaf format (`Poseidon(nullifier, spentAt)`), sorted. Correct phrasing: "a faithful copy of the on-chain nullifier **set** (nullifier, spentAt), re-encoded as a sorted tree." Verifiability is unaffected (the pairs are recoverable from transact/ragequit calldata + block timestamps, cross-checkable against the `spentNullifiers` getter), but the wording should be tightened so implementers don't try to literally copy state-tree leaves.

---

## 3. Findings by area

Severity legend (design review): **Blocker** = must be resolved before build; **Major** = must be resolved before ship, may proceed to build with a plan; **Minor** = tighten; **Open-question** = decision/verification owed.

### §1 Reward model soundness — mostly SOLID

- **[Verified] The conservation invariant holds under splits, merges, and withdrawals.** I checked the algebra beyond the A/B example. Split of a value-10 note at `t=5` into 6+4: original weight `10×5=50`; children `(6+4)×(T−5)=10(T−5)`; total `10T` = the un-split `10×T`. ✅ Because V2 conserves value per-label at each transact instant (`ValueConservation`, `Transact.circom:257-265`) and time restarts for children, the integral is exactly partitioned. Withdrawal (`amountOut>0`) correctly removes value from the pool at `spentAt`, so churn (deposit→immediate-withdraw) earns ≈0. **This is a genuine strength: the integral formulation is inherently flash-loan / snapshot-boundary resistant** — a deposit at `T−ε` earns `value×ε ≈ 0`. Worth stating explicitly as an anti-gaming property.

- **[Verified reasoning] Per-note (not per-label) granularity is the correct choice.** Labels are inherited across transfers (`outputLabel` carried through, `Transact.circom:253`), so a label-level claim would collapse B's two disjoint intervals into one and also walk/expose lineage. Per-note is both correct for the A/B model and the better privacy posture. ✅

- **[Open-question / Major — cross-asset rate] `value × time` is per-`tokenId`, but §2 and the emission `rate` treat it as a single scalar.** Different pool assets have different scales (1 ppUSDC/USDC ≈ 1e6, 1 ETH = 1e18) and different economic value per unit. A single `emissionRate` across assets is meaningless / exploitable (deposit the cheapest-per-field-unit asset to farm). The design must specify **per-asset emission rate** (or restrict a stream to one `tokenId`). Stream 3 is described as "single-pool," which helps, but Stream 2 "governance emissions" over a multi-asset pool needs this pinned. **Owed decision.**

- **[Minor] Multi-airdrop windowing formula is arithmetically fine** (`min(spentAt,T) − max(createdAt, T_prev)`), but note it can go **negative** for notes fully outside `[T_prev, T]` (created after T, or spent before T_prev). The circuit must clamp to ≥0 (or the operator must exclude such notes from eligibility). Flag as a circuit range-check obligation, not a design flaw.

### §2 Non-membership construction — VIABLE, but completeness is safety-critical

- **[Verified viable] The sorted-tree gap proof is verifiable as claimed, *conditional on the tree being the correct sorted+complete tree*.** Anyone can rebuild the sorted tree from the on-chain nullifier set and check the published root. In-circuit, non-membership of `x` = two adjacent leaves `lo < x < hi` at consecutive indices under `BinaryMerkleRoot`. The spike (`circuits/spike/`, 12,904 constraints @ depth 20 per `done.md`) already demonstrates absent-accepted / present-rejected / out-of-gap-rejected. The soundness of "sorted-ness" is established **off-chain** (the root is only trusted because the scan confirmed it encodes the correctly-sorted, complete set) — the circuit itself does not prove global sortedness, only local adjacency + range. **This is fine *if and only if* the completeness/sortedness scan is actually performed and enforced.**

- **[Blocker — re-classify tree trust] Nullifier-tree omission is an OVER-CLAIM (safety) vector, not liveness.** The §6 table lists the nullifier tree as "Publicly verifiable," which is good, but the §3.1 prose lumps it with the eligibility tree whose omission is explicitly "liveness/fairness, not safety." They are **not** symmetric:
  - Eligibility omission → a user *can't* claim → liveness only. ✅ benign.
  - **Nullifier omission → a *spent* note appears unspent → its owner takes the open path → claims `T − createdAt` instead of the true `spentAt − createdAt` → over-draws escrow.** Given §4 shares the pool, this over-draw becomes pool insolvency (see §4 finding). **Safety-critical.**
  - The design's stance "we do not need strong on-chain verification (no validity SNARK, no fraud-proof window); correctness established off-chain by the subset/faithful-copy scan" (§3.1 blockquote) therefore means: **the operator is fully trusted for a solvency-critical property, with only optimistic/social verification.** For Stream 3 (externally funded) this may be acceptable if the escrow is asset-isolated (see §4 mitigation); for Stream 2 sharing the main pool it is not. **Must be re-framed, and either (a) an on-chain root commitment + challenge window, or (b) hard asset-isolation of escrow, is required.**

- **[Verified] Open/closed path privacy IS achievable in Groth16.** Groth16 has a fixed R1CS: both the membership and non-membership sub-circuits are *always* synthesized; a private selector picks which duration is used. Constraint count and public-signal shape are identical for every claimant, so the path does not leak. ✅ **But** (Open-question → Major, circuit phase) the selector must be **constrained for consistency**: a member must not be able to set `isSpent=false` and supply a bogus non-membership witness. This is naturally enforced *because* non-membership is genuinely unsatisfiable for a member (any adjacent pair bracketing `x` would have `lo=x` or `hi=x`, breaking strict `<`) — **but only if the tree is complete.** So path-privacy soundness *also* depends on the completeness scan above. The circuit must additionally forbid `duration<0` and forbid the closed path selecting a `spentAt < createdAt`.

- **[Verified] Anti-gaming: a spent note cannot take the open path.** Confirmed by the above — its nullifier is a leaf, so no valid gap brackets it. Holds **conditional on completeness.**

### §3 Claim-nullifier domain separation — SOUND, with one Blocker dependency

- **[Verified sound] `Poseidon(nullifyingKey, commitment, airdropId)` is unlinkable to the pool spend nullifier `Poseidon(privateNullifyingKey, commitment)`.** Two independent reasons: (a) different Poseidon arity (3 vs 2 inputs → different permutation width / round constants → a different function even at `airdropId=0`); (b) an observer would need `(nullifyingKey, commitment)` — the note secret — to correlate the two outputs, which preimage-resistance denies. Cross-airdrop claims of the same note use different `airdropId` → different nullifier → correctly allowed (different windows). ✅

- **[Blocker — the claim nullifier is forgeable without keystore binding]** Double-claim prevention rests on the claim nullifier being a *deterministic function of the note*. But `nullifyingKey` is a witness. In `Transact.circom` the pool forces `privateNullifyingKey` to be *the* key bound to `ownerAddress` via a `KeystoreLeaf` + `BinaryMerkleRoot` inclusion against the public `keystoreRoot` (`Transact.circom:93-110`, and the pool checks `keystoreRoot` is known, `PoolVault.sol:355`). **The §3.3 claim-circuit signal sketch omits `keystoreRoot` and the keystore Merkle path.** If the claim circuit does not replicate this binding, an attacker who owns a note (or merely a stolen commitment opening) can compute claim nullifiers with *arbitrary* `nullifyingKey` values → many distinct claim nullifiers for one note → **double/multi-claim → escrow over-draw**. **Fix: the claim circuit MUST prove keystore inclusion of `(ownerAddress, nullifyingKey)` against a public `keystoreRoot`, identically to transact.** Add `keystoreRoot` to §3.3 public signals and the keystore path to the witnesses. Also depends on V2 guaranteeing exactly one nullifying key per note (keystore key updates would otherwise yield two valid claim nullifiers) — verify against keystore update semantics before build.

### §4 The sanctioned mint entrypoint — DEEPEST RISK (Blocker)

This is the security center of gravity. V2 today has a minimal trusted computing base: the pool inserts a commitment **only** behind a Deposit/Transact Groth16 proof it verifies itself (verified: every `_insertInStateTree` call site at `PoolVault.sol:126,178,225` is preceded by an in-contract `verify`). A mint entrypoint that inserts a reward commitment *without* a pool-verified deposit proof punches through this. Attack surface it adds:

1. **[Blocker] Hidden-amount solvency cannot be enforced at mint time.** The reward note's value is inside the commitment (hidden). The pool therefore **cannot** check "this mint's amount ≤ remaining escrow" — it doesn't know the amount. So the mint entrypoint either (a) inserts the commitment unconditionally (no amount check possible) or (b) reverts on some public counter. Amount-privacy and per-mint solvency-checking are in **direct, irreconcilable conflict** on-chain. The design's "solvency held by rate/cap + nullifiers, not a running sum" (§4/§6) is an *off-chain, operator-trust* argument, not an on-chain guarantee.

2. **[Blocker] Over-mint = theft from *other* depositors, because the reward note shares the pool's vault and asset balance.** §4/§7-ch3 put the reward note "into the pool… inside the pool's anonymity set (a normal withdrawal)." So reward notes draw against the *same* `Coin`/ERC20 balance as normal deposits. If total minted reward value exceeds the pre-funded lump (due to a mis-set rate, a buggy/omitted nullifier tree per §2, or a claim-circuit bug per §3), the surplus is silently backed by other users' deposits — and reward-note holders withdraw it via an ordinary transact. **The pool has no accounting that can detect this**, precisely because amounts are hidden. **Required mitigation: asset-isolate the escrow.** Either (i) the reward asset is a *dedicated* `tokenId` never used for public deposits, so an over-mint can only bankrupt the airdrop escrow and never touch third-party funds; or (ii) a separate vault/sub-ledger for reward-backed balances. Without isolation, a single off-chain operator error is a whole-pool solvency event. **This should be a hard design invariant, not an "open decision."**

3. **[Blocker/Major] The entrypoint expands the pool's TCB to include the whole distributor + claim circuit + their upgradeability.** The pool must whitelist *some* caller (the `RewardDistributor`) as authorized to mint. That contract's correctness, its Groth16 claim verifier, its admin keys, and its `UpgradeCap`/proxy now all sit inside the pool's trust boundary. A compromised/upgraded distributor = arbitrary pool mint = drain. Contrast today's TCB (3 fixed verifiers). Requirements: (a) the mint entrypoint must be gated by a dedicated role, not an EOA; (b) strongly prefer a *non-upgradeable* distributor or a timelock on its upgrade; (c) consider making the pool verify the claim proof *itself* (like it does deposits) rather than trusting the distributor's verification — this keeps proof-verification inside the pool TCB. The design should state which trust model it picks.

4. **[Major] Interaction with per-label value conservation and ASP gating.** A minted reward note carries some `label`. To later spend it *privately*, `Transact.circom:208-224` requires that label's hash be a member of the association set (`associationSetRoot == latestASPRoot()`, `PoolVault.sol:356`). **A reward note whose label is not registered in the ASP is only exitable via ragequit** (which exposes the label and is the "dirty" exit) — directly contradicting §7-ch3's promise that the reward redeems as "a normal withdrawal inside the anonymity set." So the airdrop must **register each reward note's label in the ASP registry** (`ASPRegistry.registerLabel` / postman root update, `ASPRegistry.sol:52,62`). This is an unstated cross-module dependency and a privacy footgun. Also: because the mint bypasses `ValueConservation`, the reward note's value is *created from nothing* in-circuit — value conservation is deliberately not enforced for it — which is exactly why the escrow-isolation invariant (#2) is load-bearing.

5. **[Major] Root-buffer churn / liveness coupling.** Verified: the state-tree root history is a **bounded circular buffer** (`RootBufferUpgradeable`, configurable `_size`, `isKnownRoot` scans it, `RootBufferUpgradeable.sol:36-78`), and transact requires `isKnownRoot(stateRoot)` (`PoolVault.sol:354`). Every reward mint inserts leaves and advances the buffer (`_updateRoot`). A burst of claims can **evict roots that in-flight normal transacts were proven against**, reverting honest withdrawals with `PoolVault_UnknownStateRoot`. Mint frequency is now coupled to the pool's proof-freshness window. Needs rate-limiting or buffer-sizing analysis; at minimum, document the coupling.

### §5 Escrow solvency without an on-chain running sum — INSUFFICIENT as stated

- **[Major] The "bounded by rate/cap + nullifiers" claim is only defensible via an *unstated* observability argument.** The operator cannot sum hidden per-note values, so how is `rate` chosen so `Σ(value×duration)×rate ≤ budget`? The saving grace, which the design never states: **the total live value in the pool equals the pool's on-chain token balance at every instant**, so `Σ_notes value×duration = ∫ poolBalance dt`, which is *publicly observable* from the balance history. An operator can bound total accrual by `rate × ∫balance dt` and fund accordingly. **This works — but it is exactly the reasoning the design must spell out, and it silently assumes the eligible subset ⊆ all notes (true) and that no hidden amount exceeds the balance (true only if the mint-escrow is asset-isolated per §4-#2, else reward notes inflate "balance" and the bound becomes circular).** So §5's solvency and §4's isolation are the *same* requirement viewed twice.

- **[Blocker restated] Can hidden amounts over-claim the budget? Yes, in three ways the contract cannot catch:** (a) operator sets `rate` too high → aggregate valid claims exceed budget; (b) nullifier-tree omission → spent notes over-claim via open path (§2); (c) claim-circuit / keystore-binding bug → double-claim (§3). In all three, each *individual* proof is valid, the running total is unknowable on-chain, and the shortfall is realized as pool insolvency. **The only real defenses are: asset-isolate the escrow (contain the blast radius), verify the trees, and bind the key — all upstream. The "no running sum" property is acceptable *only* with escrow isolation.**

- **[Open-question] The deferred "privacy-preserving claimed-total accumulator" (§5) deserves a second look** precisely because it is the one mechanism that could give an on-chain solvency bound without a deadline. Flag it as the natural v1 upgrade, not merely a deadline-avoidance alternative.

### §6 Privacy leak channels — three closed, one residual

1. **Payout amount → closed** by shielded-mint-against-pre-funded-lump (no per-claim transfer). ✅ Verified this is consistent with the vault model (a lump pre-fund + amount-hidden inserts).
2. **Claim ↔ note linkage → closed** by the separate-domain claim nullifier (§3, sound *given* keystore binding).
3. **Claim ↔ identity → closed** by minting into the pool (no recipient address) + relayer. **Compatible with the new stealth feature:** deposits/transacts already emit an encrypted discovery blob `Note(hint, data)` (`PoolVault.sol:132,193`); the reward mint should emit the *same* event so the recipient can scan/decrypt — this is a positive composition, but must be added to the mint entrypoint's interface (currently unmentioned).
4. **Timing correlation → only mitigated, not closed (Minor→Major residual).** Randomized/interval claiming + long redemption grace reduce but do not eliminate correlation between "a note spent at `spentAt`" and "a claim referencing that duration." Two concrete residuals: (a) a claimant who claims immediately after `T` for an open note, then the note is spent shortly after, narrows the anonymity set; (b) with per-asset rates and small pools, the *set* of claim timings correlates with deposit cohorts. This is inherent and acceptable if disclosed, but the design overstates it as a closed channel in the §7 header ("the four leak channels" implies all closed). Recommend downgrading ch4 to "mitigated (residual)."

- **[Minor] Public-footprint uniformity claim depends on fixed NxM-free proof shape.** Because v0 is one-note-per-claim with both paths always synthesized, the footprint is uniform — good. If aggregation (deferred, §8) ever lands, uniformity breaks (proof size reveals note count). Keep aggregation out of v0 as planned.

### §7 Recovery / sweep — ACCEPTABLE, one edge to pin

- **[Minor] Forfeiture edge is honestly acknowledged** (a reward note unredeemed past the deadline is forfeit because the contract can't distinguish unredeemed-claimed from unclaimed). The long grace + min-floor + UI nudges are reasonable. **Pin the min-floor as a security parameter** (it prevents an operator from setting an abusively short window to force forfeiture-then-sweep — a griefing/theft vector). The min-floor is therefore *safety-load-bearing*, not cosmetic; give it a concrete value and make it immutable per stream.
- **[Open-question] Sweep target and timing must not itself leak.** A sweep of "remaining escrow" reveals `budget − Σredeemed` at sweep time. If the pool balance is public and the airdrop asset is isolated, the sweep discloses aggregate unredeemed value — acceptable, but confirm it doesn't correlate with any individual non-redemption.

### §8 Open decisions — which are security-load-bearing

Flagging the §11 items by whether they gate security:

| §11 decision | Security-load-bearing? | Must close before build? |
|---|---|---|
| Delivery default (shielded-mint vs address) | **Yes** — address mode re-opens amount + identity leaks (ch1/ch3) unless carefully relayered | Yes — define the address-mode privacy story or ship shielded-only in v0 |
| **Reward asset = existing pool asset vs new asset** | **YES — this is the §4-#2 escrow-isolation Blocker in disguise** | **Yes — must be "isolated/new tokenId" for safety** |
| Grace-period default + **min floor** | **Yes** (§7 — anti-griefing floor) | Yes — set immutable floor |
| Stream-3 permissioning | **Yes** — an open/unpermissioned stream creator who also supplies the trees is the fully-trusted operator of §2/§5; recommendation "ASP-curator-approved" is correct | Yes |
| Aggregation in v0 | No (correctly deferred; keep deferred for footprint uniformity) | No |

**The design labels "reward asset = pool asset or new asset" as a routine open decision. It is actually the load-bearing solvency invariant (§4-#2). Re-classify it as a Blocker-level design invariant, not an open knob.**

### §9 Interaction with the new v2.0 features (yield / batch / stealth)

- **Yield (ppUSDC, #315) — [Major, needs a decision].** `PPYieldToken` is an ERC-4626 wrapper (`PPYieldToken.sol`); the pool treats it as just another ERC20 (`tokenId = token address`). A yield-bearing note's `value` field is a **fixed share count** (yield accrues in the *share price*, not the count — the note's committed `value` never changes while held). So `value × time` rewards **share-count × time**, not underlying-USD × time. Consequences: (a) mechanically fine (value is stable while held, so the integral is well-defined); (b) but a ppUSDC note and a raw-USDC note of the "same" economic value get *different* `value` integrals and must be on different per-asset rates (see §1 cross-asset finding); (c) users in ppUSDC already earn Aave yield — the airdrop stacks on top, which may or may not be intended. **The design predates yield and never addresses it. At minimum: decide whether yield assets are airdrop-eligible and, if so, mandate per-asset rates.** Also confirm ppUSDC share count is the intended reward basis (vs. reading `convertToAssets` at snapshot — which the operator *cannot* do per-note since values are hidden, so share-count is effectively forced).
- **Batch (#316) — no impact.** "Batch" is relayer-side (`PrivacyPoolRelay.relayBatch`, `PrivacyPoolRelay.sol:92`), not a new pool insertion path. Each batched transact still records its own `(nullifier, spentAt)` / `(commitment, createdAt)` at the shared `block.timestamp` — the same as any single tx. The airdrop's timestamp assumptions are unaffected. (One micro-note: many notes in a batch share an identical timestamp, which very slightly coarsens duration granularity, but this is already true of any co-block activity.)
- **Stealth (#317) — positive composition.** The encrypted `Note(hint, data)` discovery event (`PoolVault.sol:132,193`) is exactly the delivery channel the shielded reward mint needs (§6-ch3). The reward mint entrypoint should emit the same event so recipients can scan. **No conflict; the design should adopt it explicitly** rather than inventing a parallel discovery mechanism.

---

## 4. Concrete pre-build checklist (derived from the Blockers)

1. **Make escrow asset-isolation a hard invariant** (reward asset = dedicated `tokenId`, never a public-deposit asset) OR add a separate reward sub-ledger. Closes the §4-#2 / §5 theft-of-third-parties blast radius. *(Blocker)*
2. **Re-classify the sorted nullifier tree as safety-critical** and add either an on-chain root commitment + challenge window or a mandatory, enforced completeness scan; document that omission → over-claim, not liveness. *(Blocker)*
3. **Add `keystoreRoot` + keystore Merkle inclusion to the claim circuit** so `nullifyingKey` is uniquely bound to the note owner (mirror `Transact.circom:93-110`); verify keystore per-note key uniqueness/immutability. *(Blocker)*
4. **Gate the mint entrypoint by a dedicated role; prefer the pool verifying the claim proof itself, and a non-upgradeable/timelocked distributor.** *(Major → Blocker for TCB)*
5. **Register reward-note labels in the ASP** (or accept ragequit-only exit) so §7-ch3's "normal withdrawal" privacy actually holds. *(Major)*
6. **Specify per-asset emission rates** (or one-tokenId-per-stream) and decide yield-asset eligibility. *(Major)*
7. **Analyze root-buffer churn** vs. mint frequency; rate-limit if needed. *(Major)*
8. **Circuit range obligations:** clamp `duration ≥ 0`, forbid `spentAt < createdAt`, enforce the open/closed selector-consistency constraint. *(Major, circuit phase)*
9. **Emit the stealth `Note(hint,data)` event from the reward mint** for recipient discovery. *(Minor)*
10. **Tighten §9 wording:** two LEAF tags not one; "nullifier set" not "leaves"; update the two drifted line cites (ASP gate 356, `_transferAsset` 401). *(Minor)*

---

## 5. What I verified vs. what remains asserted

- **Verified against v2 code:** all §9 formula/timestamp/ASP/no-mint citations (table §2); the keystore binding that grounds the §3 Blocker; the root-buffer boundedness behind the §4-#5 finding; the ASP-membership requirement to privately spend (transact); that yield/batch/stealth are ERC-4626 / relayer-side / discovery-event respectively.
- **Reasoned but NOT code-verified (no code exists):** the claim circuit's soundness (§2/§3 obligations), the mint entrypoint's exact semantics (§4), and the operator tree-builder's completeness enforcement (§2). These are design-stage judgments, flagged as Open-question/Blocker where they gate safety, per Directive 0.
