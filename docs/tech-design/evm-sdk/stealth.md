# SDK — Stealth Addresses (ERC-5564)

SDK-side design + public API for **paying a Privacy Pools withdrawal to a fresh,
unlinkable stealth address** derived from the recipient's published meta-address,
and for the recipient to **discover and recover** those payments by scanning
on-chain ERC-5564 announcements.

This module is an **EXTENSION** over the SDK spec (it has no requirement in
`core-sdk-tech-design.md` or `evm-sdk-tech-design.md`); this doc reconstructs its design from the code and the
`pp/stealth-multischeme` fix commit. The module carries its own internal
`STLTH-NN` design rubric (not references to an external spec file). Deviations
are tracked in `agents/deviations.md` (INTL-01..04). All file paths below are
under `packages/evm-sdk/src/stealth/`.

## Version History

| Version | Date       | Notes |
|---------|------------|-------|
| 0.5.1   | 2026-08-17 | Doc-only. §"Stealth × deposits": on-chain submission wiring is now RESOLVED via the new standalone `packages/relayer/dust-rescue-service` (see `docs/tech-design/relayer/dust-rescue-service.md`) — no change to this module's code or public API. |
| 0.5.0   | 2026-08-10/11 | "Camouflaged dust-rescue delivery" — **supersedes 0.4.0's delivery channel** (`RelaySwaps.rescueDust`/`DustRescued`, reverted for publicly tagging rescue deposits). New exports `encodeStealthDepositPayload` / `decodeStealthDepositPayload` (`depositPayload.ts`) pack an ephemeral pubkey + view tag + ECDH-encrypted note payload into a single opaque blob sized for a deposit's `noteData.data` (arbitrary-length, unlike ERC-5564's fixed 1-byte `metadata`). New export `scanDepositNoteData` (`scan.ts`) — sibling to `scanAnnouncement`, scans that blob instead of an `Announcement` event; unlike `scanAnnouncement`, there is no separately claimed on-chain `stealthAddress` to verify a match against (deposit ownership is Poseidon-hashed, never plaintext), so the derived candidate address IS the result. `deriveStealthSharedSecret`/`recoverStealthSharedSecret` (0.4.0) are unchanged and still the shared-secret primitive this delivery reuses. First actual caller of this composition: `NoteDiscoveryService.scanStealthDeposits` (SDK-internal — see `core-sdk/pool-session.md` §Stealth Dust Rescue), closing the "not yet wired" gap 0.3.0 flagged. |
| 0.4.0   | 2026-08-07 | **Delivery channel superseded by 0.5.0**, rest still accurate. Resolved the §8 "Stealth × deposits" secret-delivery gap. New exports `deriveStealthSharedSecret` / `recoverStealthSharedSecret` (§5) expose the module's internal ECDH shared-secret hash so `packages/relayer/dust-rescue-prover` can encrypt the dust-rescue note's `noteSecret` for delivery via `RelaySwaps.rescueDust`'s new `DustRescued` event. No change to existing exports, derivation recipes, or security properties. |
| 0.3.0   | 2026-08-07 | Added §8 "Stealth × deposits" — the module's derivation functions (`resolveRecipient`/`generateEphemeralKeyPair`/`deriveStealthAddress`) are now also called from `packages/relayer/dust-rescue-prover` (a new relayer-side caller), for `PoolSessionReshieldCrosschain`'s stealth dust-rescue deposit. No change to this module's own code, public API, or security properties — the on-chain announcement-binding pattern (§4.5/§6.4) does not extend to this new caller (deposit ownership is never plaintext on-chain), and the composition is not yet complete (no wired secret-delivery channel). Doc-only. |
| 0.1.0   | 2026-07-08 | Initial doc, reconstructed post-fix. Documents the multi-scheme module: canonical EIP-5564 at `0x0001`, FluidKey at `0xfffe`, discriminated-union dispatch, pinned announcer chokepoint. Supersedes the undocumented FluidKey-only Phase 1 (#317, `d91112f2`), which shipped FluidKey under `schemeId 0x0001`. |
| 0.2.0   | 2026-07-09 | Closed the M-1/M-2 gaps in §8. M-2: `resolveRecipient` accepts a `canonical` identifier and returns a `CanonicalMetaAddress` (`0x0001`), making the canonical EIP-5564 scheme reachable through `prepareStealthWithdrawal` (§3 `resolve.ts`, §4.4). M-1: atomic `(withdraw, announce)` transport now exists via `PrivacyPoolRelay.relayAndAnnounce` + `RelayerInteractor.relayWithAnnounce`, so the STLTH-18 binding §4.5/§6.4 depended on is on-chain-enforced rather than advisory. L-1: `CANONICAL_ANNOUNCER_ADDRESS` verified (checksums to `0x55649E01B5Df198D18D95b5cc5051630cfD45564`). Stealth × batch/yield remains unsupported (C-3). Doc-only. |

## 1. Why

A normal Privacy Pools withdrawal pays a caller-chosen EVM address. If a user
reuses an address, or hands out one address per counterparty, on-chain payments
become linkable. ERC-5564 stealth addresses let a recipient publish a single
static **meta-address** while every payment lands at a fresh, one-time
`stealthAddress` that only the recipient can compute the private key for. The
sender additionally posts an **announcement** (ephemeral pubkey + 1-byte view
tag) to the canonical ERC-5564 `Announcer` so the recipient can find the payment
by scanning, without an interactive channel.

## 2. Two schemes + schemeId allocation

The module ships two derivation recipes side by side, dispatched on the
meta-address's `scheme` tag (STLTH-19, `types.ts`):

| Constant           | schemeId | Recipe | ECDH against | Point op | Shared hash | Eph. pubkey | Keys | Status |
|--------------------|----------|--------|--------------|----------|-------------|-------------|------|--------|
| `SCHEME_CANONICAL` | `0x0001` | EIP-5564 scheme 1 | recipient **viewing** pubkey | addition `S = B + hash·G` | `keccak256(0x04‖X‖Y)` (full 65 bytes) | 33-byte **compressed** | view/spend separated | implemented (`derive-canonical.ts`, `scan-canonical.ts`) |
| `SCHEME_FLUIDKEY`  | `0xfffe` | FluidKey kit | recipient **spending** pubkey | multiplication `S = B·hash` | `keccak256(X‖Y)` (64 bytes, drops `0x04`) | 65-byte **uncompressed** | spending key also scans (STLTH-17) | implemented (`derive-fluidkey.ts`, `scan-fluidkey.ts`) |

`0x0001` is the EIP-5564-registered ID for the canonical secp256k1 scheme.
`0xfffe` is an unallocated placeholder for the FluidKey variant; **STLTH-21**
tracks partnership work to register it under a permanent ID, at which point the
`SCHEME_FLUIDKEY` constant moves in a single edit (`types.ts`). The two constants
are asserted distinct in tests (`DISPATCH-04`).

### 2.1 The FluidKey → canonical migration (why `0xfffe`)

Phase 1 (#317, `d91112f2`) shipped the FluidKey variant **under `schemeId
0x0001`** (`git show d91112f2:packages/sdk/src/stealth/types.ts` →
`SCHEME_FLUIDKEY = 0x0001`), the exact ID EIP-5564 reserves for the canonical
secp256k1 scheme. Its own `types.ts` comment flagged that the ID "MUST be
coordinated with FluidKey before ship." That was a wire-level collision: a
spec-compliant scanner reading a `0x0001` announcement applies the **canonical**
recipe (compressed-key parsing, point addition, full-65-byte hash) to bytes that
were actually produced by the **FluidKey** recipe (uncompressed key, point
multiplication, 64-byte hash). Result: the announcement silently misses for a
canonical scanner — no throw, no fund loss, just an undiscoverable payment
(regression-tested as `DISPATCH-05`). The canonical scheme could also never be
added later without a breaking migration.

The fix (`1111d13d`) put canonical EIP-5564 back at `0x0001` with the correct
secp256k1 recipe, relocated FluidKey to `0xfffe`, and added discriminated-union
dispatch. **FluidKey derivation bytes are unchanged** — only the wire ID moved;
interop vectors still pass byte-for-byte (`fluidkey-vectors.test.ts`, `DERIV-03`).

## 3. Components

| File | Role |
|------|------|
| `types.ts` | Scheme constants, branded hex types (`CompressedPubKey`, `UncompressedPubKey`, `Scalar32`, `EvmAddress`), discriminated unions `MetaAddress` / `Announcement`, `assertNever`. |
| `derive.ts` | Dispatch boundary for sender-side derivation; `generateEphemeralKeyPair(scheme)` (CSPRNG, rejection-sampled). Re-exports per-scheme shared-hash helpers. |
| `derive-canonical.ts` / `derive-fluidkey.ts` | Per-scheme sender derivation + shared-hash + pubkey→address helpers. |
| `scan.ts` | Dispatch boundary for recipient-side `scanAnnouncement` and `deriveStealthPrivateKey`; per-scheme `ScanCredentials` / `DerivePrivCredentials` unions. |
| `scan-canonical.ts` / `scan-fluidkey.ts` | Per-scheme scan (view-tag prefilter → candidate reconstruct) + stealth-private-key derivation with self-validation. |
| `viewTag.ts` | 1-byte view tag (STLTH-09) derivation + metadata encoding. |
| `announce.ts` | ERC-5564 `announce(...)` ABI + calldata builder + `buildAnnounceCall` (announcer-pinned `EvmCall`). |
| `constants.ts` | `CANONICAL_ANNOUNCER_ADDRESS` + `assertCanonicalAnnouncer` (STLTH-20). |
| `bundle.ts` | `composeWithdrawalBundle` — atomic `(withdraw, announce)` pair with STLTH-18 destination binding. |
| `withdraw.ts` | `prepareStealthWithdrawal` orchestrator (resolve → eph → derive → withdraw callback → bundle). |
| `discoveryBinding.ts` | Recipient-side `verifyAnnouncementBindsToWithdrawal` (announcement ↔ same-tx Withdrawal event). |
| `resolve.ts` | `resolveRecipient` — identifier → `MetaAddress`. `raw` (65-byte uncompressed spending key) → FluidKey (`0xfffe`); `canonical` (`{ spendingPubKey, viewingPubKey }`, two 33-byte compressed keys, both curve-validated) → `CanonicalMetaAddress` (`0x0001`). Both schemes are reachable end-to-end (M-2). |
| `errors.ts` | `StealthAddressError` base + typed subclasses. |
| `internal/entropy.ts` | CSPRNG-only `csprngBytes` (STLTH-13; WebCrypto, bound at load, no fallback). |
| `internal/codec.ts` | Strict hex codec + branded-type validators (width + prefix + hex-body + curve-prefix). |
| `index.ts` | Public surface. |

## 4. Flows

### 4.1 Sender — derive (`deriveStealthAddress(metaAddress, ephemeral, schemeId)`)

1. `schemeId` is a defensive arg; it must be a recognised scheme and must equal
   `metaAddress.scheme` (else `UnsupportedScheme` / `SchemeMismatch`). Dispatch
   on `metaAddress.scheme`.
2. **Canonical:** `shared = ECDH(eph_priv, viewing_pub)` (65-byte uncompressed);
   `h = keccak256(shared)`; `S = spending_pub + (h mod n)·G`;
   `addr = keccak256(S.X‖S.Y)[-20:]`; `tag = h[0]`. Announcement carries the
   **compressed** ephemeral pubkey.
3. **FluidKey:** `shared = ECDH(eph_priv, spending_pub)`;
   `h = keccak256(shared.X‖shared.Y)`; `S = spending_pub·(h mod n)`; same
   address/tag recipe. Announcement carries the **uncompressed** ephemeral pubkey.
4. Zero-scalar guards on `h mod n`; `assertValidity()` on the output point.
   Meta-address is dropped from the return (STLTH-14).

### 4.2 Recipient — scan (`scanAnnouncement(announcement, credentials)`)

1. `announcement.schemeId` must equal `credentials.scheme` (else `SchemeMismatch`).
2. Recompute the shared hash from the recipient's key material (canonical:
   viewing priv + eph pub; FluidKey: spending priv + eph pub) and compare its
   first byte against `announcement.viewTag`. Miss → `null` (the ~1/256 view-tag
   prefilter).
3. On a tag hit, reconstruct the candidate stealth point/address and compare to
   `announcement.stealthAddress`. Match → address, else `null`.
4. To spend, `deriveStealthPrivateKey` computes `stealth_priv` (canonical:
   `spending_priv + h`; FluidKey: `spending_priv·h`, both mod n) and
   **self-validates** that `stealth_priv·G` maps to the announced address
   (`ScanIntegrityError` on mismatch).

### 4.3 Sender — announce (`buildAnnounceCall(announcement, announcerAddress)`)

Encodes `announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey,
bytes metadata)` where `metadata` is exactly the 1-byte view tag (STLTH-12).
`buildAnnounceCalldata` first rejects an off-curve `ephemeralPubKey`
(`assertValidity`) to prevent shipping a point that would DoS recipient discovery
(CRYPTO-09). `buildAnnounceCall` runs `assertCanonicalAnnouncer` (STLTH-20)
before returning the `EvmCall`.

### 4.4 Sender — withdraw + bundle (`prepareStealthWithdrawal(request)`)

1. `resolveRecipient(request.recipient)` → `MetaAddress` — either a `CanonicalMetaAddress`
   (`0x0001`, from a `canonical` `{ spendingPubKey, viewingPubKey }` identifier) or a FluidKey
   meta-address (`0xfffe`, from a `raw` identifier). As of M-2 the canonical EIP-5564 scheme is
   reachable through the orchestrator; previously `resolveRecipient` returned only FluidKey and
   `prepareStealthWithdrawal` could never emit a canonical announcement.
2. `generateEphemeralKeyPair(scheme)` — always CSPRNG-fresh; the orchestrator
   **refuses** a caller-supplied ephemeral (ENTROPY-08) so a reused/deterministic
   keypair can't collapse unlinkability.
3. `deriveStealthAddress` → `{ stealthAddress, announcement }`.
4. `request.generateWithdrawCall(stealthAddress)` — a **caller callback** that
   returns the PP `EvmCall` withdrawing to that destination. The orchestrator
   does not synthesise the proof (STLTH-04, no PP-contract changes) and does not
   decode the calldata; it trusts the caller to bind the stealth address into the
   proof's public signals.
5. `composeWithdrawalBundle` asserts `declaredDestination == announcement.stealthAddress`
   (STLTH-18) and returns `{ withdraw, announce }`, meant for **atomic**
   single-tx submission (STLTH-03).

### 4.5 Recipient — binding (`verifyAnnouncementBindsToWithdrawal`)

After a positive scan, the recipient confirms a `PoolVault.Withdrawal` event in
the **same tx** as the announcement paid the announced address. All supplied
withdrawal events must share `announcementTxHash` (else it throws). This is a
**structural** check, not a cryptographic one: its guarantee holds only if the
announce and the withdraw were co-submitted atomically. As of M-1 that atomic
co-submission is guaranteed on-chain by `PrivacyPoolRelay.relayAndAnnounce`, which
relays the withdrawal and calls the ERC-5564 Announcer in the same transaction and
reverts unless the announced stealth address equals the payout recipient (see §6.4).

## 5. Public API (`index.ts`)

`deriveStealthAddress`, `deriveStealthSharedSecret`, `generateEphemeralKeyPair`, `scanAnnouncement`,
`recoverStealthSharedSecret`, `deriveStealthPrivateKey`, `resolveRecipient`, `prepareStealthWithdrawal`,
`buildAnnounceCall`, `ERC5564_ANNOUNCE_ABI`, `composeWithdrawalBundle`,
`verifyAnnouncementBindsToWithdrawal`, `computeViewTag`,
`encodeViewTagAsMetadata`, `VIEW_TAG_BYTES`, `assertCanonicalAnnouncer`,
`CANONICAL_ANNOUNCER_ADDRESS`, `SCHEME_CANONICAL`, `SCHEME_FLUIDKEY`,
`assertNever`, the error classes, and the branded types.

`deriveStealthSharedSecret` (sender) / `recoverStealthSharedSecret` (recipient, post-scan) expose
the ECDH shared-secret hash the module already computes internally as an intermediate value —
added for `packages/relayer/dust-rescue-prover`'s dust-rescue secret delivery (§8), which needs a
symmetric key only sender and recipient can derive for a payload the fixed-size ERC-5564
`metadata` field can't carry. Not sensitive to expose: the caller already holds the private key
material needed to recompute it unassisted.

**Migration note (from Phase 1 `d91112f2`):** `buildAnnounceCalldata` was
**removed from the public surface** (regression-tested `NEGATIVE-20`); external
callers must use `buildAnnounceCall`, which enforces the announcer chokepoint.
Consumers that hard-coded `schemeId 0x0001` for FluidKey must migrate to
`0xfffe`; the ID is now the discriminant of the `Announcement` union.

## 6. Security considerations

1. **Entropy (STLTH-13).** Ephemeral keys come only from WebCrypto, bound at
   module load (`internal/entropy.ts`) so a later monkey-patch cannot downgrade
   the handle; no deterministic fallback. Rejection-sampled over `[1, n)`.
2. **Scheme confusion.** Every entry point dispatches on the union discriminant
   with `assertNever` in the default arm, and a `schemeId`/`scheme` disagreement
   is a typed hard error before any curve math. A cross-scheme announcement is
   rejected at the view-tag prefilter with overwhelming probability
   (`PROP-04`: 10 000-pair fuzz, canonical scanner never recovers a FluidKey
   announcement and vice versa) — a mismatched scheme yields `null`, never a
   wrong-but-valid address.
3. **Announcer anonymity set (STLTH-20).** All ERC-5564 traffic must flow through
   the one canonical CREATE2 announcer; using any other narrows the anonymity set
   to "users of that deployment," so the SDK refuses non-canonical announcers at a
   single chokepoint.
4. **Announcement integrity.** `deriveStealthPrivateKey` self-validates the
   recovered key controls the announced address, catching a mangled announcement.
   Discovery integrity additionally relies on §4.5 binding, which in turn relies
   on atomic co-submission — now guaranteed on-chain by
   `PrivacyPoolRelay.relayAndAnnounce` (M-1), which enforces
   `announcement.stealthAddress == PayoutRouting.recipient` and calls the Announcer
   as the last action of the same transaction that funds the stealth address. The
   announced **stealth address** is thus on-chain-bound to the withdrawal recipient
   (not merely advisory). Scope (audit L-A / INTL-06): only the *address* is enforced
   on-chain — `ephemeralPubKey`/`schemeId`/`metadata` are forwarded to the Announcer
   un-proven, so a wrong ephemeral key breaks the recipient's off-chain *discovery* of
   an otherwise-correctly-funded payment and is recoverable by re-announcing; it is
   never a fund-safety issue.
5. **View/spend separation.** Canonical keeps it (scanning needs only the viewing
   key). FluidKey's scanner needs the **spending** private key (STLTH-17
   deviation): a hot scanner holds spending authority, an accepted trade-off for
   FluidKey-kit interop.
6. **View tag.** 1 byte (STLTH-09) — ~1/256 false-positive prefilter, resolved by
   the candidate-address check; no false negatives; no fund-recovery risk from a
   false positive.

## 7. Deliberate deviations

- **INTL-01/02** (`agents/deviations.md`): the module is exempt from the SDK
  barrel-import + verb-first-test-name conventions; it uses its own `STLTH-NN`
  rubric and a `StealthAddressError` base (not `…BaseError`).
- **STLTH-04:** no PP-contract changes — the withdraw call is a caller callback.
- **STLTH-14:** meta-address never appears in sender-side output.
- **STLTH-17:** FluidKey scanning uses the spending key.
- **STLTH-21:** `0xfffe` is a placeholder pending FluidKey ID registration.

## 8. Not yet implemented / open gaps

### Resolved

- **Canonical scheme reachable through the orchestrator (M-2, RESOLVED).**
  `resolveRecipient` now accepts a `canonical` `RecipientIdentifier`
  (`{ kind: "canonical"; spendingPubKey; viewingPubKey }`, both compressed keys,
  curve-validated) and returns a `CanonicalMetaAddress` (`0x0001`), so
  `prepareStealthWithdrawal` can emit a canonical EIP-5564 announcement. Previously
  the resolver returned **only** FluidKey (`0xfffe`); the canonical derive/scan/announce
  machinery already existed — only the resolver gated it.
- **Relayer submission path / atomic (withdraw, announce) transport (STLTH-03, RESOLVED via M-1).**
  `PrivacyPoolRelay.relayAndAnnounce` relays the withdrawal to a stealth address and
  calls the ERC-5564 Announcer atomically in the same transaction, enforcing on-chain
  that the announced stealth **address** equals the payout recipient (the address half of
  the STLTH-18 binding §4.5 depends on is now on-chain-enforced; the other announcement
  fields remain forwarded-not-proven — audit L-A / INTL-06). The SDK reaches it via
  `RelayerInteractor.relayWithAnnounce` → `POST .../relay-and-announce`
  (see [relayer-interactor.md](./relayer-interactor.md)); the announcement is carried
  as plain data, so the stealth sub-package stays isolated (INTL-01).
- **Announcer address (L-1, RESOLVED).** `CANONICAL_ANNOUNCER_ADDRESS` was verified
  against the EIP-5564 spec deployment and Etherscan; it checksums to the canonical
  singleton `0x55649E01B5Df198D18D95b5cc5051630cfD45564`, which the on-chain
  `PrivacyPoolRelay.ANNOUNCER` immutable pins on live chains.

### Still open

- **Identifier resolution** — `raw` + `canonical` key material only; `*.fkey.eth`
  ENS/CCIP-Read and ERC-6538 registry lookup are declared future work (STLTH-05).
- **Stealth × batch / yield withdrawals (C-3).** `relayAndAnnounce` is standard-relay
  only — it composes with neither `relayBatch` nor the yield (`processorAddress`)
  withdrawal path. Stealth payments that also batch or redeem-to-underlying are not
  yet supported.
- **Stealth × deposits (new, 2026-08-07).** Everything above is withdrawal-payout
  stealth: a plaintext on-chain destination the contract can bind an announcement
  against (`relayAndAnnounce` enforces `announcement.stealthAddress ==
  PayoutRouting.recipient`). A first deposit-side composition now exists —
  `PoolSessionReshieldCrosschain`'s stealth dust rescue (see
  [pool-session.md](../core-sdk/pool-session.md) §Stealth Dust Rescue and
  [withdraw-and-swap.md](../core-sdk/withdraw-and-swap.md) §Cross-Chain Reshield) — where a
  relayer-generated shielded deposit note is owned by a stealth address instead of a
  withdrawal payout. This is structurally different, not just a new call site: deposit
  ownership (`noteAddressHash`) is Poseidon-hashed and never appears in plaintext
  on-chain, so the on-chain announcement-binding pattern this module relies on for
  withdrawals has no equivalent for deposits — reinforced, not undermined, by the
  delivery mechanism below, which also carries no on-chain announcement. The module's
  derivation functions (`resolveRecipient` / `generateEphemeralKeyPair` /
  `deriveStealthAddress`) are reused as-is by `packages/relayer/dust-rescue-prover` — a
  new, relayer-side caller, not a change to this module. **Secret delivery resolved
  (2026-08-10/11, "Camouflaged dust-rescue delivery"):** since the fixed 1-byte ERC-5564
  `metadata` field can't carry the deposit's note payload, the module gained
  `deriveStealthSharedSecret` (sender) / `recoverStealthSharedSecret` (recipient) that
  expose the ECDH shared secret already computed internally as an intermediate value,
  plus `encodeStealthDepositPayload` / `scanDepositNoteData` that pack the encrypted
  payload straight into the deposit's own `noteData.data` — arbitrary-length, so no
  separate announcement channel is needed. This supersedes an earlier design that
  delivered the encrypted secret via a new `RelaySwaps.rescueDust(...)` contract event,
  reverted for publicly tagging rescue deposits and shrinking their anonymity set
  (contradicting the feature's anonymity requirement — the whole point of §"Stealth ×
  deposits" carrying no on-chain announcement in the first place). Discovery is wired
  SDK-internally via `NoteDiscoveryService.scanStealthDeposits`. Scoped narrowly to the
  dust-rescue case — this is not a general-purpose "stealth deposit" API. **On-chain
  submission of the resulting deposit call is now RESOLVED (2026-08-17)** via the
  standalone `packages/relayer/dust-rescue-service` (see
  `docs/tech-design/relayer/dust-rescue-service.md`) — a mechanical wiring fix only, no
  change to this module. See `agents/deviations.md` INTL-09.
