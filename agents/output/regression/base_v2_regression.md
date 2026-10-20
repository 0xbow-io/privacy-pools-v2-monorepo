# Base-v2 Regression Audit — "No Harm to the Existing System"

**Branch:** `v2.0-features`  ·  **PR base:** `v2.0` (`d91112f2`)  ·  **Head:** `1ec7ae4fae9a1b8d9355455b1ff4c3ab36b2e8f0`
**Lens:** Where did the four features (#310 batch / #315 stealth / #316 register-and-relay / #317 yield) CHANGE pre-existing base-v2 behavior? Net-new files/functions are out of scope; only modifications to symbols that already existed at `v2.0` are analyzed.
**Method:** `git diff v2.0..HEAD` restricted to files present at `v2.0` under `packages/contracts/src`, `packages/sdk/src`, `packages/relayer/**/src` (test-only, docs, agents/, net-new files excluded).

---

## Summary table

| File | Pre-existing symbol changed | Change | Class | Note |
|------|-----------------------------|--------|-------|------|
| `contracts/src/contracts/Keystore.sol` | `setAuthPolicyWithSig(...)` external fn | +`uint256 _deadline` param; typehash gains `deadline`; +expiry require | **BREAKING** | ABI + EIP-712 domain break; old sigs invalid. `setAuthPolicy` (non-sig) untouched. No storage change. |
| `contracts/src/interfaces/IKeystore.sol` | `SET_AUTH_POLICY_TYPEHASH`, `setAuthPolicyWithSig` sig | typehash string + fn sig changed; +`Keystore_SignatureExpired` error | **BREAKING** | Interface mirror of above. |
| `contracts/src/contracts/PPRouter.sol` | `_fee(...)` internal; `_MAX_BPS` const | inline `(v*bps)/10_000` → `FeeCalculator.calcFee`; const removed | **BENIGN** | `calcFee` = `(_amount*_bps)/10_000` — bit-identical math. `_fee`/`_MAX_BPS` are internal. |
| `contracts/src/contracts/PPYieldTokenZap.sol` | `zapIn`, `zapInExact`, `zapOut` (existing external fns) | absolute `A_TOKEN.balanceOf(this)` → balance-delta (`bal - _aBefore`) | **BEHAVIOR-CHANGE** | Value flow on existing yield paths changed (anti-donation-griefing). Sigs unchanged. |
| `contracts/src/contracts/PrivacyPoolRelay.sol` | `constructor(IPoolVault,IEntrypoint)` | +`require(_MAX_BATCH < _pool.rootHistorySize())` | **BEHAVIOR-CHANGE** | Deploy-time guard; a pool w/ small root buffer now reverts at construction. |
| `contracts/src/contracts/PrivacyPoolRelay.sol` | `registerAndRelay(...)` external fn | +`uint256 _deadline` param; +skip-if-already-registered branch | **BREAKING** + BEHAVIOR-CHANGE | ABI break (new param); registration now conditionally skipped (front-run robustness). |
| `contracts/src/contracts/PrivacyPoolRelay.sol` | `_relay(...)` (single) & batch relay path | +`require(_payout.recipient != address(0))` (both paths) | **BEHAVIOR-CHANGE** | New revert on existing single + batch relay paths (footgun removal). Batch also reuses item-0 decode (perf, no behavior delta). |
| `contracts/src/interfaces/IPrivacyPoolRelay.sol` | `registerAndRelay` sig | +`_deadline` param; +`ZeroRecipient`/`RootHistoryTooSmall` errors | **BREAKING** | Interface mirror. |
| `relayer/src/quote/evm/evm.quote.service.ts` + `evm.schemas.ts` | `quoteBatch(...)` (existing endpoint) | signing now gated on `commit===true`; response `feeCommitment` required → `.optional()` | **BEHAVIOR-CHANGE** | Existing batch-quote response contract changed: `feeCommitment` now absent when `commit!==true`. |
| `relayer/src/relay/evm/evm.relay.service.ts` | `withdrawal(...)` | `minUnderlyingOut` hardcoded `0n` → `request.minUnderlyingOut ?? 0n` | **BENIGN** | Omitted → `0n`, identical to base. Reads a new optional request field. |
| `relayer/src/dto/*`, `relay.controller.ts`, `relay-validation.pipe.ts`, `chain.service`, `evm.contract.service`, `relay.interface.ts`, `relay/evm/{schemas,types}.ts` | — | net-new `registerAndRelay` endpoint/type/pipe + optional DTO fields | **BENIGN** | No removals; purely additive to existing files. |
| `sdk/src/stealth/index.ts` | `buildAnnounceCalldata` export | dropped from package barrel | **BREAKING** | Symbol still in `announce.ts` but no longer re-exported from package root. |
| `sdk/src/stealth/derive.ts` | `generateEphemeralKeyPair()` | +required `scheme: SchemeId` arg | **BREAKING** | Zero-arg calls now throw (`assertNever`). |
| `sdk/src/stealth/scan.ts` | `scanAnnouncement`, `deriveStealthPrivateKey` | 2nd param `Scalar32` → credentials union object | **BREAKING** | Bare-key callers break. |
| `sdk/src/stealth/derive.ts` + `types.ts` | `deriveStealthAddress`, `MetaAddress`, `Announcement` (types) | single-scheme → scheme-discriminated unions (require `scheme`) | **BREAKING** | Old literals lack `scheme`; runtime `SchemeMismatch`. |
| `sdk/src/stealth/types.ts` | `SCHEME_FLUIDKEY` const | value `0x0001` → `0xfffe` (0x0001 reassigned to new `SCHEME_CANONICAL`) | **BEHAVIOR-CHANGE** | On-chain-emitted / compared scheme id re-numbered. Highest cross-version risk. |
| `sdk/src/stealth/announce.ts` | `buildAnnounceCall` | +`assertCanonicalAnnouncer(announcerAddress)` | **BEHAVIOR-CHANGE** | Non-canonical announcer now throws where v2.0 accepted it. |
| `sdk/src/stealth/{resolve,withdraw,types}.ts` | `resolveRecipient` ret, `prepareStealthWithdrawal` default, `EphemeralKeyPair.publicKey` | +`scheme` on return; default scheme from meta-address; publicKey type widened | **BEHAVIOR-CHANGE** | Combined w/ SCHEME renumber, default emitted scheme differs from v2.0. |
| `sdk/src/interfaces/IKeystoreInteractor.ts` | interface | +required `signTypedData(...)` member | **BREAKING (implementors only)** | Breaks external classes implementing the interface, not callers. |
| `sdk/src/interfaces/IWalletInteractor.ts` | interface | +required `signTypedData(...)` member | **BREAKING (implementors only)** | Custom wallet adapters must add method. |
| `sdk/src/interfaces/IRelayerInteractor.ts` | interface | +2 required members | **BREAKING (implementors only)** | Same pattern. |
| `sdk/src/services/poolSessions/BatchWithdrawOrchestrator.ts` | `prepareBatchWithdraw(...)` | +up-front `feeRecipient`-consistency check → `BatchRoutingInvalid` | **BEHAVIOR-CHANGE** | Existing method now rejects divergent-feeRecipient inputs it previously accepted (SDK-side). |
| `sdk/src/services/{KeystoreInteractor, RelayerInteractor, WitnessPreparationService, PoolSession, PoolSessionWithdraw, TransactOrchestrator, walletInteractors/*}.ts` + schemas | existing methods | additive methods / optional schema fields; refactors with unchanged sig+behavior on default path | **BENIGN** | `setAuthPolicyWithSig` SDK method and `relayWithdraw` sig/behavior confirmed UNCHANGED. |

---

## Expanded BREAKING / BEHAVIOR-CHANGE items

### C1 — Keystore.setAuthPolicyWithSig gains `_deadline` (BREAKING) — GUARDED
```solidity
-  keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash)');
+  keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)');
...
-    uint256 _nullifyingKeyHash, bytes calldata _signature ) external {
+    uint256 _nullifyingKeyHash, uint256 _deadline, bytes calldata _signature ) external {
+    require(block.timestamp <= _deadline, Keystore_SignatureExpired());
```
Risk: ABI signature change + EIP-712 struct change → any off-chain signer/caller built against v2.0 produces invalid signatures / mismatched calldata. `setAuthPolicy` (the non-sig registration) is untouched. No storage-layout change (typehash is a `constant`; ERC-7201 struct unchanged) — safe for the UUPS-upgradeable Keystore.
Guard: `packages/contracts/test/unit/Keystore.t.sol` (new `_signAuthPolicyWithDeadline` helper at L217, typehash asserted L221, 4-arg call L248, expiry test present). Covered.

### C2 — PrivacyPoolRelay.registerAndRelay + `_deadline` and skip-if-registered (BREAKING + BEHAVIOR-CHANGE) — GUARDED
```solidity
+    uint256 _deadline, ...
-    POOL.keystore().setAuthPolicyWithSig({...});
+    IKeystore _keystore = POOL.keystore();
+    if (_keystore.nullifyingKeys(_account) != _nullifyingKeyHash) {
+        _keystore.setAuthPolicyWithSig({..., _deadline: _deadline, ...});
+    }
```
Risk: ABI break (new param). Behavior: if the account is already registered with the exact key, registration is skipped and the call degrades to a plain relay (front-run robustness); a mismatched existing key still reverts via the keystore one-time guard.
Guard: `packages/contracts/test/integration/RegisterAndRelay.t.sol::test_registerAndRelay_skipsRegistrationWhenAlreadyRegistered` (L113). Covered.

### C3 — PrivacyPoolRelay zero-recipient + root-history guards (BEHAVIOR-CHANGE) — GUARDED
New reverts on existing paths: constructor `require(_MAX_BATCH < _pool.rootHistorySize())`; `_relay` and batch relay `require(_payout.recipient != address(0))`. Previously a zero recipient would burn funds; now reverts.
Guard: `packages/contracts/test/unit/PrivacyPoolRelay.t.sol` (RootHistoryTooSmall L83-84, ZeroRecipient L161-162; `.tree` entries present). Covered.

### C4 — PPYieldTokenZap absolute-balance → delta accounting (BEHAVIOR-CHANGE) — GUARDED
`zapIn/zapInExact/zapOut` now credit/withdraw only `A_TOKEN.balanceOf(this) - _aBefore` instead of the absolute balance, so a pre-donated aToken balance can no longer be swept by the next caller (last-caller-wins griefing). Existing signatures unchanged; the residual-dust forward in `zapInExact` is likewise delta-scoped.
Guard: `packages/contracts/test/unit/PPYieldTokenZap.t.sol` (35 donation-scenario references). Covered.

### R1 — relayer quoteBatch: signing gated on `commit`, `feeCommitment` now optional (BEHAVIOR-CHANGE) — GUARDED
```ts
-const { asset, recipient, amounts } = params;
+const { asset, recipient, amounts, commit } = params;
+if (commit !== true) { return { txCost, gasPrice, totalFee, maxRelayFee }; }   // no feeCommitment
```
`commit` was already a required request field at v2.0 but `quoteBatch` ignored it and always signed. Now it is respected and the response schema's `feeCommitment` became `.optional()`. Consumers sending `commit:true` (the relay path) are unaffected; a consumer that sent `commit:false` and relied on always receiving `feeCommitment` now gets `undefined`. Security fix (unauthenticated signer-work DoS, R1 SEC-1).
Guard: `packages/relayer/relayer/src/quote/evm/evm.quote.service.spec.ts` and `quote/quote.controller.spec.ts`. Covered.

### S1 — stealth SCHEME_FLUIDKEY re-numbered 0x0001 → 0xfffe (BEHAVIOR-CHANGE) — highest cross-version risk
```ts
-export const SCHEME_FLUIDKEY = 0x0001 as const;
+export const SCHEME_CANONICAL = 0x0001 as const;
+export const SCHEME_FLUIDKEY  = 0xfffe as const;
```
The Phase-1 stealth module (present at v2.0) emitted/compared FluidKey announcements under scheme id `0x0001`. That value is now reassigned to the new canonical scheme, and FluidKey moved to `0xfffe`. Any announcement emitted/persisted by v2.0 code with `0x0001` will now be interpreted as `SCHEME_CANONICAL`, not FluidKey. Current-behavior tests (`fluidkey-vectors.test.ts`, `dispatch.test.ts`) assert the NEW numbering; there is **no** backward-compat test proving an old-numbered (`0x0001`) FluidKey announcement still scans as FluidKey — by design, since this is an intentional redefinition of a pre-release (Phase-1) module. Low real-world risk if nothing on mainnet emitted the old id, but it IS a wire-format change to a pre-existing exported constant.

### S2 — stealth call-shape refactor (BREAKING, 7 symbols) — GUARDED (new-behavior only)
`buildAnnounceCalldata` dropped from the barrel; `generateEphemeralKeyPair`, `scanAnnouncement`, `deriveStealthPrivateKey`, `deriveStealthAddress`, and the `MetaAddress`/`Announcement` types all moved from single-scheme (FluidKey-only) shapes to scheme-discriminated unions requiring a `scheme` field. Any consumer built against the v2.0 stealth API breaks at compile and/or runtime. These are guarded by the updated `packages/sdk/test/unit/stealth/*` suite, but the tests assert the NEW shapes — the old call shapes are intentionally removed, not preserved.

### D1 — SDK interface additions break external implementors (BREAKING, implementors only) — partially unguarded
`IKeystoreInteractor`, `IWalletInteractor`, `IRelayerInteractor` each gained required members. Callers are unaffected; external classes that *implement* these interfaces will fail to compile until they add the methods. The concrete new impls `EIP1193WalletInteractor.signTypedData` / `ViemWalletInteractor.signTypedData` have **no dedicated unit test** under `packages/sdk/test/unit/services/` (only `ViemRPCInteractor.test.ts` exists, which is a different class). These methods are net-new, so this is a coverage gap on new code rather than altered existing behavior.

### D2 — BatchWithdrawOrchestrator.prepareBatchWithdraw new feeRecipient check (BEHAVIOR-CHANGE) — GUARDED
Existing method now throws `BatchRoutingInvalid` when any item's `feeRecipient` diverges from item 0's (previously it passed SDK validation and only reverted on-chain).
Guard: `packages/sdk/test/unit/services/BatchWithdrawOrchestrator.test.ts:322`. Covered.

---

## Verdict

**Nothing pre-existing is altered in a way that is silently unguarded on the high-risk axes.** Specifically:
- **No storage-layout regression.** The only upgradeable/proxy contract touched (UUPS `Keystore`) had no state var or ERC-7201 struct change — only a `constant` typehash and a function signature. Safe.
- **No fee-math / value-conservation regression.** `PPRouter._fee` is a bit-identical refactor to `FeeCalculator.calcFee`. Zap value flow changed only to *tighten* accounting (delta vs absolute), test-guarded.
- **Every changed existing-function revert / behavior on the contract + relayer surface has a matching test**: Keystore deadline expiry, relay ZeroRecipient, RootHistoryTooSmall, registerAndRelay already-registered skip, zap donation scenarios, batch-quote commit-gating, batch feeRecipient consistency — all confirmed present.

**Items to verify manually (not "unsafe", but the residual risk):**
1. **`registerAndRelay` + `setAuthPolicyWithSig` are ABI/EIP-712 BREAKING** for any off-chain client compiled against v2.0. Intentional (the feature adds `deadline`), but confirm the SDK/relayer/website all sign the new 4-field typehash and pass the new param (they do in-repo; external integrators must update).
2. **stealth `SCHEME_FLUIDKEY` 0x0001→0xfffe (S1)** is a wire-format redefinition with no old-value backward-compat test. Confirm no already-emitted `0x0001` FluidKey announcements exist that must remain scannable. If Phase-1 stealth truly never shipped/emitted on any live chain, this is a non-issue.
3. **stealth API BREAKING refactor (S2)** removes the v2.0 single-scheme call shapes entirely — fine if there are no external consumers of the Phase-1 stealth API, which the module's own docstring implies ("Phase 1 … land in v3+ slices").
4. **SDK interface additions (D1)** break external implementors of `IWalletInteractor`/`IKeystoreInteractor`/`IRelayerInteractor`; the new `signTypedData` wallet-interactor impls have no direct unit test.

No BEHAVIOR-CHANGE on an existing path was found without a guarding test. The BREAKING items are all intentional feature-driven API/ABI evolutions, not accidental regressions.

---

## Exact test commands to confirm the pre-feature surface still passes

(Run from repo root / respective package. Do NOT run the full suites — these are the targeted guards for the changed pre-existing surface.)

Contracts (`packages/contracts`):
```bash
forge test --match-contract KeystoreTest           # C1: setAuthPolicyWithSig deadline/expiry, typehash
forge test --match-contract PrivacyPoolRelayTest    # C2/C3: ZeroRecipient, RootHistoryTooSmall, registerAndRelay skip
forge test --match-contract PrivacyPoolRelayBatch   # C3 batch: recipient/feeRecipient consistency
forge test --match-contract PPYieldTokenZap         # C4: donation/delta accounting on zapIn/zapInExact/zapOut
forge test --match-contract PPRouterWithdraw        # PPRouter._fee refactor + zero-recipient
forge test --match-path 'test/integration/RegisterAndRelay.t.sol'   # C2 integration (skips on Sepolia deployment)
forge test --match-path 'test/invariant/*'          # value-conservation invariants incl. HandlerRelay/HandlerYield
```

SDK (`packages/sdk`, vitest):
```bash
pnpm vitest run test/unit/stealth/                              # S1/S2: scheme renumber + union refactor
pnpm vitest run test/unit/services/BatchWithdrawOrchestrator.test.ts   # D2: feeRecipient consistency
pnpm vitest run test/unit/services/PoolSessionWithdraw.test.ts test/unit/services/TransactOrchestrator.test.ts  # withdraw/transact refactor unchanged-behavior
pnpm vitest run test/unit/services/KeystoreInteractor.test.ts test/unit/services/keystoreEip712.test.ts         # keystore typed-data path
pnpm vitest run test/unit/services/RelayerInteractor.test.ts    # relayer interactor additive methods
```

Relayer (`packages/relayer/relayer`, jest):
```bash
pnpm test src/quote/evm/evm.quote.service.spec.ts src/quote/quote.controller.spec.ts   # R1: quoteBatch commit-gating
pnpm test src/relay/evm/evm.relay.service.spec.ts src/relay/relay.controller.spec.ts   # withdrawal minUnderlyingOut + registerAndRelay endpoint
```

Coverage gap to add (new code, not a regression): a direct unit test for `EIP1193WalletInteractor.signTypedData` and `ViemWalletInteractor.signTypedData` (D1) — none exists under `packages/sdk/test/unit/services/`.
