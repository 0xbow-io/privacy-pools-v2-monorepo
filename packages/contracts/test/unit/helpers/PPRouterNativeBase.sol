// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouterBase} from 'test/unit/helpers/PPRouterBase.sol';

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {MockAaveAToken} from 'test/helpers/MockAaveMulti.sol';
import {MockWETH9} from 'test/helpers/MockWETH9.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @title PPRouterNativeBase
/// @notice Extends {PPRouterBase} with a NATIVE-MODE fixture over the same mock Aave pool, entrypoint
/// and pool vault: a {MockWETH9} underlying, its aWETH reserve, a ppETH wrapper (18-dp underlying, so
/// decimals offset 0 — the production ppETH configuration), a zap, and a `NATIVE_MODE = true` router.
/// The ERC-20 fixture from the parent (`usdc`/`vault`/`router`) stays available for cross-mode tests.
contract PPRouterNativeBase is PPRouterBase {
  MockWETH9 internal weth;
  MockAaveAToken internal aWETH;
  PPYieldToken internal vaultEth;
  PPYieldTokenZap internal zapEth;
  PPRouter internal routerEth;

  function setUp() public virtual override {
    super.setUp();

    weth = new MockWETH9();
    aWETH = pool.addReserve(IERC20Metadata(address(weth)), 'Aave WETH', 'aWETH');
    // Vault protocol fee = 0, as in the parent fixture: the only fee under test is the relay/vetting fee.
    vaultEth = new PPYieldToken(IERC20(address(aWETH)), 0, admin, 'Privacy Pool ETH', 'ppETH');
    zapEth = new PPYieldTokenZap(IPPYieldToken(address(vaultEth)), IAavePool(address(pool)), IERC20(address(weth)));
    entrypoint.setAssetConfig(
      address(vaultEth),
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );

    routerEth = new PPRouter(
      IPPYieldToken(address(vaultEth)),
      IAavePool(address(pool)),
      IERC20(address(weth)),
      IEntrypoint(address(entrypoint)),
      ppDust,
      IPPYieldTokenZap(address(zapEth)),
      IPoolVault(address(poolVault)),
      true
    );

    _seedNative(100e18);
  }

  /// @dev Wrap `_amount` of fresh native value into WETH held by this test contract. Never uses the
  ///      inherited `mint` (which would leave the mock's `withdraw` without native backing).
  function _wrap(uint256 _amount) internal {
    vm.deal(address(this), address(this).balance + _amount);
    weth.deposit{value: _amount}();
  }

  /// @dev Seed the ppETH vault with `_ppAmount` shares so supply > 0 and the rate can move. Offset 0:
  ///      one share is one aWETH wei, so the underlying needed equals the share count (fresh = 1:1).
  function _seedNative(uint256 _ppAmount) internal {
    _wrap(_ppAmount);
    weth.approve(address(pool), _ppAmount);
    pool.supply(address(weth), _ppAmount, address(this), 0);
    aWETH.approve(address(vaultEth), _ppAmount);
    vaultEth.deposit(_ppAmount, makeAddr('seedHolder'));
  }

  /// @dev Simulate Aave yield on the ppETH vault: supply fresh WETH as aWETH straight to it.
  function _accrueYieldNative(uint256 _extraWeth) internal {
    _wrap(_extraWeth);
    weth.approve(address(pool), _extraWeth);
    pool.supply(address(weth), _extraWeth, address(vaultEth), 0);
  }

  /// @dev Fund the mock pool vault with `_shares` ppETH shares (representing custodied deposits).
  function _fundPoolVaultNative(uint256 _shares) internal {
    uint256 _aNeeded = vaultEth.previewMint(_shares);
    _wrap(_aNeeded);
    weth.approve(address(pool), _aNeeded);
    pool.supply(address(weth), _aNeeded, address(this), 0);
    aWETH.approve(address(vaultEth), _aNeeded);
    vaultEth.mint(_shares, address(this));
    IERC20(address(vaultEth)).transfer(address(poolVault), _shares);
  }
}

/// @notice A recipient that cannot receive native value — for proving that a native-mode withdrawal
/// to it reverts as a whole instead of stranding funds.
contract RejectingRecipient {}
