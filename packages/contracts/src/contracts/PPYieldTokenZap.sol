// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

/// @title PPYieldTokenZap
/// @author 0xbow
/// @notice Stateless convenience router: underlying <-> pp-share in one call. `depositUnderlying`
/// supplies the underlying to Aave and wraps the resulting aToken into pp-shares; `redeemToUnderlying`
/// redeems pp-shares to aTokens and withdraws the underlying. The contract holds no funds between
/// transactions. One zap is deployed per `PPYieldToken` wrapper (e.g. a USDC zap over ppUSDC).
contract PPYieldTokenZap is IPPYieldTokenZap {
  using SafeERC20 for IERC20;

  /*///////////////////////////////////////////////////////////////
                          CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Underlying over-supplied so the exact `mint` can never revert on Aave's index round-trip.
  /// @dev A single `supply(x)` credits `x` or `x - 1` wei of aToken (scaledBalance round-trip), so a
  ///      1-wei buffer suffices; 2 is used for margin. This is the only value forfeited per exact mint.
  uint256 internal constant _SUPPLY_ROUNDING_BUFFER = 2;

  /*///////////////////////////////////////////////////////////////
                          IMMUTABLES
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZap
  IPPYieldToken public immutable VAULT;

  /// @inheritdoc IPPYieldTokenZap
  IAavePool public immutable POOL;

  /// @inheritdoc IPPYieldTokenZap
  IERC20 public immutable UNDERLYING;

  /// @inheritdoc IPPYieldTokenZap
  IERC20 public immutable A_TOKEN;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @param _vault The PPYieldToken wrapper
  /// @param _pool The Aave v3 pool
  /// @param _underlying The underlying token supplied to Aave (e.g. USDC)
  constructor(IPPYieldToken _vault, IAavePool _pool, IERC20 _underlying) {
    require(
      address(_vault) != address(0) && address(_pool) != address(0) && address(_underlying) != address(0),
      PPYieldTokenZap_ZeroAddress()
    );
    VAULT = _vault;
    POOL = _pool;
    UNDERLYING = _underlying;
    A_TOKEN = IERC20(_vault.asset());
  }

  /*///////////////////////////////////////////////////////////////
                          MUTATIVE FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZap
  function depositUnderlying(uint256 _underlyingAmount, address _receiver) external returns (uint256 _shares) {
    require(_underlyingAmount != 0, PPYieldTokenZap_ZeroAmount());

    UNDERLYING.safeTransferFrom(msg.sender, address(this), _underlyingAmount);
    UNDERLYING.forceApprove(address(POOL), _underlyingAmount);

    // Credit only the aTokens THIS supply produces (balance delta), never the absolute balance:
    // crediting balanceOf would let an attacker pre-donate aTokens and have the next caller sweep
    // them into their shares (last-caller-wins griefing). aTokens rebase, so the delta (not
    // `_underlyingAmount`) is the exact amount received; any donated balance is left untouched.
    uint256 _aBefore = A_TOKEN.balanceOf(address(this));
    POOL.supply({_asset: address(UNDERLYING), _amount: _underlyingAmount, _onBehalfOf: address(this), _referralCode: 0});
    uint256 _aReceived = A_TOKEN.balanceOf(address(this)) - _aBefore;

    A_TOKEN.forceApprove(address(VAULT), _aReceived);
    _shares = VAULT.deposit(_aReceived, _receiver);

    emit ZappedIn({_sender: msg.sender, _receiver: _receiver, _underlyingIn: _underlyingAmount, _shares: _shares});
  }

  /// @inheritdoc IPPYieldTokenZap
  function buyFixedYieldToken(
    uint256 _shares,
    address _receiver,
    uint256 _maxUnderlyingIn
  ) external returns (uint256 _underlyingIn) {
    require(_shares != 0, PPYieldTokenZap_ZeroAmount());
    uint256 _aNeeded = VAULT.previewMint(_shares);
    _underlyingIn = _aNeeded + _SUPPLY_ROUNDING_BUFFER;
    require(_underlyingIn <= _maxUnderlyingIn, PPYieldTokenZap_SlippageExceeded(_underlyingIn, _maxUnderlyingIn));

    UNDERLYING.safeTransferFrom(msg.sender, address(this), _underlyingIn);
    UNDERLYING.forceApprove(address(POOL), _underlyingIn);

    // Measure the aTokens THIS supply produces (delta), not the absolute balance, so a pre-donated
    // aToken balance can neither satisfy the wrap check below nor be swept as dust (griefing).
    uint256 _aBefore = A_TOKEN.balanceOf(address(this));
    POOL.supply({_asset: address(UNDERLYING), _amount: _underlyingIn, _onBehalfOf: address(this), _referralCode: 0});
    uint256 _aReceived = A_TOKEN.balanceOf(address(this)) - _aBefore;

    require(_aReceived >= _aNeeded, PPYieldTokenZap_InsufficientWrap(_aReceived, _aNeeded));
    A_TOKEN.forceApprove(address(VAULT), _aNeeded);
    VAULT.mint(_shares, _receiver);

    // Forward only THIS call's residual aToken dust (balance above the pre-supply baseline) to the
    // receiver so the zap stays stateless; any pre-donated balance is left untouched.
    uint256 _dust = A_TOKEN.balanceOf(address(this)) - _aBefore;
    if (_dust != 0) A_TOKEN.safeTransfer(_receiver, _dust);

    emit ZappedInExact({_sender: msg.sender, _receiver: _receiver, _underlyingIn: _underlyingIn, _shares: _shares});
  }

  /// @inheritdoc IPPYieldTokenZap
  function redeemToUnderlying(uint256 _shares, address _receiver) external returns (uint256 _underlyingOut) {
    require(_shares != 0, PPYieldTokenZap_ZeroAmount());

    IERC20(address(VAULT)).safeTransferFrom(msg.sender, address(this), _shares);

    // Withdraw only the aTokens THIS redeem produces (balance delta), not the absolute balance:
    // withdrawing balanceOf would let an attacker donate aTokens and have the next caller sweep them.
    uint256 _aBefore = A_TOKEN.balanceOf(address(this));
    VAULT.redeem(_shares, address(this), address(this));
    uint256 _aReceived = A_TOKEN.balanceOf(address(this)) - _aBefore;

    _underlyingOut = POOL.withdraw(address(UNDERLYING), _aReceived, _receiver);

    emit ZappedOut({_sender: msg.sender, _receiver: _receiver, _shares: _shares, _underlyingOut: _underlyingOut});
  }

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenZap
  function quoteBuy(uint256 _shares) external view returns (uint256 _underlyingNeeded) {
    _underlyingNeeded = VAULT.previewMint(_shares) + _SUPPLY_ROUNDING_BUFFER;
  }
}
