# Test-Gap Report — Stealth Addresses (full feature) — round 1

- **Scope:** `packages/sdk/src/stealth/**`, `PrivacyPoolRelay.relayAndAnnounce`, `ERC5564Announcer`,
  SDK `RelayerInteractor.relayWithAnnounce` + `RelayAndAnnounceRelayParamsSchema`.
- **Tests reviewed:** `packages/sdk/test/unit/stealth/**` (14 files), `packages/sdk/test/services/StealthWithdraw.realproof.integration.test.ts`,
  `packages/sdk/test/unit/services/RelayerInteractor.test.ts` (`relayWithAnnounce`),
  `packages/contracts/test/integration/RelayAndAnnounce.t.sol`, `packages/contracts/test/unit/PrivacyPoolRelay.t.sol` (relayAndAnnounce cases).
- **Commit:** `b69a13550377473036c566bcb60c4d77c1d3f416` (branch `v2.0-features`).
- **Relayer note:** `packages/relayer/**` has **no** relay-and-announce endpoint code (grep for `announce` is empty).
  The relay-and-announce wire surface lives entirely in the SDK (`relayWithAnnounce`) + contract. Nothing to check on the relayer side.

## Verdict

Coverage is **strong and mostly real**: FluidKey derivation is checked byte-for-byte against the real
upstream kit; canonical + FluidKey round-trips, cross-scheme isolation, view-tag, binding, and the
STLTH-18/STLTH-20 guards are all exercised with real crypto; `relayAndAnnounce` has a **real-Groth16 +
real-Announcer** integration E2E (funds land, event emitted) and a mock unit twin; the SDK
`relayWithAnnounce` announcement leg is asserted to survive Zod and reach the POST body (TEST-8);
`StealthWithdraw.realproof` ties a **real withdrawal proof** to the announcement stealth address.

**One material gap (G1): the canonical scheme has NO external-interop vector** — it is pinned only against
itself (self-consistency), while FluidKey is pinned against the real `@fluidkey/stealth-account-kit`. This
is the exact failure class the FluidKey vector exists to catch, and canonical is the scheme "standard
ERC-5564 scanners discover." The remaining gaps are Medium/Low (FluidKey never crosses the schema→wire→
contract surface; orchestrator-level scheme-mismatch guard untested).

---

## Flow × coverage matrix

Legend: ✓ real | ~ mock-only or partial | ✗ missing. `file:line` = primary test.

### Sender (payer)
| Flow | Status | Test |
|---|---|---|
| S1a resolve `raw` → FluidKey meta (+curve check) | ✓ | resolve.test.ts:20,52 |
| S1b resolve `canonical` → spend+view meta (+curve check, both keys) | ✓ | resolve.test.ts:68,95 |
| S1c resolve ENS/ERC-6538 | n/a | not implemented (compile-guarded exhaustiveness) |
| S2 generate ephemeral, no-seed API (STLTH-13) | ✓ | properties.test.ts:45,53 (1000 distinct, real CSPRNG) |
| S2a canonical ephemeral = 33-byte compressed | ✓ | derive-canonical.test.ts:104; withdraw.test.ts:99 |
| S2b FluidKey ephemeral = 65-byte uncompressed | ✓ | derive.test.ts; withdraw.test.ts:63 |
| S3a derive canonical (point addition) | ✓ (internal only) | derive-canonical.test.ts:56; scopelift-vectors.test.ts:61 |
| S3b derive FluidKey (point mult) | ✓ **external** | fluidkey-vectors.test.ts:47 (byte-for-byte vs kit) |
| S3c view tag = hash[0], 1 byte | ✓ | viewTag.test.ts:11,22; derive-canonical.test.ts:162 |
| S3d unsupported scheme id rejected | ✓ | derive.test.ts:110,118 |
| S3e schemeId≠meta.scheme rejected (STLTH-19) | ✓ | dispatch.test.ts:68,76 |
| S4a announce calldata round-trips viem | ✓ | announce.test.ts:27 |
| S4b metadata = 1-byte view tag only (STLTH-12) | ✓ | announce.test.ts:51; viewTag.test.ts |
| S4c off-curve ephemeral rejected (CRYPTO-09) | ✓ | properties.test.ts:241; announce path |
| S4d canonical Announcer enforced (STLTH-20) | ✓ | announcer.test.ts:35,72,82,114 |
| S5a compose bundle happy | ✓ | bundle.test.ts:35 |
| S5b compose bundle dest≠stealth rejected (STLTH-18) | ✓ | bundle.test.ts:57,74 |
| S6a orchestrator FluidKey happy | ✓ | withdraw.test.ts:32 |
| S6b orchestrator canonical happy | ✓ | withdraw.test.ts:72 |
| S6c meta-address not leaked (STLTH-14) | ✓ | withdraw.test.ts:103; properties.test.ts:63 |
| **S6d orchestrator explicit `schemeId` conflicting w/ resolved meta** | **✗** | — (only lower-level dispatch tested) |
| S7a atomic relayAndAnnounce on-chain (real proof + real announcer, funds+event) | ✓ **real** | RelayAndAnnounce.t.sol:42 |
| S7b stealth≠recipient reverts (no relay, no announce) | ✓ real + ✓ mock | RelayAndAnnounce.t.sol:81; PrivacyPoolRelay.t.sol:1073 |
| S7c relayWithAnnounce → announcement leg reaches POST body (TEST-8) | ✓ | RelayerInteractor.test.ts:841 |
| S7d relayWithAnnounce announcement-missing rejected | ✓ | RelayerInteractor.test.ts:872 |
| S7e relayWithAnnounce fee-commitment-expired rejected | ✓ | RelayerInteractor.test.ts:863 |
| S7f ZeroAnnouncer constructor guard | ✓ | PrivacyPoolRelay.t.sol:67 |
| **S7g FluidKey (65-byte ephemeralPubKey) through schema→wire→contract** | **✗** | — (all wire/real-proof use canonical/compressed shape) |
| S7h self-submitted (non-relayed) multicall of the composed bundle | ✗ note | no on-chain test; likely out of scope (no dedicated entrypoint) |

### Recipient (scanner)
| Flow | Status | Test |
|---|---|---|
| R1a scan canonical positive | ✓ | derive-canonical.test.ts:56; scopelift-vectors.test.ts:82 |
| R1b scan FluidKey positive | ✓ | derive.test.ts:49 |
| R1c non-recipient → null (no throw) | ✓ | derive.test.ts:142,154; derive-canonical.test.ts:114,127 |
| R1d cross-scheme isolation (canon scanner ↮ FK announcement) | ✓ | dispatch.test.ts:97,181; properties.test.ts:161 (10000) |
| R1e creds.scheme≠announcement.schemeId error | ✓ | dispatch.test.ts:84,120 |
| R2a recover canonical priv (pinned scalar) | ✓ (internal) | scopelift-vectors.test.ts:101 |
| R2b recover FluidKey priv | ✓ round-trip | derive.test.ts:49; **external scalar NOT pinned** (fixture has no expected priv) |
| R2c integrity: mangled announcement rejected | ✓ | derive.test.ts:175; derive-canonical.test.ts:144 |
| R3a binding accept same-tx match | ✓ | discoveryBinding.test.ts:37 |
| R3b binding reject no-match | ✓ | discoveryBinding.test.ts:50 |
| R3c binding reject empty set | ✓ | discoveryBinding.test.ts:70 |
| R3d binding mixed batch | ✓ | discoveryBinding.test.ts:78 |
| R3e cross-tx withdrawal throws (BIND-01) | ✓ | discoveryBinding.test.ts:111,127 |
| R4 recipient E2E: bundle→on-chain sim→scan→bind | ✓ | withdraw.test.ts:126 (FluidKey, honest path) |

### Cross-cutting
| Flow | Status | Test |
|---|---|---|
| **Canonical EXTERNAL interop vs ScopeLift / EIP-5564 reference** | **✗** | fixture explicitly defers as INTEROP-CANONICAL-02 |
| FluidKey EXTERNAL interop | ✓ | fluidkey-vectors.test.ts (2 vectors vs kit) |
| ERC5564Announcer standalone unit (arbitrary caller emits) | ~ | only via RelayAndAnnounce.t.sol integration (real, but transitive) |
| STLTH-21 sunset symbols stay deleted | ✓ | announcer.test.ts:91,101 |

---

## No-mock-only sweep (TEST-7) — result
- FluidKey interop vectors — **REAL** external (`@fluidkey/stealth-account-kit`). ✓
- Canonical vectors — **self-consistency only** (fixture `source` = "Generated by an ad-hoc Node + @noble
  harness … External byte-for-byte agreement … is INTEROP-CANONICAL-02 (deferred)"). **= G1.**
- Announce on-chain call hits a **real** `ERC5564Announcer` (`_privacyPoolRelay.ANNOUNCER()`, `vm.expectEmit`
  on its real address). ✓ (mock twin in the unit test has this real counterpart).
- Atomic binding + mismatch-revert — **real** (RelayAndAnnounce.t.sol, real ffi Groth16 proofs) AND mock
  (PrivacyPoolRelay.t.sol). ✓
- sender→scan→recover round-trip — real crypto end-to-end (derive.test, properties PROP-02, withdraw e2e). ✓
- Real Groth16 withdrawal proof bound to stealth address — `StealthWithdraw.realproof` (canonical) +
  RelayAndAnnounce.t.sol (real ffi proof). ✓ **canonical only** — see G2.

## CI selection (TEST-4)
- `packages/sdk/vitest.config.ts` `include: ["test/**/*.test.ts"]`, no integration exclude → all 14 stealth
  unit files + `RelayerInteractor.test.ts` + `StealthWithdraw.realproof.integration.test.ts` are **selected**.
- `StealthWithdraw.realproof` is `describe.skipIf(!hasTransactArtifacts)` → **silently skipped** if
  `packages/circuits/build/transact_1x1/**` is absent. Confirm the CI job builds circuits before the SDK
  suite, else the only real-proof stealth E2E in the SDK never runs.
- `RelayAndAnnounceIntegration` (forge, `test/integration/`, real proofs via `vm.ffi`) skips on the pinned
  Sepolia deployment. Confirm the forge integration profile is in the PR gate — heavy ffi proof suites are
  frequently excluded from the fast unit gate; if so this is real-but-unrun-in-default-CI.

## Error-path parity — all covered
`StealthAddressSchemeMismatchError` (dispatch:68,84; derive:129) · `StealthAddressUnsupportedSchemeError`
(derive:110,118) · `StealthAddressAnnouncementError` (bundle:57, announcer:35, discoveryBinding:111) ·
`StealthAddressDeriveError` (resolve:52, viewTag:15, codec, properties CRYPTO-09) ·
`StealthAddressScanIntegrityError` (derive:175, derive-canonical:144) ·
`PrivacyPoolRelay_AnnouncementRecipientMismatch` (unit:1073 + integration:81) ·
`PrivacyPoolRelay_ZeroAnnouncer` (unit:67). The "derived scalar is zero" branches are ~2^-256 and
genuinely infeasible to trigger — acceptable as untested.

---

## Ranked gaps

### G1 — HIGH — Canonical scheme has no external-interop vector
**Risk.** Canonical (`0x0001`) is the scheme the resolve.ts M-2 comment says "standard ERC-5564 scanners
discover." Its recipe has several silent-drift points (hash the full 65-byte shared secret vs 64-byte X‖Y;
compressed vs uncompressed; point-add vs point-mult). Every one of these would still pass `scopelift-
vectors.test.ts` because those vectors were generated by the same code they test. A drift would make **every
standard EIP-5564 wallet fail to discover our canonical payments** — the precise failure FluidKey's vector
guards against, left unguarded for canonical.
**Test to add** — `test/unit/stealth/scopelift-external-vectors.test.ts`:
`vector "<label>": our derive matches ScopeLift/EIP-5564 reference` — for each vector, assert
`deriveStealthAddress(meta, eph, SCHEME_CANONICAL).stealthAddress`, `.announcement.viewTag`, and the
recovered `deriveStealthPrivateKey(...)` equal values **captured from `@scopelift/stealth-address-sdk`
`generateStealthAddress()` / `computeStealthKey()`** (or hand-computed from the EIP-5564 §"scheme 1"
worked example). Store as `test/fixtures/scopelift/external-vectors.json` with a `source` URL + commit.
**Feasibility caveat:** if the ScopeLift SDK cannot be installed/run in this env, capture vectors once from
an environment that can and commit them; do **not** synthesize them from our own code (that just reproduces
the current self-referential fixture). If neither is possible now, keep as a filed known gap — do not
claim canonical interop.

### G2 — MEDIUM — FluidKey never crosses the schema→wire→contract surface
**Risk.** The real-proof E2E (`StealthWithdraw.realproof`) and the `relayWithAnnounce` wire test both use a
canonical/compressed-shaped announcement (`0x02…` 33-byte key, schemeId `0x1`). A 65-byte **uncompressed**
`ephemeralPubKey` (FluidKey `0xfffe`) is never asserted to survive `StealthAnnouncementFieldsSchema`
(`HexIntegerSchema`) and reach the POST body — nor through `relayAndAnnounce` calldata. A width/encoding
assumption that only holds for 33-byte keys would go unnoticed.
**Test to add** — in `RelayerInteractor.test.ts` `relayWithAnnounce`:
`post preserves a FluidKey 65-byte uncompressed ephemeralPubKey and 0xfffe scheme` — build params with
`schemeId:"0xfffe"`, `ephemeralPubKey` = `0x04`+128 hex chars, assert
`body.announcement.ephemeralPubKey` equals it (length `2 + 65*2`) and `body.announcement.schemeId==="0xfffe"`.

### G3 — MEDIUM/LOW — Orchestrator-level scheme-mismatch guard untested
**Risk.** `prepareStealthWithdrawal` accepts an optional `schemeId`; passing `SCHEME_CANONICAL` with a
`raw` (FluidKey) recipient must hard-error via `deriveStealthAddress`. Covered only at the lower dispatch
layer, not at the orchestrator boundary users actually call.
**Test to add** — `withdraw.test.ts`:
`rejects an explicit schemeId that conflicts with the resolved meta-address scheme` — call
`prepareStealthWithdrawal({ recipient:{kind:"raw",…}, schemeId: SCHEME_CANONICAL, … })`, expect rejection
with `StealthAddressSchemeMismatchError`.

### G4 — LOW — FluidKey recovery scalar not externally pinned
`fluidkey-vectors.test.ts` pins only `stealthAddress`; the recovered `stealthPrivateKey` rests on internal
round-trip. If the upstream kit exposes a recovered key, add `expectedStealthPrivateKey` to the fixture and
assert `deriveStealthPrivateKey` matches it. If the kit does not expose it, note infeasible — don't fake it.

### G5 — LOW — `ERC5564Announcer` has no standalone unit test
Its real emit (`Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata)`) is exercised
only transitively via the relay integration. Adequately *real*-covered. Optional: add
`test/unit/ERC5564Announcer.t.sol` asserting a direct `announce(...)` from an arbitrary caller emits with
`_caller == msg.sender` and forwards all four args verbatim.

### G6 — LOW — `RelayAndAnnounceRelayParamsSchema` per-field rejection untested
A *missing* announcement is rejected (tested), but a malformed field (non-address `stealthAddress`, non-hex
`ephemeralPubKey`, missing `metadata`) has no negative test. Add a `relayWithAnnounce` case asserting a
malformed announcement field → `RelayerRejected`.

### G7 — NOTE (likely out of scope) — self-submitted multicall path
`composeWithdrawalBundle` yields a `{withdraw, announce}` pair for a user who submits atomically **without**
the relayer. Only the relayer `relayAndAnnounce` path is exercised on-chain. There is no dedicated contract
multicall entrypoint, so this may be intentionally out of scope; flagged for a decision, not a required test.
