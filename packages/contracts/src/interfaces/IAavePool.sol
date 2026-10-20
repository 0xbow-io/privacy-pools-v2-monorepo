// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IAavePool
/// @author 0xbow
/// @notice Minimal subset of the Aave v3 Pool interface used by PPYieldTokenZap (supply and withdraw).
/// @dev Signatures mirror Aave v3 `IPool` exactly so a real Pool satisfies this interface.
interface IAavePool {
  /// @notice Supplies an asset into the protocol, minting the equivalent aToken to `_onBehalfOf`
  /// @param _asset The underlying asset to supply
  /// @param _amount The amount to supply
  /// @param _onBehalfOf The address that receives the aTokens
  /// @param _referralCode Referral code (unused; pass 0)
  function supply(address _asset, uint256 _amount, address _onBehalfOf, uint16 _referralCode) external;

  /// @notice Withdraws an underlying asset, burning the equivalent aToken owned by the caller
  /// @param _asset The underlying asset to withdraw
  /// @param _amount The amount to withdraw (use type(uint256).max for the full balance)
  /// @param _to The address that receives the underlying
  /// @return _withdrawn The final amount withdrawn
  function withdraw(address _asset, uint256 _amount, address _to) external returns (uint256 _withdrawn);
}
