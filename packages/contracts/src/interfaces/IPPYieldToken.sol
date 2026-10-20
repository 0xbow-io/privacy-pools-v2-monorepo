// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title IPPYieldToken
/// @author 0xbow
/// @notice Non-rebasing ERC-4626 wrapper over an Aave v3 aToken (e.g. aUSDC -> ppUSDC). Mints a
/// share token whose exchange rate to the aToken appreciates with Aave yield, net of a protocol fee.
/// Shielding/unshielding a fixed share amount leaks no value delta over time. Yield is realized at
/// unwrap; protocol revenue is the accrued fee, claimable by the admin with no withdrawal fee.
/// @dev `asset()` is the aToken. Shares are always 18 decimals. The exchange rate is always derived
/// live from `asset.balanceOf(this)`; it is never stored. Only `accumulatedFees` is checkpointed
/// lazily, on deposit/withdraw/claim/setFeeBps. The contract is immutable (no proxy); a self-contained
/// admin (the OZ Ownable2Step owner) can claim fees and adjust the fee within `[0, MAX_FEE_BPS]`, and
/// can hand the role to a new admin via the 2-step transfer. See docs/DESIGN.md.
interface IPPYieldToken is IERC4626 {
  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when accrued protocol fees are swept
  /// @param _recipient The address the fees were sent to
  /// @param _amount The amount of aUSDC swept
  event FeesClaimed(address indexed _recipient, uint256 _amount);

  /// @notice Emitted when the admin changes the protocol fee
  /// @param _oldFeeBps The previous fee, in basis points
  /// @param _newFeeBps The new fee, in basis points
  event FeeUpdated(uint256 _oldFeeBps, uint256 _newFeeBps);

  /// @notice Emitted when the admin rescues a stray (non-asset) token
  /// @param _token The token rescued
  /// @param _to The address the token was sent to
  /// @param _amount The amount rescued
  event TokenRescued(address indexed _token, address indexed _to, uint256 _amount);

  /// @notice Emitted when the admin updates the Aave rewards controller
  /// @param _oldController The previous controller
  /// @param _newController The new controller
  event RewardsControllerUpdated(address indexed _oldController, address indexed _newController);

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown at construction or in `setFeeBps` when the fee exceeds `MAX_FEE_BPS`
  error PPYieldToken_FeeTooHigh();

  /// @notice Thrown when a fee-claim recipient is the zero address
  error PPYieldToken_ZeroAddress();

  /// @notice Thrown when a deposit/mint would mint zero shares (dust rounding)
  error PPYieldToken_ZeroShares();

  /// @notice Thrown when a withdraw/redeem would return zero assets (dust rounding)
  error PPYieldToken_ZeroAssets();

  /// @notice Thrown when `rescueToken` targets the underlying asset (aUSDC)
  error PPYieldToken_CannotRescueAsset();

  /// @notice Thrown when `claimRewards` is called while the rewards controller is unset
  error PPYieldToken_RewardsControllerNotSet();

  /// @notice Thrown when attempting to renounce the admin (the role is transferable, never droppable)
  error PPYieldToken_RenounceDisabled();

  /// @notice Thrown at construction when the aToken has more than 18 decimals (offset would underflow)
  error PPYieldToken_UnsupportedDecimals();

  /*///////////////////////////////////////////////////////////////
                          ADMIN FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Sets the protocol fee (admin only); checkpoints accrued fees at the old rate first
  /// @dev Reverts with `PPYieldToken_FeeTooHigh` if `_newFeeBps > MAX_FEE_BPS`. Does not change the
  /// exchange rate at the moment of the change (already-accrued yield is charged at the old rate).
  /// @param _newFeeBps The new fee, in basis points, in `[0, MAX_FEE_BPS]`
  function setFeeBps(uint256 _newFeeBps) external;

  /// @notice Sweeps accrued protocol fees in aUSDC to `_recipient` (admin only)
  /// @dev Checkpoints pending fee first, zeroes the counter, and does not change the exchange rate.
  /// @param _recipient The address to receive the swept aUSDC (non-zero)
  /// @return _claimed The amount of aUSDC swept
  function claimFees(address _recipient) external returns (uint256 _claimed);

  /// @notice Sweeps accrued protocol fees to the admin (admin only)
  /// @return _claimed The amount of aUSDC swept
  function claimFees() external returns (uint256 _claimed);

  /// @notice Sets the Aave rewards controller used by `claimRewards` (admin only)
  /// @param _rewardsController The new controller (may be zero to disable claiming)
  function setRewardsController(address _rewardsController) external;

  /// @notice Pauses new deposits and mints (admin only); reverts if already paused
  /// @dev Affects `deposit`/`mint` only - `withdraw`/`redeem`/`claimFees` stay open so holders can
  /// always exit. While paused, `maxDeposit`/`maxMint` return 0, so the public `deposit`/`mint`
  /// revert `ERC4626ExceededMaxDeposit`/`ERC4626ExceededMaxMint`. Emits OZ `Paused`.
  function pause() external;

  /// @notice Resumes deposits and mints (admin only); reverts if not paused. Emits OZ `Unpaused`
  function unpause() external;

  /// @notice Claims Aave liquidity-mining rewards accrued by the vault, sending them to `_to` (admin only)
  /// @dev Forwards to `rewardsController.claimAllRewards`. Reverts `PPYieldToken_RewardsControllerNotSet`
  /// if the controller is unset. By the controller's semantics this can only move reward tokens the
  /// vault accrued - never the vault's aUSDC or ppUSDC.
  /// @param _assets The aTokens whose accrued rewards to claim (e.g. [aUSDC])
  /// @param _to The address to receive the reward tokens
  /// @return _rewardsList The reward token addresses claimed
  /// @return _claimedAmounts The amount claimed per reward token
  function claimRewards(
    address[] calldata _assets,
    address _to
  ) external returns (address[] memory _rewardsList, uint256[] memory _claimedAmounts);

  /// @notice Rescues a stray ERC-20 to `_to` (admin only) - airdrops, claimed rewards, stray ppUSDC
  /// @dev Reverts `PPYieldToken_CannotRescueAsset` if `_token` is the underlying asset (aUSDC), so backing
  /// can never be touched. Reverts `PPYieldToken_ZeroAddress` if `_to` is zero.
  /// @param _token The token to rescue (must not be the asset)
  /// @param _to The address to receive the tokens
  /// @param _amount The amount to rescue
  function rescueToken(IERC20 _token, address _to, uint256 _amount) external;

  /*///////////////////////////////////////////////////////////////
                          CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Basis-point denominator (100%)
  /// @return _maxBps The value 10_000
  function MAX_BPS() external view returns (uint256 _maxBps);

  /// @notice Hard ceiling on the protocol fee (20%), enforced at construction and in `setFeeBps`
  /// @return _maxFeeBps The value 2_000
  function MAX_FEE_BPS() external view returns (uint256 _maxFeeBps);

  /*///////////////////////////////////////////////////////////////
                          STATE GETTERS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The current protocol yield fee, in basis points (admin-adjustable within MAX_FEE_BPS)
  /// @return _feeBps The fee applied to each yield accrual
  function feeBps() external view returns (uint256 _feeBps);

  /// @notice The protocol admin (alias for the Ownable2Step owner): claims fees and sets the fee
  /// @return _admin The current admin address
  function admin() external view returns (address _admin);

  /// @notice Checkpointed protocol-owed aUSDC that does not back ppUSDC
  /// @return _accumulatedFees The checkpointed fee balance (excludes fee accrued since last checkpoint)
  function accumulatedFees() external view returns (uint256 _accumulatedFees);

  /// @notice The wrapper's aUSDC balance recorded at the last checkpoint
  /// @return _lastCheckpointBalance The post-action balance from the last deposit/withdraw/claim/setFeeBps
  function lastCheckpointBalance() external view returns (uint256 _lastCheckpointBalance);

  /// @notice The Aave rewards controller used by `claimRewards` (admin-settable; zero if unset)
  /// @return _rewardsController The current rewards controller address
  function rewardsController() external view returns (address _rewardsController);

  /// @notice Whether new deposits/mints are paused (withdraw/redeem/claimFees are never paused)
  /// @return _paused True if `deposit`/`mint` are currently disabled
  function paused() external view returns (bool _paused);

  /*///////////////////////////////////////////////////////////////
                          DERIVED VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Total fee currently claimable, including yield accrued since the last checkpoint
  /// @return _claimableFees `accumulatedFees` plus the not-yet-checkpointed pending fee
  function claimableFees() external view returns (uint256 _claimableFees);

  /// @notice The live exchange rate: aUSDC redeemable for one whole ppUSDC (`10 ** decimals()` shares)
  /// @dev Equals `convertToAssets(10 ** decimals())`. Asset-denominated (1:1 base = `10 ** assetDecimals`).
  /// @return _exchangeRate aUSDC value of one whole ppUSDC
  function exchangeRate() external view returns (uint256 _exchangeRate);
}
