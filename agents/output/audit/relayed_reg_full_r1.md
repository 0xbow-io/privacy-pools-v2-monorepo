# Security Audit — Relayed Key-Registration (#310 / INTL-05)

- **Commit:** `2ef7b958` (branch `v2.0-features`)
- **Scope:** `Keystore.setAuthPolicyWithSig` / `_setAuthPolicy` / `initializeEIP712`, `PrivacyPoolRelay.registerAndRelay`, the SDK predicted-root threading (`WitnessPreparationService`, `TransactOrchestrator`, `PoolSessionKeystore`, `keystoreEip712`), and the relayer register-and-relay path (`evm.relay.service`, `evm.chain.service`, `schemas`, `contract_errors`).
- **What I ran:**
  - `forge test --match-contract "Keystore|PrivacyPoolRelay" --no-match-contract Batch` → **81 passed / 0 failed**
  - `forge test --match-contract RegisterAndRelay` (real-proof integration) → **4 passed / 0 failed** (fresh recipient, EIP-1271 wallet, front-run skip, atomic-abort bad+expired sig)
  - Manual trace of every threat-model item below against source + direct deps (`PoolVault.sol:214` keystore-root gate, `IKeystore.sol`, `IPrivacyPoolRelay.sol`).

## Verdict

**No Critical / High / Medium exploitable findings.** The feature is soundly constructed: the EIP-712 domain binds `chainId` + `verifyingContract`, the one-time `nullifyingKeys[account]==0` guard is sufficient replay protection, the atomic bundle degrades correctly on a front-run, and the predicted-root race is a griefing-only (never a soundness) risk that is correctly pushed to the submission layer and documented on-chain. Three Low/Informational items, none exploitable for fund loss.

Worst severity: **Low.**

| ID | Sev | Title |
|----|-----|-------|
| L-1 | Low (Informational, by-design) | Predicted keystore-root staleness race → griefing-only revert |
| L-2 | Low (Informational) | `initializeEIP712()` reinitializer(2) is unpermissioned |
| L-3 | Info | `setAuthPolicyWithSig` has no per-account nonce (no pre-deadline revocation) |

---

## L-1 — Predicted keystore-root staleness race (griefing only, submission-layer mitigation)

**Severity:** Low / Informational — acknowledged by design; no on-chain fix exists.

**Location:** `PrivacyPoolRelay.sol:83-114` (`registerAndRelay`), `WitnessPreparationService.ts:142-148` (`pendingKeystoreRegistration` → `[...keystoreLeaves, keystoreLeaf]`), gate at `PoolVault.sol:214`.

**Scenario.** The withdrawal proof commits to a *predicted* post-insertion keystore root: the SDK appends the account's leaf at the next index off-chain and proves membership against that tree. `registerAndRelay` then (step 1) inserts the leaf on-chain and (step 2) relays. If **any** other keystore mutation (another `setAuthPolicy`/`setAuthPolicyWithSig`/`updateAuthPolicy`/`registerAndRelay`) lands between the SDK reading the leaves and this tx executing, the on-chain insertion index shifts and the real post-insertion root ≠ the predicted root. `PoolVault.transact` then fails `isKnownRoot(keystoreRoot)` → `PoolVault_UnknownKeystoreRoot` and the whole atomic bundle reverts. This is cheaply weaponizable: an attacker spamming registrations of their *own* fresh accounts can perpetually shift the index and grief in-flight bundles.

**Why it is NOT a soundness break (adversarially verified).** The pool only accepts a `keystoreRoot` that is a real known root (`currentRoot` or a previous root still inside its liveness window — `Keystore.isKnownRoot`, `Keystore.sol:181-187`), and the Groth16 proof independently proves the leaf's membership in that exact root. A *wrong* predicted root is simply not a known root → reverts. There is no root value that both (a) verifies the membership proof and (b) is accepted by the pool while corresponding to a different real state. So the failure mode is strictly "revert," never "wrong withdrawal accepted."

**Mitigation present.** The interface NatSpec (`IPrivacyPoolRelay.sol:181-185`) explicitly requires the relayer to submit via private orderflow so a stale prediction reverts on simulation rather than burning gas, and states there is no on-chain mitigation — exactly what `AUDIT_AGENT.md` (TS/SDK checklist, predicted-state item) and `SECURITY_INTERACTION_AGENT.md` (Batch × Relayed-registration) require. **No action needed on-chain**; the residual risk is operational (relayer must use private submission).

---

## L-2 — `initializeEIP712()` reinitializer(2) is unpermissioned

**Severity:** Low / Informational — not exploitable; defense-in-depth only.

**Location:** `Keystore.sol:71-73`.

```solidity
function initializeEIP712() external reinitializer(2) {
  __EIP712_init('PrivacyPoolsKeystore', '1');
}
```

**Analysis.** This is the migration hook that sets the EIP-712 domain on a proxy deployed before `setAuthPolicyWithSig` existed. It has **no access control**, so any address can call it — but it takes **no parameters**, sets only the two hardcoded constants (`'PrivacyPoolsKeystore'`, `'1'`), and `reinitializer(2)` allows it to run **exactly once, ever**. A front-runner can therefore only set the domain to its intended value, slightly earlier; there is no attacker-controlled state and no way to install a wrong domain, brick the proxy, or replay. On a fresh deploy `initialize()` already sets the domain, and this is a benign one-shot no-op. Confirmed harmless; double-init reverts are tested (`Keystore.t.sol:64-75`).

**Recommendation (optional).** Gate it with `checkAccess(UPGRADER_ROLE)` for hygiene/consistency with the other admin setters. Not required for safety.

---

## L-3 — No per-account nonce on `setAuthPolicyWithSig` (no pre-deadline revocation)

**Severity:** Informational.

**Location:** `Keystore.sol:85-98`.

**Analysis.** The signed struct is `SetAuthPolicy(account, authDigest, nullifyingKeyHash, deadline)` — no nonce. Replay protection after a successful registration is provided by the one-time `nullifyingKeys[_account]==0` guard (`_setAuthPolicy`, `Keystore.sol:206`), which is sufficient: once registered, every re-submission of the same or any other signature reverts `Keystore_AuthPolicyAlreadySet`, and a mismatched key cannot overwrite. The only residual property is that a signed-but-not-yet-submitted authorization **cannot be revoked before its `deadline`** — if the account signs `(keyA)` and changes its mind, anyone holding the signature can still bind `keyA` until the deadline. This is inherent to nonce-less meta-tx registration and is mitigated by (a) the account choosing the `deadline` (staleness bound, documented `IKeystore.sol:130-133`) and (b) registration being one-time and only ever installing *the account's own signed key*. No fund-safety impact. Acceptable as designed.

---

## Paths examined and found SAFE (Directive 0 — stated with the reason, not overstated)

- **Cross-chain / cross-contract signature replay — SAFE.** `_hashTypedDataV4` (OZ `EIP712Upgradeable`, domain `PrivacyPoolsKeystore`/`1`) binds `chainId` and `verifyingContract=Keystore`. A signature cannot be replayed onto another chain or another keystore deployment. The domain's `verifyingContract` is the Keystore (not the relay), which is correct — `registerAndRelay` forwards into the Keystore where `isValidSignatureNow` runs, so no confused-deputy: the signature authorizes "register my key in this keystore," independent of the submitter. Verified by the real-EIP-712 integration tests and `Keystore.t.sol` domain-reconstruction tests.
- **Post-registration replay — SAFE.** One-time `nullifyingKeys[_account]==0` guard; tested `test_SetAuthPolicyWithSig_WhenTheAccountAlreadyHasAnAuthPolicy` and the mismatched-key revert.
- **Signature malleability — SAFE / N/A.** Anti-replay is the storage guard, not signature uniqueness, so an alternate-`s` malleable signature buys nothing (still registers the same account/key once). OZ `ECDSA`/`SignatureChecker` also rejects high-`s` anyway.
- **EIP-1271 contract wallets — SAFE.** Verified via `SignatureChecker.isValidSignatureNow`; covered by `test_registerAndRelay_eip1271ContractWallet` and `test_SetAuthPolicyWithSig_WhenTheAccountIsAnEIP_1271ContractWallet`.
- **Atomicity / partial state — SAFE.** `registerAndRelay` is one external function; if `_relay` (or `transact`) reverts, step-1 registration reverts with it. Proven by `test_registerAndRelay_atomicAbort_badAndExpiredSignature` (note remains unspent, Bob remains unregistered, balances unchanged).
- **Front-run of the registration leg — SAFE and correct.** `PrivacyPoolRelay.sol:103` skips registration when `nullifyingKeys(_account) == _nullifyingKeyHash`, so an attacker submitting the account's own signed registration first degrades the bundle to a plain relay instead of griefing it into `Keystore_AuthPolicyAlreadySet` — this is exactly the idempotent-skip the audit checklist (item #28) requires. In the front-run case the on-chain root already equals the predicted root, so the withdrawal still verifies. A **mismatched** existing key still correctly reverts (setAuthPolicyWithSig one-time guard). Proven by `test_registerAndRelay_skipsRegistrationWhenAlreadyRegistered`.
- **Authorization on `registerAndRelay` — SAFE (permissionless by design).** Registration is gated by the account's signature; the withdrawal is gated by the ZK proof, whose context binds the payout recipient. A malicious relayer cannot redirect funds (recipient is in the proof context) nor force a harmful registration (it can only install the account's own signed key), and any invalid proof reverts the whole atomic tx.
- **Signature not bound to the withdrawal — SAFE.** The signature authorizes only the registration (the account's own key); the withdrawal is independently proof-gated with recipient bound in context. Decoupling is safe because neither leg lets a submitter extract value.
- **Fee / economics — SAFE.** `registerAndRelay` routes value only through the already-audited `_relay`; registration transfers no value and its gas is folded into the withdrawal `feeAmount`, still bounded by `ENTRYPOINT.assets(asset).maxRelayFee` (`_relay`, `PrivacyPoolRelay.sol:238-240`). Relayer must configure `maxRelayFee` with headroom (documented). Not user-exploitable.
- **Relayer wire path — SAFE.** `zRegistration` (`schemas.ts:162-168`) declares `account/authDigest/nullifyingKeyHash/deadline/signature` as explicit keys so zod does not strip them; they reach the on-chain args unchanged. The register leg reuses the withdrawal fee-commitment verification, the processor allowlist guard, and the keystore-error decode set (`contract_errors.ts:57-66`, including `Keystore_AuthPolicyAlreadySet`/`InvalidSignature`/`SignatureExpired`) so registration-leg reverts surface as named errors rather than raw selectors.
