// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';

/// @title IPPYieldTokenZapFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks one `PPYieldTokenZap` per `PPYieldToken`
/// wrapper, for wrappers whose aToken belongs to a single trusted Aave v3 pool. Kept separate from
/// the wrapper factory (single responsibility; neither factory embeds the other's creation code).
/// Zaps are stateless and fund-less, so deployment carries no custody risk.
interface IPPYieldTokenZapFactory {
  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a new zap is deployed
  /// @param _vault The PPYieldToken wrapper the zap routes to
  /// @param _zap The deployed PPYieldTokenZap
  /// @param _underlying The underlying token the zap supplies to Aave
  event ZapCreated(address indexed _vault, address indexed _zap, address indexed _underlying);

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when the pool passed to the constructor is the zero address
  error PPYieldTokenZapFactory_ZeroAddress();

  /// @notice Thrown when the wrapper's aToken does not belong to this factory's trusted Aave pool
  error PPYieldTokenZapFactory_NotAavePoolAToken();

  /// @notice Thrown when a zap already exists for the wrapper
  error PPYieldTokenZapFactory_AlreadyDeployed();

  /// @notice Thrown when renouncing ownership is attempted; the owner is transferable but never renounceable so the deploy function is never bricked
  error PPYieldTokenZapFactory_RenounceDisabled();

  /*///////////////////////////////////////////////////////////////
                            ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deploys a `PPYieldTokenZap` for `_vault` (owner only)
  /// @dev Reverts `PPYieldTokenZapFactory_NotAavePoolAToken` if the wrapper's `asset()` aToken does
  /// not report this factory's pool, and `PPYieldTokenZapFactory_AlreadyDeployed` if a zap exists.
  /// The underlying is derived from the aToken, and the pool from this factory.
  /// @param _vault The PPYieldToken wrapper to build a zap for
  /// @return _zap The deployed zap
  function createZap(address _vault) external returns (address _zap);

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The trusted Aave v3 pool; only wrappers over its aTokens can get a zap here
  /// @return _pool The pool address
  function POOL() external view returns (IAavePool _pool);

  /// @notice The zap deployed for a given wrapper (zero if none)
  /// @param _vault The wrapper
  /// @return _zap The zap address
  function zapFor(address _vault) external view returns (address _zap);

  /// @notice The number of zaps deployed
  /// @return _count The count
  function zapsCount() external view returns (uint256 _count);

  /// @notice The zap at index `_i` in deployment order
  /// @param _i The index
  /// @return _zap The zap address
  function allZaps(uint256 _i) external view returns (address _zap);
}
