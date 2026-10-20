# Test-Gap Audit — ppUSDC yield surface (post ppv2 re-apply)

Repo: `packages/contracts` (this repo — the combined router variant).
Scope: the 6 yield contracts and their tests. Method: enumerated every external/public
function and every `require`/custom-error path, then grep-verified whether a test exercises
each. "Covered via router" = exercised only indirectly through `PPRouter.t.sol`'s real (not
mocked) `PPYieldTokenZap` / `PPYieldToken` — not by a dedicated unit test.

Key setup fact: `test/unit/PPRouter.t.sol` constructs a **real** `PPYieldTokenZap` (line 62)
and a real `PPYieldToken`, so `depositExactShares`/`withdrawToUnderlying` genuinely drive the
zap's `buyFixedYieldToken` / `redeemToUnderlying` and the vault's mint/redeem end-to-end.

---

## Coverage table

### PPYieldToken.sol
| Function / path | Covered? |
|---|---|
| constructor: `FeeTooHigh` | ✅ PPYieldToken.t.sol / Admin (`test_Constructor_AcceptsFeeEqualToMax`, FeeTooHigh tests) |
| constructor: `UnsupportedDecimals` (>18) | ✅ PPYieldTokenDecimals.t.sol |
| `setFeeBps` happy + old-rate charge | ✅ Admin `test_SetFeeBps_*` |
| `setFeeBps` `FeeTooHigh` / onlyOwner / no-yield no-op | ✅ Admin |
| `renounceOwnership` reverts (owner + non-owner) | ✅ Admin `test_RenounceOwnership_*` |
| `claimFees(recipient)` happy / `ZeroAddress` / onlyOwner / zero-claim / 1-wei | ✅ Admin |
| `claimFees()` (owner default) | ✅ Admin / PPYieldToken.t.sol |
| `setRewardsController` happy / onlyOwner / overwrite-emit | ✅ Admin |
| `pause` / `unpause` happy / onlyOwner / EnforcedPause / ExpectedPause | ✅ Admin |
| `claimRewards` happy / onlyOwner / `RewardsControllerNotSet` | ✅ Admin `test_ClaimRewards_*` |
| `rescueToken` happy / onlyOwner / `CannotRescueAsset` / `ZeroAddress` / stray shares | ✅ Admin |
| `admin` / `exchangeRate` / `claimableFees` | ✅ Admin / PPYieldToken.t.sol |
| `maxDeposit` / `maxMint` gated-to-0 while paused + restore | ✅ Admin `test_Pause_*` / `test_Unpause_Restores*` |
| `totalAssets` (net of fees) | ✅ PPYieldToken.t.sol |
| `_deposit` `ZeroShares` | ✅ PPYieldToken.t.sol / Admin |
| `_withdraw` `ZeroAssets` | ✅ PPYieldToken.t.sol |
| reentrancy on claimFees/claimRewards/rescueToken | ✅ PPYieldTokenReentrancy.t.sol |
| `totalAssets` defensive `_balance>_fees?…:0` zero-clamp branch | ⚠️ Nit — clamp branch not explicitly forced |

### PPYieldTokenZap.sol
| Function / path | Covered? |
|---|---|
| constructor 3× `ZeroAddress` | ✅ PPYieldTokenZap.t.sol |
| `depositUnderlying` happy / `ZeroAmount` / receiver / full-balance-with-dust | ✅ PPYieldTokenZap.t.sol + integration |
| `redeemToUnderlying` happy / `ZeroAmount` / receiver | ✅ PPYieldTokenZap.t.sol + integration |
| `buyFixedYieldToken` happy path (mint exact shares) | ⚠️ Only via router (no dedicated zap unit test) |
| `buyFixedYieldToken` `ZeroAmount` (line 91) | ❌ **GAP** — distinct require, never hit |
| `buyFixedYieldToken` `SlippageExceeded` (line 94) | ❌ **GAP** — unreachable via router, untested anywhere |
| `buyFixedYieldToken` `InsufficientWrap` (line 101) | ✅ via router `test_depositExactShares_revertsOnInsufficientWrap` |
| `buyFixedYieldToken` dust-forward branch (line 106-107) | ⚠️ Only via router→skim (receiver = router); direct-EOA receiver untested |
| `ZappedInExact` event | ❌ **GAP** — never asserted (`ZappedIn`/`ZappedOut` are) |
| `quoteBuy` (line 130) | ⚠️ Only via `router.quote` (`test_quote_matchesPreviewMintPlusBuffer`); no direct assert |

### PPRouter.sol
| Function / path | Covered? |
|---|---|
| `depositExactShares` happy / rate-rise / vetting-fee split | ✅ PPRouter.t.sol |
| `depositExactShares` `AssetMismatch` / `ZeroValue` / `SlippageExceeded` (+1-wei boundary) | ✅ |
| `depositExactShares` `SharesStranded` (entrypoint under-pull) | ✅ `test_depositExactShares_revertsIfEntrypointUnderpulls` |
| `depositExactShares` `InsufficientWrap` bubble-up | ✅ |
| `withdrawToUnderlying` happy w/fee, no-fee, fee-recipient default | ✅ |
| `withdrawToUnderlying` `ZeroWithdrawal` / `ZeroRecipient` / `AssetMismatch` / `InvalidProcessor` | ✅ |
| `withdrawToUnderlying` `NativeGasMismatch` / `FeeExceedsMax` / `FeeExceedsWithdrawal` / `BelowMinUnderlying` | ✅ |
| `withdrawToUnderlying` dust-fee waiver branch (line 193) | ✅ `test_withdrawToUnderlying_waivesDustFeeInsteadOfReverting` |
| `withdrawToUnderlying` recipientShares==0 / fee-takes-all | ✅ `test_..._recipientSharesZero_feeTakesAll` |
| `withdrawToUnderlying` native-gas forward | ✅ `test_..._forwardsNativeGas` |
| `withdrawToUnderlying` `SharesNotReceived` (vault underpays) | ✅ `test_..._revertsIfVaultUnderpays` |
| `skim` sweep / no-op-when-empty / event | ✅ |
| `quote` / `quoteWithdraw` | ✅ |
| constructor `ZeroAddress` (7 args) / `AssetMismatch` (zap pair) | ✅ |

**All 13 `PPRouter_*` errors are covered.** PPRouter is the best-covered contract in the set.

### PPYieldTokenFactory.sol / PPYieldTokenZapFactory.sol / PPRouterFactory.sol
| Path | Covered? |
|---|---|
| YieldTokenFactory: createWrapper happy/seed/emit/onlyOwner/ForeignAToken/AlreadyDeployed/ZeroSeed/ZeroPool/OOB/one-wei/dead-shares/reentrancy | ✅ PPYieldTokenFactory.t.sol |
| ZapFactory: createZap happy/emit/onlyOwner/ForeignPool/AlreadyDeployed/ZeroPool/OOB/functional | ✅ PPYieldTokenZapFactory.t.sol |
| RouterFactory: createRouter wires/onlyOwner/ForeignPoolAToken/Duplicate/emit/ZeroAddress/tracksMultiple | ✅ (inside PPRouter.t.sol; all 3 `PPRouterFactory_*` errors hit) |

---

## Findings (severity-ordered)

### 1. HIGH — `PPYieldTokenZap.buyFixedYieldToken` has no dedicated unit test; its slippage guard is entirely unexercised
- Location: `src/contracts/PPYieldTokenZap.sol:86-110`, esp. the slippage require at **line 94**
  (`PPYieldTokenZap_SlippageExceeded`).
- `buyFixedYieldToken` / `quoteBuy` are external entrypoints that exist ONLY in this repo (the
  canonical ppv2 module lacks them, so the re-applied tests don't touch them). Verified by grep:
  the literal `buyFixedYieldToken` appears in **zero** test files; it runs only indirectly inside
  `router.depositExactShares`.
- The router path passes its own pre-computed `_underlyingIn` as the zap's `_maxUnderlyingIn`
  (`PPRouter.sol:146`). Both figures derive from the same `ZAP.quoteBuy` = `previewMint(_total)+2`,
  so `_underlyingIn <= _maxUnderlyingIn` always holds with **equality** — the zap's line-94 guard
  can never fire through the router. It is also referenced nowhere in the tests. A mutation that
  weakens or deletes that require survives.
- The zap is documented as a standalone "convenience router" (`PPYieldTokenZap.sol:11-16`); a
  direct external caller relies on `_maxUnderlyingIn` for overpay protection, and that protection
  has no test.
- Missing cases: (a) direct `buyFixedYieldToken` happy path crediting a named receiver with exactly
  `_shares`; (b) `_maxUnderlyingIn` too low → `PPYieldTokenZap_SlippageExceeded(needed, max)`.
- Suggested test (in `test/unit/PPYieldTokenZap.t.sol`):
  - `test_BuyFixedYieldToken_MintsExactSharesToReceiver` — assert `vault.balanceOf(receiver) == _shares`
    and returned `_underlyingIn == quoteBuy(_shares)`.
  - `test_BuyFixedYieldToken_RevertsOnSlippage` — call with `_maxUnderlyingIn = quoteBuy(_shares) - 1`,
    `vm.expectRevert(...PPYieldTokenZap_SlippageExceeded.selector...)`.

### 2. MEDIUM — `buyFixedYieldToken` zero-amount guard (line 91) untested
- Location: `src/contracts/PPYieldTokenZap.sol:91` (`require(_shares != 0, PPYieldTokenZap_ZeroAmount())`).
- The `ZeroAmount` selector is tested for `depositUnderlying` and `redeemToUnderlying`, but **not**
  for `buyFixedYieldToken` — it is a distinct require on a distinct line. The router guards
  `_value != 0` upstream and never forwards 0, so this line is never reached. Mutation survives.
- Suggested test: `test_BuyFixedYieldToken_RevertsOnZeroShares` — `zap.buyFixedYieldToken(0, alice, type(uint256).max)`.

### 3. MEDIUM — `quoteBuy` has no direct unit test
- Location: `src/contracts/PPYieldTokenZap.sol:130`.
- Functionally exercised only via `router.quote` (`test_quote_matchesPreviewMintPlusBuffer`), which
  couples the assertion to the router's fee math. No test asserts `quoteBuy(_shares) ==
  previewMint(_shares) + 2` directly, nor that its output round-trips with what `buyFixedYieldToken`
  actually pulls.
- Suggested test: `test_QuoteBuy_EqualsPreviewMintPlusBuffer` + assert `buyFixedYieldToken` with
  `_maxUnderlyingIn = quoteBuy(_shares)` succeeds exactly (round-trip).

### 4. LOW — `buyFixedYieldToken` dust-forward branch only tested with receiver = router
- Location: `src/contracts/PPYieldTokenZap.sol:106-107`.
- The `_dust != 0` branch is exercised via `depositExactShares` + `skim`, but there the receiver is
  the router itself. The direct case (an EOA receiver getting `<= 2` wei aToken dust forwarded) is
  untested. Covered by the suggested test #1 if it asserts `A_TOKEN.balanceOf(receiver)` dust.

### 5. NIT — `ZappedInExact` event never asserted
- Location: `src/contracts/PPYieldTokenZap.sol:109`.
- `ZappedIn` and `ZappedOut` are asserted in `test/integration/PPYieldTokenZap.t.sol`; `ZappedInExact`
  is not asserted anywhere. Add a `vm.expectEmit` to the suggested test #1.

### 6. NIT — `PPYieldToken.totalAssets` zero-clamp branch not force-tested
- Location: `src/contracts/PPYieldToken.sol:197` (`_balance > _fees ? _balance - _fees : 0`).
- Defensive branch; hard to reach in practice (fees can't exceed balance under normal flow). Optional.

---

## Notes on what is NOT a gap (checked, found covered)
- All 13 `PPRouter_*` revert paths, the dust-fee waiver, fee-takes-all, native-gas forward, and both
  balance-guard reverts — covered in `PPRouter.t.sol`.
- Every `PPYieldToken_*` error and every admin role-gated path — covered in `PPYieldTokenAdmin.t.sol`
  (+ Reentrancy + Decimals).
- All three factories' errors and access control — covered.
- `PPYieldTokenZap_InsufficientWrap` — covered via the router (`test_depositExactShares_revertsOnInsufficientWrap`).

---

## Resolution (closed)

Added 4 dedicated tests to `test/unit/PPYieldTokenZap.t.sol` (suite 8 → 12, all pass):
- `test_BuyFixedYieldToken_MintsExactSharesToReceiver` — exact shares to receiver, `underlyingIn == quoteBuy`, dust ≤ buffer forwarded to receiver, stateless zap, asserts `ZappedInExact`. → closes **HIGH** (happy), **LOW** (dust-to-EOA), **NIT** (event).
- `test_BuyFixedYieldToken_RevertsWhenMaxUnderlyingTooLow` (`maxUnderlyingIn = quoteBuy − 1`) → closes **HIGH** (slippage guard).
- `test_BuyFixedYieldToken_RevertsWhenSharesIsZero` → closes **MEDIUM #2** (zero-amount guard).
- `test_QuoteBuy_EqualsPreviewMintPlusRoundingBuffer` → closes **MEDIUM #3**.

Remaining: only NIT #6 (`totalAssets` defensive zero-clamp) — unreachable under normal flow, left as-is.
