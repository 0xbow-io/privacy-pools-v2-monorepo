# User-Flow × Permutation Coverage Matrix — v2.0

**Branch:** `audit/v2.0-features`. **Date:** 2026-07-08. Coverage as of the audit's fix commits.
Legend: **✅** covered (real behavior asserted) · **▲** covered but *mock-proof / mock-Aave / vendored-copy* (not deployed `src/` through a real proof) · **○** partial · **✗** missing.
"Real-proof E2E" = goes through a real Groth16 proof against `src/contracts`.

Cross-reference: `../audit/contracts_r1.md`, `../code-review/{sdk,relayer}_r1.md`,
`../security/{CROSS_FEATURE_THREAT_MODEL,STEALTH_REVIEW_AND_DIFF}.md`, `../audit/PHASE0_build_and_selection.md`.

---

## 1. Relayed Registration (#310)  — `Keystore.setAuthPolicyWithSig`, `PrivacyPoolRelay.registerAndRelay`

| Flow / permutation | Test | Status |
|---|---|---|
| Register via valid EOA signature | `Keystore.t.sol::test_SetAuthPolicyWithSig_WhenTheSignatureIsValidForTheAccount` | ✅ |
| Register via EIP-1271 smart wallet | `…_WhenTheAccountIsAnEIP_1271ContractWallet`; `RegisterAndRelay.t.sol::test_registerAndRelay_eip1271ContractWallet` | ✅ |
| Invalid signature rejected | `…_WhenTheSignatureIsNotValidForTheAccount` | ✅ |
| Account already registered (one-time guard) | `…_WhenTheAccountAlreadyHasAnAuthPolicy` | ✅ |
| nullifyingKeyHash = 0 / out of scalar field | `…_WhenNullifyingKeyHashIsZero`, `…IsOutOfScalarField` | ✅ |
| authDigest out of scalar field | `…_WhenAuthDigestIsOutOfScalarField` | ✅ |
| Keystore tree at capacity | `…_GivenKeystoreTreeIsAtCapacity` | ✅ |
| `initializeEIP712` on v1 proxy / already-v2 | `…test_InitializeEIP712_WhenCalledOnAVersion1Proxy`, `…WhenAlreadyInitializedAtVersion2` | ✅ |
| register-then-relay, fresh unfunded recipient | `RegisterAndRelay.t.sol::test_registerAndRelay_freshRecipientNeverFunded` (real proof) | ✅ |
| **Signature replay after capture (no nonce/deadline)** | — | ✗ (threat S5) |
| **Stale-signature front-run locks stale key material** | — | ✗ (threat S5) |
| **Cross-chain / cross-deployment domain replay** | — | ✗ (verify EIP-712 domain has chainId+verifyingContract) |
| **`initializeEIP712` called by arbitrary caller (unpermissioned)** | — | ○ (init tested, but not the "anyone can call it" access-control angle) |
| Fuzz/invariant handler for `registerAndRelay` | — | ✗ (no handler in `test/invariant/handlers/`) |

## 2. Batch Withdrawal (#316) — `PrivacyPoolRelay.relayBatch`, SDK `BatchWithdrawOrchestrator`

| Flow / permutation | Test | Status |
|---|---|---|
| N-item ERC20 full withdrawal (real proof) | `BatchTransact.t.sol::test_relayBatch_fullWithdrawal_erc20` | ✅ |
| N-item ETH full withdrawal (real proof) | `…test_relayBatch_fullWithdrawal_eth` | ✅ |
| Single-item batch (real proof) | `…test_relayBatch_singleItem_erc20` | ✅ |
| Batch size 1 / MAX-1 / MAX / >MAX / empty | `PrivacyPoolRelayBatch.t.sol::…WhenBatchHasASingleItem / …IsMaxBatchMinusOne / …IsAtMaxBatch / …ExceedsMaxBatch / …IsEmpty` | ✅ |
| Item fee > maxRelayFee / > its withdrawal | `…WhenAnItemFeeExceedsMaxRelayFee / …ExceedsItsWithdrawal` | ✅ |
| Item asset / recipient / feeRecipient inconsistent | `…WhenAnItemHasADifferentAsset / …Recipient / …FeeRecipient` | ✅ |
| Zero withdrawal item | `…WhenAnItemHasZeroWithdrawal` | ✅ |
| msg.value ≠ Σ nativeGas | `…WhenMsgValueDoesNotMatchTotalNativeGas` | ✅ |
| length mismatches (params / noteData) | `…WhenTransactParamsLengthMismatches / …NoteDataLengthMismatches` | ✅ |
| feeRecipient = address(0) → defaults to sender | `…WhenFeeRecipientIsAddressZero` | ✅ |
| SDK fee math (bps/flat/cap/infeasible/per-item) | `computeBatchFees.test.ts` (10) | ✅ |
| SDK orchestrator selection/routing/persist | `BatchWithdrawOrchestrator.test.ts` (12), `PoolSessionBatchWithdraw.test.ts` (10) | ✅ (mock prover) |
| SDK routing tamper (greedy relayer / recipient mismatch) | `…throw BatchRoutingInvalid …`, `BatchRoutingMismatch` | ✅ |
| **`relayBatch` recipient = address(0) (ETH burn)** | — | ✗ (threat, contracts_r1 fix) |
| **Orchestrator `prepareBatchWithdraw` through a REAL proof** | — | ▲ integration test proves the shared-root invariant but bypasses the orchestrator |
| Fuzz/invariant handler for `relayBatch` | — | ✗ |

## 3. Yield Deposit & Withdrawal (#315) — `PPYieldToken`, `PPYieldTokenZap`, `PPRouter`

| Flow / permutation | Test | Status |
|---|---|---|
| Deposit USDC → ppUSDC shares (unit, mock Aave) | `PPYieldTokenZap.t.sol`, `PPRouter.t.sol` (UnitPPRouterDeposit) | ✅ (mock) |
| Withdraw ppUSDC → USDC via router (unit) | `UnitPPRouterWithdraw` (17) incl. zero-recipient, invalid-processor, dust-fee-waiver, no-fee, with-fee | ✅ (mock) |
| ERC-4626 accounting / fee accrual / decimals | `PPYieldToken.t.sol` (48), `PPYieldTokenDecimals.t.sol` (8) | ✅ |
| Admin (setFeeBps, claimFees, pause, rescue, rewards) | `PPYieldTokenAdmin.t.sol` (36) | ✅ |
| Reentrancy (asset / controller) | `PPYieldTokenReentrancy.t.sol` (6) | ✅ |
| Factory dead-share seed / first-depositor | `PPYieldTokenFactory.t.sol` (16) | ○ (factory path only; see below) |
| Invariants (solvency, backing, fee bound, rate) | `test/invariant/PPYieldToken.t.sol` (6) | ✅ (PPYieldToken only) |
| Round-trip deposit→withdraw with real proof | `PPUSDCYieldMock/Fork` integration (24) | ▲ **exercises VENDORED copies under `test/integration/helpers/ppusdc/`, NOT `src/`** |
| SDK yield deposit/withdraw sessions | `PoolSessionYieldDeposit.test.ts` (31), `…Withdraw.test.ts` (48) | ✅ (mock) + 1 real-proof (`…realproof.integration`) |
| **Real-proof E2E of DEPLOYED `src/` yield contracts** | — | ✗ (only vendored copies; contracts_r1) |
| **First-depositor inflation on factory-BYPASS deploy** | — | ✗ (`DeployYieldFork` bypasses the dead-share seed; threat S8) |
| **Zap donation (balanceOf-driven) griefing** | — | ✗ (threat S8) |
| Invariants for `PPRouter` / `Zap` / factories | — | ✗ (only `InvariantPPYieldToken`) |
| Relayed yield withdraw via SDK (`processorAddress`) | — | ✗ (unreachable via SDK — sdk_r1 F-1; relayer honors it, SDK can't send it) |

## 4. Stealth Addresses (#317) — SDK `src/stealth/` (no contract, no circuit)

| Flow / permutation | Test | Status |
|---|---|---|
| FluidKey derive/scan round-trip + interop vectors | `derive.test.ts`, `fluidkey-vectors.test.ts` (`DERIV-03`) | ✅ |
| Canonical EIP-5564 derive/scan + ScopeLift vectors | `derive-canonical.test.ts`, `scopelift-vectors.test.ts` | ✅ (unit) |
| Discriminated-union dispatch / scheme isolation | `dispatch.test.ts` (`DISPATCH-01/03/04/05`) | ✅ |
| Wrong-scheme announcement misparse (the old 0x0001 bug) | `dispatch.test.ts::DISPATCH-05` | ✅ (regression) |
| Announcer chokepoint enforcement | `announcer.test.ts` | ✅ |
| View-tag match/miss | `viewTag.test.ts` (5) | ✅ |
| Announcement ↔ withdrawal binding | `discoveryBinding.test.ts` (7) | ▲ advisory (M-1: binding not cryptographically atomic) |
| 10k cross-scheme fuzz | `properties.test.ts` (`PROP-04`) | ✅ |
| **Canonical scheme end-to-end via the ORCHESTRATOR** | — | ✗ (M-2: `resolveRecipient` only returns FluidKey `0xfffe`; canonical unreachable) |
| **Stealth withdrawal submitted through the relayer** | — | ✗ (no relayer schema; bundle dies at SDK boundary — threat S11) |

---

## Headline coverage gaps (ranked)
1. **Yield has no real-proof E2E of deployed `src/`** — the proof-carrying tests run *vendored copies*
   that have already drifted from `src/`. (contracts_r1; add a real-proof E2E against `src/`.)
2. **Batch orchestrator (`prepareBatchWithdraw`) never runs through a real proof** — the invariant is
   proven but the SDK code path that builds the batch is only mock-tested.
3. **Signature-replay / no-deadline** on `setAuthPolicyWithSig` is unmodeled in tests (threat S5).
4. **Zero-recipient ETH burn** in `relayBatch`/`_relay` untested (and unguarded) — contracts_r1 fix.
5. **First-depositor inflation on a factory-bypass deploy** + **zap donation griefing** untested (S8).
6. **`relayBatch` / `registerAndRelay` have no fuzz/invariant handler** — the invariant campaign that
   covers deposit/transact/ragequit/relay does not cover the two new relay entrypoints.
7. **Two "implemented but not wired" gaps** with zero E2E: relayed-yield `processorAddress` (SDK can't
   send) and canonical stealth scheme (orchestrator can't select).
