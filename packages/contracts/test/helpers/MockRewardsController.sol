// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @notice Minimal stand-in for Aave's RewardsController. On `claimAllRewards` it transfers a
/// configured amount of a configured reward token (which it must hold) to `_to` and records the
/// call. It has no power over the caller's assets - it only moves its own reward balance.
contract MockRewardsController {
  IERC20 public reward;
  uint256 public rewardAmount;
  address public lastTo;
  address[] public lastAssets;

  function setReward(IERC20 _reward, uint256 _amount) external {
    reward = _reward;
    rewardAmount = _amount;
  }

  function claimAllRewards(
    address[] calldata _assets,
    address _to
  ) external returns (address[] memory _rewardsList, uint256[] memory _claimedAmounts) {
    lastTo = _to;
    lastAssets = _assets;

    _rewardsList = new address[](1);
    _rewardsList[0] = address(reward);
    _claimedAmounts = new uint256[](1);
    _claimedAmounts[0] = rewardAmount;

    if (rewardAmount != 0) reward.transfer(_to, rewardAmount);
  }
}
