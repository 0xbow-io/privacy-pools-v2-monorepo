# Relayed Key-Registration (#310 / INTL-05) — User-Flow Matrix & SDK Comprehension

**Audited commit:** `2ef7b958` (branch `v2.0-features`)
**Lens:** Feature-Standards — feature-completeness / SDK-comprehension (every conceivable flow has a code path AND is reachable through the public SDK).
**Feature:** A fresh, unfunded recipient registers their keystore auth policy AND withdraws atomically via a relayer (no ETH for gas).

Legend: ✅ reachable through public SDK · ⚠️ partial (works but a seam/ergonomic caveat) · ❌ real gap (no path, not documented) · 🔵 intentionally deferred per INTL-05.

---

## Entry-point reachability (public exports verified)

| Symbol | Public? | Evidence |
|---|---|---|
| `PoolSession.prepareRelayedRegistration` | ✅ facade | `PoolSession.ts:398-402` → delegate `PoolSessionKeystore.ts:177-231`; iface `IPoolSessionKeystore.ts:67-69` |
| `PoolSession.isKeystoreRegistered` | ✅ facade | `PoolSession.ts:388-390`; iface `IPoolSessionKeystore.ts:28` |
| `PoolSession.prepareRegisterAndWithdrawRelay` | ✅ facade | `PoolSession.ts:231-240` → delegate `PoolSessionWithdraw.ts:124-163`; iface `IPoolSessionWithdraw.ts:47` |
| `RelayerInteractor.relayRegisterAndWithdrawal` | ✅ class export + iface | `RelayerInteractor.ts:344-382`; iface `IRelayerInteractor.ts:117`; exported `external.ts:33` |
| `RelayerInteractor.submitRelayedRegistration` | ✅ class export + iface | `RelayerInteractor.ts:307-337`; iface `IRelayerInteractor.ts:102`; exported `external.ts:33` |
| `PoolSession`-level submit wrapper for the bundle | ⚠️ none | No `relayRegisterAndWithdrawal`/relayer accessor on the facade (grep clean). Submit is reached via the separately-exported `RelayerInteractor` class — **by design** per `pool-session.md:383` ("returns the pieces for the caller to hand to `IRelayerInteractor.relayRegisterAndWithdrawal`"). Note: `RelayerInteractor` + `HTTPClient` are both exported (`external.ts:33-34`), so the integrator constructs one; the facade is not the *sole* entry point for this leg, unlike `relayWithdraw` (`PoolSession.ts:218-224`). |
| Relayer `POST .../register-and-relay` | ✅ | `relay.controller.ts:64-77` → `evm.relay.service.ts:98-149` → `evm.contract.service.ts` `sdkRegisterAndRelay` |
| Relayer `POST .../register` (standalone) | 🔵 deferred | RelayerInteractor posts to `.../register` (`RelayerInteractor.ts:323`) but **no `@Post("register")`** in `relay.controller.ts` — would 404. Matches INTL-05 deferral (2). |
| Contract `Keystore.setAuthPolicyWithSig` | ✅ | `Keystore.sol:85-98` |
| Contract `PrivacyPoolRelay.registerAndRelay` | ✅ | `PrivacyPoolRelay.sol:83-114` |

---

## Flow matrix

| # | Flow / state | Code path (SDK → relayer → contract) | Reachable (public SDK)? | Verdict |
|---|---|---|---|---|
| 1 | **Fresh unfunded recipient: register + withdraw atomically — self-signed** (core flow) | `prepareRelayedRegistration({deadline})` (signs via `keystoreInteractor.signTypedData`, `PoolSessionKeystore.ts:213`) → `prepareRegisterAndWithdrawRelay(params, registration)` (`PoolSessionWithdraw.ts:124`, builds proof vs **predicted post-insertion keystore root** `pendingKeystoreRegistration:true` `:140,226`) → `RelayerInteractor.relayRegisterAndWithdrawal` → `POST /register-and-relay` (`relay.controller.ts:64`) → `evm.relay.service.registerAndRelay` (`:98`) → `PrivacyPoolRelay.registerAndRelay` (`:83`) → `setAuthPolicyWithSig` + `_relay` | ✅ Facade prepares both legs; submit via exported `RelayerInteractor`. Real-proof e2e `packages/sdk/test/services/RegisterAndWithdraw.realproof.integration.test.ts`; contract `test/integration/RegisterAndRelay.t.sol` | ✅ |
| 2 | **…external signer (EIP-1271 smart account / hardware wallet)** | `prepareRelayedRegistration({deadline, sign:false})` → returns `PreparedRelayedRegistration.typedData` (`PoolSessionKeystore.ts:204-211,229`; type `PoolSessionKeystore.ts:95-108`) → integrator signs externally → reconstruct `registration` with the signature → `prepareRegisterAndWithdrawRelay`. On-chain, `SignatureChecker.isValidSignatureNow` (`Keystore.sol:96`) accepts EIP-1271 contract signatures. | ⚠️ Reachable: unsigned `typedData` is exposed and the contract verifies EIP-1271. But there is **no helper to re-attach the external signature** into a `PreparedRelayedRegistration` — the integrator must rebuild the plain object by hand (`prepareRegisterAndWithdrawRelay` requires non-null `signature`, `PoolSessionWithdraw.ts:128-132`). Ergonomic caveat only, not a gap. | ⚠️ |
| 3 | **Already-registered account attempts register-and-relay (guard)** | SDK: `prepareRelayedRegistration` calls `isKeystoreRegistered()` and throws `KeystoreAlreadyRegistered` **before** signing/proof (`PoolSessionKeystore.ts:187-189`). Contract defense-in-depth: `registerAndRelay` skips `setAuthPolicyWithSig` when `nullifyingKeys[_account] == _nullifyingKeyHash` (idempotent, `PrivacyPoolRelay.sol:103-111`); a **mismatched** existing key still reverts `Keystore_AuthPolicyAlreadySet` (`Keystore.sol:206` via `_setAuthPolicy`). | ✅ Guard reachable via facade (`isKeystoreRegistered` `PoolSession.ts:388`), correct at both layers (double-guarded, front-run-robust). | ✅ |
| 4 | **Standalone registration (register only, no withdrawal) via relayer** | SDK method exists: `RelayerInteractor.submitRelayedRegistration` → `POST .../register` (`RelayerInteractor.ts:307-337`). Relayer has **no `register` route** (`relay.controller.ts` has only `register-and-relay`). | 🔵 SDK method is exported/callable but the server endpoint is **deferred** — confirmed **not silently broken**: it is documented as deferred in INTL-05 and in `pool-session.md:405`; economic rationale (no fee commitment → unresolved gas-comp) in `deviations.md`. Would 404 if called today. | 🔵 (INTL-05) |
| 5 | **Register-and-relay for a YIELD withdrawal** | `PoolSessionYieldWithdraw.ts` has **no** `prepareRegisterAndWithdrawRelay` / `pendingKeystoreRegistration` (grep clean); no PPRouter atomic-dispatch routing for it. | 🔵 Deferred per INTL-05 (1) and `pool-session.md:405`. Confirmed absent, documented — mechanical mirror of the just-hardened standard withdraw session. | 🔵 (INTL-05) |
| 6 | **Signature (registration EIP-712 deadline) expired between prepare and submit** | Prepare: `prepareRelayedRegistration` rejects a past `deadline` up front with `RegistrationDeadlineInPast` using seconds (`Math.floor(Date.now()/1000)`, `PoolSessionKeystore.ts:194-197`) — matches contract `block.timestamp <= _deadline` (`Keystore.sol:92`), no seconds/ms unit bug (TEST-4). Submit: `relayRegisterAndWithdrawal` asserts only the **feeCommitment** expiration (`RelayerInteractor.ts:355`), **not** the registration `deadline`. | ⚠️ SDK surfaces a usable error at **prepare** (`RegistrationDeadlineInPast`). At **submit** the registration deadline is not re-checked — a deadline that lapses in the prepare→submit window surfaces only as an on-chain `Keystore_SignatureExpired` revert. Mitigated by design: bundle is meant for private orderflow so a stale-deadline revert costs no gas (`pool-session.md:385`). Minor asymmetry vs the feeCommitment recheck; not a functional gap. | ⚠️ |
| 7 | **Predicted-root staleness (a concurrent registration lands first, shifting the insertion index)** | Withdrawal proof is anchored to the predicted post-insertion keystore root (`pendingKeystoreRegistration:true`, `PoolSessionWithdraw.ts:140` → `TransactOrchestrator`/`WitnessPreparationService`). If a concurrent keystore mutation invalidates the predicted root, `transact` reverts on `isKnownRoot` on-chain. | ⚠️ The optimistic-root risk is **documented** (`pool-session.md:385`; `prepareRegisterAndWithdrawRelay` throws only unsigned/fee/asset guards, `PoolSessionWithdraw.ts:128-163`). Staleness is **not** surfaced as a pre-submit SDK error — it is caught only as an on-chain revert, and the spec's stated mitigation is private-orderflow submission (revert = no gas). Consistent with the intended design; no client-side detection exists or is claimed. | ⚠️ |
| 8 | **EIP-712 payload for external signing (hardware wallet / smart account)** | `prepareRelayedRegistration({sign:false})` returns `PreparedRelayedRegistration.typedData: Eip712TypedData` (`PoolSessionKeystore.ts:204-211`; built by `buildSetAuthPolicyTypedData`, `keystoreEip712.ts:34-53`, domain `PrivacyPoolsKeystore`/`1` matching `Keystore.sol:33` `SET_AUTH_POLICY_TYPEHASH`). | ✅ Exact typed-data is obtainable via the facade return value. Note: the `buildSetAuthPolicyTypedData` **helper itself is not exported** from `external.ts` — but the integrator does not need it, the payload is returned. | ✅ |

---

## Findings

**No ❌ (real, undocumented gaps).** Every conceivable relayed-registration flow either has a reachable public-SDK path or is an explicitly-documented INTL-05 deferral.

**INTL-05 deferrals confirmed (not gaps):**
- Flow 4 — standalone `POST /register` endpoint: SDK `submitRelayedRegistration` present, relayer route absent → would 404, deferred by design (no fee-commitment gas-comp model resolved).
- Flow 5 — yield-atomic register-and-relay: absent from `PoolSessionYieldWithdraw`, deferred by design.

**⚠️ partials (design-consistent caveats, worth a ratify note, none blocking):**
- Flow 6 — registration EIP-712 `deadline` re-checked at *prepare* but not at *submit* (only feeCommitment expiry is rechecked in `relayRegisterAndWithdrawal`). Surfaces as on-chain `Keystore_SignatureExpired`; mitigated by private orderflow.
- Flow 7 — predicted-root staleness has no pre-submit SDK detection; caught only on-chain. Documented/intended.
- Flow 2 — external-signer path lacks an "attach-signature" helper; integrator hand-builds the `PreparedRelayedRegistration`. Ergonomics only.
- Reachability row — the atomic **submit** leg is not on the `PoolSession` facade; it is reached via the separately-exported `RelayerInteractor`. Documented in `pool-session.md`, but breaks the "sole public entry point" facade property that `relayWithdraw` upholds.

---

## What I ran / verified
- Exports: `external.ts` re-exports `RelayerInteractor` (`:33`) + `HTTPClient` (`:34`); `buildSetAuthPolicyTypedData` NOT exported (payload reachable via return value).
- Interfaces carry every method (`IPoolSessionKeystore:67`, `IPoolSessionWithdraw:47`, `IRelayerInteractor:102,117`); facade delegates all three (`PoolSession.ts:231,388,398`).
- Grep confirmed **no** `@Post("register")` standalone route, and **no** register-and-relay in `PoolSessionYieldWithdraw.ts` (both INTL-05 deferrals).
- Wire schema `RegisterAndWithdrawalRelayParamsSchema` nests `registration` explicitly (Zod strip-safe, `schemas/RelayerInteractor.ts:163-168`); `signature` required (`:158`); SDK rejects unsigned before assembly (`PoolSessionWithdraw.ts:128-132`).
- Deadline unit correctness: seconds on both SDK (`Math.floor(Date.now()/1000)`) and contract (`block.timestamp`) — no TEST-4 unit bug.
- Tests present: `RegisterAndWithdraw.realproof.integration.test.ts` (SDK real-proof), `RegisterAndRelay.t.sol` (contract integration + fuzz cases for registration-succeeds and registration-reverts).
