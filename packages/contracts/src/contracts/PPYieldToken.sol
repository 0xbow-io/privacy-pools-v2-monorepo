// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {FeeCalculator} from 'abstracts/FeeCalculator.sol';
import {IAaveRewardsController} from 'interfaces/IAaveRewardsController.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ERC4626} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';
import {ReentrancyGuardTransient} from '@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol';

/// @title PPYieldToken
/// @author 0xbow
/// @notice Non-rebasing ERC-4626 wrapper over an Aave v3 aToken (e.g. aUSDC -> ppUSDC). Mints a
/// share token whose exchange rate to the aToken appreciates with Aave yield, net of an admin-set
/// protocol fee bounded by `MAX_FEE_BPS`. Shares are always 18 decimals (offset = 18 - aToken
/// decimals), so the inflation buffer is largest for low-decimal assets. Shielding/unshielding a
/// fixed share amount leaks no value delta over time; yield is realized at unwrap, and the admin
/// claims the accrued fee with no withdrawal fee.
/// @dev Immutable (no proxy). A self-contained admin (the Ownable2Step owner) can claim fees and
/// adjust the fee; the role is handed over via the 2-step transfer. The exchange rate is always
/// derived live from `asset.balanceOf(this)` (never stored); only `accumulatedFees` is checkpointed
/// lazily, on deposit/withdraw/claim/setFeeBps. Deployed per-asset by `PPYieldTokenFactory` (Aave
/// aTokens only, which are trusted and have no transfer hooks). See docs/DESIGN.md.
contract PPYieldToken is ERC4626, Ownable2Step, ReentrancyGuardTransient, Pausable, IPPYieldToken {
  using SafeERC20 for IERC20;

  /*///////////////////////////////////////////////////////////////
                            CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldToken
  uint256 public constant MAX_BPS = 10_000;

  /// @inheritdoc IPPYieldToken
  uint256 public constant MAX_FEE_BPS = 2000;

  /*///////////////////////////////////////////////////////////////
                            IMMUTABLES
  ///////////////////////////////////////////////////////////////*/

  /// @dev ERC-4626 virtual-share offset, fixed at construction to `18 - aToken decimals` so shares
  /// are always 18 decimals (and the inflation buffer is `10 ** offset`).
  uint8 private immutable _DECIMALS_OFFSET;

  /*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldToken
  uint256 public feeBps;

  /// @inheritdoc IPPYieldToken
  uint256 public accumulatedFees;

  /// @inheritdoc IPPYieldToken
  uint256 public lastCheckpointBalance;

  /// @inheritdoc IPPYieldToken
  address public rewardsController;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @param _aToken The Aave v3 aToken to wrap (the ERC-4626 underlying asset; must be <= 18 decimals)
  /// @param _initialFeeBps The initial protocol yield fee, in basis points (<= MAX_FEE_BPS)
  /// @param _admin The initial admin (owner); claims fees and sets the fee. Must be non-zero.
  /// @param _name The ERC-20 name of the wrapped share token (e.g. "Privacy Pool USDC")
  /// @param _symbol The ERC-20 symbol of the wrapped share token (e.g. "ppUSDC")
  constructor(
    IERC20 _aToken,
    uint256 _initialFeeBps,
    address _admin,
    string memory _name,
    string memory _symbol
  ) ERC20(_name, _symbol) ERC4626(_aToken) Ownable(_admin) {
    require(_initialFeeBps <= MAX_FEE_BPS, PPYieldToken_FeeTooHigh());
    uint8 _assetDecimals = IERC20Metadata(address(_aToken)).decimals();
    require(_assetDecimals <= 18, PPYieldToken_UnsupportedDecimals());
    _DECIMALS_OFFSET = 18 - _assetDecimals; // shares are always 18 decimals
    feeBps = _initialFeeBps;
  }

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldToken
  function setFeeBps(uint256 _newFeeBps) external onlyOwner {
    require(_newFeeBps <= MAX_FEE_BPS, PPYieldToken_FeeTooHigh());
    // charge yield accrued so far at the OLD rate, then switch the baseline to now. No token moves
    // here, so the balance `_checkpoint` read is still current - reuse it (one external call).
    uint256 _balance = _checkpoint();
    uint256 _oldFeeBps = feeBps;
    feeBps = _newFeeBps;
    lastCheckpointBalance = _balance;
    emit FeeUpdated(_oldFeeBps, _newFeeBps);
  }

  /// @inheritdoc IPPYieldToken
  function claimFees() external returns (uint256 _claimed) {
    _claimed = claimFees(owner());
  }

  /// @inheritdoc IPPYieldToken
  function setRewardsController(address _rewardsController) external onlyOwner {
    emit RewardsControllerUpdated(rewardsController, _rewardsController);
    rewardsController = _rewardsController;
  }

  /// @inheritdoc IPPYieldToken
  /// @dev Gates `deposit`/`mint` only, via `maxDeposit`/`maxMint` returning 0 while paused (the
  /// ERC-4626 cap the public entrypoints already enforce). `_pause` reverts `EnforcedPause` if
  /// already paused.
  function pause() external onlyOwner {
    _pause();
  }

  /// @inheritdoc IPPYieldToken
  /// @dev `_unpause` reverts `ExpectedPause` if not paused.
  function unpause() external onlyOwner {
    _unpause();
  }

  /// @inheritdoc IPPYieldToken
  /// @dev Thin typed passthrough: the only method ever invoked on the controller is
  /// `claimAllRewards`, whose Aave semantics can only move reward tokens the vault accrued - never
  /// the vault's aUSDC or ppUSDC. `nonReentrant` guards against a (settable) controller re-entering.
  function claimRewards(
    address[] calldata _assets,
    address _to
  ) external onlyOwner nonReentrant returns (address[] memory _rewardsList, uint256[] memory _claimedAmounts) {
    address _controller = rewardsController;
    require(_controller != address(0), PPYieldToken_RewardsControllerNotSet());
    (_rewardsList, _claimedAmounts) = IAaveRewardsController(_controller).claimAllRewards(_assets, _to);
  }

  /// @inheritdoc IPPYieldToken
  /// @dev Rescues any token except the underlying asset (so backing can never be touched). The
  /// vault's own ppUSDC (address(this)) is rescuable - moving stray shares does not affect backing.
  function rescueToken(IERC20 _token, address _to, uint256 _amount) external onlyOwner nonReentrant {
    require(address(_token) != asset(), PPYieldToken_CannotRescueAsset());
    require(_to != address(0), PPYieldToken_ZeroAddress());
    _token.safeTransfer(_to, _amount);
    emit TokenRescued(address(_token), _to, _amount);
  }

  /*///////////////////////////////////////////////////////////////
                      EXTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldToken
  function admin() external view returns (address _admin) {
    _admin = owner();
  }

  /// @inheritdoc IPPYieldToken
  function claimableFees() external view returns (uint256 _claimableFees) {
    _claimableFees = _currentFees(IERC20(asset()).balanceOf(address(this)));
  }

  /// @inheritdoc IPPYieldToken
  function exchangeRate() external view returns (uint256 _exchangeRate) {
    _exchangeRate = convertToAssets(10 ** decimals());
  }

  /*///////////////////////////////////////////////////////////////
                          PUBLIC FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldToken
  function claimFees(address _recipient) public onlyOwner nonReentrant returns (uint256 _claimed) {
    require(_recipient != address(0), PPYieldToken_ZeroAddress());
    _checkpoint();
    _claimed = accumulatedFees;
    accumulatedFees = 0;
    if (_claimed != 0) {
      IERC20(asset()).safeTransfer(_recipient, _claimed);
    }
    lastCheckpointBalance = IERC20(asset()).balanceOf(address(this));
    emit FeesClaimed(_recipient, _claimed);
  }

  /*///////////////////////////////////////////////////////////////
                        PUBLIC VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Renouncing the admin is disabled - the role is transferable (2-step) but never droppable
  /// @dev Prevents permanently stranding fee/reward collection and fee control. Overrides Ownable.
  function renounceOwnership() public view override onlyOwner {
    revert PPYieldToken_RenounceDisabled();
  }

  /// @inheritdoc IERC4626
  /// @dev Returns 0 while paused (deposits disabled), otherwise unbounded.
  function maxDeposit(address _receiver) public view override(ERC4626, IERC4626) returns (uint256 _maxAssets) {
    _maxAssets = paused() ? 0 : super.maxDeposit(_receiver);
  }

  /// @inheritdoc IERC4626
  /// @dev Returns 0 while paused (mints disabled), otherwise unbounded.
  function maxMint(address _receiver) public view override(ERC4626, IERC4626) returns (uint256 _maxShares) {
    _maxShares = paused() ? 0 : super.maxMint(_receiver);
  }

  /// @inheritdoc IERC4626
  /// @dev Net assets backing ppUSDC: live aUSDC balance minus all fees (checkpointed plus pending),
  /// clamped at zero defensively.
  function totalAssets() public view override(ERC4626, IERC4626) returns (uint256 _totalAssets) {
    uint256 _balance = IERC20(asset()).balanceOf(address(this));
    uint256 _fees = _currentFees(_balance);
    _totalAssets = _balance > _fees ? _balance - _fees : 0;
  }

  /// @inheritdoc IPPYieldToken
  /// @dev Resolves the `Pausable` + `IPPYieldToken` inheritance; delegates to `Pausable`.
  function paused() public view override(Pausable, IPPYieldToken) returns (bool _paused) {
    _paused = super.paused();
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Persists the pending fees into `accumulatedFees`
  /// @dev Caller updates `lastCheckpointBalance` to the post-action balance afterwards. Returns the
  /// pre-action balance read here so callers that don't move tokens (setFeeBps) can reuse it.
  /// @return _balance The aUSDC balance read at checkpoint time
  function _checkpoint() internal returns (uint256 _balance) {
    _balance = IERC20(asset()).balanceOf(address(this));
    accumulatedFees += _pendingFees(_balance);
  }

  /// @inheritdoc ERC4626
  /// @dev Checkpoints the pending fee against the pre-deposit balance, mints, then records the
  /// post-deposit balance so the deposited principal is excluded from future yield. Reverts on a
  /// dust deposit that rounds to zero shares. Covers both `deposit` and `mint`.
  function _deposit(
    address _caller,
    address _receiver,
    uint256 _assets,
    uint256 _shares
  ) internal override nonReentrant {
    require(_shares != 0, PPYieldToken_ZeroShares());
    _checkpoint();
    super._deposit({caller: _caller, receiver: _receiver, assets: _assets, shares: _shares});
    lastCheckpointBalance = IERC20(asset()).balanceOf(address(this));
  }

  /// @inheritdoc ERC4626
  /// @dev Checkpoints the pending fee against the pre-withdraw balance, burns and transfers, then
  /// records the post-withdraw balance. Reverts on a dust redeem that rounds to zero assets. Covers
  /// both `withdraw` and `redeem`.
  function _withdraw(
    address _caller,
    address _receiver,
    address _owner,
    uint256 _assets,
    uint256 _shares
  ) internal override nonReentrant {
    require(_assets != 0, PPYieldToken_ZeroAssets());
    _checkpoint();
    super._withdraw({caller: _caller, receiver: _receiver, owner: _owner, assets: _assets, shares: _shares});
    lastCheckpointBalance = IERC20(asset()).balanceOf(address(this));
  }

  /*///////////////////////////////////////////////////////////////
                      INTERNAL VIEW FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The protocol fees accrued on yield since the last checkpoint, for a given live balance
  /// @dev Single source of truth for the fee formula. Zero unless the balance has risen (yield).
  /// @param _balance The current aUSDC balance of the vault
  /// @return _fees `feeBps` of the balance increase since the last checkpoint
  function _pendingFees(uint256 _balance) internal view returns (uint256 _fees) {
    if (_balance > lastCheckpointBalance) {
      _fees = FeeCalculator.calcFee(_balance - lastCheckpointBalance, feeBps);
    }
  }

  /// @notice Total fee owed given a live aUSDC balance: checkpointed plus the pending fees
  /// @param _balance The current aUSDC balance of the vault
  /// @return _fees The checkpointed fee plus `feeBps` of yield since the last checkpoint
  function _currentFees(uint256 _balance) internal view returns (uint256 _fees) {
    _fees = accumulatedFees + _pendingFees(_balance);
  }

  /// @notice Shares are always 18 decimals: offset = 18 - aToken decimals (virtual shares = 10 ** offset)
  /// @return _offset The ERC-4626 decimals offset, fixed at construction
  function _decimalsOffset() internal view override returns (uint8 _offset) {
    _offset = _DECIMALS_OFFSET;
  }
}
