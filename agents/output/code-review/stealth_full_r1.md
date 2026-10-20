# Code Review + Coherence — Whole stealth-addresses feature

- **Commit:** `b69a1355` (branch `v2.0-features`)
- **Base v2 style reference:** `v2.0` @ `d91112f2`. `packages/contracts/CLAUDE.md` and
  `packages/sdk/CLAUDE.md` confirmed present+unchanged in base v2 → trustworthy oracles.
  `packages/relayer/CLAUDE.md` validated against base-v2 relayer code, not just its written claims.
- **Delta since prior review** (`stealth_m1_m2_r1.md` @ `f9e9d71`): only two **docs** commits
  (`3f912771`, `b69a1355`); no stealth/contract/relayer source changed. The prior review's
  **CR-1** (import block not alphabetically sorted) is **RESOLVED** — `forge fmt --check` on all four
  contract scope files now **exits 0**, and `IERC5564Announcer` sorts above `IEntrypoint` in both
  `PrivacyPoolRelay.sol` and `IPrivacyPoolRelay.sol`.
- **Scope:** all 18 `packages/sdk/src/stealth/**` files; `PrivacyPoolRelay.relayAndAnnounce` +
  `ERC5564Announcer`/`IERC5564Announcer`; the SDK relay leg (`RelayerInteractor.relayWithAnnounce`,
  `RelayAndAnnounceRelayParams`, schemas); the relayer relay-and-announce stack; `stealth.md`.
- **Verdict: PASS.** No High/Medium correctness or coherence defects. Cross-layer Announcement
  parity holds across all four layers. Findings are low/informational: 2 low (1 dead re-export,
  1 reducible duplication) + 3 stale-comment/coherence nits + 2 informational.

---

## Correctness / coherence — no High or Medium found

The crypto dispatch is sound and the branded-type + Announcement contracts line up end-to-end.
No correctness bug, no unreachable branch that changes behavior, no silent-drop field.

---

## CODE-REVIEW findings

### CR-1 [Low — dead code] `derive.ts:91-92` re-exports four helpers no one imports via `derive.js`
- `derive.ts:91-92` re-export `computeFluidKeySharedHash`, `fluidKeyPublicKeyToEvmAddress`,
  `canonicalPublicKeyToEvmAddress`, `computeCanonicalSharedHash` from the per-scheme modules.
- Verified: the only importers of `./derive.js` are `index.ts` and `withdraw.ts`, and both pull only
  `deriveStealthAddress` / `generateEphemeralKeyPair`. The scan modules import those four helpers
  **directly** from `derive-canonical.js` / `derive-fluidkey.js`. `index.ts` does not re-export them,
  and `stealth.md` §5 does not list them as public. → the two re-export lines are dead.
- Fix: delete `derive.ts:91-92`.

### CR-2 [Low — simplification] Duplicated, non-scheme-specific EVM-address derivation
- `canonicalPublicKeyToEvmAddress` (`derive-canonical.ts:75-83`) and `fluidKeyPublicKeyToEvmAddress`
  (`derive-fluidkey.ts:69-80`) are byte-identical logic — validate 65-byte `0x04` point,
  `keccak256(bytes.slice(1))`, take last 20 bytes — differing **only** in input type (`Uint8Array`
  vs `UncompressedPubKey` hex). This is standard Ethereum address derivation, *not* a scheme-specific
  recipe, so the per-scheme split is unjustified duplication (the genuinely per-scheme parts —
  ECDH-target key, hash width, point add-vs-mul — are already correctly factored and *not* flagged).
- Fix: one shared `uncompressedPubKeyToEvmAddress(bytes: Uint8Array)` (e.g. in `internal/codec.ts`);
  the hex-input callsite does `hexToBytes` then delegates. Both remain correct + tested.

### CR-3 [Low — coherence/convention] Inaccurate scheme-specific comment in the shared calldata builder
- `announce.ts:46`: `// - ephemeralPubKey as bytes (the 65-byte uncompressed pubkey, length-prefixed)`.
  `buildAnnounceCalldata` serves **both** schemes, and a **canonical** announcement carries a
  **33-byte compressed** ephemeral pubkey (`types.ts:92`, `derive-canonical.ts:133`). The comment
  is wrong for canonical; `stealth.md` §4.3 does not make this error.
- Fix: reword to "the 33-byte compressed (canonical) or 65-byte uncompressed (FluidKey) ephemeral pubkey".

## COHERENCE findings

### CO-1 [Low — stale doc, half-migrated] `resolve.ts` docstring still says "raw mode only"
- `resolve.ts:26-35`: "v5 supports the `raw` mode only … v5 lands the raw path; subsequent slices
  (v6+) add the others." But the function body implements the `canonical` case (`resolve.ts:54-73`,
  M-2), and `stealth.md` §8 documents canonical as **RESOLVED**. Residual FluidKey→multischeme
  refactor comment that now contradicts both the code and the spec doc.
- Fix: update the docstring to state both `raw` (→FluidKey `0xfffe`) and `canonical` (→`0x0001`)
  are supported, with only ENS/CCIP-Read + ERC-6538 still future (STLTH-05).

### CO-2 [Informational — coherence] Version-tag drift across future-work comments
- The same future work (ENS/CCIP-Read + ERC-6538) is tagged differently: `index.ts:8` "(v9+)",
  `resolve.ts:35` "(v6+)", while `stealth.md` §8 correctly ties it to **STLTH-05** with no version.
- Fix: drop the ad-hoc `vN` tags in the doc-comments and reference STLTH-05 (the doc's convention).

### CO-3 [Informational — coherence] `SchemeMismatchError` message assumes a meta-address caller
- `errors.ts:44-45` hard-codes "meta-address declares scheme X but caller passed scheme Y", but
  `scan.ts:41` and `scan.ts:86` raise it with `(announcement.schemeId, credentials.scheme)` — the
  first arg is an **announcement**, not a meta-address. Message is mildly misleading on the scan path
  (functionally correct; still a typed hard error before any curve math).
- Fix: generalize to "declared scheme 0x… but caller passed scheme 0x…".

### CO-4 [Informational — note only, no change] Discriminant field name not uniform across the two unions
- `MetaAddress` / `ScanCredentials` / `DerivePrivCredentials` discriminate on `scheme`; `Announcement`
  discriminates on `schemeId`. Dispatch sites therefore read `.scheme` vs `.schemeId`. Defensible —
  `schemeId` mirrors the ERC-5564 `announce(uint256 schemeId,…)` arg and the on-chain struct field,
  `scheme` mirrors the EIP-5564 meta-address field — so this is intentional, not drift. Recorded for
  completeness; no change recommended.

---

## Convention checks that PASS (evidence)

- **Contract (base-v2 Solidity rules).** Single-line `///` only; errors are `PrivacyPoolRelay_*`
  and raised via `require(cond, PrivacyPoolRelay_AnnouncementRecipientMismatch())`
  (`PrivacyPoolRelay.sol:129`); `Announcement`/`PayoutRouting` structs live in the interface
  (`IPrivacyPoolRelay.sol:21-38`); immutable `ANNOUNCER` is `SCREAMING_SNAKE` (`PrivacyPoolRelay.sol:41`);
  section banners present + ordered; CEI honored (relay first, `ANNOUNCER.announce` last, no persistent
  state — `PrivacyPoolRelay.sol:133-136`). `ERC5564Announcer` faithful to the ERC-5564 minimal shape.
  `forge fmt --check` on all four scope files → exit 0.
- **Stealth sub-package (INTL-01/02 exempt — not flagged).** Own barrels, branded `Hex`/`EvmAddress`/
  `Scalar32`, `StealthAddressError` base, `STLTH-NN`/rubric-prefixed test titles — all as designed;
  correctly excluded from base-SDK barrel/verb-first rules.
- **Scheme-dispatch uniformity.** `derive.ts` and `scan.ts` both dispatch on the union discriminant
  with `assertNever` in the default arm; a `schemeId`/`scheme` disagreement is a typed hard error
  (`StealthAddressSchemeMismatchError`) before any curve math. `derive.ts` additionally range-checks
  its untyped `schemeId: number` arg (`UnsupportedScheme`); `scan.ts` relies on the typed
  `ScanCredentials`/`DerivePrivCredentials` unions — a justified asymmetry given the signatures.
- **Per-scheme derive/scan duplication is justified.** The recipes genuinely differ (ECDH target
  viewing-vs-spending key; hash 65-vs-64 bytes; point add-vs-mul; priv `+`-vs-`*`), and the common
  parts (`computeXSharedHash`, `computeViewTag`, the shared-hash ECDH-to-uncompressed) are already
  factored into helpers. Only the address-from-uncompressed-pubkey step is over-duplicated (CR-2).
- **Discriminated-union usage consistent.** `Announcement`/`MetaAddress` used as tagged unions
  throughout; `Extract<Announcement, {schemeId: …}>` narrowing at the scan dispatch (`scan.ts:46,52`).
- **Error taxonomy coherent.** `StealthAddressError` base + 5 subclasses, each sets `this.name`; all
  exported (`index.ts:57-64`) and all referenced in source.
- **`internal/` boundary sound.** `codec.ts` (strict hex + branded validators with width/prefix/
  hex-body/curve-prefix) and `entropy.ts` (CSPRNG-only, method bound at load, no fallback) are
  self-contained and only import `../errors.js`/`../types.js`; no leakage of internal helpers to `index.ts`.
- **`buildAnnounceCalldata` correctly NOT public.** Used internally by `buildAnnounceCall`; absent from
  `index.ts` — matches `stealth.md` §5 migration note (regression `NEGATIVE-20`).

## Type ⟺ schema parity + single-source across the relayAndAnnounce boundary — PASS

All four layers agree on field names and types:

| Field | Contract struct (`IPrivacyPoolRelay.sol:33-38`) | SDK type (`types/RelayerInteractor.ts:294-303`) | SDK schema (`schemas/RelayerInteractor.ts:170-175`) | Relayer schema (`evm/schemas.ts:194-198`) / ABI tuple (`relayer_abi.ts:218-221`) |
|---|---|---|---|---|
| `schemeId` | `uint256` | `Hex` | `HexIntegerSchema` | `zHex` / `uint256` |
| `stealthAddress` | `address` | `Address` | `AddressSchema` | `zEvmAddress` / `address` |
| `ephemeralPubKey` | `bytes` | `Hex` | `HexIntegerSchema` | `zHex` / `bytes` |
| `metadata` | `bytes` | `Hex` | `HexIntegerSchema` | `zHex` / `bytes` |

- **No dropped field.** `RelayAndAnnounceRelayParamsSchema` nests `announcement` as an **explicit**
  key via `.extend` (not spread), with the anti-strip comment (`schemas/RelayerInteractor.ts:177-180`);
  `zEvmRelayAndAnnounceRequest.extend({ announcement: zAnnouncement })` mirrors it on the relayer.
  All four `StealthAnnouncementFields` keys have matching schema keys on both sides.
- **`schemeId` hex→bigint converted once, at the chain-service boundary** (`evm.chain.service.ts:522`,
  `{ schemeId: BigInt(schemeId), stealthAddress, ephemeralPubKey, metadata }`); relayer_abi tuple
  matches the contract struct field-for-field. No duplicated derivation that can drift.
- **On-chain single-source binding.** `relayAndAnnounce` decodes `PayoutRouting` from the same
  `_transactParams.data` the proof context commits to and requires
  `_announcement.stealthAddress == _payout.recipient` (`PrivacyPoolRelay.sol:128-129`) — the address
  is not recomputed, it is read from the one authoritative source (the on-chain half of STLTH-18).

## External coherence — PASS

- **Branded-type boundary respected.** The stealth sub-package's branded `Announcement` (with
  `viewTag: number`) never crosses into the main SDK; `RelayerInteractor` carries the announcement as
  plain `StealthAnnouncementFields` hex data (`metadata` already view-tag-encoded), so the sub-package
  stays isolated (INTL-01) — as `stealth.md` §8 states. (Observation: no in-`src` adapter converts a
  stealth-module `Announcement`→`StealthAnnouncementFields`; the integrator hand-maps `viewTag`→
  `metadata` via `encodeViewTagAsMetadata` and `schemeId`→hex. Acceptable — the two transports
  (raw-EvmCall bundle vs `relayWithAnnounce`) are deliberately separate — but a thin helper would
  remove a hand-mapping seam. Not a defect.)
- **`WithdrawCallGenerator` seam.** `prepareStealthWithdrawal` treats the PP withdraw call as an opaque
  caller callback bound to the derived `stealthAddress` (`withdraw.ts:20,74-75`), never decoding
  calldata (STLTH-04) — consistent with `bundle.ts`'s `declaredDestination` binding.
- **Doc ⟺ code.** `stealth.md` (v0.2.0) matches the code: the component table, both scheme recipes,
  the M-1/M-2 resolutions, and the C-3 "stealth × batch/yield unsupported" gap all check out. The only
  doc/code divergences are the stale in-code comments CO-1/CO-2 (the spec doc is correct; the code
  comments lag).
