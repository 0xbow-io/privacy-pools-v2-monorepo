# Stealth Addresses — Security Review + As-Merged Diff Audit

- **Repo HEAD:** `71858e770e8bb52f8148256deeb21b5bfbe8696f` (branch `audit/v2.0-features`)
- **Date:** 2026-07-08
- **Scope:** `packages/sdk/src/stealth/**` (current, HEAD) vs as-merged Phase 1 `d91112f2` (#317). Fix commit `1111d13d` (`pp/stealth-multischeme`).
- **Tests run:** `npx vitest run test/unit/stealth` → **96 passed / 0 failed** (14 files), observed this session. FluidKey interop vectors (`fluidkey-vectors.test.ts`, `DERIV-03`) ran and passed.

---

> **UPDATE (2026-07-09) — M-1, M-2, L-1 CLOSED.** The open items below are resolved on `v2.0-features`:
> **M-2** (canonical unreachable) — `resolveRecipient` gained a `canonical` identifier, so the orchestrator
> now emits a spec-compliant `0x0001` announcement (`5695e717`). **M-1** (advisory binding / no transport) —
> `PrivacyPoolRelay.relayAndAnnounce` (`c574ab0c`) relays then calls the ERC-5564 Announcer atomically and
> **enforces on-chain that the announced stealth address equals the withdrawal recipient** (no aggregator
> contract needed); relayer `/relay-and-announce` (`f9e9d71c`) + SDK `relayWithAnnounce` (`ed03e8e4`); real-
> proof integration (`RelayAndAnnounce.t.sol`, mainnet fork) + SDK e2e cover it. **L-1** (announcer address)
> — verified vs EIP-5564 spec + Etherscan (`3622c843`). A fresh confirmatory audit found no High/Med (see
> `audit/stealth_m1_m2_r1.md`); the binding is address-only by design (INTL-06, audit L-A). C-1 (no transport)
> is closed; C-3 (stealth × batch/yield) remains unsupported. The M-1/M-2 rows below are retained as the
> historical review record.

## A. Diff-audit conclusion

### A.1 The collision existed — CONFIRMED (git evidence)

`git show d91112f2:packages/sdk/src/stealth/types.ts` defines
`export const SCHEME_FLUIDKEY = 0x0001` with the comment *"The scheme id
placeholder (0x0001) MUST be coordinated with FluidKey before ship."* The
as-merged `derive.ts` implements the **FluidKey** recipe under that ID:
`computeSharedHash = keccak256(shared.slice(1))` (64-byte X‖Y) and point
**multiplication**, and emits announcements with `schemeId = SCHEME_FLUIDKEY = 0x0001`.

`0x0001` is the EIP-5564-registered ID for the **canonical secp256k1** scheme.
So Phase 1 emitted FluidKey-recipe bytes (uncompressed eph pubkey, 64-byte-hash
view tag, multiplicative stealth point) tagged as the canonical scheme. A
spec-compliant scanner applies the canonical recipe (compressed-key parse, point
addition, full-65-byte hash) and **silently misses** the payment. This is
concretely regression-tested at HEAD by `dispatch.test.ts` `DISPATCH-05`
("Phase-1-tagged FluidKey announcement silently misses canonical scanner" →
`scanAnnouncement` returns `null`, no throw, no fund loss but undiscoverable).
Severity of the original latent bug: **interop-High** (funds recoverable only
by a FluidKey-recipe scanner; unrecoverable/undiscoverable by any standard
ERC-5564 scanner, and canonical scheme un-addable without a breaking migration).

### A.2 The fix closes it — CONFIRMED

At HEAD (`types.ts`): `SCHEME_CANONICAL = 0x0001`, `SCHEME_FLUIDKEY = 0xfffe`,
asserted distinct (`DISPATCH-04`). Canonical is now implemented correctly
(`derive-canonical.ts`): ECDH against the **viewing** pubkey, `keccak256` over
the **full 65-byte** uncompressed shared point, point **addition**
`S = spending_pub + (h mod n)·G`, **compressed** 33-byte ephemeral pubkey in the
announcement, `stealth_priv = spending_priv + h`. FluidKey moved intact to
`0xfffe`. The wire-level collision is gone: canonical and FluidKey now occupy
different schemeIds and each scanner applies its own recipe.

### A.3 FluidKey behavior unchanged byte-for-byte — CONFIRMED (ran vectors)

Current `derive-fluidkey.ts` `computeFluidKeySharedHash` = `keccak256(shared.slice(1))`
and `deriveStealthAddressFluidKey` uses `spendingPoint.multiply(scalar)` — the
identical algorithm to as-merged `d91112f2` `computeSharedHash`. Only the wire
ID and function names changed. `fluidkey-vectors.test.ts` (`DERIV-03`) derives
against `@fluidkey/stealth-account-kit` reference vectors and asserts
byte-for-byte address equality; it **ran and passed** (2 tests) in the 96-test
run. Interop with FluidKey-kit recipients is preserved.

### A.4 No regression introduced — CONFIRMED

- **Dispatch isolation:** `PROP-04` — 10 000 cross-scheme pairs, canonical
  scanner never recovers a FluidKey announcement and vice versa; a scheme
  mismatch yields `null` or a typed error, never a wrong-but-valid address.
- **Announcer enforcement:** `announcer.test.ts` — `assertCanonicalAnnouncer`
  accepts the canonical address in any casing and rejects others; `buildAnnounceCall`
  and `composeWithdrawalBundle` both refuse a non-canonical announcer.
- **Scan/derive happy paths:** `DISPATCH-04` positive paths + `PROP-02`
  round-trip (sender-derive == recipient-recover) pass for both schemes.
- **Public-surface change (migration):** `buildAnnounceCalldata` was **removed
  from `index.ts`** (present in `d91112f2:index.ts` line 18, absent at HEAD;
  regression-tested `NEGATIVE-20` "buildAnnounceCalldata is NOT re-exported").
  The function still exists in `announce.ts` for internal use but is no longer
  public — downstream callers must use `buildAnnounceCall` (which enforces the
  announcer chokepoint). Consumers hard-coding `schemeId 0x0001` for FluidKey
  must migrate to `0xfffe`.

**Verdict on the fix:** The schemeId collision is **fully closed** with no
functional regression to FluidKey and no security regression in dispatch,
announcer enforcement, or scan paths.

---

## B. Security findings (current module, by severity)

### High
_None._ Core crypto is sound: ECDH commutativity is used correctly per scheme,
zero-scalar guards on `h mod n` and on the derived stealth scalar,
`assertValidity()` on output points, strict hex + curve-prefix validators in
`internal/codec.ts`, off-curve `ephemeralPubKey` rejected before calldata
(CRYPTO-09), CSPRNG-only entropy bound at load with no fallback (STLTH-13), and
`deriveStealthPrivateKey` self-validates the recovered key controls the announced
address (catches mangled announcements).

### Medium

- **M-1 — STLTH-18 binding is structural and its atomicity premise is unmet
  end-to-end.** `verifyAnnouncementBindsToWithdrawal` (`discoveryBinding.ts`) ties
  the announcement to the withdrawal only by *"a Withdrawal event exists in the
  same tx as the announcement, paying the announced address."* Its guarantee holds
  **only if** announce + withdraw were co-submitted in one tx (STLTH-03). No
  relayer path does that co-submission today (see C-1), so the binding is
  effectively **advisory**: if announce and withdraw land in separate txs the
  recipient's `announcementTxHash`-equality check fails and the recipient cannot
  positively bind, even for a legitimate payment. Not a fund-theft vector (the
  private-key self-validation still protects spend), but the anti-griefing/
  discovery-integrity property the design claims is not achievable through the
  shipped transport. Recommend: land the atomic relayer bundle path, or downgrade
  the doc's STLTH-03 "MUST atomic" claim to reflect the current transport.

- **M-2 — Canonical scheme is unreachable through the public orchestrator.**
  `resolveRecipient` (`resolve.ts`) returns **only** `SCHEME_FLUIDKEY` for its one
  `raw` identifier mode, so `prepareStealthWithdrawal` can never emit a canonical
  (`0x0001`) announcement. The whole point of the fix — a spec-compliant canonical
  scheme — is exercised only by direct unit-level calls. A consumer using the
  ergonomic entry point still gets FluidKey-under-`0xfffe`, an **unregistered**
  scheme that standard ERC-5564 scanners ignore. Documented as an open gap in the
  design doc §8; flagging because a reader may assume "fix shipped ⇒ canonical is
  live," which it is not at the orchestrator level.

### Low / Informational

- **L-1 — Pinned announcer address needs on-chain verification.**
  `CANONICAL_ANNOUNCER_ADDRESS = 0x55649e01b5df198d18d95b5cc5051630cfd45564`
  (`constants.ts`) is a vanity `0x5564…5564`. The comment asserts it is the
  canonical CREATE2 deployment, but this review did not verify it against the
  live ERC-5564 Announcer on any chain. If it does not match the real deployment,
  STLTH-20 enforcement would pin traffic to the *wrong* contract. Verify the
  checksummed address per chain before mainnet. (Honesty: not confirmed wrong,
  not confirmed right — unverified.)

- **L-2 — FluidKey hot-scanning key (accepted deviation STLTH-17).** FluidKey
  scanning requires the **spending** private key, not a viewing key, so a scanner
  must hold spend authority hot. Accepted trade-off for FluidKey-kit interop, but
  worth surfacing to integrators: canonical (`0x0001`) is the view/spend-separated
  option and should be preferred once it is reachable (M-2).

- **L-3 — Caller-declared destination trust in `composeWithdrawalBundle`.** The
  bundle binds `announcement.stealthAddress` to a caller-supplied
  `declaredDestination`, not to the actual proof public signals (the module
  cannot decode PP calldata, STLTH-04). A caller that lies produces a bundle whose
  announcement won't bind at recovery time — self-detected, wastes a withdrawal,
  no theft. The code comments already recommend passing `declaredDestination`
  from the same SDK call that produced the proof; keep that guidance prominent.

- **L-4 — View-tag timing.** Scan does a cheap 1-byte tag compare before the
  candidate reconstruction; the tag compare is a plain `!==` on a number. No
  secret-dependent branch of concern here (the announcement and view tag are
  public); constant-time is not required. No action.

No key-reuse, malleability, or weak-entropy defects found in the current module.

---

## C. Cross-feature interaction note (feeds the security-interaction pass)

- **C-1 — The stealth withdrawal bundle has no relayer transport.** `grep -rli
  stealth packages/relayer/relayer/src` → **0 files**; no reference to `announce`,
  `schemeId`, or `ephemeralPubKey`. The EVM relay schema
  (`packages/relayer/relayer/src/relay/evm/schemas.ts`) accepts only a single
  transact proof (`zEvmRelayWithdrawalRequest` = one proof + fee commitment +
  optional processor) or a batch of such items (`zEvmRelayBatchRequest`). There is
  **no field for a second `announce` call and no multicall/bundle wrapper**. So
  `StealthWithdrawalBundle` (`bundle.ts`) terminates at the SDK boundary — it
  cannot be submitted via the relayer.

  Consequence: a stealth withdrawal today can only be submitted (a) by the user
  self-sending the atomic multicall — which reveals the user as `tx.origin`,
  defeating relay privacy — or (b) as two separate txs (relayed withdraw, then a
  separate announce), which breaks the STLTH-03 atomicity that the M-1 binding
  relies on. Either way the shipped design's end-to-end story is incomplete.

- **C-2 — Linkage under a normal relayed withdraw.** If the stealth withdraw is
  pushed through the ordinary `zEvmRelayWithdrawalRequest` path, the relayer sees
  the **stealth address in clear** as the payout recipient (it is in the proof's
  public signals / PayoutRouting). This is inherent to relaying and is *not* an
  identity leak by itself — the stealth address is fresh and unlinkable to the
  recipient's meta-address. The residual risk is correlational: a relayer that
  also later relays a spend *from* that stealth address could link the two. No
  cryptographic identity leak; a metadata-correlation caveat.

- **C-3 — Does not compose with batch or yield paths.** The batch schema
  (`zEvmRelayBatchRequest`) has a **single recipient for the whole batch** and no
  per-item announce, so a batch of N stealth payouts (which would need N distinct
  stealth addresses + N announcements) is unsupported. The yield withdraw path
  (`processorAddress` = PPRouter `withdrawToUnderlying`) likewise carries no
  announce call. Stealth composes with **neither** batch nor yield relay flows
  today.

---

## Overall verdict

The `pp/stealth-multischeme` fix **fully closes** the `schemeId 0x0001`
FluidKey/canonical collision (canonical correctly at `0x0001`, FluidKey relocated
to `0xfffe`, dispatch-isolated), with **no regression** — FluidKey interop
vectors pass byte-for-byte and the full stealth suite is **96/96 green** (run
this session). The module's crypto is sound (no High findings). The material
open issues are **integration, not cryptography**: the canonical scheme is not
reachable through the orchestrator (M-2), and the withdrawal bundle has no
relayer transport, which leaves the STLTH-18/03 atomic-binding property advisory
(M-1/C-1). The previously-missing design doc has been written at
`docs/tech-design/sdk/stealth.md`.
