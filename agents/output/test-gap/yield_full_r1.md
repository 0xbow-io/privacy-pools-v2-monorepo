# Test-Gap Analysis — YIELD feature (#315), full flow sweep — round 1

**Scope:** whole yield feature — 6 contracts (`PPYieldToken`, `PPYieldTokenZap`, `PPYieldTokenFactory`,
`PPYieldTokenZapFactory`, `PPRouter`, `PPRouterFactory`) + `FeeCalculator`; SDK yield sessions/interactors;
relayer yield/processor routing. Matched to user flows per `agents/TEST_GAP_AGENT.md`.
**Commit:** `b7910a6` · branch `v2.0-features` · **read-only.**
**Method:** flow enumeration → per-flow {covered | mock-only | missing}; TEST-7 no-mock-only sweep;
TEST-8 schema→wire; error-path parity; TEST-9 invariant efficacy; CI-selection (SEL) check.

## Verdict

The contract layer is **comprehensively covered** — every custom error and behavior has an asserting test,
the real-Aave-fork integration suite exercises deposit/withdraw/exact-shares/fees against a real ray-scaled
index, the SDK real-proof integration tests hit `src/` session methods with genuine Groth16 proofs (the H-1
"vendored copies" regression is closed), and the invariant harness is TEST-9-sound (no swallowed handler
asserts). The "46 yield tests unselected" SEL regression is **not present** now.

**Three gaps remain, one material.** The relayer's own on-chain processor dispatch
(`withdrawToUnderlying` ABI wiring, `args[3]=minUnderlyingOut`, `address=processorAddress`) has **no real
on-chain exercise in the relayer's test surface at all** — its unit specs fully mock the signer/chain, and
the relayer docker/anvil e2e has **zero** `PPRouter`/`withdrawToUnderlying` coverage (grep-confirmed empty).
The only real exercise of that dispatch is the SDK's `yield-e2e-relayed` script (anvil fork), which is
env-gated and excluded from every default gate. This is worse than the known-gap history note (which assumed
the docker e2e covered it). The other two gaps are lower risk (a receiving-side TEST-8 parse-survival test,
and the slippage-floor revert never tripped on the real fork).

---

## Flow × status matrix

Actors: **D**epositor · **W**ithdrawer · **R**elayer · **A**dmin · **F**actory. Path: self / relayed.

### Contracts — PPYieldToken (ERC-4626 wrapper)
| Flow / behavior | Status | Test @ file:line |
|---|---|---|
| deposit / mint happy | covered | `test_Deposit_…` PPYieldToken.t.sol:120; `test_Mint_…`:221 |
| withdraw / redeem happy | covered | :249 / :304 |
| yield accrual + fee checkpoint | covered | `test_FeeAccrual_*` :469–547; exact-floor Admin:144 |
| setFeeBps charges old-rate then switches | covered | Admin:86; no-op no-yield Admin:370 |
| claimFees (zero / non-zero / dust) | covered | :341,:366,:382; Admin:109,:158,:193 |
| claimableFees / exchangeRate / totalAssets clamp | covered | :451,:457 / :426–439 / :414 |
| pause/unpause gates maxDeposit/maxMint→0 | covered | :203,:621; Admin:429,:508 |
| setRewardsController / claimRewards (happy/not-set/reentrant) | covered | Admin:267,:380,:292,:286; Reentrancy:153 |
| rescueToken (happy / own-shares / not-asset / zero-recip / reentrant) | covered | Admin:342,:356,:328,:335; Reentrancy:130 |
| renounceOwnership reverts / Ownable2Step transfer | covered | Admin:397,:404 / :231 |
| decimals offset (18−assetDec) | covered | Decimals:40–71; PPYieldToken.t.sol:103 |
| first-depositor inflation neutralized | covered | :553; dead-share offset-0 Factory:270 |
| errors _FeeTooHigh/_UnsupportedDecimals/_ZeroAddress/_ZeroAssets/_ZeroShares/_CannotRescueAsset/_RenounceDisabled/_RewardsControllerNotSet | covered | all present (see contract-unit sub-report) |

### Contracts — Zap / Factory / ZapFactory
| Flow | Status | Test @ file:line |
|---|---|---|
| depositUnderlying (happy / zero) | covered | Zap:121 / :111 |
| buyFixedYieldToken (happy / zero / slippage / insufficient-wrap / dust) | covered | Zap:225,:281,:244,:294,:239 |
| redeemToUnderlying (happy / zero) | covered | Zap:171 / :161 |
| quoteBuy · constructor zero-addr · donated-aToken-not-swept | covered | Zap:328,:90–100,:138/:196/:263 |
| createWrapper (happy/not-owner/NotAavePoolAToken/AlreadyDeployed/ZeroSeed/dead-seed) | covered | Factory:72,:119,:127,:136,:146,:270 |
| createZap (happy/not-owner/NotAavePoolAToken/AlreadyDeployed) + views | covered | ZapFactory:55,:127,:133,:143 |

### Contracts — PPRouter (deposit shield / withdraw-to-underlying processor)
| Flow | Status | Test @ file:line |
|---|---|---|
| depositExactShares happy + exact-share + slippage | covered | PPRouterDeposit.t.sol:… ; **real fork** PPUSDCYieldFork:357 |
| withdrawToUnderlying happy (recipient+fee legs) | covered (self) | PPRouterWithdraw.t.sol:…; **real fork** PPUSDCYieldFork:271,:303 |
| withdrawToUnderlying **relayed** (processor path) | **mock-only in default gate** | see Gap 1 |
| all 13 `PPRouter_*` errors | covered | one revert test each (PPRouterDeposit/Withdraw) |
| fee-leg waived when previewRedeem(fee)==0 · native-gas fwd · feeRecipient default | covered | PPRouterWithdraw.t.sol:57,:229,:93 |
| `PPRouter_BelowMinUnderlying` **tripped on real fork** | **missing** | Gap 3 (mock-unit only :197) |
| skim (no-op / dust+event) · quote / quoteWithdraw | covered | PPRouterDeposit:222,:207; :285 / PPRouterWithdraw:257 |

### SDK — yield sessions
| Flow | Unit (mock) | Real-proof (src/) | Ref |
|---|---|---|---|
| prepareYieldDeposit | ✅ | ✅ | Deposit.test.ts:93…; realproof:137 (imports `../../src/internal.js`, real `proveDeposit`/`verifyDeposit`) |
| sharesForUnderlying | ✅ | n/a (pure arith) | Deposit.test.ts:290 |
| prepareYieldWithdraw | ✅ | ✅ | Withdraw.test.ts:118…; realproof:322,:331 |
| prepareYieldWithdrawRelay | ✅ | ✅ | Withdraw.test.ts:489…; realproof:402,:413 |
| PPYieldTokenInteractor (rate/preview/encodeRedeem) | ✅ | ✅ (gated local) | Interactor.test.ts:57–150; yield-wrapper-local:31 |
| relay params processorAddress/minUnderlyingOut → POST body | ✅ | ✅ | RelayerInteractor.test.ts:617–698 (asserts body.* fields) |

### Relayer — yield/processor routing
| Flow | Status | Ref |
|---|---|---|
| decide processor vs relay; build withdrawToUnderlying args | covered (mock) | evm.chain.service.ts:387–445; processor.spec.ts:80–107 |
| processorAddress/minUnderlyingOut thread to call args | covered (mock) | processor.spec.ts:114–145 |
| disallowed-processor REJECTION (allowlist) | covered (real prim.) | evm.relay.service.processor.spec.ts:102; chain-config.spec.ts:22–42 |
| **real on-chain withdrawToUnderlying dispatch** | **mock-only / unrun in default gate** | Gap 1 |
| **Zod parse-survival of processorAddress/minUnderlyingOut (receiving side)** | **missing** | Gap 2 |

---

## Ranked gaps

### Gap 1 — HIGH (real-but-unrun): relayer on-chain processor dispatch has no real exercise anywhere in default gates
**What:** `EVMChainService.simulateAndWriteRelay` (evm.chain.service.ts:400–424) is the only place the
relayer encodes `withdrawToUnderlying` (PP_ROUTER_ABI, `args[3] = minUnderlyingOut ?? 0n`,
`address = processorAddress`). Its unit spec (`evm.chain.service.processor.spec.ts`) stubs `client()`/
`signer()` with `jest.fn` `simulateContract`/`writeContract` — **no real viem call, no real PPRouter.**
Grep of the relayer docker/anvil e2e (`packages/relayer/e2e/src/**`) for `withdrawToUnderlying|PPRouter|
minUnderlyingOut` returns **nothing** — the yield branch is untested on-chain there. The relayer default
jest gate is `rootDir:"src", testRegex:".*\.spec\.ts$"` (package.json:76–77) → only mocked specs run.
The **only** real on-chain exercise of the relayer→PPRouter dispatch is the SDK script
`packages/sdk/scripts/e2e-yield/yield-e2e-relayed.test.ts` (anvil fork, submits real
`withdrawToUnderlying` via the relayer), which is `describe.skip` unless `YIELD_E2E_RELAYED=1` and lives
under `scripts/` (outside both the SDK `test/**` glob and the relayer jest gate). **Consequence:** a drift
in the relayer's `PP_ROUTER_ABI` / arg order / `minUnderlyingOut` position would pass every default-gate
test. This is strictly worse than the TEST_GAP_AGENT history note, which assumed the docker e2e covered it.
**Test to add:** a relayer integration/e2e (anvil fork) that deploys or forks a real `PPRouter` at
`processorAddress` and drives `simulateAndWriteRelay` end-to-end, asserting the router's
`WithdrawnToUnderlying` event / a real USDC balance change and the `minUnderlyingOut` floor reaching the
call. Minimum viable: promote `yield-e2e-relayed` into a nightly/CI-gated job and document that the
relayer processor dispatch is verified only there (Directive 0 — don't claim it as default-gate covered).

### Gap 2 — MEDIUM (TEST-8, receiving side): no Zod parse-survival test for processorAddress/minUnderlyingOut
**What:** both fields are correctly declared `.optional()` in `zEvmRelayWithdrawalRequest`
(schemas.ts:142,:149) and reach the call args, and the **sending** side (SDK `RelayerInteractor.test.ts:
653–677`) asserts they land in the POST body. But on the **receiving** relayer side, the spec suite has
the exact TEST-8 pattern for *other* fields — `it("preserve the registration hex fields through parsing")`
runs `zEvmRegisterAndRelayRequest.parse(body)` and asserts each field survives (evm.relay.service.spec.ts:216)
— yet **no equivalent parse-survival test exists for `processorAddress`/`minUnderlyingOut` on
`zEvmRelayWithdrawalRequest`.** If those two `.optional()` lines were removed, Zod would silently strip the
fields and relayed yield withdrawal would break with **no failing relayer test.** The processor specs bypass
Zod entirely (`makeRequest(...) as unknown as EvmRelayWithdrawalRequest`).
**Test to add:** `it("preserves processorAddress and minUnderlyingOut through parsing")` →
`const parsed = zEvmRelayWithdrawalRequest.parse(rawBodyWithBothFields); expect(parsed.processorAddress)
.toBe(...); expect(parsed.minUnderlyingOut).toBe(...)`; plus a negative test that a malformed address /
negative bigint is rejected.

### Gap 3 — LOW: `PPRouter_BelowMinUnderlying` revert never tripped against the real Aave fork
**What:** the slippage-floor revert is covered only by the mock unit test (`PPRouterWithdraw.t.sol:197`,
`_min = expected+1`). Every fork test passes a *satisfied* floor (`_minUnderlyingOut == previewRedeem`,
PPUSDCYieldFork:288,:335,:389), so the revert is never exercised against real Aave index rounding. Backend-
independent arithmetic, hence low risk, but there's no integration-level assertion that the floor trips.
**Test to add (env-gated on `MAINNET_RPC`):** a fork test setting `_minUnderlyingOut = previewRedeem+1` and
expecting `PPRouter_BelowMinUnderlying`.

### Notes (not ranked gaps)
- **Contract unit suite has no aToken index-rounding mock** — yield is a flat 1:1 balance delta
  (`MockERC20`/`MockAaveMulti`). This is acceptable because the real-index path IS covered at integration
  level: `PPUSDCYieldFork` (real Aave, ray-scaled), `PPUSDCYieldMock` (`MockRebasingAToken`, ray `rayMul`/
  `rayDiv` with interest), and `MockUnderCreditingPool` (Zap:342, proves the supply-delta wrap check). No
  TEST-7 violation — a real counterpart exists for each mocked yield behavior.
- **`depositExactShares` absent from the deterministic mock integration suite** (`PPUSDCYieldMock` is
  withdraw-only); covered by real fork (PPUSDCYieldFork:357) + 1:1 unit tests. Acceptable.
- **Fork suite hard-fails (not skips) when `MAINNET_RPC` is unset** (`IntegrationBase.t.sol:91`, no
  `vm.envOr` skip). "Fork tests pass" is only meaningful when `MAINNET_RPC` is provided — absent it they
  error, they do not silently no-op. Worth a graceful skip guard for honest CI signal.
- **Stale interface:** `IWithdrawalRelayRequest` (relayer.types.ts:149–154) omits `minUnderlyingOut`.
  Harmless (the DTO shape derives from `createZodDto(zEvmRelayWithdrawalRequest)`, not this interface) but
  should be synced.
- **Additional integration files** exist and were not deep-read in this pass:
  `test/integration/PPYieldToken.t.sol`, `test/integration/PPYieldTokenZap.t.sol` — additive coverage,
  not relied on for any verdict above.

## TEST-7 / TEST-9 / SEL confirmations
- **TEST-7 (no-mock-only):** every mocked yield behavior has a real counterpart EXCEPT the relayer's own
  on-chain `withdrawToUnderlying` dispatch (Gap 1). SDK session methods are all real-proof-covered (the
  e2e scripts hand-roll but the `*.realproof.integration.test.ts` call the real `src/` methods).
- **TEST-9 (invariant efficacy):** `foundry.toml` sets `fail_on_revert=false` on both invariant profiles
  (:50,:64). `HandlerYield.sol` contains **zero** correctness asserts (only `bound()`/early-return guards);
  all five properties live in load-bearing `invariant_YIELD_1..5` functions in `InvariantYield.t.sol:60–117`.
  Sound.
- **SEL:** SDK default glob `test/**/*.test.ts` selects all yield unit + both realproof integration tests
  (artifacts present → they execute, not skip). The "46 unselected yield tests" regression is closed. Only
  the live-fork `scripts/e2e-yield/*` and the env-gated `yield-smoke`/`yield-wrapper-local` sit outside the
  default gate (by design). Relayer default gate excludes all e2e (separate vitest+docker package).
