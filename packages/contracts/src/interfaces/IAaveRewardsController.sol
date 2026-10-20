// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title IAaveRewardsController
/// @author 0xbow
/// @notice Minimal subset of Aave v3's RewardsController used to claim liquidity-mining incentives
/// accrued by holding aTokens.
/// @dev Signature mirrors Aave v3 `IRewardsController.claimAllRewards` exactly. The controller only
/// distributes reward tokens the caller (the vault) has accrued; it has no authority over the
/// caller's aTokens or other balances.
interface IAaveRewardsController {
  /// @notice Claims all reward tokens accrued by the caller for the given assets, sending them to `_to`
  /// @param _assets The aTokens whose accrued rewards to claim (e.g. [aUSDC])
  /// @param _to The address that receives the reward tokens
  /// @return _rewardsList The reward token addresses claimed
  /// @return _claimedAmounts The amount claimed per reward token (aligned with `_rewardsList`)
  function claimAllRewards(
    address[] calldata _assets,
    address _to
  ) external returns (address[] memory _rewardsList, uint256[] memory _claimedAmounts);
}
