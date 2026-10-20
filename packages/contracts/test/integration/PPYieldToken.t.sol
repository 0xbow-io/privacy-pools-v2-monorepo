// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockAavePool, MockRebasingAToken} from 'test/integration/helpers/MockAavePool.sol';

/// @title IntegrationPPYieldToken
/// @notice End-to-end tests against a local high-fidelity Aave mock: USDC -> aUSDC (rebasing) ->
/// ppUSDC, with borrower-driven, time-warped yield. Verifies the wrapper's yield accounting across
/// multiple users, ppUSDC transfers, fee claims, and a full USDC round-trip. See PPYieldToken.tree.
contract IntegrationPPYieldToken is Test {
  MockERC20 internal usdc; // plain 6-decimal ERC-20 standing in for USDC
  MockAavePool internal pool;
  MockRebasingAToken internal aUSDC;
  PPYieldToken internal vault;

  uint256 internal constant FEE = 1000; // 10%
  uint256 internal constant BPS = 10_000;
  uint256 internal constant ONE = 1e6;
  uint256 internal constant RATE_10PCT = 0.1e27; // 10% APR (ray)

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');
  address internal borrower = makeAddr('borrower');

  function setUp() public {
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    pool = new MockAavePool(IERC20(address(usdc)), 'Aave USDC', 'aUSDC', 6);
    aUSDC = pool.A_TOKEN();
    vault = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
  }

  /*///////////////////////////////////////////////////////////////
                            HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Mint USDC to a user and supply it to Aave, returning the aUSDC received
  function _supply(address _user, uint256 _amount) internal {
    usdc.mint(_user, _amount);
    vm.startPrank(_user);
    usdc.approve(address(pool), _amount);
    pool.supply(address(usdc), _amount, _user, 0);
    vm.stopPrank();
  }

  /// @notice Wrap a user's aUSDC into ppUSDC
  function _wrap(address _user, uint256 _aAmount) internal returns (uint256 _shares) {
    vm.startPrank(_user);
    aUSDC.approve(address(vault), _aAmount);
    _shares = vault.deposit(_aAmount, _user);
    vm.stopPrank();
  }

  /// @notice Supply then wrap in one step
  function _supplyAndWrap(address _user, uint256 _amount) internal returns (uint256 _shares) {
    _supply(_user, _amount);
    _shares = _wrap(_user, aUSDC.balanceOf(_user));
  }

  /// @notice Have the borrower draw USDC from the pool to create utilization, at a given rate
  function _createUtilization(uint256 _borrowAmount, uint256 _rateRay) internal {
    pool.setBorrowRate(_rateRay);
    vm.prank(borrower);
    pool.borrow(address(usdc), _borrowAmount, borrower);
  }

  function _fee(uint256 _delta) internal pure returns (uint256) {
    return (_delta * FEE) / BPS;
  }

  /*///////////////////////////////////////////////////////////////
                          singleUserYield
  ///////////////////////////////////////////////////////////////*/

  function test_SingleUserYield() public {
    _supplyAndWrap(alice, 100 * ONE); // alice: 100 aUSDC -> ppUSDC; pool holds 100 USDC
    _createUtilization(50 * ONE, RATE_10PCT); // 50% utilization @ 10% APR -> 5% supply APR

    vm.warp(block.timestamp + 365 days);

    // vault aUSDC grew ~5% on 100 -> 105; delta 5, fee 0.5, net to holder 4.5
    assertApproxEqAbs(aUSDC.balanceOf(address(vault)), 105 * ONE, 100);
    assertApproxEqAbs(vault.claimableFees(), _fee(5 * ONE), 100);

    uint256 _shares = vault.balanceOf(alice);
    vm.prank(alice);
    uint256 _out = vault.redeem(_shares, alice, alice);

    assertApproxEqAbs(_out, 100 * ONE + (5 * ONE - _fee(5 * ONE)), 100); // principal + 90% of yield
    assertApproxEqAbs(aUSDC.balanceOf(address(vault)), _fee(5 * ONE), 100); // fee remains
  }

  /*///////////////////////////////////////////////////////////////
                          twoUsersProRata
  ///////////////////////////////////////////////////////////////*/

  function test_TwoUsers_EqualDeposit_SplitYieldEqually() public {
    _supplyAndWrap(alice, 100 * ONE);
    _supplyAndWrap(bob, 100 * ONE);
    _createUtilization(100 * ONE, RATE_10PCT); // util 50% on 200 supplied

    vm.warp(block.timestamp + 365 days);

    uint256 _aShares = vault.balanceOf(alice);
    uint256 _bShares = vault.balanceOf(bob);
    vm.prank(alice);
    uint256 _aliceOut = vault.redeem(_aShares, alice, alice);
    vm.prank(bob);
    uint256 _bobOut = vault.redeem(_bShares, bob, bob);

    // symmetric depositors at the same time get equal payouts
    assertApproxEqAbs(_aliceOut, _bobOut, 2);
    // conservation: both payouts + remaining fee == everything the vault held
    assertApproxEqAbs(_aliceOut + _bobOut + aUSDC.balanceOf(address(vault)), 210 * ONE, 100);
  }

  /*///////////////////////////////////////////////////////////////
                          depositAfterYield
  ///////////////////////////////////////////////////////////////*/

  function test_DepositAfterYield_NoYieldCapture() public {
    _supplyAndWrap(alice, 100 * ONE);
    _createUtilization(50 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 365 days); // alice's stake earns ~5

    // bob now deposits 100 aUSDC at the elevated rate -> fewer shares than alice got at 1:1
    uint256 _bobShares = _supplyAndWrap(bob, 100 * ONE);
    assertLt(_bobShares, vault.balanceOf(alice));

    // immediately (no further yield) bob redeems ~ his 100 back, not alice's prior yield
    vm.prank(bob);
    uint256 _bobOut = vault.redeem(_bobShares, bob, bob);
    assertApproxEqAbs(_bobOut, 100 * ONE, 100);

    // alice still holds her ~104.5 of net value
    assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(alice)), 100 * ONE + (5 * ONE - _fee(5 * ONE)), 200);
  }

  /*///////////////////////////////////////////////////////////////
                          transferCarriesYieldClaim
  ///////////////////////////////////////////////////////////////*/

  function test_TransferCarriesYieldClaim() public {
    uint256 _shares = _supplyAndWrap(alice, 100 * ONE);
    _createUtilization(50 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 365 days);

    // alice sends half her ppUSDC to bob; the yield claim travels with the token
    vm.prank(alice);
    vault.transfer(bob, _shares / 2);

    vm.warp(block.timestamp + 365 days); // more yield, now shared equally

    uint256 _aShares = vault.balanceOf(alice);
    uint256 _bShares = vault.balanceOf(bob);
    vm.prank(alice);
    uint256 _aliceOut = vault.redeem(_aShares, alice, alice);
    vm.prank(bob);
    uint256 _bobOut = vault.redeem(_bShares, bob, bob);

    // equal share holdings since the transfer -> equal final payouts
    assertApproxEqAbs(_aliceOut, _bobOut, 2);
    assertGt(_bobOut, 0);
  }

  /*///////////////////////////////////////////////////////////////
                          claimFeesDuringActivity
  ///////////////////////////////////////////////////////////////*/

  function test_ClaimFees_PreservesRate_AndPaysProtocol() public {
    _supplyAndWrap(alice, 100 * ONE);
    _createUtilization(50 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 365 days);

    // checkpoint the fee with a small second deposit
    _supplyAndWrap(bob, 1 * ONE);

    uint256 _rateBefore = vault.exchangeRate();
    uint256 _feeBefore = vault.accumulatedFees();
    assertGt(_feeBefore, 0);

    vm.prank(admin);
    uint256 _claimed = vault.claimFees();

    assertEq(_claimed, _feeBefore);
    // claim does not move the rate (within 1 wei of rebasing-aToken scaled rounding in the mock)
    assertApproxEqAbs(vault.exchangeRate(), _rateBefore, 2);
    assertEq(aUSDC.balanceOf(admin), _claimed);
    assertEq(vault.accumulatedFees(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          fullExitSolvency
  ///////////////////////////////////////////////////////////////*/

  function test_FullExitSolvency() public {
    _supplyAndWrap(alice, 100 * ONE);
    _supplyAndWrap(bob, 50 * ONE);
    _createUtilization(75 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 200 days);

    uint256 _aShares = vault.balanceOf(alice);
    uint256 _bShares = vault.balanceOf(bob);
    vm.prank(alice);
    vault.redeem(_aShares, alice, alice);
    vm.prank(bob);
    vault.redeem(_bShares, bob, bob);

    assertEq(vault.totalSupply(), 0);

    vm.prank(admin);
    vault.claimFees();

    // everything is drained to dust; protocol fee swept
    assertApproxEqAbs(aUSDC.balanceOf(address(vault)), 0, 10);
    assertEq(vault.accumulatedFees(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          noLeakProperty (USDC round-trip)
  ///////////////////////////////////////////////////////////////*/

  function test_EndToEnd_USDCRoundTrip_WithBorrowRepay() public {
    // alice: USDC -> aUSDC -> ppUSDC
    _supply(alice, 100 * ONE);
    uint256 _shares = _wrap(alice, aUSDC.balanceOf(alice));

    _createUtilization(50 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 365 days);

    // borrower repays principal + interest, restoring pool liquidity for a USDC exit
    uint256 _debt = pool.totalDebt();
    usdc.mint(borrower, _debt); // borrower funds the interest portion
    vm.startPrank(borrower);
    usdc.approve(address(pool), _debt);
    pool.repay(address(usdc), _debt, borrower);
    vm.stopPrank();

    // alice's ppUSDC balance never changed while held (no duration leak), then she unwraps
    assertEq(vault.balanceOf(alice), _shares);
    vm.startPrank(alice);
    uint256 _aOut = vault.redeem(_shares, alice, alice); // ppUSDC -> aUSDC
    uint256 _usdcOut = pool.withdraw(address(usdc), _aOut, alice); // aUSDC -> USDC
    vm.stopPrank();

    // yield realized in USDC at unwrap: principal + 90% of the 5 USDC yield
    assertApproxEqAbs(_usdcOut, 100 * ONE + (5 * ONE - _fee(5 * ONE)), 1000);
    assertEq(vault.balanceOf(alice), 0);
  }

  /*///////////////////////////////////////////////////////////////
                  shield -> pool -> recipient unshield
  ///////////////////////////////////////////////////////////////*/

  /// @notice The privacy-pool use case: a depositor shields ppUSDC, yield accrues while the pool
  /// holds it, and a DIFFERENT recipient unshields the same amount and collects the yield on unwrap.
  /// The actual V2 pool isn't in this repo (ppUSDC is just an accepted ERC-20), so the pool is
  /// modelled as a holding address. The point: yield rides the (non-rebasing) ppUSDC to whoever
  /// holds it at unwrap, and the shielded amount equals the unshielded amount (no duration signal).
  function test_ShieldThenRecipientUnshieldsAndGetsYield() public {
    address _pool = makeAddr('privacyPool');

    // alice wraps and shields the full amount into the pool
    uint256 _shares = _supplyAndWrap(alice, 100 * ONE);
    vm.prank(alice);
    vault.transfer(_pool, _shares);
    assertEq(vault.balanceOf(_pool), _shares);

    // yield accrues for a year while the pool holds the ppUSDC
    _createUtilization(50 * ONE, RATE_10PCT);
    vm.warp(block.timestamp + 365 days);

    // the pool's ppUSDC balance is unchanged (non-rebasing -> no shielding-duration leak)
    assertEq(vault.balanceOf(_pool), _shares);

    // recipient bob unshields the SAME amount, then unwraps
    vm.prank(_pool);
    vault.transfer(bob, _shares);
    assertEq(vault.balanceOf(bob), _shares); // shielded amount == unshielded amount

    vm.prank(bob);
    uint256 _out = vault.redeem(_shares, bob, bob);

    // bob never deposited, yet collects principal + (1 - fee) * yield; the protocol fee remains
    assertApproxEqAbs(_out, 100 * ONE + (5 * ONE - _fee(5 * ONE)), 100);
    assertApproxEqAbs(aUSDC.balanceOf(address(vault)), _fee(5 * ONE), 100);
    assertEq(vault.balanceOf(bob), 0);
  }
}
