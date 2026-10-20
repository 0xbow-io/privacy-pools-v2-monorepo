# Code-Review + Test-Gap — Stealth M-1/M-2 surface (relayAndAnnounce, ERC-5564 Announcer, canonical resolve)

- **Commit:** `f9e9d71cf6875acdfa0441ec592ee2de0a1b0a88` (branch `v2.0-features`)
- **Base v2 style reference:** `v2.0` @ `d91112f2` ("feat: stealth addresses (#317)"). Note: base v2 already
  ships the stealth crypto + `PrivacyPoolRelay` **without** the announcer leg — the M-1/M-2 announce surface
  (`relayAndAnnounce`, `ERC5564Announcer`, `IERC5564Announcer`, canonical `resolveRecipient`) is branch-authored
  on top, so it is correctly in scope as "new code conforming to pre-existing conventions".
- **Verdict:** PASS with one real Low (mechanical, breaks the `forge fmt --check` CI gate) + informational notes.
  No High/Medium correctness or coverage defects found. Conventions, type⟺schema parity, and the no-mock-only /
  schema→wire / error-path checks all hold.

---

## CODE-REVIEW

### CR-1 [Low — mechanical, fails CI fmt gate] Import block not alphabetically sorted (`sort_imports=true`)
- `src/contracts/PrivacyPoolRelay.sol:6-7` and `src/interfaces/IPrivacyPoolRelay.sol:4-5`
- The new `import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';` is placed **after**
  `IEntrypoint`, but `IERC5564Announcer` sorts before `IEntrypoint` (`'R' 0x52` < `'n' 0x6e`).
- Empirically confirmed: `forge fmt --check` on the six scope files **exits 1** with a diff that moves the
  `IERC5564Announcer` import above `IEntrypoint` in both files. `packages/contracts/CLAUDE.md` pins
  `sort_imports=true`, so this is a real convention violation that breaks the fmt gate.
- Fix: move the `IERC5564Announcer` import above `IEntrypoint` in both files (or run `forge fmt`).
- All other scope files (`ERC5564Announcer.sol`, `IERC5564Announcer.sol`, both test files) pass fmt.

### Conventions that PASS (evidence)
- **Solidity NatSpec / errors / structs / sections** — new code uses single-line `///` only; errors are
  contract-name-prefixed and raised via `require(cond, PrivacyPoolRelay_*())` (e.g. `PrivacyPoolRelay.sol:52-54,
  128`); `Announcement` struct lives in `IPrivacyPoolRelay.sol:33-38` (structs-in-interfaces); immutable
  `ANNOUNCER` is `SCREAMING_SNAKE`; section banners present and ordered. `ERC5564Announcer.sol` faithful to the
  ERC-5564 minimal shape.
- **`bulloak check test/unit/PrivacyPoolRelay.tree`** → "All checks completed successfully" (the new constructor
  `ANNOUNCER`/`RootHistoryTooSmall` branches and the `relayAndAnnounce` branch all map to test fns).
- **CEI / reentrancy** — `relayAndAnnounce` relays first, then calls the pinned immutable `ANNOUNCER` as the last
  action with no persistent state (`PrivacyPoolRelay.sol:117-136`); recipient binding enforced on-chain
  (`stealthAddress == PayoutRouting.recipient`, line 128) = the STLTH-18 guarantee.
- **SDK stealth exemption (M-2)** — `stealth/resolve.ts` stays entirely inside the stealth sub-package barrels
  (imports `./types.js`, `./errors.js`, `./internal/codec.js`, `@noble/curves`); it adds the `canonical`
  `RecipientIdentifier` variant returning `SCHEME_CANONICAL` and does **not** leak main-SDK types. INTL-01/02
  exemption respected. Curve-membership check applied to BOTH canonical keys (resolve.ts:60-71).
- **SDK main-boundary types (M-1 relay leg)** — `StealthAnnouncementFields` (`types/RelayerInteractor.ts:294`)
  and `RelayAndAnnounceRelayParams` use `Hex`/`Address` at the boundary; `RelayerInteractor.relayWithAnnounce`
  is a public method placed among the public block (`services/RelayerInteractor.ts:389`); JSDoc is two-layer —
  interface has base `@throws {RelayerInteractorBaseError}` only (`IRelayerInteractor.ts:130`), impl uses
  `@inheritdoc` + specific `@throws {RelayerRejected}` / `{FeeCommitmentExpired}`.
- **Relayer pipe→schema→service→chain** — `RelayAndAnnounceValidationPipe` → `zEvmRelayAndAnnounceRequest`
  → `EvmRelayService.relayAndAnnounce` → `EVMChainService.simulateAndWriteRelayAndAnnounce`; controller only
  delegates (`relay.controller.ts:89-92`); `zAnnouncement` schema naming + `Announcement = z.infer` type;
  DTO `RelayAndAnnounceRequestDto extends createZodDto(zEvmRelayAndAnnounceRequest)` with `@ApiProperty`;
  `BadRequestException` on amountOut==0 / sim revert; `schemeId` hex→bigint converted at the chain-service
  boundary (`evm.chain.service.ts:522`). Relayer ABI tuple (`relayer_abi.ts:213-222`) matches the contract
  `Announcement` struct.

### Type ⟺ schema parity (recurring-defect check #1) — PASS
- **SDK:** `StealthAnnouncementFields` {schemeId, stealthAddress, ephemeralPubKey, metadata} ⟺
  `StealthAnnouncementFieldsSchema` — all four keys **declared explicitly** (`schemas/RelayerInteractor.ts:170-181`),
  and `RelayAndAnnounceRelayParamsSchema.extend({ announcement: ... })` nests it as an explicit key (not spread),
  with an inline comment noting the anti-strip intent. No dropped field.
- **Relayer:** `Announcement` = `z.infer<zAnnouncement>` (`schemas.ts:194-199`); all four keys present;
  `zEvmRelayAndAnnounceRequest.extend({ announcement: zAnnouncement })` explicit. No dropped field.

### Informational (not defects)
- **INFO-1 (efficiency nit):** `relayAndAnnounce` `abi.decode`s `PayoutRouting` once to read `recipient`
  (line 127) and `_relay` re-decodes the same `_transactParams.data` (line 231). Both decode identical calldata
  so there is **no** drift risk (recurring-check #2 is satisfied), just a small redundant decode. `relayBatch`
  avoids this by reusing `_ref` for item 0; `relayAndAnnounce` could pass the decoded recipient down, but `_relay`
  is shared with plain `relay`, so the current shape is a reasonable readability trade-off. No action required.
- **INFO-2:** SDK `zAnnouncement` fields `ephemeralPubKey`/`metadata` reuse `HexSchema` (aliased
  `HexIntegerSchema`, regex `/^0x[0-9a-fA-F]+$/`, `+` = min one nibble, no normalization). It correctly preserves
  the exact bytes (leading zeros kept), so pubkeys/view-tags are not corrupted. Edge: an **empty** `metadata`
  (`"0x"`) is rejected (min length 1); ERC-5564 metadata always carries at least the 1-byte view tag, so this is
  acceptable in practice. Odd-length bytes would only fail later at viem encode, not schema. No action.

---

## TEST-GAP

### TEST-7 (no-mock-only) — PASS for the announce leg
- The on-chain `announce` is exercised against a **real** announcer, not a mock. `Deploy.s.sol:291-295`
  `_resolveAnnouncer()` deploys a real `ERC5564Announcer` when the canonical singleton has no code (the local
  forge env), and `RelayAndAnnounce.t.sol` (integration, real Groth16) asserts the real `Announcement` event via
  `vm.expectEmit(address(_privacyPoolRelay.ANNOUNCER()))` with `address(_privacyPoolRelay)` as the caller topic
  (`RelayAndAnnounce.t.sol:62-65`). This is the real (non-mock) counterpart to the unit test's
  `vm.mockCall(_announcer, ...)`, and it also gives `ERC5564Announcer.sol` (the one-line emit) real coverage.
- **Mismatch-revert tested for real:** `test_relayAndAnnounce_revertsWhenStealthAddressMismatchesRecipient`
  (`RelayAndAnnounce.t.sol:81-101`) drives the real contract to `PrivacyPoolRelay_AnnouncementRecipientMismatch`.
- **M-2 canonical resolve + derive covered:** `test/unit/stealth/resolve.test.ts` canonical-mode tests assert
  `scheme === SCHEME_CANONICAL`, reject an uncompressed spending key, and reject a malformed viewing key (proving
  both keys are curve-checked). `derive-canonical.test.ts` + `scopelift-vectors.test.ts` cover the derive path.

### TEST-8 (schema→wire survival) — PASS (asserted at every boundary)
- **SDK:** `RelayerInteractor.test.ts:854-859` asserts the whole `announcement` object survives Zod and reaches
  the POST body (all four fields), plus `body` has `proof` — the F-1-style no-strip assertion.
- **Relayer schema:** `evm.relay.service.spec.ts:437-443` "preserve the announcement fields through parsing"
  checks schemeId/stealthAddress/ephemeralPubKey/metadata post-parse.
- **Relayer → contract call args:** `evm.relay.service.spec.ts:485-516` asserts the built `relayAndAnnounce`
  args include the announcement tuple with `schemeId` converted hex→bigint and `metadata`/`ephemeralPubKey`
  reaching the on-chain call unchanged — the field genuinely reaches the wire, not just the type.

### Error-path parity — PASS
| Error / reject | Test |
|---|---|
| `PrivacyPoolRelay_ZeroAnnouncer` | unit `test_Constructor_WhenAnnouncerIsAddressZero` (PrivacyPoolRelay.t.sol:67) |
| `PrivacyPoolRelay_RootHistoryTooSmall` | unit `test_Constructor_WhenRootHistoryNotAboveMaxBatch` (line 93) |
| `PrivacyPoolRelay_AnnouncementRecipientMismatch` | unit `test_RelayAndAnnounce_WhenStealthAddressDoesNotMatchRecipient` (line 1073) + integration (real) |
| SDK `RelayerRejected` (invalid params) | `RelayerInteractor.test.ts:872` "throw RelayerRejected when the announcement is missing" |
| SDK `FeeCommitmentExpired` | `RelayerInteractor.test.ts:863` "throw when the fee commitment has expired" |
| Relayer `BadRequestException` (amountOut==0) | `evm.relay.service.spec.ts:387` |
| Relayer `BadRequestException` (malformed stealthAddress) | `evm.relay.service.spec.ts:430` |
| Relayer `BadRequestException` (sim revert wrap) | `evm.relay.service.spec.ts:518` |

### CI-selection — PASS
- `UnitPrivacyPoolRelay` (contains `Unit`) and `RelayAndAnnounceIntegration` (contains `Integration`) are both
  selected by the respective `--match-contract` globs.

### TG-1 [Low — residual, consistent with the documented known gap] No real (anvil) relayer e2e for relay-and-announce
- `grep -rli announce packages/relayer/e2e` → **no matches**. The relayer's actual on-chain `relayAndAnnounce`
  submission (viem ABI-encode of `relayer_abi.ts` `PP_RELAY_ABI` against the deployed relay, real revert
  behavior) is exercised **only** through the stubbed-client spec (`evm.relay.service.spec.ts:485`, `jest.spyOn`
  on `client`/`signer`). This mirrors the already-documented `withdrawToUnderlying`/processor-dispatch gap
  (relayer on-chain wiring lives only in the docker/anvil e2e, excluded from the PR gate) — here there is not
  even that. The contract's real behavior IS covered by the Solidity integration test, so the only uncovered
  surface is relayer↔contract **ABI drift** (a changed `relayAndAnnounce` selector/tuple would not fail the mock
  spec). Low severity because the ABI was just added and currently matches the contract.
- Test to add (when the anvil e2e harness is available): an e2e that POSTs `/relay-and-announce` to the running
  relayer against an anvil-deployed relay+announcer and asserts a real `Announcement` log is emitted and the
  stealth address is funded — the real counterpart the stub spec cannot provide.

TEST-9 (invariant efficacy): N/A — no invariant handlers touched by this surface.
