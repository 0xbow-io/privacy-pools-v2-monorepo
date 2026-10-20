// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockAavePool, MockRebasingAToken} from 'test/integration/helpers/MockAavePool.sol';

/// @title IntegrationPPYieldTokenZap
/// @notice Tests the USDC <-> ppUSDC router against the local Aave mock. See PPYieldTokenZap.tree.
contract IntegrationPPYieldTokenZap is Test {
  MockERC20 internal usdc;
  MockAavePool internal pool;
  MockRebasingAToken internal aUSDC;
  PPYieldToken internal vault;
  PPYieldTokenZap internal zap;

  uint256 internal constant FEE = 1000; // 10%
  uint256 internal constant BPS = 10_000;
  uint256 internal constant ONE = 1e6;
  uint256 internal constant OFFSET = 1e12; // 10 ** _decimalsOffset()
  uint256 internal constant RATE_10PCT = 0.1e27;

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');
  address internal borrower = makeAddr('borrower');

  function setUp() public {
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    pool = new MockAavePool(IERC20(address(usdc)), 'Aave USDC', 'aUSDC', 6);
    aUSDC = pool.A_TOKEN();
    vault = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    zap = new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(pool)), IERC20(address(usdc)));
  }

  function _fee(uint256 _delta) internal pure returns (uint256) {
    return (_delta * FEE) / BPS;
  }

  /*///////////////////////////////////////////////////////////////
                          constructor
  ///////////////////////////////////////////////////////////////*/

  function test_Constructor_WhenTheVaultIsTheZeroAddress() external {
    // It should revert with PPYieldTokenZap_ZeroAddress
    vm.expectRevert();
    new PPYieldTokenZap(IPPYieldToken(address(0)), IAavePool(address(pool)), IERC20(address(usdc)));
  }

  function test_Constructor_WhenThePoolIsTheZeroAddress() external {
    // It should revert with PPYieldTokenZap_ZeroAddress
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAddress.selector);
    new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(0)), IERC20(address(usdc)));
  }

  function test_Constructor_WhenTheUSDCIsTheZeroAddress() external {
    // It should revert with PPYieldTokenZap_ZeroAddress
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAddress.selector);
    new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(pool)), IERC20(address(0)));
  }

  function test_Constructor_WhenCalledWithValidParameters() external view {
    // It sets VAULT, POOL, USDC and infers A_USDC from vault.asset()
    assertEq(address(zap.VAULT()), address(vault));
    assertEq(address(zap.POOL()), address(pool));
    assertEq(address(zap.UNDERLYING()), address(usdc));
    assertEq(address(zap.A_TOKEN()), address(aUSDC));
  }

  /*///////////////////////////////////////////////////////////////
                          depositUnderlying
  ///////////////////////////////////////////////////////////////*/

  function test_DepositUSDC_WhenTheAmountIsZero() external {
    // It should revert with PPYieldTokenZap_ZeroAmount
    vm.prank(alice);
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAmount.selector);
    zap.depositUnderlying(0, alice);
  }

  function test_DepositUSDC_WhenCalledWithAValidAmount() external {
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);

    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    // It emits ZappedIn (indexed sender/receiver; amounts checked via the assertions below)
    vm.expectEmit(true, true, false, false, address(zap));
    emit IPPYieldTokenZap.ZappedIn(alice, alice, _amount, 0);
    uint256 _shares = zap.depositUnderlying(_amount, alice);
    vm.stopPrank();

    // It pulls USDC, wraps to ppUSDC for the receiver, and returns the shares
    assertEq(_shares, vault.balanceOf(alice));
    assertGt(_shares, 0);
    assertEq(usdc.balanceOf(alice), 0);
    // It holds no USDC or aUSDC afterwards (stateless)
    assertEq(usdc.balanceOf(address(zap)), 0);
    assertEq(aUSDC.balanceOf(address(zap)), 0);
    assertEq(vault.balanceOf(address(zap)), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          redeemToUnderlying
  ///////////////////////////////////////////////////////////////*/

  function test_RedeemToUSDC_WhenTheSharesIsZero() external {
    // It should revert with PPYieldTokenZap_ZeroAmount
    vm.prank(alice);
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAmount.selector);
    zap.redeemToUnderlying(0, alice);
  }

  function test_RedeemToUSDC_WhenCalledWithValidShares() external {
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);
    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, alice);

    // redeem straight back (no yield) -> ~100 USDC
    vault.approve(address(zap), _shares);
    // It emits ZappedOut (indexed sender/receiver; amounts checked via the assertions below)
    vm.expectEmit(true, true, false, false, address(zap));
    emit IPPYieldTokenZap.ZappedOut(alice, alice, _shares, 0);
    uint256 _usdcOut = zap.redeemToUnderlying(_shares, alice);
    vm.stopPrank();

    // It returns USDC to the receiver and holds nothing afterwards
    assertApproxEqAbs(_usdcOut, _amount, 2);
    assertApproxEqAbs(usdc.balanceOf(alice), _amount, 2);
    assertEq(vault.balanceOf(alice), 0);
    assertEq(aUSDC.balanceOf(address(zap)), 0);
    assertEq(vault.balanceOf(address(zap)), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          roundTrip
  ///////////////////////////////////////////////////////////////*/

  function test_RoundTrip_GivenYieldAccruesBetweenDepositAndRedeem() external {
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);

    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, alice);
    vm.stopPrank();

    // alice's zap deposit already seeded the pool with 100 USDC; a 50 borrow -> 50% util @ 10% APR
    pool.setBorrowRate(RATE_10PCT);
    vm.prank(borrower);
    pool.borrow(address(usdc), 50 * ONE, borrower);
    vm.warp(block.timestamp + 365 days);

    // borrower repays so the pool can satisfy the USDC withdrawal
    uint256 _debt = pool.totalDebt();
    usdc.mint(borrower, _debt);
    vm.startPrank(borrower);
    usdc.approve(address(pool), _debt);
    pool.repay(address(usdc), _debt, borrower);
    vm.stopPrank();

    vm.startPrank(alice);
    vault.approve(address(zap), _shares);
    uint256 _usdcOut = zap.redeemToUnderlying(_shares, alice);
    vm.stopPrank();

    // 5% supply yield on 100 = 5; principal + 90% of yield = 104.5 USDC
    assertApproxEqAbs(_usdcOut, 100 * ONE + (5 * ONE - _fee(5 * ONE)), 1000);
  }

  /*///////////////////////////////////////////////////////////////
                    donation griefing (C-7 balance-delta)
  ///////////////////////////////////////////////////////////////*/

  function test_DepositUSDC_IgnoresPriorAUSDCDust_NoGriefing() external {
    // C-7: a griefer donates aUSDC to the (stateless) zap beforehand.
    uint256 _dust = 5 * ONE;
    usdc.mint(address(this), _dust);
    usdc.approve(address(pool), _dust);
    pool.supply(address(usdc), _dust, address(this), 0);
    aUSDC.transfer(address(zap), aUSDC.balanceOf(address(this)));

    // alice deposits 100 USDC; the zap credits ONLY the aUSDC this supply produced (balance delta).
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);
    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, alice);
    vm.stopPrank();

    // alice is credited for her 100 USDC only (~100 * offset), NOT the 105 the zap transiently held.
    assertApproxEqAbs(_shares, 100 * ONE * OFFSET, OFFSET);
    assertEq(vault.balanceOf(alice), _shares);
    // the donated dust stays stranded in the zap (not swept into alice's shares).
    assertApproxEqAbs(aUSDC.balanceOf(address(zap)), _dust, 2);
  }

  function test_RedeemToUnderlying_IgnoresPriorAUSDCDust_NoGriefing() external {
    // alice gets a position
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);
    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, alice);
    vm.stopPrank();

    // C-7: a griefer donates aUSDC to the zap before the redeem.
    uint256 _dust = 5 * ONE;
    usdc.mint(address(this), _dust);
    usdc.approve(address(pool), _dust);
    pool.supply(address(usdc), _dust, address(this), 0);
    aUSDC.transfer(address(zap), aUSDC.balanceOf(address(this)));

    // alice redeems to bob: the zap withdraws ONLY the aUSDC this redeem produced (balance delta).
    vm.startPrank(alice);
    vault.approve(address(zap), _shares);
    zap.redeemToUnderlying(_shares, bob);
    vm.stopPrank();

    // bob receives alice's position (~100 USDC) only, NOT 105 including the donation.
    assertApproxEqAbs(usdc.balanceOf(bob), 100 * ONE, 100);
    // the donated dust stays stranded in the zap.
    assertApproxEqAbs(aUSDC.balanceOf(address(zap)), _dust, 2);
  }

  /*///////////////////////////////////////////////////////////////
                          receiver != caller
  ///////////////////////////////////////////////////////////////*/

  function test_DepositUnderlying_CreditsTheReceiverNotTheCaller() external {
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);
    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, bob);
    vm.stopPrank();

    // bob (the receiver) gets the shares; alice (the caller) gets none; the zap holds nothing
    assertEq(vault.balanceOf(bob), _shares);
    assertGt(_shares, 0);
    assertEq(vault.balanceOf(alice), 0);
    assertEq(usdc.balanceOf(address(zap)), 0);
    assertEq(aUSDC.balanceOf(address(zap)), 0);
    assertEq(vault.balanceOf(address(zap)), 0);
  }

  function test_RedeemToUnderlying_SendsToReceiverAndHoldsNothing() external {
    uint256 _amount = 100 * ONE;
    usdc.mint(alice, _amount);
    vm.startPrank(alice);
    usdc.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, alice);

    // alice redeems to bob (the receiver)
    vault.approve(address(zap), _shares);
    uint256 _out = zap.redeemToUnderlying(_shares, bob);
    vm.stopPrank();

    // bob gets the USDC; the zap is left holding no USDC, aUSDC, or shares
    assertApproxEqAbs(usdc.balanceOf(bob), _amount, 2);
    assertEq(usdc.balanceOf(bob), _out);
    assertEq(usdc.balanceOf(address(zap)), 0);
    assertEq(aUSDC.balanceOf(address(zap)), 0);
    assertEq(vault.balanceOf(address(zap)), 0);
  }
}
