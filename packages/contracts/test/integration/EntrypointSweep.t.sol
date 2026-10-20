// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {_calcFee} from 'test/handlers/HandlerBase.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for Entrypoint.sweep() — real deposits accumulate fees, then sweep them out
/// @dev Generates deposit proofs at runtime via FFI calls to test/helper/DepositProofGenerator.mjs
contract EntrypointSweepIntegration is IntegrationBase {
  /*///////////////////////////////////////////////////////////////
                          SWEEP TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits ERC20 → fees accumulate → entrypoint manager sweeps ERC20 fees
  function test_sweep_happyPath_erc20() external {
    _sweepFlow(address(_token), SAMPLE_VALUE);
  }

  /// @notice Alice deposits ETH → fees accumulate → entrypoint manager sweeps native ETH fees
  function test_sweep_happyPath_eth() external {
    _sweepFlow(Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  /// @notice Alice and Bob each deposit ERC20 → entrypoint manager sweeps all accumulated fees
  function test_sweep_multipleDeposits_erc20() external {
    _multiDepositSweepFlow(address(_token), SAMPLE_VALUE);
  }

  /// @notice Alice and Bob each deposit ETH → entrypoint manager sweeps all accumulated ETH fees
  function test_sweep_multipleDeposits_eth() external {
    _multiDepositSweepFlow(Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  /// @notice Alice deposits ERC20, Bob deposits ETH → entrypoint manager sweeps each asset independently
  function test_sweep_mixedAssets() external {
    _deposit(alice, address(_token), SAMPLE_VALUE);
    _deposit(bob, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    uint256 expectedTokenFee = _calcFee(address(_token), SAMPLE_VALUE);
    uint256 expectedEthFee = _calcFee(Constants.NATIVE_ASSET, SAMPLE_VALUE);
    uint256 charlieEthBefore = charlie.addr.balance;

    assertEq(_balanceOf(address(_token), address(_entrypoint)), expectedTokenFee, 'Entrypoint should hold ERC20 fee');
    assertEq(address(_entrypoint).balance, expectedEthFee, 'Entrypoint should hold ETH fee');

    vm.prank(_config.entrypointManager);
    _entrypoint.sweep(address(_token), charlie.addr);

    vm.prank(_config.entrypointManager);
    _entrypoint.sweep(Constants.NATIVE_ASSET, charlie.addr);

    assertEq(_balanceOf(address(_token), address(_entrypoint)), 0, 'Entrypoint ERC20 balance should be zero');
    assertEq(address(_entrypoint).balance, 0, 'Entrypoint ETH balance should be zero');
    assertEq(_balanceOf(address(_token), charlie.addr), expectedTokenFee, 'Charlie should receive ERC20 fee');
    assertEq(charlie.addr.balance, charlieEthBefore + expectedEthFee, 'Charlie should receive ETH fee');
  }

  /// @notice Entrypoint manager sweeps an asset with zero balance — should succeed with amount=0
  function test_sweep_zeroBalance() external {
    assertEq(_balanceOf(address(_token), address(_entrypoint)), 0, 'Entrypoint should start empty');

    vm.expectEmit();
    emit IEntrypoint.Swept(address(_token), charlie.addr, 0);

    vm.prank(_config.entrypointManager);
    _entrypoint.sweep(address(_token), charlie.addr);

    assertEq(_balanceOf(address(_token), charlie.addr), 0, 'Recipient should receive nothing');
  }

  /// @notice A random caller without ENTRYPOINT_MANAGER_ROLE cannot sweep
  function test_sweep_revertsWhenUnauthorized() external {
    _deposit(alice, address(_token), SAMPLE_VALUE);

    vm.prank(alice.addr);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    _entrypoint.sweep(address(_token), charlie.addr);
  }

  /*///////////////////////////////////////////////////////////////
                    FORK-GATED SWEEP TESTS
  ///////////////////////////////////////////////////////////////*/

  function test_fork_sweep_usdc() external {
    _sweepFlow(_usdc, SAMPLE_VALUE);
  }

  function test_fork_sweep_usdt() external {
    _sweepFlow(_usdt, SAMPLE_VALUE);
  }

  function test_fork_sweep_eth() external {
    _sweepFlow(Constants.NATIVE_ASSET, 1 ether);
  }

  function test_fork_sweep_multipleDeposits_usdc() external {
    _multiDepositSweepFlow(_usdc, SAMPLE_VALUE);
  }

  function test_fork_sweep_multipleDeposits_usdt() external {
    _multiDepositSweepFlow(_usdt, SAMPLE_VALUE);
  }

  function test_fork_sweep_multipleDeposits_eth() external {
    _multiDepositSweepFlow(Constants.NATIVE_ASSET, 1 ether);
  }

  /*///////////////////////////////////////////////////////////////
                      SHARED FLOW HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Single deposit → sweep flow, parameterized for fork tests
  function _sweepFlow(address _tokenAddr, uint256 _value) internal {
    _deposit(alice, _tokenAddr, _value);

    uint256 expectedFee = _calcFee(_tokenAddr, _value);
    uint256 charlieBalanceBefore = _balanceOf(_tokenAddr, charlie.addr);

    assertEq(_balanceOf(_tokenAddr, address(_entrypoint)), expectedFee, 'Entrypoint should hold vetting fee');

    vm.expectEmit();
    emit IEntrypoint.Swept(_tokenAddr, charlie.addr, expectedFee);

    vm.prank(_config.entrypointManager);
    _entrypoint.sweep(_tokenAddr, charlie.addr);

    assertEq(_balanceOf(_tokenAddr, address(_entrypoint)), 0, 'Entrypoint should be empty after sweep');
    assertEq(
      _balanceOf(_tokenAddr, charlie.addr), charlieBalanceBefore + expectedFee, 'Recipient should receive swept fees'
    );
  }

  /// @dev Two deposits → sweep flow, parameterized for fork tests
  function _multiDepositSweepFlow(address _tokenAddr, uint256 _value) internal {
    _deposit(alice, _tokenAddr, _value);
    _deposit(bob, _tokenAddr, _value);

    uint256 totalFees = _calcFee(_tokenAddr, _value) * 2;
    uint256 charlieBalanceBefore = _balanceOf(_tokenAddr, charlie.addr);

    assertEq(_balanceOf(_tokenAddr, address(_entrypoint)), totalFees, 'Entrypoint should hold both fees');

    vm.expectEmit();
    emit IEntrypoint.Swept(_tokenAddr, charlie.addr, totalFees);

    vm.prank(_config.entrypointManager);
    _entrypoint.sweep(_tokenAddr, charlie.addr);

    assertEq(_balanceOf(_tokenAddr, address(_entrypoint)), 0, 'Entrypoint should be empty after sweep');
    assertEq(
      _balanceOf(_tokenAddr, charlie.addr), charlieBalanceBefore + totalFees, 'Recipient should receive all swept fees'
    );
  }
}
