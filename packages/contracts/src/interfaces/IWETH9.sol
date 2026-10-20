// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title IWETH9
/// @author 0xbow
/// @notice Minimal interface for the canonical Wrapped Ether contract (WETH9), covering only the two
/// conversion functions beyond plain ERC-20. WETH9 is immutable, permissionless and 1:1 backed by
/// construction: `deposit` credits exactly `msg.value` WETH and `withdraw` returns exactly the burned
/// amount in native ETH.
interface IWETH9 is IERC20 {
  /// @notice Wraps the sent native ETH into WETH, credited to the caller 1:1
  function deposit() external payable;

  /// @notice Unwraps WETH into native ETH, sent to the caller
  /// @dev Canonical WETH9 pushes the ETH with a 2300-gas-stipend `transfer`, so a contract caller's
  ///      `receive()` must stay within that stipend (no storage writes, no logs)
  /// @param _amount The WETH amount to unwrap
  function withdraw(uint256 _amount) external;
}
