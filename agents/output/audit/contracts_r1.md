# Contracts Quality Loop r1 — Combined Alignment / Code-Review / Security-Audit

**Commit (HEAD at audit):** `71858e770e8bb52f8148256deeb21b5bfbe8696f`
**Branch:** `audit/v2.0-features`  **Date:** 2026-07-08
**Package:** `packages/contracts` (Foundry). Local `forge 1.4.1`; CI pins foundry `stable`.

## Scope
v2.0 features that touched contracts:
- **Yield farming:** `PPYieldToken`, `PPYieldTokenFactory`, `PPYieldTokenZap`, `PPYieldTokenZapFactory`, `PPRouter`, `PPRouterFactory` + interfaces + `script/DeployLocalYield.s.sol`, `script/DeployYieldFork.s.sol`.
- **Relayed registration:** `Keystore` (EIP712 + `setAuthPolicyWithSig`, `initializeEIP712`), `PrivacyPoolRelay.registerAndRelay`.
- **Batch transactions:** `PrivacyPoolRelay` (`relayBatch`, `_relay`, `_distribute`, `_MAX_BATCH`).

## Commands run + observed results
- `forge build` → exit 0 (only pre-existing solady/lint notes).
- `forge test --match-contract UnitEntrypoint --match-test test_Deposit` → **10/10 pass** after harness fix (was 8/10).
- `forge test --match-path 'test/unit/*'` → **44 suites, 888 tests, 0 failed** (includes +3 new relay tests).
- `forge test --match-contract "UnitPrivacyPoolRelay"` → 28 + 18 pass, 0 failed.
- `forge test --match-contract "UnitPoolVault|UnitTransactVerifierRouter"` → 64 + 13 pass (regression check on shared harness change).
- Fork (`MAINNET_RPC`, archive): `forge test --match-contract "BatchTransactIntegration|RelayIntegration|RegisterAndRelayIntegration"` → **10 + 2 + 3 pass, 0 failed** (real Groth16).

## VERDICT: DONE-WITH-GAPS
All contract-source findings are either fixed-and-verified or benign-on-analysis. Two genuine gaps remain and are REPORT-ONLY by policy (cross-package / needs-decision): the **vendored-copy yield E2E gap (HIGH)** and the **DeployYieldFork factory bypass**, plus the **fuzz/invariant handler gaps (Medium)**. Nothing here is a live exploit on the deployed source.

---

## SPECIFIC ROOT-CAUSE: the 2 Entrypoint deposit fuzz failures — TEST-HARNESS BUG (fixed)

**Conclusion: (a) test-harness bug. NOT a fee round-trip asymmetry.** PHASE0's hypothesis (that `Entrypoint.deposit` recomputes `_value' = msg.value − fee(msg.value)`) is **refuted by the source**: `Entrypoint.deposit` (src/contracts/Entrypoint.sol:79) forwards the proof's `_value` **literally** — `$.poolVault.deposit{value: _value}(...)` — and keeps the fee in the Entrypoint. No divergence.

Evidence chain:
1. `-vvvv` trace: mock registered at `value = 66613…306`, the emitted `Deposited._value = 66613…306`, and the forwarded internal `deposit{value:_value}` value are **identical**. So value + calldata match.
2. `mockPoolVault = makeAddr('mockPoolVault')` (test/unit/helpers/TestUtils.sol:18) is a **codeless** address.
3. In foundry 1.4.1, a **value-keyed** `vm.mockCall` alone does not make a codeless address callable — the forwarded call reverts `call to non-contract address` before the mock resolves.
4. Proof: `test_Deposit_WhenCiphertextIsNotEmpty` PASSES (1000 runs) with the *identical* value-keyed deposit mock — its only difference is it *also* registers a non-value `vm.mockCall` (aspRegistry) on the same address, which makes the address callable. The 2 failing tests register only the value-keyed mock. On CI's `stable` foundry the value-keyed mock alone suffices, so CI was green — a version-dependent harness behavior.

**Fix (applied):** `test/unit/helpers/TestUtils.sol` value-keyed `_mockAndExpect` now registers a generic (any-value) behavior `vm.mockCall` so the codeless target is callable, and keeps the value-keyed `vm.expectCall` so the exact forwarded `msg.value` is still asserted. Version-robust; preserves the value assertion.
**Verified:** all 10 `test_Deposit*` pass; `UnitEntrypoint` 29/29; `UnitPoolVault` 64 and `UnitTransactVerifierRouter` 13 (the other two suites using the value-keyed overload) still pass. Honest unit baseline is now **all green**, not 439/441.

---

## FINDINGS (severity-ranked)

### HIGH

**H-1 — Yield real-proof integration tests exercise VENDORED forks, not `src/` (zero E2E coverage of deployed source). REPORT-ONLY (Phase-3).**
`test/integration/helpers/ppusdc/{PPRouter,PPYieldToken,PPYieldTokenZap}.sol` are drifted forks of `src/contracts/`. The only yield real-proof integration suites (`PPUSDCYieldMock`, `PPUSDCYieldFork`, `PPUSDCRouterWithdraw*`) import these vendored copies, so the deployed source has **no** real-proof E2E coverage. Confirmed behavioral deltas:

| Aspect | `src/contracts/` | vendored `helpers/ppusdc/` |
|---|---|---|
| Zap surface | `depositUnderlying` + **`buyFixedYieldToken`** + `redeemToUnderlying` + **`quoteBuy`** | `depositUnderlying` + `redeemToUnderlying` only (no exact-mint / quote) |
| PPRouter deposit path | `ZAP.buyFixedYieldToken(_total,…)` (single Aave touch-point in zap) | direct `POOL.supply(...)` + `VAULT.mint(...)` inline |
| PPRouter withdraw recipient guard | `require(_payout.recipient != 0, PPRouter_ZeroRecipient())` (PPRouter.sol:182) | **absent** |
| PPRouter withdraw fee leg | dust-fee waiver: `_payableFee = (feeAmount!=0 && previewRedeem(feeAmount)!=0) ? feeAmount : 0` (PPRouter.sol:192-193) | charges `_payout.feeAmount` directly (can revert on dust) |
| `_quote` signature | returns `(_underlyingNeeded, _total)` | returns `(_aNeeded, _underlyingNeeded, _total)` |

Fix (proposed, Phase-3): re-vendor the copies from `src/`, or point the integration suites at `src/` directly and mock only the Aave layer. Until then, any "yield E2E is green" claim must be qualified as testing the vendored copies.

### MEDIUM

**M-1 — `PrivacyPoolRelay` had no `recipient != address(0)` guard; a zero recipient burns funds (and native gas). FIXED.**
`_relay`/`relayBatch` forwarded `_payout.recipient` straight into `_distribute`, which for `NATIVE_ASSET` does `_recipient.safeTransferETH(...)` → burns to `address(0)`; for ERC-20 most tokens revert but not guaranteed. The recipient is bound into the proof `context` (PoolVault.sol:145-149), so this is a self-inflicted misconfiguration rather than a relayer-tamperable vector — but reverting is strictly safer than burning, and `PPRouter` already guards it (`PPRouter_ZeroRecipient`). **Fix:** added `PrivacyPoolRelay_ZeroRecipient` and a guard in `_relay` (after the zero-withdrawal check) and in `relayBatch` (once on `_ref.recipient`, since all items must equal it). Added `test_Relay_WhenRecipientIsZero` and `test_RelayBatch_WhenRecipientIsZero`.

**M-2 — `_MAX_BATCH < rootHistorySize` coupling was unenforced. FIXED (constructor guard).**
`_MAX_BATCH = 10` must stay below the pool's state-root buffer size (`rootHistorySize`, deploy default 16) or later batch items would evict the shared pre-batch state root and revert `PoolVault_UnknownStateRoot` (funds safe — atomic revert — but a liveness break). Each `transact` pushes exactly one state root (PoolVault.sol:178-179), so an N-item batch needs `N <= rootHistorySize`. Nothing enforced it. **Fix:** constructor now `require(_MAX_BATCH < _pool.rootHistorySize(), PrivacyPoolRelay_RootHistoryTooSmall())` (`IPoolVault` inherits `IRootBuffer`, so the getter is callable). Added `test_Constructor_WhenRootHistoryNotAboveMaxBatch`.

**M-3 — `registerAndRelay` and `relayBatch` have NO invariant/fuzz handler coverage. REPORT-ONLY (test-gap).**
`test/invariant/handlers/HandlerRelay.sol` only defines `handler_guided_relaySingleNote`; there is no batch or register handler. `PPRouter`/`Zap`/factories have no invariants (only `InvariantPPYieldToken` exists, covering `PPYieldToken` alone). Recommend a `HandlerRelayBatch` (fund-conservation: sum of item `amountOut` == recipient + fee + gas) and a `HandlerRegisterAndRelay`.

### LOW

**L-1 — `Keystore.initializeEIP712()` is unpermissioned `reinitializer(2)`. Benign; note consumed version.**
Anyone can call it, but exactly once, and the effect is deterministic (sets the EIP-712 domain to the hardcoded constants `('PrivacyPoolsKeystore','1')`) regardless of caller — front-running is harmless. It is *needed* on the live proxy so post-upgrade signatures verify. Only real consequence: reinitializer version **2** is now consumed, so any future Keystore upgrade needing an initializer must use `reinitializer(>=3)`. Document; no code change.

**L-2 — `setAuthPolicyWithSig` has no nonce/deadline. Low (UX footgun, not an exploit).**
Only the account owner can produce a valid EIP-712 sig (ECDSA/ERC-1271), so no third party can register arbitrary key material. The one-shot `nullifyingKeys[_account]==0` guard (Keystore.sol:203) prevents replay after registration. Residual: `nullifyingKeyHash` is immutable once set (`updateAuthPolicy` changes only `authDigest`, keeping the stored NKH — Keystore.sol:105-109); so if a user signs two conflicting messages and an older one lands (via leak/front-run), they are permanently bound to the abandoned NKH. Cross-chain replay is **not** possible: the domain separator binds `chainId` + `verifyingContract` (EIP712Upgradeable recomputes with `block.chainid`). **Recommend (CROSS-PACKAGE/NEEDS-DECISION):** add a `deadline` (and optionally nonce) to the typehash so users can bound/invalidate stale sigs — this changes the EIP-712 struct the SDK signs, so it needs an SDK-coordinated decision. Not applied.

**L-3 — Keystore inheritance reorder (`IKeystore, UUPSUpgradeable, EIP712Upgradeable, Permissioned`) is storage-safe. Benign (verified).**
No slot collision/shift on the live UUPS proxy: `UUPSUpgradeable` uses ERC-1967 fixed slots + immutable `__self`; `EIP712Upgradeable` uses ERC-7201 namespaced storage; `Permissioned` holds only an `immutable ACCESS_ROUTER` (no sequential storage — src/abstracts/Permissioned.sol:15); Keystore's own state is ERC-7201 namespaced. Adding a parent with only namespaced/immutable storage cannot shift existing slots. No change.

**L-4 — Yield trusted-owner surface (`PPYieldToken`). Low/informational; trusted 2-step admin.**
- `rewardsController` is owner-settable and `claimRewards` calls `claimAllRewards` on it (arbitrary target) — but the call executes in the *controller's* context, the vault never approves it, and `claimRewards` is `onlyOwner nonReentrant`; it cannot move the vault's aUSDC/ppUSDC. Benign.
- `rescueToken` cannot touch `asset()` (the aToken backing — guarded, PPYieldToken.sol:149); it *can* move the vault's own ppUSDC shares, which are liabilities not backing, so depositors are unaffected. Benign.
- `setFeeBps` ≤ 20% (MAX_FEE_BPS), applied only to *yield* (balance increase), and `_checkpoint()` charges accrued yield at the OLD rate before the switch (PPYieldToken.sol:100) — no retroactive fee. Trusted-owner risk only; a timelock is optional hardening.
- `totalAssets()` clamps `balance - fees` at 0 (PPYieldToken.sol:219). This masks a would-be inversion only in an Aave balance-decrease (bad-debt) scenario; the clamp is the safe choice (avoids bricking withdrawals via underflow). Documented.

**L-5 — `PPYieldTokenZap` has no reentrancy guard. Accepted risk → INTL-04.**
No exploitable reentrancy path found: the zap is genuinely stateless (all amounts read via `balanceOf` in-call, no persistent storage), is deployed only over the trusted hook-free (USDC, Aave-aToken) pair, and the one re-enterable downstream (`PPYieldToken`) is itself `ReentrancyGuardTransient`. The `balanceOf`-driven amounts mean a donated/stray token balance is forwarded to whoever calls next — a gift, not a theft (donor loses, caller gains). Ratified as **INTL-04** with the argument; add `ReentrancyGuardTransient` if a hook-bearing underlying is ever onboarded.

**L-6 — `DeployYieldFork.s.sol` deploys `PPYieldToken` directly, bypassing `PPYieldTokenFactory` (no dead-share seed). REPORT-ONLY (deploy script, cross-package e2e).**
`new PPYieldToken(...)` at DeployYieldFork.s.sol:32 skips the factory's anti-inflation dead-share seed. **Practical severity is Low:** `PPYieldToken` uses `_decimalsOffset = 18 - assetDecimals` = **12** for USDC → 10^12 virtual shares, which *alone* makes first-depositor inflation economically infeasible (an attacker would need to donate `> V·10^12` underlying to grief a victim depositing `V`); the dead-share seed is defense-in-depth on top of that. **Not applied** because: it is a deploy script feeding a gas-gated fork e2e + website/relayer wiring I cannot re-run to verify; routing through the factory requires the deployer to be pre-funded with USDC + approval at deploy time (unverifiable here), and a blind change could silently revert the deploy on `safeTransferFrom`. Proposed patch: deploy a `PPYieldTokenFactory` and call `createWrapper(...)` with a seed (ensure deployer pre-funded). Also hardcodes Sepolia Aave addresses (expected for a fork script).

**L-7 — `DeployLocalYield.s.sol` imports test mocks into the deploy compilation unit. Low/informational; inherent to its purpose.**
Imports `MockERC20` and `MockAavePool/MockRebasingAToken` from `test/` (DeployLocalYield.s.sol:7-8). This is by design — the script is explicitly a **local MOCK-Aave** harness for the SDK local-wrapper e2e; it *needs* the mocks. If the convention "`script/` must not import `test/`" is to be enforced, relocate the mocks to `script/helpers/`. Not applied (would break the mock harness; the SDK e2e references this script — cross-package). It also deploys `PPYieldToken` directly and seeds to `deployer` (not `_DEAD`), which is fine for a throwaway local mock.

### NITS

**N-1 — `relayBatch` decoded `_transactParams[0].data` twice. FIXED.**
Item 0 was `abi.decode`d once for `_ref` and again in the loop for `_payout`. **Fix:** the loop reuses the already-decoded `_ref` for `_i == 0` (`_payout = _i == 0 ? _ref : abi.decode(...)`). Behavior-identical; saves one redundant decode.

**N-2 — `PPRouter._fee` re-implements `FeeCalculator.calcFee` inline. No drift today; flag.**
`PPRouter._fee` = `(_value * vettingFeeBPS) / _MAX_BPS` with `_MAX_BPS = 10_000` (PPRouter.sol:280-282); `FeeCalculator.calcFee` = `(_amount * _bps) / MAX_FEE_BPS` with `MAX_FEE_BPS = 10_000`. Both floor identically and match `Entrypoint.deposit`'s fee (Entrypoint.sol:72), so `PPRouter._quote`'s `_total = value + fee` equals exactly what `ENTRYPOINT.deposit` pulls. **Drift hazard only** — recommend importing `FeeCalculator` to keep a single source of truth. Not applied (behavior-identical; no bug).

**N-3 — Missing `.tree` BTT files for the 8 yield unit suites. PARTIALLY FIXED (6 of 8; see status below).**
`PPYieldToken`, `PPYieldTokenAdmin`, `PPYieldTokenDecimals`, `PPYieldTokenReentrancy`,
`PPYieldTokenZap`, `PPYieldTokenZapFactory` now have bulloak-clean trees. `PPRouter.tree` and
`PPYieldTokenFactory.tree` were NOT created (see the corrected status section at the end — `PPRouter.t.sol`
is multi-contract). Convention gap remains for those two.

---

## Benign-on-analysis (confirmed NOT findings)
- **Aggregate batch fee cap (10×maxRelayFee).** Each item's `feeAmount` is ≤ `maxRelayFee` AND ≤ that item's `amountOut` AND **bound into that item's own proof `context`** (PoolVault.sol:145-149). The aggregate is a sum of individually user-authorized fees — not an over-charge vector.
- **First-depositor inflation via factory.** `PPYieldTokenFactory.createWrapper` seeds `_DEAD` with the full post-supply aToken balance (PPYieldTokenFactory.sol:87-96), and the `10^12` virtual-share offset independently neutralizes the attack. Effective.
- **10-item batch gas.** Bounded loop, `_MAX_BATCH = 10`; the real-proof `BatchTransactIntegration` (ETH + ERC20 multi-note) passes within block gas.

## Cross-package / needs-decision deferrals
- **L-2** deadline/nonce on `setAuthPolicyWithSig` typehash — SDK-coordinated.
- **H-1** re-vendor / re-point yield integration tests — Phase-3.
- **L-6** DeployYieldFork factory routing — deploy-flow + e2e wiring.
- `minUnderlyingOut = 0` on the relayer PPRouter path — relayer/SDK (candidate in deviations.md).

---

## Files edited (source + tests; tree left dirty, NOT committed)
Source:
- `src/contracts/PrivacyPoolRelay.sol` — zero-recipient guards (`_relay`, `relayBatch`), constructor `rootHistorySize` guard, double-decode fix.
- `src/interfaces/IPrivacyPoolRelay.sol` — `PrivacyPoolRelay_ZeroRecipient`, `PrivacyPoolRelay_RootHistoryTooSmall`.

Tests:
- `test/unit/helpers/TestUtils.sol` — value-keyed `_mockAndExpect` now registers a generic behavior mock (Entrypoint root-cause fix).
- `test/unit/PrivacyPoolRelay.t.sol` — setUp + constructor test mock `rootHistorySize`; recipient coercion (helper + `whenAssetIsERC20`); `assumeNotForgeAddress` on fuzzed `_pool`; new `test_Constructor_WhenRootHistoryNotAboveMaxBatch`, `test_Relay_WhenRecipientIsZero`.
- `test/unit/PrivacyPoolRelayBatch.t.sol` — setUp mock `rootHistorySize`; new `test_RelayBatch_WhenRecipientIsZero`.
- 8 new `test/unit/PPYield*.tree` + `PPRouter.tree` (bulloak-verified — status below).

Deviations: `agents/deviations.md` — added **INTL-04** (PPYieldTokenZap reentrancy accepted risk).

## Tests added
- `test_Constructor_WhenRootHistoryNotAboveMaxBatch` (fuzz) — verified pass.
- `test_Relay_WhenRecipientIsZero` (fuzz) — verified pass.
- `test_RelayBatch_WhenRecipientIsZero` — verified pass.

## Honesty note (Directive 0)
Everything marked FIXED was re-run and observed passing (unit + fork). REPORT-ONLY items were deliberately not applied and are flagged with the reason. The `.tree` files' status is the verbatim `bulloak check` result below — anything not confirmed clean is called out.

## `.tree` generation status (corrected — the initial pass stalled here)
Verified with the real `bulloak` 0.9.2 binary (`~/.cargo/bin/bulloak`; the stalled pass tried
`npx bulloak`, which 404s — bulloak is a Rust binary, not on npm).

- **CLEAN under bulloak 0.9.2** (`bulloak check` → "All checks completed successfully"):
  `PPYieldToken.tree`, `PPYieldTokenAdmin.tree`, `PPYieldTokenDecimals.tree`,
  `PPYieldTokenReentrancy.tree`, `PPYieldTokenZap.tree`, `PPYieldTokenZapFactory.tree` (6 yield
  trees), and `PrivacyPoolRelay.tree` (with the two new nodes: `When root history not above max
  batch` and `When recipient is zero`).
- **NOT created** (correcting the "8 trees" claim above to **6**): `PPRouter.tree` and
  `PPYieldTokenFactory.tree`. `PPRouter.t.sol` holds **three** test contracts
  (`UnitPPRouterDeposit/Withdraw/Factory`) and bulloak maps one tree per contract, so it needs three
  trees (or a split); left as a known convention gap.
- **`PrivacyPoolRelayBatch.tree` — pre-existing non-conformance.** The committed base tree already
  fails `bulloak check` **17 checks** against its own `.sol` under bulloak 0.9.2 (independent of this
  audit). It appears CI pins a different bulloak version, or the batch tree merged non-conforming.
  I therefore did **not** add a `When recipient is zero` node to it (the new
  `test_RelayBatch_WhenRecipientIsZero` test exists and passes; only the tree entry is omitted).
  Flagged for the team to reconcile with their pinned bulloak.

`bulloak` was not runnable in the stalled pass, so all tree claims above were re-verified here.

