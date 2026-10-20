# Test-Gap Report — Relayed Key-Registration (#310 / INTL-05)

- **Commit:** `2ef7b958` (`2ef7b95818c09fafa19c2952b8d2e0542869313e`), branch `v2.0-features`
- **Scope:** Atomic register-keystore + withdraw for a fresh unfunded recipient.
  `Keystore.setAuthPolicyWithSig` (EIP-712 sig-auth), `PrivacyPoolRelay.registerAndRelay`,
  SDK predicted-post-insertion keystore-root witness (`pendingKeystoreRegistration`),
  relayer `POST /register-and-relay`.
- **Method:** Independent re-check of CURRENT coverage after the recent test-gap harvest.
  TEST-7 (no-mock-only) and TEST-8 (schema→wire) applied strictly. Prioritized reading; no
  full forge/SDK suite run.

## Verdict

**Coverage is STRONG on the load-bearing proof surface (contract + SDK).** Every property the
prompt flagged as high-priority is covered with a REAL Groth16 proof and/or a real keystore, not
mock-only:

- **Predicted-post-insertion keystore root — REAL-PROOF, not mock-only. ✓**
  SDK `RegisterAndWithdraw.realproof.integration.test.ts:198-220` drives the real
  `TransactOrchestrator` (real `WitnessPreparationService` + `ProofService` + Groth16) with
  `pendingKeystoreRegistration: true` over a snapshot that omits Bob's leaf, then asserts (a)
  `verifyTransact(proof,1,1) === true` (the circuit accepts the predicted root) and (b) the
  proof's `keystoreRoot` public signal equals the independently-computed predicted root
  (`otherLeaves + bobLeaf`). The negative case (`:222-241`) proves the withdrawal is UNPROVABLE
  without the flag. Cross-checked on-chain by contract
  `RegisterAndRelay.t.sol:277` (`isKnownRoot(mirrorRoot)` after a real-proof `registerAndRelay`).
  Artifact present (`packages/circuits/build/transact_1x1/...wasm`), so the `skipIf` gate runs.

- **Atomic-abort — REAL keystore + REAL EIP-712, not mock-only. ✓**
  `RegisterAndRelay.t.sol:155-203` aborts the whole bundle for BOTH a wrong-signer sig
  (`Keystore_InvalidSignature`) and a correctly-signed EXPIRED deadline
  (`Keystore_SignatureExpired`), then asserts recipient/fee/pool balances unchanged AND that the
  note was not spent (a subsequent VALID `registerAndRelay` still succeeds — a consumed nullifier
  would revert).

- **EIP-1271 smart-account signer — covered twice. ✓**
  Contract unit `Keystore.t.sol:373` (`MockERC1271Wallet`, forces the `code.length>0` branch) AND
  real-proof integration `RegisterAndRelay.t.sol:82` (`test_registerAndRelay_eip1271ContractWallet`
  via `MockSmartWallet`, unfunded).

- **All 6 registration reverts — covered at contract unit.** `Keystore.t.sol`:
  `Keystore_SignatureExpired` (:251, plus at-deadline boundary :271), `Keystore_InvalidSignature`
  (:233), `Keystore_AuthPolicyAlreadySet` (:329), `Keystore_OutOfScalarField` (:300, :314),
  `Keystore_InvalidNullifyingKeyHash` (:347), `Keystore_KeystoreTreeFull` (:357).

- **EIP-712 SDK↔contract digest cross-check — GENUINE, not self-referential. ✓**
  `keystoreEip712.test.ts:79-142` re-derives `keccak256(0x1901 ‖ domainSeparator ‖ structHash)`
  from the RAW contract type strings (`SetAuthPolicy(address account,uint256 authDigest,...)`,
  `PrivacyPoolsKeystore`/`1`) and asserts `hashTypedData(sdkTypedData)` matches. This is
  independent of the SDK's own constants, so it catches typehash/field-order/domain drift.

- **already-registered guard (harvest) — GENUINE.** Contract unit revert (`Keystore.t.sol:329`)
  PLUS real-proof front-run skip (`RegisterAndRelay.t.sol:113` —
  `test_registerAndRelay_skipsRegistrationWhenAlreadyRegistered`), which proves the bundle degrades
  to a plain relay instead of reverting the whole atomic bundle.

- **Registration leg TEST-8 field survival — covered.** `zRegistration` is a REQUIRED nested
  object (`schemas.ts:176`); `evm.relay.service.spec.ts:215-221` asserts all 5 fields
  (`account/authDigest/nullifyingKeyHash/deadline/signature`) survive `parse`, and `:267-294`
  asserts hex→bigint reaches the on-chain `registerAndRelay` call args in the right positions.

**Gaps that remain are concentrated in the RELAYER's revert-surfacing / ABI-drift / wire layer —
all Medium or lower.** No gap undermines fund safety or the load-bearing predicted-root property.

## Harvest additions — do they hold up?

| Harvest item | Holds up? | Note |
|---|---|---|
| EIP-712 digest reconstruction (`keystoreEip712.test.ts`) | **YES — genuine** | Independent re-derivation from raw contract strings; not a self-round-trip. |
| already-registered guard (unit + front-run skip) | **YES — genuine** | Real-proof front-run test proves the skip, not just the revert. |
| `contract_errors` Keystore decoding (`contract_errors.spec.ts`) | **PARTIAL — see G1** | Uses REAL selector bytes (viem `encodeErrorResult`), so the *decoder unit* is genuine. BUT `decodeContractError` has **zero production callers** and is **not on the register-and-relay dispatch path**, so it gives false comfort about register-path error messages. |

## Gaps

### G1 — Relayer register-path Keystore-revert surfacing is untested with real revert data (Medium, TEST-7)
- **Untested path:** `evm.chain.service.ts:486-490` — `simulateAndWriteRegisterAndRelay`'s catch
  block surfaces reverts via viem's `error.message` (viem decodes using `ALL_CONTRACT_ERRORS`
  embedded in the simulate ABI at `:470`). The ONLY register-path revert test
  (`evm.relay.service.spec.ts:296-314`) throws a **generic** `Error("register reverted")`, so the
  Keystore-error decoding on this path is never exercised.
- **The tested function is not the production path.** `decodeContractError`
  (`contract_errors.ts:98`) has **no production caller** (grep across the whole relayer package —
  only its own definition + spec). The harvest built and tested a decoder that isn't wired in.
- **User-flow mapping:** "relayer returns an actionable error when the registration auth fails"
  (bad sig / expired / already-set). Today that message quality is unproven.
- **TEST-7:** the real decode path for register reverts has no real-revert-bytes test.
- **Fix:** in the `simulateAndWriteRegisterAndRelay` revert test, make `simulateContract` throw a
  viem `BaseError`/`ContractFunctionExecutionError` carrying real Keystore revert data (reuse
  `contract_errors.spec.ts`'s `encodeErrorResult({abi:[{type:"error",name:"Keystore_SignatureExpired",inputs:[]}]})`),
  and assert the thrown `BadRequestException` message contains `Keystore_SignatureExpired` (proving
  `ALL_CONTRACT_ERRORS` decodes it on THIS path). Separately: either wire `decodeContractError`
  into the catch block or delete it as dead code — an exported, spec-covered, unused decoder is a
  drift trap.

### G2 — No golden/artifact-drift test for the hand-listed Keystore errors or the registerAndRelay ABI (Medium, TEST-8)
- **Untested path:** `ALL_CONTRACT_ERRORS` Keystore entries (`contract_errors.ts:57-65`) and the
  `registerAndRelay` fragment in `PP_RELAY_ABI` (`sdk/relayer_abi.ts:120`) are **hand-copied**.
  `contract_errors.spec.ts` re-encodes selectors from the **same hardcoded names**, so it is
  self-referential for drift — it proves the decoder round-trips its own list, not that the list
  matches `IKeystore.sol`. The existing golden spec (`pprouter_abi.golden.spec.ts`) covers ONLY
  `withdrawToUnderlying`.
- **Consequence:** if Solidity renames/adds a Keystore error, register-path reverts silently
  regress to raw selectors (`Unknown contract error: 0x…`); if `registerAndRelay`'s signature
  changes, the simulate call encodes wrong args — with no failing test.
- **TEST-8:** ABI is the wire contract between relayer and chain; drift must be policed against the
  compiled artifact.
- **Fix:** golden spec that loads `packages/contracts/out/IKeystore.sol/IKeystore.json` (+
  `PrivacyPoolRelay.json`) and asserts every `error` fragment ∈ `ALL_CONTRACT_ERRORS` (name +
  inputs) and that the `registerAndRelay` fragment matches `PP_RELAY_ABI`.

### G3 — Relayer→contract register-and-relay wire is entirely mock-only; no real counterpart (Medium, TEST-7)
- **Untested path:** the chain-service arg construction and dispatch
  (`evm.chain.service.ts:455-491`) is asserted only against a **stubbed** `simulateContract`
  (`evm.relay.service.spec.ts:229-315`). There is **no** e2e/anvil test for register-and-relay
  (grep of `packages/relayer/e2e`: none). The real on-chain proof exists only in Solidity
  (`RegisterAndRelay.t.sol`), which does NOT go through the relayer's viem encoding.
- **Consequence:** the relayer's actual encoded call is never proven to be accepted by a real
  `PrivacyPoolRelay`. Matches the agent doc's "real-but-unrun / mock-only dispatch" flag class
  (currently noted for processor dispatch; here register-and-relay has not even a docker e2e).
- **Fix:** a docker/anvil e2e that POSTs `/register-and-relay` for a fresh unfunded recipient and
  asserts on-chain registration + payout; or a fork test that submits the chain-service-built
  request to a deployed relay. If infeasible in CI, gate it and flag as real-but-unrun (do not
  count as covered).

### G4 — No negative test that omitting the whole `registration` leg is rejected (Low, TEST-8)
- **Untested path:** `zRegistration` is required (`schemas.ts:176`), but no test asserts
  `zEvmRegisterAndRelayRequest.parse(bodyWithoutRegistration)` throws — the exact "leg silently
  vanishes" scenario TEST-8 targets. Sub-field survival is covered; missing-leg rejection is not.
- **Fix:** `it("reject a request missing the registration leg")` asserting the omitted-registration
  body throws.

### G5 — No end-to-end SDK-signature → real-Keystore acceptance, and no controller→pipe→schema path test (Low)
- **Untested path:** the SDK builds+signs typed data and self-verifies with viem
  (`RegisterAndWithdraw.realproof...:243-269`), but no test feeds an SDK-produced signature into the
  real `Keystore.setAuthPolicyWithSig` (the contract test hand-rolls the Solidity signature). The
  controller spec (`relay.controller.spec.ts:46`) delegates a cast dummy body, bypassing
  `RegisterAndRelayValidationPipe`; the full wire path is covered only by composition of separate
  tests. Residual risk is LOW because the digest-formula cross-check (`keystoreEip712.test.ts:79`)
  bridges the SDK↔contract seam.
- **Fix (optional):** a fixture test asserting a known SDK signature over fixed inputs equals a
  Foundry-generated golden, or an integration submitting an SDK signature to a deployed Keystore.

## Priority summary

| ID | Sev | Lens | One-liner |
|----|-----|------|-----------|
| G1 | Medium | TEST-7 | Register-path Keystore-revert message untested; `decodeContractError` has no prod caller |
| G2 | Medium | TEST-8 | No artifact-drift golden for Keystore error list / registerAndRelay ABI (self-referential today) |
| G3 | Medium | TEST-7 | Relayer→contract register wire is mock-only; no anvil/fork counterpart |
| G4 | Low | TEST-8 | No "omit registration leg → reject" negative test |
| G5 | Low | — | No SDK-sig→real-Keystore acceptance / no controller-pipe end-to-end path test |

**No High findings.** The four highest-priority questions from the brief — predicted-root real
proof, EIP-712 cross-check, atomic-abort, EIP-1271 — are all genuinely covered. The harvest
additions hold up, with one caveat: the `contract_errors` decoder is real but unwired to the
production register path (G1).
</content>
