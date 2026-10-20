// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title FeeCalculator
/// @notice Provides fee calculation utilities for contracts that need basis point fee logic
library FeeCalculator {
  /*///////////////////////////////////////////////////////////////
                            CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Maximum basis points (100%)
  // solhint-disable-next-line private-vars-leading-underscore
  uint256 internal constant MAX_FEE_BPS = 10_000;

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Calculates a fee amount from a value and basis points
  /// @param _amount The amount to calculate the fee from
  /// @param _bps The fee in basis points (1 bps = 0.01%)
  /// @return _fee The calculated fee amount
  function calcFee(uint256 _amount, uint256 _bps) internal pure returns (uint256 _fee) {
    _fee = (_amount * _bps) / MAX_FEE_BPS;
  }
}
