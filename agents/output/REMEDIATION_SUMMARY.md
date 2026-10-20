# Privacy Pools V2 — External Audit Remediation Summary

Self-contained: every dispositioned finding below carries a plain-language **Issue** and a
**Fix / Disposition** — you do not need the original audit report to read this.

| | |
|---|---|
| **Branch** | `audit/consensys-remediation` — commits on top of `v2.0`, **pushed, not merged** (for review) |
| **Review against** | base **`v2.0`** (not the repo default `dev`): `github.com/0xbow-io/v2-monorepo/compare/v2.0...audit/consensys-remediation` |
| **Sources** | ConsenSys Diligence / tintinweb "minr" report (126 findings @ `b1264a0f`) + Auditware re-audit (5 findings) |
| **Platform status (minr)** | **24 fixed · 21 wont-fix · 3 false-positive · 78 open** (re-triaged 2026-08-16) — see "Open findings" for what the 78 actually contain |
| **Auditware IDs** | This round's `AW-*` IDs are **not** the circuits round's. See "A note on AW-* identifiers". |
| **Internal re-review** | Two rounds over the original 14 commits: round 1 = `36e5f048`, round 2 = `9e784cb3`..`a0c33584`. See "Follow-up fixes". |
| **Branch currency** | `origin/v2.0` **merged in 2026-08-20** (integration step; it does not change the reviewer's diff). The merge surfaced one in-scope finding — see "Branch currency" below. |

## Bottom line

Every actionable finding is resolved, rejected with a documented reason, or accepted-and-documented.
Both High-severity findings are closed. The remediation was reviewed by the team; several proposed
fixes that guarded non-exploitable footguns or touched already-audited crypto were deliberately **not
applied** (see "Reviewed — not fixed"). Each `fixed` verdict on the minr platform links to the exact
on-branch commit. Kept code fixes were mutation-verified where a guard exists.

Two things a reader should not have to dig for. First, the remediation was itself re-reviewed twice,
and both rounds found real defects in fixes already marked done — including one (#600) where the fix
was inert end to end. Fixes are not assumed to work because they were written; each guard was broken
to confirm a test catches it. Second, four corrections are still outstanding **on the minr platform**
rather than in this repo, and correcting this document does not correct them — they are listed under
"Outstanding platform-side triage edits" with the exact edit required.

---

## HIGH severity

### #221 (High) — Reshield/cross-chain swap: relayer inflates `amountSent`, skims the inflation
- **Issue:** the guard meant to bind the relayer-chosen pool outflow to the user's intended amount was
  tautological, so a malicious relayer could over-withdraw and pocket the difference as uncapped dust.
- **Disposition:** **Already fixed by the team** before this pass. Verified present on HEAD.
- **Correct citation: implemented via PR #340; carried into `v2.0` through PR #341.** No further
  merge is needed — the fix is already on `v2.0`. The minr triage note cites **PR #339, which was
  CLOSED and never merged** (it targeted `dev`); #340 landed the same head branch into
  `fat/swaps/fix_rc_08_byte_containemnt`, which #341 merged into `v2.0`.
- **Both paths enforce the same invariant** — `amountSent == net + fee` (equivalently, the signed
  `amountSent` equals the caller's intended gross outflow). What differs is **where in the API the
  check fires**, not the accounting convention:
  - `PoolSessionWithdrawAndSwap` asserts twice: in `prepareSwapQuote`, where `amount` is already
    gross, and again in `relayWithdrawAndSwap`, where `amount` is net and is reconstituted to
    gross at the call site (`amount + feeAmount`).
  - `PoolSessionReshield` asserts once, in `relayReshield`, with the addition done inside the
    helper.
  The `amount` parameter simply means gross at the quote stage and net at the relay stage, which
  is what makes the two helpers *look* like different conventions. They are not.

### #660 (High) — Keystore registration capacity (2^18) strands unregistered owners from both exits
- **Issue:** once the keystore tree fills (2^18 leaves) no new account can register, and unregistered
  owners can neither `transact` nor `ragequit`; deposits are not keystore-gated, so funds can enter a
  state they cannot exit. Raising the cap on-chain would break the depth-18 circuit proofs for everyone.
- **Disposition:** **Accepted & documented (tree-size class).** Not a code fix — the forward fix is
  operational: run the trusted setup at **keystore depth 22 before launch** (or expand the tree later).
  Governance-recoverable; funds never at risk. A PoC confirms existing depth-18 notes survive the
  expansion.

---

## FIXED — Contracts

### #233 — Three PP factories inherit an un-overridden `renounceOwnership`, bricking their deploy fn
- **Issue:** an owner renouncing would permanently disable each factory's only non-view function.
- **Fix (`d808968f`):** override `renounceOwnership` to revert on all three factories. Kept for
  consistency with the existing renounce-freezes on `PPYieldToken` (v2.0) and `RelaySwaps` (finding
  #230), so the factories are not the odd `Ownable` siblings out.

### #131 (Auditware AW-M-01) — Production deploy path skips config validation
- **Issue:** `run()` (the `forge script --broadcast` entrypoint) invoked none of the `DeploymentVerifier`
  checks, so a placeholder or escalation-enabling config could ship an ungovernable protocol.
- **Fix (`b79b9225` + regression test `324470c9`):** run `validate*` before deploy and `verify*` after,
  in `run()`; the mainnet placeholder config now self-rejects. Verified on a real sepolia fork; a
  regression test asserts `run()` reverts on a placeholder config. **This is the highest-value contract
  fix — the consequence is an irreversible ungovernable mainnet deploy, and the mainnet config currently
  ships placeholders.**

### #130 — Ops role config could grant an ops admin an escalation path to UPGRADER
- **Issue:** `_opsAdminRoles` could be configured with `UPGRADER`/`DEPOSITOR`, letting an ops-tier
  admin escalate to upgrade rights.
- **Fix (`b79b9225`, same commit as #131):** the `DeploymentVerifier` allowlist that rejects this
  (`_requireKnownOpsRole`) already existed but ran on no production path. Wiring the verifier into
  `run()` is what actually closes it; the constructor stays configurable by design, with the
  deploy-time allowlist as the guard.

---

## FIXED — SDK

### #600 (Med) — PaymentRequest terminal-flip suppresses discovery of genuine payment notes
- **Issue:** a request's public payload (tag, pubkey, slot hashes) is everything discovery uses to match,
  so any holder can craft a cheap "phantom" note that flips the request to `FULFILLED`. Because discovery
  only scanned `OPEN` requests, the genuine later payment was then never discovered — funds on-chain but
  invisible to the wallet.
- **Fix (`12c00ee3`, retroactivity `36e5f048`):** discovery no longer gates on status — it scans
  all live requests by tag (`getScannableRequests`); only a real slot-consuming match advances
  fulfillment (a 0-value / duplicate phantom cannot); the only terminal states are recipient-`ARCHIVE`
  and time expiry, both user/time-bounded, not attacker-triggerable. The PoC is ported as a passing
  regression.
- **Follow-up (found in review, fixed on-branch):** the 7-day scan expiry was computed from
  `createdAt` on every scan, so it applied **retroactively** — on upgrade, every already-shared
  request older than 7 days would silently drop out of the scan set, recreating exactly the
  invisible-payment failure #600 set out to fix. Expiry is now stamped at generation (`expiresAt`);
  a record without a stamp predates the policy and never expires. The 7-day default is retained as a
  deliberate product decision.
- **Sender-visible expiry (also fixed on-branch):** `expiresAt` is now part of the **shareable**
  `PaymentRequest` payload, not just the recipient's local record, and
  `prepareFulfillPaymentRequest` **rejects an expired request** (`PaymentRequestExpired`) before any
  proof work. A UI-only treatment would not have been sufficient: the SDK is the layer that can
  refuse to spend. Because expiry is intentional rather than incidental, the sender needs both the
  deadline and the enforcement. Requests carrying no `expiresAt` predate the policy and stay
  fulfillable indefinitely. This is a **wire-format addition** to the QR/link encoding — an optional
  field, so older payloads still parse.

### #1070 (Auditware AW-L-02) — Unverified relayer receipt drives note-state to SPENT
- **Issue:** the wallet marked notes SPENT purely on a relayer-supplied txHash's receipt status — a
  relayer returning the hash of an *unrelated* successful tx could make spendable notes look spent.
- **Fix (`efb3fc22`, transfer path `b64e7d2c`, swap paths + fail-open root cause `36e5f048`):**
  before persisting SPENT, parse the receipt's `Transacted` logs and require every spent nullifier to
  appear in a log emitted by the *expected PoolVault*. Verify-and-warn (a benign parse miss never
  strands a real spend).
- **Follow-up (found in review, fixed on-branch):** the gate's `verification` parameter was
  **optional**, so it failed OPEN — `relayWithdrawAndSwap` and `relayReshield` called
  `persistNoteUpdates` bare and skipped it entirely, and `BatchWithdrawOrchestrator`'s public
  `persistBatchNoteUpdates` forwarded an optional value. Since `SPENT` is terminal in the note-status
  transition table, an unverified persist is **unrecoverable** by discovery. The parameter is now
  **required** on both interfaces, which turns any future miss into a compile error, and all
  call sites pass real evidence. Coverage now spans withdraw, batch, transfer, **withdraw-and-swap,
  and reshield**; both swap paths have adversarial regression tests (previously their test doubles
  stubbed `persistNoteUpdates` and asserted nothing, which is why the gap was invisible).
- **Second follow-up (surfaced by the `v2.0` merge, 2026-08-20, fixed on-branch):** cross-chain
  reshield (`PoolSessionReshieldCrosschain.relayReshieldCrosschain`) landed on `v2.0` *after* this
  branch forked and carried the same bare `persistNoteUpdates` call — the identical fail-OPEN hole,
  on a path that did not exist when the fix above was written. Making `verification` **required**
  is what caught it: the omission became a compile error the moment the two histories met, which is
  precisely the outcome that change was made for. Fixed by threading
  `{ expectedNullifiers, receiptLogs }` through, mirroring `relayReshield`; its unit test asserted
  the old three-argument call and its orchestrator double omitted `spentNullifiers`, so both were
  corrected to exercise the gate instead of passing `undefined` through it. **All 10 call sites**
  across the SDK now pass real evidence (verified by inspection, not assumed).

### #281 / #360 — Note secrets + the full note graph persist and export in cleartext (CWE-312)
- **Issue:** no sealed at-rest storage; `exportAccount` emitted secrets in clear.
- **Fix (`ff3b8ecf`, key-binding `36e5f048`):** opt-in `EncryptedStorageService` decorator
  (scrypt-derived key from a runtime passphrase, never persisted; XChaCha20-Poly1305; values-only) +
  sealed `exportAccountSealed` / `importAccountSealed`. Additive; default unchanged.
- **Follow-up (found in review, fixed on-branch):** records were sealed under the derived key alone,
  with nothing binding a ciphertext to the storage key it lived at — so an attacker with **write**
  access to the backing store could transplant a valid record between keys (across owners, chains, or
  record kinds) and it would decrypt cleanly. The record marker, format version, and logical storage
  key are now authenticated as AEAD associated data.

  **No migration is required, but not for the reason first written here.** The earlier wording —
  "the SDK is unreleased (`0.0.0`)" — is not accurate and an auditor will disprove it in one click:
  the package is `private: true` and absent from npm, but `sdk-pre-release.yml` publishes versioned
  GitHub prerelease tarballs (`@privacy-pools-v2/sdk@0.0.0-prerelease.<sha>`) on every push to `dev`
  that touches `packages/sdk/**`, and at least five such prereleases exist (latest `18620ac3`,
  2026-07-27). The SDK *is* distributed; the version string just never moves.

  The correct reason is narrower and stronger: **the at-rest code has never been in a distributed
  artifact at all.** `packages/sdk/src/utils/AtRestSealing.ts` exists on neither `origin/dev` nor
  `origin/v2.0` (verified with `git ls-tree`), so no prerelease tarball has ever contained the
  writer. No ciphertext can exist because nothing that could produce it has shipped. That holds only
  while this branch is unmerged — **if it lands on `dev` before the AAD change, the argument
  expires** and a versioned record format plus a read-path fallback becomes mandatory.

### #501 / #540 — A reversible ASP "rejected" flip permanently strands a spendable note
- **Issue:** a single unverified ASP `getLabelStatus === "rejected"` moved a note to `REJECTED`, which
  had no path back to `ACTIVE` — so a transient/incorrect rejection stranded an on-chain-spendable note.
- **Fix (`7ee30f50`, anchoring + authoritative read `36e5f048`):** demotion to `REJECTED` now
  requires corroboration against the ASP association set; and a **guarded** `REJECTED -> ACTIVE`
  recovery restores a re-approved note only when its nullifier is unspent (the double-count guard —
  a spent note goes to SPENT, never back to ACTIVE).
- **Follow-up (found in review, fixed on-branch) — both guards were weaker than described:**
  > **Trust model:** the ASP is trusted, operator-run infrastructure. Neither of these is an
  > anti-malice measure. Both close the same gap — a guard that was only as current as a snapshot
  > it could not date-check — so the failure they prevent is **stale or internally inconsistent
  > data**, not an adversarial ASP.

  - *#540 was not actually on-chain-anchored.* Corroboration read `aspDataProvider.getLeaves()`, the
    raw HTTP endpoint, which performs no root verification. Label status and leaves are separate
    reads that can disagree — a lagging replica, a snapshot served mid-rebuild, a cache holding a
    superseded set — so corroborating a rejection against an unverified leaf set from the same
    service could confirm a stale view of itself. It now reads
    `IASPClient.getAssociationSetLeaves()`, which rebuilds the LeanIMT root and asserts it against
    the on-chain `latestASPRoot`; that is what makes the second read independent evidence. A failed
    verification defers the demotion rather than stranding the note.
  - *#501's "unspent on-chain" was event-derived.* The check consulted a nullifier set built from the
    ASP snapshot plus a chain tail — a snapshot lagging the chain can omit a recent spend, and on
    snapshot failure the chain scan resumes from the sync cursor, so older spends are invisible.
    Recovery now confirms against `PoolVault.spentNullifiers` directly before re-activating, and
    fails closed.
  - Impact of the residual was bounded: a wrongly re-activated note inflates the local balance and
    yields a spend that reverts on-chain — not a double-spend.

---

## REVIEWED ON TEAM REVIEW — accepted, not fixed

These proposed fixes were reconsidered during review and deliberately **not applied**; the findings are
triaged `wont-fix` with the rationale below. The branch was rewritten to drop them — **neither a guard
nor a test for any of them is present in the code.**

> Note for anyone reading commit messages rather than diffs: `b64e7d2c`'s message claims a
> "#1002 TEST-7 gap: real-crypto scanTargeted tag-reduce test". **Its diff contains no such test.**
> The only #1002-adjacent change is a test-fixture correction making `deterministicSecret` produce
> canonical in-field (`< p`) values. The commit message overstates what landed; the `wont-fix`
> disposition is unaffected.

### #132 — AccessRouter constructor accepts unvalidated (incl. zero-address) role holders
- **Decision (not fixed):** a role held by `address(0)` is **inert** — no transaction can originate from
  the zero address, so it grants power to nobody. The only failure mode is a self-evident broken
  deployment, not a silent compromise; it is also redundant with **#131**. Standard behavior retained.

### #820 — `renounceRole` lets DEFAULT_ADMIN renounce itself, bricking governance recovery
- **Decision (not fixed):** guards only an **honest operator's** self-renounce — a *malicious* admin
  would escalate + drain (far worse), so `renounceRole` is not an attack surface. The admin is a
  timelocked multisig and a renounce is recoverable via an upgrade migration. Standard OZ
  `AccessControl.renounceRole` behavior retained.

### #700 / #740 — dependency-setter / verifier zero-address guards
- **Issue:** an UPGRADER could repoint a PoolVault dependency (or the transact verifier) to `address(0)`,
  bricking a core path.
- **Decision (not fixed):** same class as #132 — a privileged fat-finger with a **trivially recoverable**
  consequence (the same UPGRADER just re-calls the setter with the right address). Deliberate privileged
  action, no attacker surface. Not worth the extra guards.

### #271 / #272 — HKDF note-payload key + memory zeroization
- **Issue:** the note-payload key is `SHA-256(ECDH secret)` with no HKDF/context binding, and key bytes
  aren't wiped from memory.
- **Decision (not fixed):** `SHA-256(shared_secret)` as a single-purpose symmetric key is **not broken**;
  HKDF+context is forward-looking hygiene, and JS zeroization is best-effort (GC'd; strings can't be
  wiped). Critically, #271 is a **breaking change to an already-audited key-derivation scheme** — not
  worth introducing unaudited crypto pre-launch for a non-vulnerability.

### #1002 / #1003 — Poseidon field-range + HKDF index validation
- **Issue:** Poseidon inputs `>= p` hash identically to their reduced form; the HKDF index truncates at
  `2^64`.
- **Decision (not fixed):** **not reachable in practice.** Every protocol-controlled Poseidon input
  (commitments, nullifiers, `generateSecret()`) is already `< p`; the only `>= p` value (the X25519
  discovery-tag secret) is deterministic and reduced identically on both sides, so it already works
  correctly at v2.0. The HKDF index is a small sequential integer, never `2^64`/negative. These are
  fail-closed guards against inputs the protocol never produces, and adding them touches the audited
  crypto/discovery path — so they were dropped to keep that surface untouched.

---

## ALREADY FIXED on HEAD (team, before this pass)

- **#230** — RelaySwaps `renounceOwnership` freeze (`ad885354`).
- **#301** — dead `RelaySwaps_InvalidCalldata` removed from the contract (`ad885354`). One harmless
  stale decoder entry remains in the relayer; cosmetic, no behaviour.
- **#262 / #400** — relayer error/log de-anonymization scrub (PR #347).
- **#202** — the yield redeem min-out floor is present; the out-of-proof-context residual is a
  previously-ratified accepted Low.
- Also team-fixed earlier: **#210, #250, #251, #290, #380, #960** (swaps hardening).

---

## REJECTED — false-positive (auditor premise wrong / does not reproduce)

### #200 — `maxRelayFee == 0` "uncapped" disables the fee ceiling
- **Why rejected:** `0 = uncapped` is an **intentional, spec-documented sentinel** (commit `2cea13ae`,
  `batch-withdraw.md`), consistent across contract / relayer / SDK. "Fixing" it would revert a feature.

### #344 — `updateAuthPolicy` no-op self-rotation can orphan the caller's leaf
- **Why rejected:** **does not reproduce.** The vendored LeanIMT `_update` reverts `LeafAlreadyExists`
  on old==new *before* any state change — no orphan, clean revert.

### #741 — transact `main.circom` omits `public[...]`, leaving signals unbound
- **Why rejected:** **stub-only.** All 25 production `transact_NxM.circom` declare the public block; only
  an unused dev stub does not.

---

## ACCEPTED & DOCUMENTED (deviations register, INTL-09..14)

### #171 — `PPYieldTokenZap.depositUnderlying` has no min-shares floor
- **Accept:** a variable-output convenience primitive with no in-repo caller (shielded deposits use the
  exact-output `buyFixedYieldToken`); near-zero realizable slippage.

### AW-L-03 — yield withdraw fee-leg can revert the recipient payout under Aave illiquidity
- **Accept:** the revert is clean/atomic (funds safe, retryable); the "fee blocks recipient" window is
  ~0.1%-wide (needs Aave near-full-utilization). Behavior deliberately unchanged.

### #460 — relayed transfer vs withdrawal is on-chain-distinguishable
- **Accept (by-design):** operation type is intrinsically public — a withdrawal moves value out of the
  pool (a visible outflow), a transfer does not. The routing distinguisher leaks nothing the value-outflow
  does not already reveal; the correct invariant is **within-type unlinkability**, which holds.

### #580 / #441 — dependency-setter repoints can desync coupled state
- **Accept:** a governance/runbook constraint — no on-chain coherence assert is feasible (keystore root
  history lives in the Keystore, not assertable from PoolVault; `assetConfigs` is a non-enumerable
  mapping). Both are UPGRADER_ROLE-gated (timelocked).

### #201 — production assets ship `maxRelayFee = type(uint256).max` (ceiling inert)
- **Accept:** pre-launch ops placeholder; realistic per-asset values are set with the deployment config
  (same launch checklist as the #131/AW-M-01 mainnet governance addresses).

### #320 / #321 / #240 — batch fee guards validate against the relayer's own quoted ceiling
- **Accept (low-sev defense-in-depth):** the on-chain contract is the authoritative enforcer of
  `feeAmount <= maxRelayFee` against the proof-context-bound routing, so an inflated quote is rejected at
  execution. On-chain-read fix deferred (needs `IEntrypointInteractor` DI plumbing).

### #964 — `SwapRouting.fallbackAddress` decoded on-chain but never referenced
- **Accept:** it is a proof-bound member of the `SwapRouting` ABI tuple across contract/SDK/relayer and
  carries cross-chain (LiFi) semantics; removing it would break proof-context binding.

### #440 / #110 / #661 — tree-capacity ceilings / cap-setter bounds
- **Accept (tree-size class, with #660):** forward fix is the pre-launch larger-depth trusted setup /
  expand-later, not an on-chain cap guard. Note: the auditor's #440 "drop the ragequit nullifier leaf"
  fix was **code-verified to contradict a documented invariant** — `transact` and `ragequit` both insert
  timestamped nullifier leaves that the note scheme and the planned airdrop hold-time proofs rely on.

---

## DEFERRED / OPEN (with status)

- **AW-L-01 / #920 / #263 — cold-start register-and-withdraw gas-drain.** A spammer can front-run the
  predicted keystore root, reverting the bundle and burning relayer gas (funds safe; liveness only).
  **Status:** documented **TODO** — intended fix is private-orderflow / sponsored submission.
- **AW-L-04 — live Arbitrum signer key + Alchemy key in git history.** **Status:** **keys already rotated
  by the team** — resolved. Recommend adding a CI secret-scan gate.
- **Ops follow-ups (not code):** populate real mainnet governance addresses + realistic per-asset
  `maxRelayFee`; un-skip the mainnet deploy safety test as a CI gate (all part of the #131/AW-M-01 launch
  checklist).
## Open findings (the 78)

Mostly the Informational tail — doc-drift, deploy-runbook notes, and by-design defense-in-depth
observations, not mass-triaged. Full list in the minr report. One correction to that framing:

- **Not all 78 are Informational.** `#920` and `#263` are the **deferred** cold-start gas-drain Low
  described above, and are counted here. They remain `open` on the platform because minr has no
  `deferred` status and `wont-fix` would misstate a deferral — so read the open count as "the
  Informational tail plus two deferred Lows", not as 78 untriaged Informationals.
- The three that were previously stale-open — `#965`, `#967` (PR #351, merged 2026-07-31) and `#242`
  (PR #355, merged 2026-08-04) — are now triaged `fixed` on the platform. Each was verified **from
  source on `origin/v2.0`**, not from the PR title: #965 by the routing `nativeGas`-vs-`extraGas`
  check the PR's own changelog says the same-chain path previously skipped; #967 by the hardening of
  the shared `zNonNegativeBigInt` helper (the `minOutputAmount` call site is unchanged, so a
  call-site-only check reads as a false negative); #242 by `resolveFeeReceiver` plus two regression
  tests. All three post-date this branch's fork point, so none is in its diff.

### Branch currency — `v2.0` merged in on 2026-08-20

This section has been revised twice, and both prior positions are kept rather than quietly dropped.

**Revision 1** said the branch was N commits behind `origin/v2.0` and that the merge should happen
"before this goes to the auditor". That was wrong: being behind does not affect what a reviewer sees.
`compare/v2.0...audit/consensys-remediation` is a **three-dot** comparison — it resolves against the
merge base, so it shows exactly this branch's own commits and nothing from `v2.0`.

**Revision 2** concluded from that the merge should therefore not be done at all before review.

**Current state: the merge was done anyway, on 2026-08-20, as an integration step.** The three-dot
argument above is unchanged and still correct — the merge did *not* alter the reviewer's diff, which
is why it was safe to do mid-review. Measured across it: 39 own commits / 89 files before, 40 commits
(the merge included) / 91 files after; the branch was 57 behind. The two extra files are the finding
recorded below.

The predicted cost did materialise, as revision 2 warned. Doc version-history tables collided and
this branch's entries were renumbered — but **away from** `v2.0`'s, not around them, because every
existing cross-reference (`withdraw-and-swap.md` → v1.19.0, `sdk-tech-design.md` → v1.16.0,
`agents/deviations.md` → v1.19.4) points at `v2.0`'s numbers and none at this branch's:

| Doc | Before | After |
|---|---|---|
| `sdk/pool-session.md` | 1.15.0 / 1.16.0 / 1.17.0 / 1.18.0 / 1.18.1 | 1.20.0 / 1.21.0 / 1.22.0 / 1.23.0 / 1.23.1 (above `v2.0`'s 1.19.4) |
| `sdk/batch-withdraw.md` | 0.3.0 / 0.4.0 | unchanged (`v2.0`'s colliding 0.3.0 became 0.5.0, by date) |

`v2.0`'s numbers were left untouched, so no cross-reference broke. Findings are cited by `AW-*` /
issue number throughout this document, never by doc version, so the renumbering does not affect any
claim made here.

**The merge surfaced one in-scope finding.** `PoolSessionReshieldCrosschain.relayReshieldCrosschain`
— cross-chain reshield, which landed on `v2.0` after this branch forked — called
`core.persistNoteUpdates(...)` **without** the `verification` argument, persisting notes as `SPENT`
on an unverified relayer `txHash`. That is the same fail-OPEN hole **AW-L-02 / #1070** closed on
`relayWithdraw` / `relayTransfer` / `relayWithdrawAndSwap` / `relayReshield` (entries 1.20.0–1.22.0);
`SPENT` is terminal, so the corruption is not recoverable by `discoverNotes()`. It was caught
mechanically: making `verification` a **required** parameter (1.22.0) turned the omission into a
compile error the moment the two histories met — the guard behaving exactly as that entry intended.
Fixed here by threading `{ expectedNullifiers, receiptLogs }` through, mirroring `relayReshield`
verbatim; its unit test asserted the old three-argument call and its orchestrator double omitted
`spentNullifiers`, so both were corrected to exercise the gate rather than pass `undefined` through
it. This is a genuine extension of AW-L-02's scope to a path that did not exist when it was written.

The one thing that genuinely needed handling is documentation, not merging: `#965`, `#967` and `#242`
are fixed on `v2.0` and are therefore **absent from this branch's diff** even though the platform
marks them `fixed` — still true after the merge, since `v2.0`'s commits sit in the merge base. That
is stated explicitly above so it does not read as an unsupported claim.

---

## A note on `AW-*` identifiers (ID collision across two Auditware rounds)

`AW-M-01` and `AW-L-01` each mean **two different things** in this repo, because an earlier Auditware
round used the same numbering:

| ID | Earlier circuits round (May 2026) | This re-audit |
|---|---|---|
| `AW-M-01` | ValueConservation self-defending range checks (`circuits-benchmark.md`, `ValueConservation.md`) | Deploy path skips config validation (**#131**) |
| `AW-L-01` | Output-label inheritance in ValueConservation | Cold-start register-and-withdraw gas drain |

`AW-L-02`, `AW-L-03`, `AW-L-04` are unambiguous (this round only). When reading
`contracts-tech-design.md` (new meaning) alongside the circuits docs (old meaning), check which round
is meant. **Recommend renumbering this round to `AW2-*` before the report goes back to the auditor.**

## Follow-up fixes from the internal re-review (round 1 — `36e5f048`)

A review of this branch against the triage export found five residual code defects in findings already
marked fixed, plus documentation claims stronger than the code. All five are fixed in `36e5f048` and
mutation-verified (each guard was individually broken to confirm its new test fails).

| Area | Finding | What was still wrong |
|---|---|---|
| SDK | #1070 | Verification was optional → fail-open; 2 relayed swap paths + 1 public batch method skipped it |
| SDK | #540 | Corroboration used the unverified raw ASP endpoint, so a stale snapshot could confirm itself |
| SDK | #600 | 7-day scan expiry applied retroactively; and expiry was invisible to and unenforced against the sender |
| SDK | #501 | "Unspent on-chain" was event-derived, not an authoritative `PoolVault` read |
| SDK | #281/#360 | Sealed records were not bound to their storage key (no AEAD associated data) |

## Follow-up fixes from the internal re-review (round 2 — over `36e5f048`)

A second pass verified every line of `36e5f048` against the fix pack it was answering. Four of the
five code fixes hold as written. The #600 fix did **not** work end to end, and four guards had been
added with nothing pinning their behaviour. All are fixed in the five commits listed in the index
below, each mutation-verified the same way.

| Area | Finding | Sev | What was still wrong after `36e5f048` |
|---|---|---|---|
| SDK | #600 | **High** | `generatePaymentRequest` — the only path producing a shareable request — hand-built the payload and dropped `record.expiresAt`. Every request the SDK issued therefore carried no stamp, which the grandfathering rule reads as "never expires", so the new sender-side guard was unreachable in production while the recipient still dropped the request at 7 days. The exact loss #600 exists to prevent. The test missed it because its fixture and its `toEqual` shared the omission. |
| SDK | #600 | Low-Med | No grace between the sender's `expiresAt` check and on-chain inclusion: a payment legitimate when submitted could land after the recipient stopped scanning. `isExpired` now allows `expiresAt + 24h`; the sender's bound is unchanged, and the asymmetry is deliberate. |
| SDK | #281/#360 | Med | `PaymentRequestExpired` and the whole `PaymentRequest`/`EncryptedStorage` error families were **type-only** in the public barrel — `instanceof` always false for a consumer, which guts the reason for enforcing expiry in the SDK rather than the UI. Caught by running the B-2 build-and-enumerate check; there was no standing test, so one now exists. |
| SDK | #501 | Low | The authoritative spend reads were one unbounded `Promise.all`. The mass-revocation case that motivates batching is the same case that gets rate-limited, and every rejection fails closed — so a throttled burst would recover nothing. Now 8 in flight. |
| SDK | #1070 / #501 / #600 | Test | Four guards had no test: the `if (!verification)` branch, `isNullifierSpentOnChain`'s fail-closed catch, `requestExpiryMs` constructor validation, and the sender-side exact-expiry boundary. All four now covered and mutation-verified. |
| SDK | #540 | Test (Med) | Root verification IS the #540 fix, and it was mock-only at every layer: the discovery tests mock `getAssociationSetLeaves`, the `ASPClient` tests mock `computeRoot`, and `MerkleService`'s own tests use a hash mock that concatenates hex. No real LeanIMT-over-Poseidon root was ever computed and compared to a chain root. Three real-crypto cases added. Evidence the mocks were blind: making `computeRoot` order-insensitive fails exactly one test — the new one — while all 27 mocked cases pass. |
| Docs | #600 | Low | The wording implied the sender-side check was a security control. The shareable payload is unauthenticated, so it is a staleness guard; an attacker who can rewrite `expiresAt` can rewrite `tag`/`paymentPubKey` and redirect the payment outright. Stated plainly rather than left for the re-audit to raise. |
| SDK | #600 | Test (Med) | **Scenario now authored, still OPEN.** `tests/integration/scenarios/08-payment-request.test.ts` covers generate → fulfil → discover (live `expiresAt` from the real service, no secrets in the payload, lapsed-request refusal, `hint == tag` binding, recipient discovery). It has **never been executed** — these scenarios need live Sepolia with a funded faucet (≥ 0.15 ETH) and a relayer, which this environment lacks. Authored ≠ passing, so the gap stays open until someone runs it with credentials. |
| Repo | — | Test (Med) | **`apps/sample/tests/**` is typechecked by nothing, and has drifted 60 errors.** `tsc -p tsconfig.test.json` reports 60 pre-existing failures in the integration helpers (`exportAccount` now returns a Promise, `recipientReceipt`/`changeReceipt`/`NoteEvent.tag` gone). The sample's only typecheck script covers `src/` and `checks/` but **excludes `tests/`**; no workflow typechecks them; vitest uses esbuild and does not typecheck. The one suite that exercises the real stack is the one suite no gate type-checks — which is as much the mechanism behind the #600 miss as the missing scenario was. Fix: add a `typecheck` script pointing at `tsconfig.test.json`, gate it, repair the 60. Out of scope here. |

**One correction to the fix pack itself.** `verified_findings.md` D-7 asserted that `b64e7d2c` "adds a
#1002-labeled test (real-crypto `scanTargeted` tag-reduce)". It does not — checked directly, its only
`#1002`-adjacent change is a `deterministicSecret` fixture correction making test secrets canonical
(`< p`). The commit *message* claims a test that never landed. `36e5f048`'s stronger note ("its diff
contains no such test") is the accurate one; the `wont-fix` disposition is unaffected either way.

## Commit index (branch `audit/consensys-remediation`)

| Commit | Findings | Area |
|---|---|---|
| `d808968f` | #233 | Freeze `renounceOwnership` on the 3 PP factories |
| `b79b9225` | #131 (AW-M-01) | Run DeploymentVerifier on the production broadcast path |
| `6a6bccc0` | supports #233/#131 | LAYER-3 spec doc-sync |
| `324470c9` | supports #131 | run() broadcast-path regression test |
| `4a82fd3e` | #171, AW-L-03 (accepted) | Deviations INTL-09/10 |
| `a61988a6` | #460, #580, #441, #201 (accepted) | Deviations INTL-11/12/13 |
| `12c00ee3` | #600 | Payment-request discovery decoupling |
| `efb3fc22` | #1070 (AW-L-02) | Verify Transacted logs before persisting SPENT |
| `ff3b8ecf` | #281, #360 | Opt-in AEAD-sealed at-rest storage |
| `7ee30f50` | #501, #540 | Guarded ASP-rejection recovery |
| `0d35330d` | #320, #321, #240 (accepted) | Deviations INTL-14 |
| `b64e7d2c` | #1070 (transfer path) + Lows | SDK quality-loop fixes |
| `edcf2acd` | supports #1070 | LAYER-3 pool-session doc-sync |
| `a98eb1e7` | — | This summary |
| `36e5f048` | #1070, #540, #600, #501, #281/#360 | Re-review round 1: the five residual code defects |
| `9e784cb3` | #600 | Round 2: carry `expiresAt` into the shareable payment request |
| `c038b1d5` | #1070, #501, #600 | Round 2: cover the four untested guard branches |
| `01238c20` | #600, #281/#360 | Round 2: scan grace past expiry; make the new errors `instanceof`-able |
| `3ea424b8` | #501 | Round 2: bound the rejected-note recovery RPC fan-out |
| `a0c33584` | — | Round 2: format the one fixture that was failing `pnpm format` |

> **Not on the branch (dropped on team review):** #132 / #820 (AccessRouter), #700 / #740 (setter
> guards), #271 / #272 / #1002 / #1003 (crypto cluster). See "Reviewed — not fixed".

## Platform-side triage corrections (minr backend — APPLIED 2026-08-16)

These four live in the minr triage record, not in any file here, so correcting this document would not
have corrected them. All are now written to the backend and **verified by reading the state back**,
not by trusting the write call's own success report — the bulk endpoint reported `written: 4` while
having silently left the two `wont-fix` reasons and one `closeReason` untouched (it appears to rewrite
`closeReason` only when the *status* changes; the single-finding form does not have that limitation).

| # | Finding | Current backend state | Required edit |
|---|---|---|---|
| D-1 | `#441`, `#580` | **DONE** — clause removed; both re-read clean | Deleted the clause. The guard was dropped with #700/#740 on team review and `RC-02` appears nowhere in the repo — the claim contradicts this summary's own #700/#740 entry. `deviations.md` INTL-12 is correct and needs no change. |
| D-2 | `#221` | **DONE** — reason rewritten, `trackingUrl` set to PR #341 | Re-cited: PR **#339 is CLOSED and was never merged** (it targeted `dev`). The fix landed via **#340 → #341 → `v2.0`**. Verified via `gh`. |
| D-4 | `#965`, `#967`, `#242` | **DONE** — all three now `fixed` with PR links | Flipped to `fixed` citing PR **#351** (#965/#967, merged 2026-07-31) and PR **#355** (#242, merged 2026-08-04). All three are on `origin/v2.0` and post-date this branch's fork point, so they are absent from its diff. |
| D-5 | `#920`, `#263` | **Left `open` deliberately** — minr has no `deferred` status (`open`\|`in-progress`\|`fixed`\|`wont-fix`\|`false-positive`), and marking them `wont-fix` would be a false statement about a deferral. Addressed instead by the reword below, which was D-5's stated alternative. | Was: mark `deferred` — both are the cold-start gas-drain Low this summary already describes as deferred, so the Informational framing and the open count are both overstated. |

## Quality-loop status — NOT converged, and why

The loop is `alignment → code review → audit → test gap`, repeated until one sequential run yields
**0 findings**. Reports: `agents/output/{alignment,code-review,audit,test-gap}/sdk_remediation_r2.md`.

| Lens | Verdict |
|---|---|
| Alignment | **DONE** — 0 open CONTRADICTIONs; one EXTENSION (the scan grace), signed off before implementation |
| Code review | **DONE** — conventions clean; 1 High + 2 Nits found and fixed |
| Audit | **DONE** — no exploitable finding; 2 DoS surfaces bounded, 2 overstated claims corrected |
| Test gap | **DONE-WITH-GAPS** — 7 gaps found, 6 closed and mutation-verified, **TG-2 open** |

**So the loop has not converged, and should not be reported as converged.** TG-2 — the payment-request
flow has no CI-gated real-stack coverage — cannot be closed in the review environment: it needs a
running stack (`RPC_URL`, anvil). It is filed open rather than waved through, and the fix is a
`tests/integration/scenarios/08-payment-request.test.ts` covering generate → fulfil → discover.

Worth stating because it is the point: **that missing scenario is why the #600 defect shipped.** The
unit tests mocked `paymentRequestService` wholesale, so nothing exercised `generatePaymentRequest`
against the real service, and a dropped field passed every test. Closing TG-2 is what stops the next
one.

Two confirming passes were run after the fixes. The first found TG-2 plus two stale comments; the
second found that `PaymentRequestExpired`'s message — and four further comments — had been made
**false** by the scan grace added earlier in the same review, each claiming the recipient stops
scanning at `expiresAt` when it now scans past it. Both rounds are recorded in the lens reports. The
useful lesson is that a fix can quietly invalidate prose written around it, and only re-reading the
final state catches that.

## Verification status (measured, not asserted)

Run on the branch tip in a clean worktree. Numbers are what the commands actually printed.

| Package | Command | Result |
|---|---|---|
| `sdk` | `tsc --noEmit` · `eslint` · `prettier --check` · `vitest run` | typecheck PASS · lint PASS · format PASS · **1688 passed, 8 skipped** (103 files, 2 skipped). Baseline at `36e5f048` was 1662 — the round-2 commits add 26 tests. |
| `relayer` | `jest` | **187 passed, 1 skipped** (27 suites). The skip is RPC-gated on `localhost:8545` and logs its reason. |
| `circuits` | `mocha` (unit; `benchmark`/`constraints` excluded as the package script does) | **272 passing** |
| `contracts` | the four CI gates (`test:unit`, `test:integration`, `test:invariant:ci`, `test:invariant:execution-paths`) | **708 passed, 0 failed, 1 skipped** — unit 458 (22 suites) · integration 196 (29 suites, 1 skipped) · invariant-ci 24 (3 suites) · execution-paths 30. Total wall clock ~10.5 min. |
| `swaps` | `tsc --noEmit` · `vitest run` | **typecheck FAILS · zero tests collected** — see caveat |

**Caveats — read these rather than the summary line.**

- **`swaps` does not typecheck and runs no tests.** Failures are in `test/mainnet-*.integration.test.ts`
  (undefined identifiers, a `DeploymentAddresses` shape missing `relaySwapsAddress`), and `vitest`
  excludes every one of those files, so `vitest run` collects **zero** tests and exits non-zero. This is
  **pre-existing**, not caused by the remediation: verified by restoring `packages/sdk/src` to
  `36e5f048` and re-running — byte-identical failures. Both swaps steps in `.github/workflows/ci-swaps.yml`
  are **commented out**, so nothing gates it. `pnpm test` at the repo root will fail on this package.
- **The contracts numbers come from the four CI gates, not from a bare `forge test`.** A bare
  `forge test` runs the invariant campaign at the DEFAULT profile, which for this repo does not
  terminate in any practical time: a run was killed after **24 hours**, having completed 48 suites
  (601 tests, 0 failures) and then sat at <1% CPU inside the invariant campaign with no further
  output. Nothing is wrong with the code — `test:invariant:ci` covers the same suites under the
  bounded `invariant-ci` profile in 348 s, which is exactly why that profile exists. Anyone
  reproducing these numbers should run the four package scripts, not `forge test`.
- **The 1 skipped test** is `Deployment.t.sol::test_default_setUpDeploymentChecks`, hard-skipped via
  `vm.skip(true)` behind a `TODO: re-enable when properly setting deployment params`. Pre-existing and
  unrelated to this branch; it is already tracked in "Ops follow-ups" as part of the #131/AW-M-01
  launch checklist ("un-skip the mainnet deploy safety test as a CI gate"). Logged here rather than
  left silent (TEST-5).
- **`forge fmt --check` fails on `packages/contracts/test/invariant/handlers/HandlerTransact.sol`.**
  That file is byte-identical to `v2.0` and was last touched 2026-06-17 by an unrelated fuzzing commit,
  so this is not branch-introduced. Local `forge` is `1.4.1` (Aztec toolchain) whereas CI installs
  foundry `stable` unpinned — most likely a formatter-version difference rather than a real regression,
  but it does mean `forge fmt --check` is not reproducible across toolchains. **Recommend pinning the
  foundry version in `ci-contracts.yml`.**
- Nothing here was fixed by this review except the one SDK fixture (`a0c33584`); the two items above are
  reported, not repaired, because both sit outside the remediation scope and in files the branch has not
  touched.
