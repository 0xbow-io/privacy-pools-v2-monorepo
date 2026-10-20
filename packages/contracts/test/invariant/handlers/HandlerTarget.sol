// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';

import {HandlerCommon} from './HandlerCommon.sol';
import {HandlerSkew} from './HandlerSkew.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';

/// @dev `HandlerSkew` folds deposit, ragequit, transact, and skew aliases into one target contract.
contract HandlerTarget is HandlerSkew {
  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  constructor(
    IEntrypoint _entrypoint_,
    IPoolVault _poolVault_,
    IPrivacyPoolRelay _relay_,
    IASPRegistry _aspRegistry_,
    IKeystore _keystore_,
    IAccessControl _accessRouter_,
    address _postman_,
    address _pauser_,
    address _unpauser_,
    address _entrypointManager_,
    address[] memory _assets_
  )
    HandlerCommon(
      _entrypoint_,
      _poolVault_,
      _relay_,
      _aspRegistry_,
      _keystore_,
      _accessRouter_,
      _postman_,
      _pauser_,
      _unpauser_,
      _entrypointManager_,
      _assets_
    )
  {}

  /*///////////////////////////////////////////////////////////////
                        HANDLER FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fuzz target: pause the PoolVault
  function handler_pause() external {
    vm.assume(!_poolVault.paused());
    vm.prank(_pauser);
    _poolVault.pause();
  }

  /// @dev Fuzz target: unpause the PoolVault
  function handler_unpause() external {
    vm.assume(_poolVault.paused());
    vm.prank(_unpauser);
    _poolVault.unpause();
  }

  /// @dev Fuzz target: sweep accumulated fees of a chosen asset from the Entrypoint to a registered actor.
  function handler_unguided_sweep(uint256 _recipientSeed, uint256 _assetSeed) external {
    address _asset = _pickAsset(_assetSeed);
    uint256 _amount = _balanceOf(_asset, address(_entrypoint));
    vm.assume(_amount > 0);
    address _recipient = _getActor(_recipientSeed).addr;

    vm.prank(_entrypointManager);
    _entrypoint.sweep(_asset, _recipient);

    ghost_feeSwept[_asset] += _amount;
    ghost_sweptTo[_asset][_recipient] += _amount;
  }
}
