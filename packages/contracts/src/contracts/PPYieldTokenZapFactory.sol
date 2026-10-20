// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAToken} from 'interfaces/IAToken.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZapFactory} from 'interfaces/IPPYieldTokenZapFactory.sol';

import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title PPYieldTokenZapFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks one stateless `PPYieldTokenZap` per
/// `PPYieldToken` wrapper, for wrappers whose aToken belongs to a single trusted Aave v3 pool. Kept
/// separate from `PPYieldTokenFactory` so neither factory embeds the other's creation code (each
/// stays well under the contract-size limit) and each has a single responsibility; the deploy script
/// orchestrates the two. Zaps hold no funds, so this factory grants no power over user assets.
/// @dev The underlying is derived from the wrapper's aToken (`UNDERLYING_ASSET_ADDRESS`) and the pool
/// from this factory, so the caller only supplies the wrapper. The `aToken.POOL()` check anchors
/// genuineness; a wrapper lying about `asset()` only yields a useless zap (owner self-harm).
contract PPYieldTokenZapFactory is Ownable, IPPYieldTokenZapFactory {
  /*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZapFactory
  IAavePool public immutable POOL;

  /// @inheritdoc IPPYieldTokenZapFactory
  mapping(address _vault => address _zap) public zapFor;

  /// @dev All zaps in deployment order
  address[] internal _allZaps;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @param _pool The trusted Aave v3 pool whose wrappers may get a zap
  /// @param _owner The factory owner (may deploy zaps)
  constructor(IAavePool _pool, address _owner) Ownable(_owner) {
    require(address(_pool) != address(0), PPYieldTokenZapFactory_ZeroAddress());
    POOL = _pool;
  }

  /*///////////////////////////////////////////////////////////////
                          ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZapFactory
  function createZap(address _vault) external onlyOwner returns (address _zap) {
    address _aToken = IPPYieldToken(_vault).asset();
    require(IAToken(_aToken).POOL() == address(POOL), PPYieldTokenZapFactory_NotAavePoolAToken());
    require(zapFor[_vault] == address(0), PPYieldTokenZapFactory_AlreadyDeployed());
    address _underlying = IAToken(_aToken).UNDERLYING_ASSET_ADDRESS();

    _zap = address(new PPYieldTokenZap(IPPYieldToken(_vault), POOL, IERC20(_underlying)));
    zapFor[_vault] = _zap;
    _allZaps.push(_zap);

    emit ZapCreated(_vault, _zap, _underlying);
  }

  /*///////////////////////////////////////////////////////////////
                          VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZapFactory
  function zapsCount() external view returns (uint256 _count) {
    _count = _allZaps.length;
  }

  /// @inheritdoc IPPYieldTokenZapFactory
  function allZaps(uint256 _i) external view returns (address _zap) {
    _zap = _allZaps[_i];
  }

  /// @notice Ownership is transferable but cannot be renounced, so the owner-gated `createZap` is never bricked
  /// @dev Mirrors the renounce-freeze on {PPYieldToken}; reverts unconditionally
  function renounceOwnership() public view override onlyOwner {
    revert PPYieldTokenZapFactory_RenounceDisabled();
  }
}
