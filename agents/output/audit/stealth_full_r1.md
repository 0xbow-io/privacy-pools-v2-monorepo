# Stealth Addresses — Full-Feature Adversarial Security Audit (r1)

- **Repo:** `v2-monorepo-audit`, branch `v2.0-features`
- **HEAD:** `b69a13550377473036c566bcb60c4d77c1d3f416`
- **Date:** 2026-07-10
- **Method:** `agents/AUDIT_AGENT.md`. Every candidate finding adversarially self-refuted; default verdict "not a finding" unless a concrete exploit path survives. Builds on and re-verifies `agents/output/security/STEALTH_REVIEW_AND_DIFF.md` and `agents/output/audit/stealth_m1_m2_r1.md`.
- **Scope:** whole feature — SDK crypto per scheme (`packages/sdk/src/stealth/**`), dispatch, announce chokepoint, codec/entropy/validators, transport (`RelayerInteractor.relayWithAnnounce`, relayer `relay-and-announce` endpoint + chain service), contract (`PrivacyPoolRelay.relayAndAnnounce` + `ERC5564Announcer`), deploy resolver.
- **What I ran:**
  - `npx vitest run test/unit/stealth` → **102 passed / 0 failed** (14 files), observed this session (up from 96 at the prior audit; `scopelift-vectors.test.ts` canonical vectors + extra dispatch cases now present). `properties.test.ts` (10 000 cross-scheme pairs, round-trip, dispatch isolation) and `fluidkey-vectors.test.ts` (byte-for-byte FluidKey-kit interop) both ran and passed.
  - Static trace of the full surface listed above + the load-bearing dependency `PoolVault.transact` context binding.
  - `git diff f9e9d71..HEAD` over the entire stealth surface (see "Delta since prior audit").

---

## Verdict

**No Critical / High / Medium findings.** The feature is soundly constructed end-to-end and I confirm the two prior audits' conclusions still hold on current HEAD. Independent re-derivation of every attack premise (crypto per scheme, cross-scheme dispatch isolation, the on-chain address binding, reentrancy via announce-last, transport wire-fidelity, deploy canonicity) either matched the reference behavior or refuted the attack with a concrete argument. **Both residual Lows from the prior round have since been mitigated in code**: L-A by NatSpec/comment softening (the "provably describes THIS withdrawal" overclaim is gone), and L-B by a deploy-time `chainid == 31337` guard that refuses a non-canonical announcer on any real chain. Residual items are Low/Informational only.

The one load-bearing external assumption — that `PayoutRouting.recipient` (which the announcement is bound to) is itself committed by the withdrawal proof — is **confirmed**: `PoolVault.sol:145-147` verifies `proof.context() == keccak256(abi.encode(_transactParams, _noteData)) % SNARK_SCALAR_FIELD`, and `_transactParams.data` is the ABI-encoded `PayoutRouting`. So the stealth binding anchors to the proof's intended recipient, not an attacker-substitutable one.

---

## Delta since the prior audit (why its conclusions still hold)

`git diff f9e9d71..HEAD` over the whole surface touches only four files:
- `packages/sdk/src/stealth/**` — **byte-identical** (0 changes). Every crypto/codec/dispatch conclusion in the prior reviews transfers verbatim, and I re-verified them independently below rather than merely inheriting them.
- `PrivacyPoolRelay.sol` — comment-only change on `relayAndAnnounce` (import reorder + the STLTH-18 comment reworded to state the binding is **address-only**). No control-flow change. **Closes L-A's doc half.**
- `IPrivacyPoolRelay.sol` — NatSpec on `relayAndAnnounce` / `PrivacyPoolRelay_AnnouncementRecipientMismatch` reworded to "ONLY the address is enforced … other fields forwarded as-is, not proven." **Closes the L-A overclaim.**
- `Deploy.s.sol` — `_resolveAnnouncer` gained `require(block.chainid == 31_337, 'Deploy: canonical ERC-5564 Announcer absent on a non-local chain')` before deploying a stand-in (`:299`). **Closes L-B**: a real-chain deploy can no longer silently pin a non-canonical announcer; it reverts.

---

## Attack-surface-by-surface results

### 1. Canonical crypto (`derive-canonical.ts`, `scan-canonical.ts`) — SOUND
- ECDH direction correct: sender `computeCanonicalSharedHash(eph_priv, viewingPub)`; recipient `(viewing_priv, eph_pub)`. Commutativity yields the same 65-byte shared point; hash is over **all 65 bytes** including `0x04` (`derive-canonical.ts:65`) — matches ScopeLift and the now-present `scopelift-vectors.test.ts`.
- Point addition `S = spending_pub + (h mod n)·G` on both derive (`:119-123`) and scan (`scan-canonical.ts:50-52`); `assertValidity()` on the output on both sides.
- `stealth_priv = (spending_priv + h) mod n` (`scan-canonical.ts:83`), with **self-validation** that `stealth_priv·G` reproduces the announced address (`:90-97`) → a mangled announcement throws `StealthAddressScanIntegrityError`, never yields a wrong-but-valid key.
- **Zero-scalar guards present at every step**: `hashScalar == 0` on derive (`:116`) and scan (`:46`), and `stealthScalar == 0` on the priv derivation (`:84`). secp256k1 has cofactor 1 (prime order) → no small-subgroup bypass on the `assertValidity` checks.
- View tag is `sharedHash[0]` (raw hash byte, **not** the mod-n-reduced scalar), computed identically on both sides (`viewTag.ts:29`) → sender/recipient always agree even when the mod-n reduction is non-trivial.

### 2. FluidKey crypto (`derive-fluidkey.ts`, `scan-fluidkey.ts`) — SOUND, interop preserved
- ECDH against **spending** pub (STLTH-17), hash over the 64-byte `X‖Y` body (`slice(1)`, `derive-fluidkey.ts:59`) — the exact recipe byte that distinguishes it from canonical. Point **multiplication** `S = h·spending_pub`; `stealth_priv = (spending_priv · h) mod n`, self-validated (`scan-fluidkey.ts:90`).
- Zero-scalar guards on `scalar`/`stealthScalar` at every step. `spending·h mod n == 0` requires `spending==0` or `h==0` (n prime) — both guarded; `getPublicKey` additionally rejects a `>= n` / zero spending key.
- `fluidkey-vectors.test.ts` re-ran this session → byte-for-byte equality with `@fluidkey/stealth-account-kit`. Unchanged.

### 3. Entropy (`internal/entropy.ts`) — SOUND
CSPRNG bound at module load to the `getRandomValues` **method** (not the Crypto object), defeating a later method-level monkey-patch (ENTROPY-07). `null` capture + hard refusal when WebCrypto is absent — no deterministic fallback (STLTH-13). `generateEphemeralKeyPair` (`derive.ts:31-59`) uses **rejection sampling** over `[1, n)` → no modular bias in the ephemeral scalar. The one non-rejection reduction (`h mod n` for the stealth offset) carries the standard ~2⁻¹²⁸ bias, identical to ScopeLift/EIP-5564; acceptable.

### 4. Codec / validators (`internal/codec.ts`) — SOUND
Strict `HEX_BODY_REGEX` before `parseInt` (rejects `0x1g`, CODEC-02); even-and-nonzero length; brand validators enforce `0x`-prefix + exact byte width + curve-prefix byte (`02/03` compressed, `04` uncompressed). View tag fixed at exactly 1 byte (`viewTag.ts:11,22-30`, `encodeViewTagAsMetadata` range-checks `[0,256)`).

### 5. Scheme dispatch (STLTH-19) — SOUND, no silent fallback
`deriveStealthAddress` (`derive.ts:70-89`) hard-errors on unknown scheme (`StealthAddressUnsupportedSchemeError`) and on `metaAddress.scheme != schemeId` (`StealthAddressSchemeMismatchError`) **before** any curve math. `scanAnnouncement`/`deriveStealthPrivateKey` (`scan.ts`) reject `announcement.schemeId != credentials.scheme`. `assertNever` in every default arm makes a third scheme a compile-time sweep. `dispatch.test.ts` DISPATCH-05 + `properties.test.ts` PROP-04 (10 000 pairs) confirm a canonical scanner never recovers a FluidKey announcement and vice-versa — mismatch is `null` or a typed throw, never a wrong-but-valid address.

### 6. Announcer chokepoint (STLTH-20) — SOUND
`buildAnnounceCall` (`announce.ts:90-99`) routes every announce-calldata path through `assertCanonicalAnnouncer` (`constants.ts:26-34`, case-insensitive equality to `0x5564…5564`). `buildAnnounceCalldata` is **not** re-exported from `index.ts` (confirmed: `index.ts:21` exports only `buildAnnounceCall`/`ERC5564_ANNOUNCE_ABI`), so consumers cannot bypass the chokepoint. `buildAnnounceCalldata` also runs `assertValidity()` on `ephemeralPubKey` (CRYPTO-09) — refuses to ship an off-curve point in sender-generated calldata.

### 7. Contract `relayAndAnnounce` (`PrivacyPoolRelay.sol:117-137`) — SOUND
- **Binding:** `require(_announcement.stealthAddress == _payout.recipient)` where `_payout` is decoded from the same `_transactParams.data` `_relay` uses. Two `abi.decode`s of the same immutable `calldata` → deterministic, no TOCTOU. `_payout.recipient` is proof-committed (see Verdict) → the announcement cannot name an address this withdrawal never funds.
- **CEI / reentrancy:** `ANNOUNCER.announce` is the **last** call, after `_relay` has fully paid out. The contract holds **no persistent state**; all amounts are proof/`msg.value`-driven, never `balanceOf`-driven (`:229,232-234,243`). The announcer is called with **no value** and (canonical/stand-in) only emits an event — no callback. `receive()` (`:65-67`) rejects ETH from anyone but `POOL`, so a hostile announcer cannot push ETH back mid-call. A reentrant relay would need its own fresh proof + matching `msg.value`. No double-count surface. **Refuted.**
- **Atomicity is a plus:** announce reverting reverts the whole tx (relay included) → never "funds moved, announcement missing." Immutable `ANNOUNCER` + `!= address(0)` constructor guard (`:54`).

### 8. Transport (relayer + SDK) — CONSISTENT, wire-faithful
- `zEvmRelayAndAnnounceRequest` (`schemas.ts:208-214`) lists `announcement` sub-fields as explicit keys (no `.passthrough`/strip); reuses `extractWithdrawalQuote` so `asset`/`amountSent`/`feeAmount`/recipient(`data`) are bound to the relayer's **signed** commitment, not attacker-suppliable at relay time. `amountOut == 0` rejected up front (`evm.relay.service.ts:159-163`). No `processorAddress`/`minUnderlyingOut` on this endpoint (stealth×yield unsupported by construction).
- Chain service (`evm.chain.service.ts:501-533`) converts `schemeId` hex→`BigInt`, passes `stealthAddress/ephemeralPubKey/metadata` through unchanged; a `stealthAddress != recipient` mismatch reverts in `simulateContract` → `BadRequestException` before any state change (no funds at risk).
- SDK `HexSchema` (`schemas/common.ts:5-26`) preserves the announcement hex **strings** verbatim (validates only; does not round-trip through bigint), so no leading-zero truncation of `ephemeralPubKey`/`metadata`. `RelayerInteractor.relayWithAnnounce` (`:389-427`) validates params, asserts the fee commitment is live, and POSTs the announcement leg intact.

### 9. Privacy / linkage — NO NEW LEAK
Announce `caller` topic is `msg.sender` = the relay contract (one shared caller for all relayed announcements — strictly better than per-user self-announce). Public fields (`stealthAddress`, `ephemeralPubKey`) reveal only what the withdrawal already reveals plus the ephemeral key needed for *intended-recipient* discovery; the meta-address never enters the bundle (STLTH-14 — `withdraw.ts:57` drops the `metaAddress` reference). Residual = the inherent, documented C-2 relayer correlation (a relayer that later relays a spend *from* S).

### 10. Replay / malleability / DoS — no new vector
Announcement "replay" is inherent to a permissionless ERC-5564 announcer and cheaper to do directly than via a full withdrawal; it only affects (recoverable) off-chain discovery. No signatures in the announce path (no malleability surface). The relayer acts only on a commitment it signed (signing gated on `commit === true` at quote time), so the endpoint does no unbounded/unauthenticated expensive work. Announce path is O(1), no unbounded loop.

---

## Low / Informational findings

### L-A (residual, was Low → now doc-mitigated) — Address-only binding; `ephemeralPubKey`/`schemeId`/`metadata` trusted, not proven
- **Where:** `PrivacyPoolRelay.sol:129,134-136`; SDK relayer/chain-service forward the fields verbatim.
- **Scenario:** on a public mempool an adversary can copy a pending `relayAndAnnounce`, keep the correct `stealthAddress` but supply a garbage `ephemeralPubKey`/`schemeId`, and front-run. Funds still reach S (no theft — recipient is proof-bound), but scanner-based discovery of that announcement fails.
- **Why not Medium:** fully recoverable — the payer can permissionlessly re-`announce(schemeId, S, E, metadata)` on the canonical Announcer; and the intended transport is a private relayer, which removes the public-mempool front-run surface (the same submission-layer mitigation the audit framework requires for the `registerAndRelay` predicted-root race). Attacker pays the full withdrawal cost for pure griefing.
- **Status:** the code's prior overclaim ("provably describes THIS withdrawal") has been **removed** this cycle; NatSpec now states the address-only scope explicitly. No further action required; retained as an architectural note.
- **Confidence:** high.

### L-B (was Low) — CLOSED
Deploy now `require(block.chainid == 31_337)` before minting a stand-in announcer (`Deploy.s.sol:299`), so a real-chain deploy that lacks the canonical singleton reverts rather than pinning a non-canonical immutable. Combined with the SDK-side `assertCanonicalAnnouncer` chokepoint, the STLTH-20 anonymity-set-fragmentation risk is closed at both layers. No residual.

### L-C (informational) — `scanAnnouncement` throws (not `null`) on an adversarial announcement
- **Where:** `scan-canonical.ts:39` / `scan-fluidkey.ts:33` — `compute*SharedHash` runs `getSharedSecret` (which parses the `ephemeralPubKey`) **before** the cheap view-tag filter, so an off-curve or malformed `ephemeralPubKey` throws `StealthAddressDeriveError` rather than returning `null`.
- **Scenario:** anyone can emit arbitrary `Announcement` events directly on the canonical/stand-in announcer (permissionless). A recipient's scan loop that calls `scanAnnouncement` per log and does not wrap it in try/catch could be halted by a single hostile off-curve announcement.
- **Why Informational, not a module bug:** the announcer is inherently open to arbitrary events, so any production scanner iterating raw logs MUST already be defensive per-announcement — this module introduces no new exposure, and the log-reader lives outside the stealth module by design. The doc's "returns null on a miss" wording is nonetheless narrower than reality for adversarial input.
- **Fix (optional):** either wrap the per-announcement scan in an internal try/catch that maps parse failures to `null`, or document that callers must isolate each announcement. No fund-safety impact.
- **Confidence:** high (mechanism), high (non-exploitability of the module itself).

### L-D (informational) — `receive()` reverts if a hostile announcer returns ETH
`receive()`'s `OnlyPoolCanSendETH` guard (`:66`) would revert the whole tx if a misconfigured/hostile announcer ETH-pushed during `announce` — a self-DoS of an already-misconfigured deployment, never a fund-safety issue. With L-B closed the precondition is unreachable on real chains. No action.

---

## Cross-check against the two prior stealth audits
- `STEALTH_REVIEW_AND_DIFF.md`: schemeId 0x0001 collision **closed** (canonical `0x0001`, FluidKey `0xfffe`, dispatch-isolated) — re-confirmed via `types.ts:14-15` + PROP-04. M-1/M-2/C-1 closed; C-3 (stealth × batch/yield) remains unsupported-by-design (scope, not a vuln). L-1 announcer address verification recorded in `constants.ts`.
- `stealth_m1_m2_r1.md`: reentrancy-refuted and TOCTOU-refuted arguments **independently reproduced**; its L-A residual now doc-mitigated; its L-B suggested deploy assertion now **implemented**.

**Overall:** ship-ready from a security standpoint. No code change required; the only optional item is L-C's scanner-robustness note, which is an integration-layer hardening outside this module.
