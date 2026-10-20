// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';

/// @title IPPYieldTokenFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks `PPYieldToken` wrappers, one per Aave v3
/// aToken of a single trusted pool. Each wrapper is seeded with permanently-locked "dead shares" at
/// creation so it is never empty, neutralizing the ERC-4626 first-depositor inflation attack
/// regardless of the asset's decimals offset. Aave aTokens are trusted and have no transfer hooks.
interface IPPYieldTokenFactory {
  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a new wrapper is deployed
  /// @param _underlying The underlying ERC-20 (e.g. USDC)
  /// @param _aToken The Aave aToken being wrapped (e.g. aUSDC)
  /// @param _wrapper The deployed PPYieldToken
  /// @param _admin The wrapper's initial admin
  event WrapperCreated(address indexed _underlying, address indexed _aToken, address indexed _wrapper, address _admin);

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when the pool passed to the constructor is the zero address
  error PPYieldTokenFactory_ZeroAddress();

  /// @notice Thrown when the aToken does not belong to this factory's trusted Aave pool
  error PPYieldTokenFactory_NotAavePoolAToken();

  /// @notice Thrown when a wrapper already exists for the aToken
  error PPYieldTokenFactory_AlreadyDeployed();

  /// @notice Thrown when the seed amount is zero (a non-zero seed is required to lock dead shares)
  error PPYieldTokenFactory_ZeroSeed();

  /// @notice Thrown when renouncing ownership is attempted; the owner is transferable but never renounceable so the deploy function is never bricked
  error PPYieldTokenFactory_RenounceDisabled();

  /*///////////////////////////////////////////////////////////////
                            ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deploys a `PPYieldToken` wrapper for `_aToken` and seeds locked dead shares (owner only)
  /// @dev Reverts `PPYieldTokenFactory_NotAavePoolAToken` if `_aToken.POOL()` is not this factory's pool, and
  /// `PPYieldTokenFactory_AlreadyDeployed` if a wrapper already exists. Pulls `_seedAssets` of the underlying
  /// from the caller, supplies it to Aave for aTokens, and deposits them into the new wrapper to a
  /// burn address (locked forever). The caller must approve this factory for `_seedAssets` first.
  /// @param _aToken The Aave aToken to wrap
  /// @param _feeBps The wrapper's initial protocol fee (<= MAX_FEE_BPS)
  /// @param _admin The wrapper's initial admin
  /// @param _name The wrapper's ERC-20 name
  /// @param _symbol The wrapper's ERC-20 symbol
  /// @param _seedAssets The amount of underlying to lock as dead shares (non-zero)
  /// @return _wrapper The deployed wrapper
  function createWrapper(
    address _aToken,
    uint256 _feeBps,
    address _admin,
    string calldata _name,
    string calldata _symbol,
    uint256 _seedAssets
  ) external returns (address _wrapper);

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The trusted Aave v3 pool; only its aTokens can be wrapped
  /// @return _pool The pool address
  function POOL() external view returns (IAavePool _pool);

  /// @notice The wrapper deployed for a given aToken (zero if none)
  /// @param _aToken The aToken
  /// @return _wrapper The wrapper address
  function wrapperFor(address _aToken) external view returns (address _wrapper);

  /// @notice The number of wrappers deployed
  /// @return _count The count
  function wrappersCount() external view returns (uint256 _count);

  /// @notice The wrapper at index `_i` in deployment order
  /// @param _i The index
  /// @return _wrapper The wrapper address
  function allWrappers(uint256 _i) external view returns (address _wrapper);
}
