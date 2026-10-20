# Stealth M-1/M-2 Surface — Adversarial Security Audit + Cross-Feature Interaction Review

- **Repo:** `v2-monorepo-audit`, branch `v2.0-features`
- **HEAD:** `f9e9d71cf6875acdfa0441ec592ee2de0a1b0a88`
- **Date:** 2026-07-09
- **Method:** `agents/AUDIT_AGENT.md` + `agents/SECURITY_INTERACTION_AGENT.md`. Each candidate finding adversarially self-refuted; default verdict "not a finding" unless a concrete exploit path survives.
- **What I ran:** static read of the full new surface (contract + interface + minimal announcer + deploy resolver + relayer service/chain-service/ABI/schema + SDK RelayerInteractor/resolve/constants) and cross-checked the prior `agents/output/security/STEALTH_REVIEW_AND_DIFF.md`. Did **not** execute `forge test` / `vitest` this pass (heavy; existing suites `PrivacyPoolRelay.t.sol`, `RelayAndAnnounce.t.sol` present and assert the behaviors below).

---

## Verdict

**No Critical / High / Medium findings.** The `relayAndAnnounce` surface is soundly constructed. The two headline attack premises — reentrancy via the announce-last external call, and TOCTOU divergence in the address binding — are both **refuted with a concrete argument** (no persistent state to corrupt; single deterministic calldata source decoded identically on both sides). The prior review's **M-2 is now closed** (canonical scheme is reachable through `resolveRecipient` and validates both keys on-curve), **C-1 is closed** (a relayer transport now exists), and **M-1 is substantially closed** (atomic relay+announce in one tx makes the STLTH-18 binding a guarantee, not advisory). Residual items are Low/Informational: the on-chain binding covers the **address only** (not the discovery `ephemeralPubKey`), and announcer canonicity is delegated to the deploy script rather than enforced by the constructor.

---

## Attack-by-attack results

### 1. Reentrancy / CEI on `relayAndAnnounce` — REFUTED (not a finding)
`ANNOUNCER.announce` is the last external call, after `_relay` (which does `POOL.transact` + `_distribute`). `PrivacyPoolRelay` holds **no persistent state**: every value is derived per-call from the proof and `msg.value`, and `_distribute` pays out the full withdrawn amount within `_relay`, so the contract's token/ETH balance returns to its prior level *before* `announce` fires. A reentrant call back into `relay`/`relayBatch`/`relayAndAnnounce` would need its own valid proof (fresh, unspent nullifiers consumed inside `POOL.transact`) and its own `msg.value` (re-checked `== nativeGas` inside that inner `_relay`) — there is nothing to double-count and no balance to drain. `_distribute` amounts are proof/`msg.value`-driven, **never `balanceOf`-driven** (`PrivacyPoolRelay.sol:274-296`), so a donation/force-send cannot be siphoned either. `receive()` (`:65-67`) rejects ETH from anyone but `POOL`, so a hostile announcer cannot even push ETH back mid-call. Announce-last is genuinely safe here. **Confidence: high.**

### 2. The binding check — SOUND; one Low doc-scope note (L-A)
`_payout` in `relayAndAnnounce` (`:127`) and `_payout` in `_relay` (`:231`) are two `abi.decode` calls over the **same immutable `calldata`** (`_transactParams.data`) — deterministic, no TOCTOU, no double-decode divergence. The address the announcement is bound to is exactly the recipient the funds go to. **No fund-routing bug.**

However, `require(_announcement.stealthAddress == _payout.recipient)` binds **only the address**. `schemeId`, `ephemeralPubKey`, and `metadata` are forwarded verbatim and unbound (`:133-135`). The NatSpec (`IPrivacyPoolRelay.sol:92-95`, and the contract comment `:123-126`) claims the announcement "provably describes THIS withdrawal" — that is stronger than what is enforced: the *discovery data* (`ephemeralPubKey`, which is what actually lets the recipient derive the stealth private key) is trusted, not proven. See **L-A** below for the (recoverable) griefing consequence. Not a griefing/spam escalation over the status quo: the canonical Announcer is already permissionlessly spammable and cheaper to spam directly than via a full withdrawal. **Confidence: high.**

### 3. Announcer trust / L-1 — DELEGATED to deploy; one Low note (L-B)
The constructor guards only `!= address(0)` (`:54`); it does **not** enforce canonicity. Canonicity is delegated to `Deploy.s.sol::_resolveAnnouncer` (`:291-295`), which uses the canonical singleton when `CANONICAL_ERC5564_ANNOUNCER.code.length != 0` and otherwise deploys a local stand-in. On mainnet/testnets where the ScopeLift singleton exists → canonical is used (correct). The stand-in only materializes where **no** canonical announcer exists at that block (anvil, or a chain/fork predating the singleton) — where there is, by definition, no established anonymity set to fragment. The address constants match byte-for-byte between `Deploy.s.sol:78` and `sdk/.../constants.ts:19` (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`), and `constants.ts` records the L-1 verification (2026-07-09, EIP-5564 spec + Etherscan). Residual risk = a **misconfigured deploy** pinning a wrong non-zero announcer, which the immutable then locks in for the contract's life. Low. **Confidence: medium-high** (did not independently re-derive the EIP-55 checksum against a live chain this pass).

### 3b. Stand-in announcer event signature — CORRECT (not a finding)
`ERC5564Announcer.announce` (`ERC5564Announcer.sol:12-19`) emits `Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)` — byte-identical topic0 to the canonical ERC-5564 event (`IERC5564Announcer.sol:15-21`). Any SDK/scanner keyed on the standard signature discovers stand-in announcements unchanged. **Confidence: high.**

### 4. Relayer path — CONSISTENT (not a finding)
`relayAndAnnounce` reuses `extractWithdrawalQuote` (`evm.relay.service.ts:167`), which verifies the signed fee commitment, binds `asset`/`amountSent`/`feeAmount` to the proof (`:343-365`), and derives the `PayoutRouting` `data` from the **signed** commitment — so the recipient (= stealth address) is bound into the relayer's signature, not attacker-suppliable at relay time. `amountOut == 0` is rejected up front (`:159-163`). The Zod schema (`schemas.ts:194-214`) lists `announcement` sub-fields as explicit keys (no `.passthrough`/strip) so they reach the on-chain args unchanged; `schemeId` (hex) → `BigInt` at the chain layer (`evm.chain.service.ts:522`). The endpoint carries **no** `processorAddress`/`minUnderlyingOut` (stealth×yield unsupported by construction). If a caller mismatches `announcement.stealthAddress` vs the quoted recipient, `simulateContract` reverts `PrivacyPoolRelay_AnnouncementRecipientMismatch` → `BadRequestException` (`:528-532`) — caught before any state change, no funds at risk. **Confidence: high.**

### 5. M-2 resolver — CLOSED; validation is sound (not a finding)
`resolveRecipient`'s new `canonical` branch (`resolve.ts:54-72`) runs `asCompressedPubKey` (0x-prefix + 33-byte width + 0x02/0x03 prefix) **and** `secp256k1.Point.fromBytes(...).assertValidity()` on **both** spending and viewing keys, rejecting malformed or off-curve inputs before returning `SCHEME_CANONICAL`. secp256k1 has cofactor 1 (prime order), so there is no small-subgroup/low-order bypass. This makes the spec-compliant canonical scheme reachable through the public orchestrator — the exact gap flagged as **M-2** in the prior review is now closed. **Confidence: high.**

### 6. Privacy — NO NEW LEAK; caller field is a plus (not a finding)
The announce caller topic is `msg.sender` = the **relay contract** (verified by `RelayAndAnnounce.t.sol` expecting `caller == address(_privacyPoolRelay)`), so every announcement from this path shares one caller — strictly better than users self-announcing (which would expose per-user EOAs). The announcement's public fields (`stealthAddress`, `ephemeralPubKey`) reveal only what the withdrawal already reveals (recipient = stealth address in `PayoutRouting`/`Relayed`) plus the ephemeral key needed for *intended-recipient* discovery; the meta-address stays hidden without the viewing key. No sender↔recipient linkage beyond the inherent, documented **C-2** relayer correlation (a relayer that later relays a spend *from* S). **C-1** (no transport) is now closed by this path + the relayer endpoint. **C-3** stands as a documented limitation: `relayAndAnnounce` is single-item, no batch and no PPRouter/yield leg — stealth still composes with neither, but that is scope, not a vulnerability. **Confidence: high.**

---

## Low / Informational findings

### L-A — Address-only binding; `ephemeralPubKey` is trusted, not proven (Low)
- **Where:** `PrivacyPoolRelay.sol:128,133-135`; overstated by NatSpec `IPrivacyPoolRelay.sol:92-95` and comment `:123-126`.
- **Scenario:** `relayAndAnnounce` is permissionless. On a **public** mempool, an adversary can copy a pending relay's `{proof, transactParams, noteData}`, resubmit as `relayAndAnnounce` with the correct `stealthAddress` but a **garbage `ephemeralPubKey`**, and front-run. The withdrawal still pays the correct address S (no theft), but the emitted announcement no longer derives to S under the recipient's keys, so scanner-based discovery fails — the recipient holds funds at S they cannot immediately find/spend. If `PayoutRouting.feeRecipient == address(0)`, the front-runner also collects the relay fee (a pre-existing property of `relay`/`registerAndRelay`, not new here).
- **Why not Medium:** fully **recoverable** — the payer (who generated the ephemeral key) can permissionlessly re-`announce(schemeId, S, E, metadata)` on the canonical Announcer, restoring discovery; no funds are lost. And the intended transport is a **relayer** (private submission), which removes the public-mempool front-run surface — the same submission-layer mitigation the audit framework already requires for the `registerAndRelay` predicted-root race. Attacker pays the full withdrawal cost (gas + any `nativeGas`) for zero gain beyond griefing.
- **Fix (optional / doc):** soften the "provably describes THIS withdrawal" language to "provably pays the announced address; discovery-data integrity relies on the honest submitter (submit via a private relayer)." Mirrors accepted **L-3** in the stealth review. No code change required.
- **Confidence:** high (mechanism), high (recoverability).

### L-B — Constructor does not enforce announcer canonicity (Low)
- **Where:** `PrivacyPoolRelay.sol:54` (zero-guard only); relies on `Deploy.s.sol:291-295`.
- **Scenario:** a deployment that passes a wrong-but-non-zero announcer permanently pins `relayAndAnnounce` traffic to a non-canonical contract (STLTH-20 anonymity-set fragmentation; standard scanners watching the singleton miss it). The immutable makes this unfixable post-deploy.
- **Why Low:** requires operator misconfiguration; the shipped deploy script resolves correctly (canonical-if-present-else-stand-in keyed on on-chain code, so real chains with the singleton always get it), and the SDK independently refuses non-canonical announcers in the direct `buildAnnounceCall` path via `assertCanonicalAnnouncer` (`constants.ts:26-34`). A hard on-chain assert is infeasible because local/nascent chains legitimately lack the singleton.
- **Fix (optional):** add a deploy-time post-condition asserting the resolved announcer equals `CANONICAL_ERC5564_ANNOUNCER` on non-local chain IDs, or emit the resolved announcer for review. No contract change needed.
- **Confidence:** high.

### L-C — `receive()` reverts if a hostile announcer returns ETH (informational, not exploitable)
A non-canonical/hostile announcer that ETH-pushes to the relay during `announce` would hit `receive()`'s `OnlyPoolCanSendETH` guard (`:66`) and revert the whole tx — a self-DoS of that (already-misconfigured) deployment, never a fund-safety issue. Noted for completeness; no action.

---

## Cross-check against `STEALTH_REVIEW_AND_DIFF.md`
- **M-1** (binding advisory / atomicity premise unmet) → **substantially closed**: `relayAndAnnounce` co-submits relay+announce atomically and enforces `stealthAddress == recipient` on-chain. Residual = the address-only scope (L-A).
- **M-2** (canonical unreachable through orchestrator) → **closed**: `resolveRecipient` `canonical` branch reachable + on-curve-validated (§5).
- **C-1** (no relayer transport) → **closed**: relayer `relayAndAnnounce` endpoint + SDK `relayWithAnnounce` exist and round-trip the announcement unbound-stripped.
- **C-2** (relayer correlation) → **unchanged/inherent**; no new leak (§6).
- **C-3** (no batch/yield composition) → **unchanged, documented**; endpoint explicitly excludes processor/batch.
- **L-1** (announcer address unverified) → **verification recorded** in `constants.ts`; residual is the on-chain non-enforcement (L-B).
- **L-3** (caller-declared destination trust) → **same class as L-A** here.

**Overall:** ship-ready from a security standpoint. Only optional doc-tightening (L-A) and a deploy-time assertion (L-B) are worth doing; neither blocks.
