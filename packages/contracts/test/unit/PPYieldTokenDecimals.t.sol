// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title UnitPPYieldTokenDecimals
/// @notice The wrapper targets 18-decimal shares for any aToken via offset = 18 - assetDecimals, so
/// the virtual-share inflation buffer is 10**offset (largest for low-decimal assets). See PPYieldTokenDecimals.tree.
contract UnitPPYieldTokenDecimals is Test {
  MockAaveMultiPool internal pool;
  address internal admin = makeAddr('admin');
  uint256 internal constant FEE = 1000;

  function setUp() external {
    pool = new MockAaveMultiPool();
  }

  function _wrap(uint8 _dec) internal returns (PPYieldToken _vault, MockAaveAToken _aToken, MockERC20 _underlying) {
    _underlying = new MockERC20('Token', 'TKN', _dec);
    _aToken = pool.addReserve(IERC20Metadata(address(_underlying)), 'aToken', 'aTKN');
    _vault = new PPYieldToken(IERC20(address(_aToken)), FEE, admin, 'Privacy Pool Token', 'ppTKN');
  }

  function _giveAToken(MockERC20 _u, address _who, uint256 _amt) internal {
    _u.mint(_who, _amt);
    vm.startPrank(_who);
    _u.approve(address(pool), _amt);
    pool.supply(address(_u), _amt, _who, 0);
    vm.stopPrank();
  }

  function test_Decimals_Are18_For6dpAsset() external {
    (PPYieldToken _v,,) = _wrap(6);
    assertEq(_v.decimals(), 18);
  }

  function test_Decimals_Are18_For8dpAsset() external {
    (PPYieldToken _v,,) = _wrap(8);
    assertEq(_v.decimals(), 18);
  }

  function test_Decimals_Are18_For18dpAsset() external {
    (PPYieldToken _v,,) = _wrap(18);
    assertEq(_v.decimals(), 18);
  }

  function test_Offset_FirstDepositScalesByOffset_6dp() external {
    (PPYieldToken _v, MockAaveAToken _a, MockERC20 _u) = _wrap(6);
    _giveAToken(_u, address(this), 1e6);
    _a.approve(address(_v), 1e6);
    // offset 12: 1 token (1e6) -> 1e18 shares
    assertEq(_v.deposit(1e6, address(this)), 1e6 * 1e12);
  }

  function test_Offset_FirstDepositScalesByOffset_8dp() external {
    (PPYieldToken _v, MockAaveAToken _a, MockERC20 _u) = _wrap(8);
    _giveAToken(_u, address(this), 1e8);
    _a.approve(address(_v), 1e8);
    // offset 10: 1 token (1e8) -> 1e18 shares
    assertEq(_v.deposit(1e8, address(this)), 1e8 * 1e10);
  }

  function test_Offset_FirstDepositScalesByOffset_18dp() external {
    (PPYieldToken _v, MockAaveAToken _a, MockERC20 _u) = _wrap(18);
    _giveAToken(_u, address(this), 1e18);
    _a.approve(address(_v), 1e18);
    // offset 0: 1 token (1e18) -> 1e18 shares (1:1)
    assertEq(_v.deposit(1e18, address(this)), 1e18);
  }

  function test_Offset_RoundTripWithYieldAndFee_8dp() external {
    // 8-dp asset (offset 10): exercise the full deposit -> yield -> fee -> redeem path through a
    // scaled offset, not just the first-deposit share count (catches a redeem-leg rounding bug).
    (PPYieldToken _v, MockAaveAToken _a, MockERC20 _u) = _wrap(8);
    uint256 _dep = 100e8;
    _giveAToken(_u, address(this), _dep);
    _a.approve(address(_v), _dep);
    uint256 _shares = _v.deposit(_dep, address(this));

    // simulate 10-token yield by supplying aTokens straight to the vault
    uint256 _yield = 10e8;
    _u.mint(address(this), _yield);
    _u.approve(address(pool), _yield);
    pool.supply(address(_u), _yield, address(_v), 0);

    // redeem everything: holder gets principal + 90% of yield (10% fee), protocol keeps 10%
    uint256 _out = _v.redeem(_shares, address(this), address(this));
    assertApproxEqAbs(_out, _dep + (_yield * 9000) / 10_000, 1e4, 'holder gets principal + net yield');
    assertApproxEqAbs(_v.claimableFees(), (_yield * 1000) / 10_000, 1e4, 'protocol keeps the fee');
  }

  function test_Constructor_RevertsWhenAssetDecimalsExceed18() external {
    MockERC20 _u = new MockERC20('Big', 'BIG', 19);
    MockAaveAToken _a = pool.addReserve(IERC20Metadata(address(_u)), 'aBig', 'aBIG');
    // It should revert with PPYieldToken_UnsupportedDecimals
    vm.expectRevert(IPPYieldToken.PPYieldToken_UnsupportedDecimals.selector);
    new PPYieldToken(IERC20(address(_a)), FEE, admin, 'Privacy Pool Big', 'ppBIG');
  }
}
