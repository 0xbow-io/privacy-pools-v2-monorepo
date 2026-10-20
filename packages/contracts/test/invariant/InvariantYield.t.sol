// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {HandlerYield} from './handlers/HandlerYield.sol';
import {MockAaveAToken} from 'test/helpers/MockAaveMulti.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title InvariantYield
/// @notice Invariant coverage for the yield layer (`PPYieldTokenZap` + `PPYieldToken`), which had unit
/// + integration tests but was absent from the invariant harness. Asserts the layer's core value
/// properties across arbitrary interleavings of deposits, exact buys, redeems, and aToken-donation
/// griefing: (1) share<->underlying conservation (backing always covers redeemable shares), (2) zap
/// statelessness / C-7 no-free-value (the stateless zap never accrues value beyond donated dust and a
/// redeemer never extracts more than was supplied), and (3) the factory-seeded dead shares stay
/// permanently locked.
/// @dev Self-contained on a 1:1 Aave mock (see `HandlerYield`); the mock pays no interest and does no
/// pool-level rounding, so all rounding lives in the ERC-4626 conversion and the bounds below are
/// tight. Matched by the `test:invariant:ci` / `:campaign` scripts (`--match-contract Invariant`).
contract InvariantYield is Test {
  /// @dev Burn address holding the factory-seeded dead shares (literal; the handler keeps it internal
  ///      because a public `address constant` getter trips a solc 0.8.32 ICE).
  address internal constant _DEAD = address(0xdEaD);

  /// @dev Dead-share seed supplied to the factory at wrapper creation, in underlying units (mirrors
  ///      `HandlerYield._SEED_ASSETS`; referenced directly for the same solc-ICE reason as `_DEAD`).
  uint256 internal constant _SEED_ASSETS = 1e6;

  HandlerYield internal _handler;

  PPYieldToken internal _vault;
  PPYieldTokenZap internal _zap;
  MockAaveAToken internal _aToken;

  function setUp() public {
    _handler = new HandlerYield();
    _vault = _handler.vault();
    _zap = _handler.zap();
    _aToken = _handler.aToken();

    targetContract(address(_handler));
  }

  /// @notice YIELD-1: net backing is exactly the seed plus tracked deposit/redeem flows, and always
  ///         covers what every outstanding share can redeem.
  /// @dev The two `previewRedeem(totalSupply) <= backing` bounds hold by ERC-4626 construction (they are
  ///      convert-then-compare against the same balance), so on their own they are near-tautological. The
  ///      load-bearing check is the equality: `totalAssets()` is pinned to an INDEPENDENT accounting of
  ///      backing flows — the locked seed, plus aTokens that actually entered the vault
  ///      (`ghost_vaultBackingIn`, which excludes the per-buy rounding-buffer dust forwarded to receivers),
  ///      minus aTokens withdrawn on redeem (`ghost_underlyingRedeemed`, 1:1). No interest accrues on this
  ///      mock, so fees stay zero and the relation is exact. A path that minted shares without pulling the
  ///      matching backing (or that leaked backing) would break the equality even though `previewRedeem`
  ///      would silently re-price around it.
  function invariant_YIELD_1_backingCoversShares() external view {
    uint256 _redeemableAll = _vault.previewRedeem(_vault.totalSupply());
    uint256 _backing = IERC20(address(_aToken)).balanceOf(address(_vault));
    assertLe(_redeemableAll, _backing, 'YIELD-1: outstanding shares exceed aToken backing');
    // `totalAssets` (backing net of fees) must likewise cover redemptions.
    assertLe(_redeemableAll, _vault.totalAssets(), 'YIELD-1: redeemable exceeds net totalAssets');
    // Independent solvency: net backing equals seed + tracked-in - tracked-out (exact, fees are zero here).
    assertEq(
      _vault.totalAssets(),
      _SEED_ASSETS + _handler.ghost_vaultBackingIn() - _handler.ghost_underlyingRedeemed(),
      'YIELD-1: totalAssets diverged from tracked backing flows'
    );
  }

  /// @notice YIELD-2: the stateless zap never accrues value beyond griefing donations.
  /// @dev After any op the zap holds zero underlying (fully forwarded) and no MORE aToken than the
  ///      cumulative donated amount — the C-7 property. A supply/redeem path that swept a donation
  ///      would push the stranded balance off `ghost_donatedAToken`; equality holds on this exact mock.
  function invariant_YIELD_2_zapStateless() external view {
    assertEq(IERC20(address(_handler.underlying())).balanceOf(address(_zap)), 0, 'YIELD-2: zap holds underlying');
    // Exact equality (not <=): on the 1:1 mock every op forwards its full aToken delta out of the zap, so
    // the ONLY aToken the stateless zap ever retains is the cumulative donation. `assertLe` would pass the
    // C-7 sweep mutation (a swept donation drives the balance toward 0, still <= donated); `assertEq` fails
    // it because the residual must equal the donation exactly.
    assertEq(
      IERC20(address(_aToken)).balanceOf(address(_zap)),
      _handler.ghost_donatedAToken(),
      'YIELD-2: zap aToken balance != donated dust (value sweep or leak)'
    );
  }

  /// @notice YIELD-3: no free value — aggregate underlying redeemed never exceeds underlying supplied.
  /// @dev With no interest and the seed locked in dead shares, redeemers can only ever pull back what
  ///      was supplied; extracting more (e.g. the locked seed or a donation) would break this.
  function invariant_YIELD_3_noFreeValue() external view {
    assertLe(
      _handler.ghost_underlyingRedeemed(),
      _handler.ghost_underlyingSupplied(),
      'YIELD-3: redeemed underlying exceeds supplied (free value extracted)'
    );
  }

  /// @notice YIELD-4: the factory-seeded dead shares are permanently locked (never spendable/decreasing).
  /// @dev `0xdEaD` can never be pranked, so its balance is constant; and total supply can never fall
  ///      below the seed, i.e. the vault never empties (first-depositor inflation stays neutralized).
  function invariant_YIELD_4_deadSharesLocked() external view {
    assertEq(_vault.balanceOf(_DEAD), _handler.deadShares(), 'YIELD-4: dead-share balance changed');
    assertGe(_vault.totalSupply(), _handler.deadShares(), 'YIELD-4: total supply fell below locked seed');
  }

  /// @notice YIELD-5: pp-share supply equals the locked seed plus every tracked mint, minus every tracked
  ///         redeem — a closed share-conservation ledger.
  /// @dev Independent of the value/backing invariants: this pins the SHARE count (not the asset backing) to
  ///      the handler's mint/redeem ghosts. Shares only enter via the seed (dead shares) and the two zap mint
  ///      paths, and only leave via zap redeems; no interest changes the count. A modest mis-mint (extra or
  ///      missing shares) that keeps `previewRedeem`/backing internally consistent — and so slips past YIELD-1
  ///      — still moves `totalSupply` off this ledger.
  function invariant_YIELD_5_shareConservation() external view {
    assertEq(
      _vault.totalSupply(),
      _handler.deadShares() + _handler.ghost_sharesMinted() - _handler.ghost_sharesRedeemed(),
      'YIELD-5: total supply diverged from seed + minted - redeemed'
    );
  }
}
