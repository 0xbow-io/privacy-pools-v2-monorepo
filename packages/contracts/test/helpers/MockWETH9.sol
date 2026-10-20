// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @notice WETH9-style mock for tests: `deposit` wraps sent native value 1:1 and `withdraw` burns and
/// pushes native value back with a 2300-gas `transfer`, exactly like canonical mainnet WETH9 — so any
/// contract under test that receives the unwrap must fit its `receive()` in the stipend, the same
/// constraint it faces in production. Inherits {MockERC20}'s public `mint`, which tests must NOT use
/// for this token (minted balances have no native backing and would make `withdraw` revert).
contract MockWETH9 is MockERC20 {
  constructor() MockERC20('Wrapped Ether', 'WETH', 18) {}

  receive() external payable {
    deposit();
  }

  function deposit() public payable {
    _mint(msg.sender, msg.value);
  }

  function withdraw(uint256 _amount) external {
    _burn(msg.sender, _amount);
    payable(msg.sender).transfer(_amount);
  }
}
