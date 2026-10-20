// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @notice Simple mintable mock ERC20 with configurable decimals, for tests. Used as the underlying
/// USDC, and as a stand-in aUSDC in unit tests where yield is simulated by minting to the vault.
contract MockERC20 is ERC20 {
  uint8 private immutable _DECIMALS;

  constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
    _DECIMALS = decimals_;
  }

  function decimals() public view override returns (uint8) {
    return _DECIMALS;
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
