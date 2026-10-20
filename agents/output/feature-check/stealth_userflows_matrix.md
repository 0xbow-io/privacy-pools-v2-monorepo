# Stealth Addresses — User-Flow Matrix + SDK Comprehension

- **Repo HEAD:** branch `v2.0-features` (build tree at `/Users/nh2/0xbow/v2-monorepo-audit`)
- **Date:** 2026-07-10
- **Builds on:** `agents/output/security/STEALTH_REVIEW_AND_DIFF.md` (crypto analysis not re-done here;
  this doc covers **flow coverage + public-API reachability** only).
- **Scope:** `packages/sdk/src/stealth/**` (+ `src/stealth.ts` barrel), `PrivacyPoolRelay.relayAndAnnounce`
  + `IERC5564Announcer`, relayer `/relay-and-announce`, SDK `RelayerInteractor.relayWithAnnounce` +
  `RelayAndAnnounceRelayParams`.

## Two public entry surfaces (they do NOT share a barrel)

1. **Stealth subpath** `@privacy-pools-v2/sdk/stealth` (barrel `src/stealth.ts` → `stealth/index.ts`):
   sender derive, recipient scan/recover, announcement encoding, **self-multicall bundle** composition,
   discovery-binding verify, identifier resolution, view-tag. Branded primitive types (`Hex`, `EvmAddress`,
   `Announcement`, `viewTag: number`).
2. **Main SDK** `@privacy-pools-v2/sdk` → `RelayerInteractor.relayWithAnnounce(relayer, params)` taking
   `RelayAndAnnounceRelayParams` = `WithdrawalRelayParams` + `StealthAnnouncementFields`
   (`{schemeId: Hex, stealthAddress, ephemeralPubKey: Hex, metadata: Hex}`).

**These two surfaces are not connected by any SDK code.** The stealth module emits an `Announcement`
(`viewTag: number`) and, at most, two ABI-encoded `EvmCall`s (`StealthWithdrawalBundle`); the relay path
consumes `StealthAnnouncementFields` (`metadata: Hex`) alongside a `WithdrawalRelayParams` proof. No
converter (`Announcement → StealthAnnouncementFields`, `viewTag → metadata`) exists anywhere outside
tests. This is the central reachability gap (M-2-class), detailed in the Gaps section.

---

## Flow matrix

Legend for Reachable: **Y** = invocable via public API with no internal hand-construction; **partial** =
reachable but requires the integrator to hand-bridge/hand-assemble types the SDK does not provide;
**N** = exists at code level only, not exposed.

| # | Flow | Actor | Scheme | Code path (file:fn chain) | SDK public entrypoint | Reachable? | Notes |
|---|------|-------|--------|---------------------------|-----------------------|-----------|-------|
| 1 | Resolve raw spending pubkey → FluidKey meta-address | payer | 0xfffe | `resolve.ts:resolveRecipient` (kind `raw`) → curve-check → `{scheme:FLUIDKEY}` | `stealth`: `resolveRecipient` | **Y** | 65-byte uncompressed; STLTH-17 spend-key scheme |
| 2 | Resolve canonical spend+view pair → canonical meta-address | payer | 0x0001 | `resolve.ts:resolveRecipient` (kind `canonical`) → curve-check both keys → `{scheme:CANONICAL}` | `stealth`: `resolveRecipient` | **Y** | M-2 fix: canonical now reachable via resolver |
| 3 | Generate CSPRNG ephemeral keypair (scheme-shaped) | payer | both | `derive.ts:generateEphemeralKeyPair(scheme)` → `internal/entropy.ts` CSPRNG | `stealth`: `generateEphemeralKeyPair` | **Y** | compressed for canonical, uncompressed for FluidKey |
| 4 | Derive stealth address + announcement (dispatch) | payer | both | `derive.ts:deriveStealthAddress` → `deriveStealthAddressCanonical` / `deriveStealthAddressFluidKey` | `stealth`: `deriveStealthAddress` | **Y** | dispatch on `metaAddress.scheme`, `assertNever` default |
| 5 | Canonical derive (ECDH vs viewing pub, point-add, compressed eph) | payer | 0x0001 | `derive-canonical.ts:deriveStealthAddressCanonical` → `computeCanonicalSharedHash` (keccak full 65B) → `canonicalPublicKeyToEvmAddress` | via #4 | **Y** | |
| 6 | FluidKey derive (ECDH vs spending pub, point-mul, uncompressed eph) | payer | 0xfffe | `derive-fluidkey.ts:deriveStealthAddressFluidKey` → `computeFluidKeySharedHash` (keccak X‖Y) → `fluidKeyPublicKeyToEvmAddress` | via #4 | **Y** | byte-for-byte FluidKey-kit compatible (DERIV-03) |
| 7 | Compute + encode view tag as 1-byte metadata | payer | both | `viewTag.ts:computeViewTag` / `encodeViewTagAsMetadata` | `stealth`: `computeViewTag`, `encodeViewTagAsMetadata`, `VIEW_TAG_BYTES` | **Y** | STLTH-12: metadata = exactly 1 byte |
| 8 | Build single announce EvmCall (announcer chokepoint) | payer | both | `announce.ts:buildAnnounceCall` → `assertCanonicalAnnouncer` → `buildAnnounceCalldata` (CRYPTO-09 off-curve reject) | `stealth`: `buildAnnounceCall`, `ERC5564_ANNOUNCE_ABI` | **Y** | `buildAnnounceCalldata` itself is NOT re-exported (NEGATIVE-20) — enforced via `buildAnnounceCall` |
| 9 | Compose atomic self-multicall bundle (withdraw+announce), STLTH-18 destination binding | payer | both | `bundle.ts:composeWithdrawalBundle` → dest==stealthAddr assert → `buildAnnounceCall` | `stealth`: `composeWithdrawalBundle` | **Y** | produces `{withdraw:EvmCall, announce:EvmCall}` |
| 10 | Full orchestrated withdrawal prep (resolve→ephemeral→derive→caller proof→bundle) | payer | both | `withdraw.ts:prepareStealthWithdrawal` → `resolveRecipient` → `generateEphemeralKeyPair` → `deriveStealthAddress` → `generateWithdrawCall` callback → `composeWithdrawalBundle` | `stealth`: `prepareStealthWithdrawal` | **Y** | returns `StealthWithdrawalBundle`; caller supplies proof via `WithdrawCallGenerator` |
| 11 | **Submit (a): self-multicall bundle on-chain** | payer | both | `StealthWithdrawalBundle` → integrator's own multicall/EOA → PoolVault + Announcer | none (integrator submits the two EvmCalls) | **partial** | SDK stops at the bundle; no submit helper. Self-send reveals `tx.origin` (C-1/C-2) |
| 12 | **Submit (b): atomic relay via relayer** (`relayAndAnnounce`) | payer | both | SDK `RelayerInteractor.relayWithAnnounce` → POST `/relay/{type}/{id}/relay-and-announce` → relayer `relay.controller.ts:relayAndAnnounce` → `evm.relay.service.ts:relayAndAnnounce` → contract `PrivacyPoolRelay.relayAndAnnounce` → `ANNOUNCER.announce(...)` | main SDK: `relayWithAnnounce` | **partial** | Transport fully wired; but params (`StealthAnnouncementFields`, `WithdrawalRelayParams`) must be **hand-assembled** — no glue from stealth `Announcement`/bundle (see Gap G-1) |
| 13 | On-chain binding enforcement (announced addr == payout recipient) | relayer/chain | both | `PrivacyPoolRelay.sol:relayAndAnnounce` L129 `require(_announcement.stealthAddress == _payout.recipient, …AnnouncementRecipientMismatch)`; relay-then-announce (L131-135) | (contract, invoked by #12) | **Y** | Makes STLTH-18 binding on-chain, not advisory — for path (b) only |
| 14 | Recipient scans announcement (view-tag prefilter → recover) | recipient | both | `scan.ts:scanAnnouncement` → schemeId==cred.scheme guard → `scanAnnouncementCanonical` / `scanAnnouncementFluidKey` (view-tag compare then reconstruct) | `stealth`: `scanAnnouncement`, type `ScanCredentials` | **Y** | returns address or `null` on miss |
| 15 | Canonical scan (viewing_priv + spending_pub) | recipient | 0x0001 | `scan-canonical.ts:scanAnnouncementCanonical` | via #14, `ScanCredentials{scheme:CANONICAL, viewing_priv, spending_pub}` | **Y** | view/spend separated (cold spend key) |
| 16 | FluidKey scan (**spending_priv** only, STLTH-17) | recipient | 0xfffe | `scan-fluidkey.ts:scanAnnouncementFluidKey` | via #14, `ScanCredentials{scheme:FLUIDKEY, spending_priv}` | **Y** | requires HOT spending key (L-2 deviation) |
| 17 | Recover stealth private key + self-validate control of address | recipient | both | `scan.ts:deriveStealthPrivateKey` → schemeId guard → `deriveStealthPrivateKeyCanonical` (`s = spend+h`) / `deriveStealthPrivateKeyFluidKey` (`s = spend·h`) | `stealth`: `deriveStealthPrivateKey`, type `DerivePrivCredentials` | **Y** | self-validates derived priv ⇒ announced address |
| 18 | Recipient verifies discovery binding (withdraw in same tx as announce) | recipient | both | `discoveryBinding.ts:verifyAnnouncementBindsToWithdrawal(announceTxHash, announcement, withdrawalsInSameTx)` | `stealth`: `verifyAnnouncementBindsToWithdrawal`, type `WithdrawalLogEvent` | **Y** (path b) / advisory (path a) | Binds only if announce+withdraw co-submitted — true for #12/#13, not for two-tx submission |
| 19 | Scheme-mismatch error (announcement.schemeId ≠ credentials.scheme) | recipient | cross | `scan.ts:scanAnnouncement`/`deriveStealthPrivateKey` throw `StealthAddressSchemeMismatchError` | via #14/#17 | **Y** | prevents wrong-recipe recovery |
| 20 | Off-curve / malformed ephemeral pubkey reject (sender) | payer | both | `announce.ts:buildAnnounceCalldata` `secp256k1.Point.fromBytes().assertValidity()` → `StealthAddressDeriveError` (CRYPTO-09) | via #8/#9/#10 | **Y** | |
| 21 | Off-curve / malformed recipient key reject (resolve) | payer | both | `resolve.ts:resolveRecipient` `assertValidity()` → `StealthAddressDeriveError` | via #1/#2 | **Y** | applied to spending (+ viewing for canonical) |
| 22 | Non-canonical / wrong announcer reject | payer | both | `constants.ts:assertCanonicalAnnouncer` (pinned `0x5564…5564`) → throw; enforced in `buildAnnounceCall` | via #8/#9/#10 | **Y** | STLTH-20 chokepoint; L-1: address unverified vs live deployment |
| 23 | stealthAddress ≠ declared withdrawal destination reject (sender bundle) | payer | both | `bundle.ts:composeWithdrawalBundle` → `StealthAddressAnnouncementError` (STLTH-18) | via #9/#10 | **Y** | |
| 24 | Withdrawal from wrong tx passed to binding verifier reject | recipient | both | `discoveryBinding.ts` throws if any `w.txHash != announcementTxHash` | via #18 | **Y** | BIND-01 hardening |
| 25 | View-tag miss (announcement not for this recipient) | recipient | both | `scan-*.ts` cheap tag `!==` compare → return `null` (no throw) | via #14 | **Y** | L-4: tag is public, no constant-time need |
| 26 | Non-atomic submission (announce & withdraw in separate txs) | payer/recipient | both | (no single code path) — path (a) two-tx or path (b) not used | none | **N/degraded** | Binding (#18) fails; funds still spendable (key self-validation). M-1 residual only if integrator hand-splits |
| 27 | Front-run announce (attacker announces same/different addr) | attacker | both | contract binding (#13) rejects mismatch on path (b); on path (a) recipient binding (#18) detects | (contract / #18) | **Y** (path b) | wrong ephemeral only breaks discovery, not spend (contract L126) |
| 28 | Meta-address non-leak in bundle | payer | both | `withdraw.ts` drops `metaAddress` ref after derive; bundle carries only stealth addr (STLTH-14) | via #10 | **Y** | |
| 29 | Empty/absent announcement in relay params reject | payer | both | `RelayAndAnnounceRelayParamsSchema` (zod) in `relayWithAnnounce`; relayer `RelayAndAnnounceValidationPipe` | main SDK: `relayWithAnnounce` | **Y** | validated both SDK-side and relayer-side |
| 30 | Stealth × batch withdrawal | payer | both | — batch schema has single recipient, no per-item announce | none | **N** | C-3: unsupported by design |
| 31 | Stealth × yield withdrawal (`withdrawToUnderlying`) | payer | both | — relay-and-announce is standard-relay only (`evm.relay.service.ts` L170 "no PPRouter branch") | none | **N** | C-3: unsupported by design |
| 32 | ENS / ERC-6538 registry identifier resolution | payer | both | — `resolve.ts` default arm throws; only `raw`/`canonical` implemented | none | **N** | STLTH-05: planned v6+, not shipped |

---

## Gaps — flows NOT fully reachable via the public API

### G-1 (Medium, M-2-class, NEW) — The atomic `relayAndAnnounce` flow is not wired from the stealth module to `relayWithAnnounce`; the integrator must hand-bridge two incompatible type worlds.

The **transport** is fully built and correct end-to-end: `RelayerInteractor.relayWithAnnounce` →
relayer `/relay-and-announce` → `PrivacyPoolRelay.relayAndAnnounce` (on-chain binding
`stealthAddress == _payout.recipient`, L129) → `ANNOUNCER.announce`. What is **missing is the SDK glue**
that turns the stealth module's output into the relay input:

- `prepareStealthWithdrawal` / `composeWithdrawalBundle` produce a **`StealthWithdrawalBundle`** =
  `{withdraw: EvmCall, announce: EvmCall}` — two ABI-encoded calldata blobs shaped for the **self-multicall
  path (a)**. This is the *wrong shape* for the relayer: `relayWithAnnounce` does not take EvmCalls; it takes
  `WithdrawalRelayParams` (proof + publicSignals + fee commitment) plus **`StealthAnnouncementFields`**
  (`{schemeId: Hex, stealthAddress, ephemeralPubKey: Hex, metadata: Hex}`).
- The stealth `Announcement` carries **`viewTag: number`**, not `metadata: Hex`. There is **no exported
  converter** `Announcement → StealthAnnouncementFields` and **no `viewTag → metadata`** helper wired for
  this purpose (`encodeViewTagAsMetadata` exists and is public, but the integrator must know to call it and
  reassemble the struct by hand). Grep confirms zero non-test SDK code references
  `StealthAnnouncementFields` outside its own type/schema files, and the stealth barrel never references
  `relayWithAnnounce`/`RelayAndAnnounceRelayParams`.
- The `RelayerInteractor.test.ts` proof of this: it builds `mockAnnouncement` **by hand** with
  `metadata: "0xaa"` — it does not consume a stealth-module `Announcement`.

**Missing glue (named):** a public helper (e.g. `toStealthAnnouncementFields(announcement)` on the stealth
barrel, or a `prepareRelayAndAnnounceParams(...)` orchestrator) that (1) maps
`schemeId`/`stealthAddress`/`ephemeralPubKey` across the branded↔main-SDK `Hex` boundary, (2) runs
`encodeViewTagAsMetadata(viewTag)` into `metadata`, and (3) pairs it with the caller's
`WithdrawalRelayParams`. Until it exists, path (b) is **partial**: the ergonomic stealth entry point
(`prepareStealthWithdrawal`) dead-ends at a bundle usable only for self-multicall, and an integrator wanting
the privacy-preserving relayed path must abandon `prepareStealthWithdrawal`'s output and manually
re-derive/re-encode the announcement fields into `RelayAndAnnounceRelayParams`.

> Relation to the security review: STEALTH_REVIEW §C-1 said the bundle "has no relayer transport." The
> transport now **exists** (contract + relayer + `relayWithAnnounce`), so C-1 is resolved at the wire level.
> But the **SDK-comprehension** gap it implied persists one layer up: the stealth module still terminates at
> a self-multicall bundle and is not connected to the relay path it was meant to feed.

### G-2 (Low, path-a submission) — No submit/multicall helper for the self-multicall bundle (Flow 11).
`StealthWithdrawalBundle` is returned as two `EvmCall`s with no SDK helper to wrap them into a single atomic
multicall or send them. The integrator supplies the multicall aggregator and submission. Self-sending also
defeats relay privacy (reveals `tx.origin`, C-2). Reachable only with integrator-supplied plumbing.

### G-3 (Low, informational) — Canonical resolver reachable, but no `st:eth:` meta-address parser (Flow 2).
`resolveRecipient` canonical mode takes pre-split `spendingPubKey`+`viewingPubKey` compressed hex. There is
no public parser from the `st:eth:0x<spend><view>` wire meta-address string into that pair, so an integrator
holding the standard encoded meta-address must split it themselves. Minor ergonomic gap, not a functional
block.

### Non-gaps (correctly unsupported by design, not reachability defects)
- **Flows 30/31** (stealth × batch / yield): intentionally unsupported (STEALTH_REVIEW C-3). Documented.
- **Flow 32** (ENS/ERC-6538): explicitly deferred to v6+ (STLTH-05). The `resolve.ts` default arm is a
  compile-time exhaustiveness guard, so adding them later is a type-checked sweep.

---

## Verdict

The stealth feature is **crypto-sound and, for recipient-side and sender-derive flows, fully reachable via
the public `@privacy-pools-v2/sdk/stealth` barrel** (Flows 1-10, 14-25, 27-29 = **Y**). The **M-2** canonical
gap flagged in the security review **is genuinely closed**: `resolveRecipient` now has a `canonical`
identifier mode (Flow 2) and `prepareStealthWithdrawal` emits a spec-compliant `0x0001` announcement when fed
one. The atomic `relayAndAnnounce` transport is **built and correct end-to-end**, with the STLTH-18 binding
now enforced **on-chain** (contract L129), and is invocable through `RelayerInteractor.relayWithAnnounce`.

**But one M-2-class reachability gap remains (G-1):** the stealth module and the relay path are **not wired
together**. `prepareStealthWithdrawal` produces a self-multicall `StealthWithdrawalBundle`, while
`relayWithAnnounce` consumes an unrelated `RelayAndAnnounceRelayParams`/`StealthAnnouncementFields` shape,
and no SDK code bridges `Announcement` (`viewTag: number`) → `StealthAnnouncementFields` (`metadata: Hex`).
An integrator wanting the private relayed path (the intended production flow) must hand-assemble those params
— exactly the "exists at code level but not reachable through the ergonomic entry point" class M-2 belonged
to. **Recommendation:** add a public `toStealthAnnouncementFields` / `prepareRelayAndAnnounceParams` bridge on
the stealth barrel so path (b) is reachable without hand-construction.

### Reachability-gap list
- **G-1 (Medium):** atomic `relayAndAnnounce` not wired from stealth module to `relayWithAnnounce` — missing
  `Announcement → StealthAnnouncementFields` / bundle→relay-params glue. Flows 12/18 are **partial**.
- **G-2 (Low):** no submit/multicall helper for the self-multicall bundle (Flow 11 partial).
- **G-3 (Low):** no `st:eth:` meta-address string parser feeding `resolveRecipient` canonical (Flow 2 minor).
