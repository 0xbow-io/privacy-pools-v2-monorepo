# Relayed Key-Registration (#310 / INTL-05) — Full-Feature Review Synthesis

**Reviewed at:** commit `2ef7b958` (branch `v2.0-features`), six lenses in parallel + hand
verification of every Medium+ finding.

**Context:** this feature was concurrently being worked by another instance (the
`feature/harvest-relayed-registration` commits `3570c46f`→`8e7a7190`: register-and-relay
Keystore-revert decoding, EIP-712 digest tests, an already-registered guard, test-gap fixes).
This is an INDEPENDENT audit of the resulting state.

**Scope:** `Keystore.setAuthPolicyWithSig` (EIP-712 sig-authorized auth-policy registration) +
`PrivacyPoolRelay.registerAndRelay` (atomic register-then-relay) + the SDK predicted-post-
insertion keystore-root witness (`pendingKeystoreRegistration`) + relayer `POST /register-and-relay`.

## Per-lens verdicts

| Lens | Verdict | Report |
|------|---------|--------|
| Security audit | **worst severity LOW** — no Crit/High/Med; no soundness break | `audit/relayed_reg_full_r1.md` |
| Code review + coherence | **APPROVE WITH MINOR FIXES** — all four coherence checks PASS | `code-review/relayed_reg_full_r1.md` |
| User-flow matrix + SDK comprehension | **DONE-WITH-GAPS — no real (undocumented) gaps** | `feature-check/relayed_reg_userflows_matrix.md` |
| Test-gap (matched to flows) | **no High** — load-bearing proof surface strongly covered | `test-gap/relayed_reg_full_r1.md` |

## Security posture (verified safe)

The load-bearing property is sound: the withdrawal proves keystore membership against a
**predicted** post-insertion root, but a wrong prediction can only cause the atomic tx to
**revert** — the pool independently accepts only real known roots and Groth16 independently
proves membership, so no wrong root both verifies and is accepted (audit L-1, confirmed by
hand). Replay is blocked by the one-time `nullifyingKeys[account]==0` guard (no nonce needed);
cross-chain/contract replay blocked by the EIP-712 domain (chainId + verifyingContract);
EIP-1271 smart-account signers supported; `registerAndRelay` is atomic and its front-run
idempotent-skip is safe (a mismatched existing key still reverts). 81 unit + 4 real-proof
integration tests pass. Coherence: the SDK EIP-712 payload EXACTLY matches `Keystore.sol`'s
typehash + `PrivacyPoolsKeystore`/`1` domain (proven by a genuine digest-reconstruction test),
and the SDK predicts the same insertion index the contract inserts at.

## Findings (all hand-verified against the code)

| ID | Lens | Sev | Verified | Disposition (OUTCOME) |
|----|------|-----|----------|-----------------------|
| **RR-1** | code-review / flow | Major (judgment) | ✓ `submitRelayedRegistration` POSTs `.../register` (RelayerInteractor.ts:323); relay controller has no `@Post("register")` route → always 404s | **FIXED** — the SDK method now throws `RelayerRequestFailed` up front with an actionable message (the standalone endpoint is the INTL-05-deferred one; use `relayRegisterAndWithdrawal`), instead of POSTing to a 404. Test updated + interface doc. |
| **RR-2** | code-review | Minor | ✓ 0 of `ZeroRecipient`/`AnnouncementRecipientMismatch`/`ZeroAnnouncer`/`RootHistoryTooSmall`/`_announcer` in `relayer_abi.ts` | **FIXED** — added the 4 error fragments + the `_announcer` ctor arg to the relayer `PP_RELAY_ABI` mirror (names verified against `IPrivacyPoolRelay.sol`). |
| **RR-3** | code-review / test-gap G1 | Minor | ✓ `decodeContractError` has zero production callers (real revert-surfacing uses `ALL_CONTRACT_ERRORS` spread into viem's simulate ABI) | **FIXED (deleted)** — removed `decodeContractError` + its now-unused imports + its spec, keeping `ALL_CONTRACT_ERRORS`/`deduplicateErrorAbi`. (Deletes harvest code — done under explicit user authorization.) |
| **G1** | test-gap | Medium (TEST-7) | ✓ | **FIXED** — added a test in `evm.relay.service.spec.ts` that surfaces a REAL `Keystore_SignatureExpired()` revert through the production `ALL_CONTRACT_ERRORS` (via viem `getContractError`/`RawContractError`) and asserts the message names the error, not a raw selector. |
| **G2** | test-gap | Medium (TEST-8) | ✓ | **FIXED** — new `register_abi.golden.spec.ts` pins the `registerAndRelay` selector (`0xaaa7a340`, independently recomputed from the compiled `PrivacyPoolRelay.json`) + the 8 Keystore error selectors, transcribed from compiled artifacts (not self-referential). |
| **G3** | test-gap | Medium (TEST-7) | ✓ | **ACCEPTED** — the relayer→contract register wire is mock-only; the e2e/anvil harness lives in `packages/relayer/e2e/` (a separate boundary) with no register-and-relay case, and a real one needs new fork infra (deployed Keystore+Relay, a real proof + EIP-712 sig + predicted root). Funds-safety on this wire is covered by the contract's own real-proof `RegisterAndRelay.t.sol`; the relayer leg is a thin viem dispatch (arg construction covered by the chain-service unit test + G1/G2). A gated fork e2e is recommended for the `packages/relayer/e2e/` owner. |
| **L-1** | audit | Low/Info | ✓ | **ACCEPTED** — predicted-root staleness race → griefing-only (never a soundness break). Documented on-chain; no on-chain fix exists. |
| **L-2** | audit | Low/Info | ✓ | **ACCEPTED (not fixed)** — `initializeEIP712()` reinitializer(2) is unpermissioned but NOT exploitable (no params, hardcoded constants, one-time; a revert rolls back the version bump so no lockout). Gating it with `UPGRADER_ROLE` was implemented then reverted: it ripples into `Keystore.t.sol` + `Keystore.tree` + a new access test + bulloak — exactly the keystore files the concurrent instance owns — a disproportionate churn/conflict cost for a non-exploitable Info item. Left for whoever owns the keystore contract. |
| **L-3** | audit | Info | ✓ | **ACCEPTED** — no per-account nonce → a signed-but-unsubmitted authorization can't be revoked before its deadline. Bounded by account-chosen deadline + one-time guard. |
| Flow-2 | flow | ⚠️ | ✓ | EIP-1271 external-signer path reachable (`sign:false` returns `typedData`) but no helper to re-attach the external signature; integrator hand-builds. Minor ergonomics. |
| Flow-6 | flow | ⚠️ | plausible | The registration `deadline` is checked at prepare but not re-checked at submit (only the fee commitment is); a stale deadline surfaces as an on-chain revert. |

## Fixes applied (under explicit user authorization)

The user authorized fixing everything despite the overlap with the concurrent
`feature/harvest-relayed-registration` work. Applied: RR-1 (SDK), RR-2/RR-3/G1/G2 (relayer
package, kept strictly inside `packages/relayer/relayer/`). RR-3 deletes `decodeContractError`
that the harvest just added — done deliberately per that authorization. G3 and L-2 were left
as accepted (G3 needs fork infra outside the relayer package; L-2 is non-exploitable and would
churn the keystore test/tree surface the concurrent instance owns). Because these commits sit
on top of the remote tip `8e7a7190` and the other instance may push more, a rebase may be
needed before any push.

Verification: SDK `tsc --noEmit` clean + 48 RelayerInteractor tests; relayer `src/chain.service`
+ `src/relay` = 14 suites / 91 tests pass (incl. the new golden + real-revert tests); the
golden's `registerAndRelay` selector independently recomputed from the compiled artifact.
