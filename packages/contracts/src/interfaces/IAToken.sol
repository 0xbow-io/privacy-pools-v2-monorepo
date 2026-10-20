// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IAToken
/// @author 0xbow
/// @notice Minimal subset of an Aave v3 aToken used by `PPYieldTokenFactory` to validate that a
/// token is a genuine aToken of the trusted pool and to resolve its underlying asset.
/// @dev Both getters are part of Aave v3's `IAToken`/`IInitializableAToken`.
interface IAToken {
  /// @notice The Aave pool that owns this aToken
  /// @return _pool The pool address
  function POOL() external view returns (address _pool);

  /// @notice The underlying asset this aToken represents
  /// @return _underlying The underlying ERC-20 address
  function UNDERLYING_ASSET_ADDRESS() external view returns (address _underlying);
}
