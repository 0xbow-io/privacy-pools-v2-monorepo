// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

// VETTING_FEE_BPS and _calcFee with it used from HandlerBase
contract Constants {
  uint256 internal constant MIN_AMOUNT = 0.1 ether;
  uint256 internal constant MAX_RELAY_FEE = 0.01 ether;
  uint256 internal constant MAX_INPUTS = 5;
}
