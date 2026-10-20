// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title IPPYieldTokenZap
/// @author 0xbow
/// @notice Stateless convenience router: underlying <-> pp-share in one call, routing through Aave v3
/// (supply/withdraw) and a `PPYieldToken` wrapper (deposit/redeem). One zap is deployed per wrapper
/// (e.g. a USDC zap over ppUSDC). Holds no funds between transactions.
interface IPPYieldTokenZap {
  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted on an underlying -> pp-share zap
  /// @param _sender The caller who supplied the underlying
  /// @param _receiver The address that received the shares
  /// @param _underlyingIn The underlying supplied
  /// @param _shares The pp-shares minted
  event ZappedIn(address indexed _sender, address indexed _receiver, uint256 _underlyingIn, uint256 _shares);

  /// @notice Emitted on an exact-output underlying -> pp-share zap (mints exactly `_shares`)
  /// @param _sender The caller who supplied the underlying
  /// @param _receiver The address that received the shares
  /// @param _underlyingIn The underlying pulled from the caller (`previewMint(shares) + buffer`)
  /// @param _shares The pp-shares minted (exactly the requested amount)
  event ZappedInExact(address indexed _sender, address indexed _receiver, uint256 _underlyingIn, uint256 _shares);

  /// @notice Emitted on a pp-share -> underlying zap
  /// @param _sender The caller who supplied the shares
  /// @param _receiver The address that received the underlying
  /// @param _shares The pp-shares redeemed
  /// @param _underlyingOut The underlying returned
  event ZappedOut(address indexed _sender, address indexed _receiver, uint256 _shares, uint256 _underlyingOut);

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown at construction when any dependency address is zero
  error PPYieldTokenZap_ZeroAddress();

  /// @notice Thrown when a zap amount or share count is zero
  error PPYieldTokenZap_ZeroAmount();

  /// @notice Thrown when the underlying needed to mint the requested shares exceeds the caller's bound
  /// @param _required The underlying the zap must pull to mint exactly the requested shares (+ buffer)
  /// @param _maxUnderlyingIn The caller's ceiling
  error PPYieldTokenZap_SlippageExceeded(uint256 _required, uint256 _maxUnderlyingIn);

  /// @notice Thrown (defensively) when the aToken credited by the supply is below what the exact mint
  ///         needs — should be impossible given the rounding buffer; signals unexpected pool rounding
  /// @param _received The aToken balance credited by the supply
  /// @param _needed The aToken the exact mint consumes (`previewMint(shares)`)
  error PPYieldTokenZap_InsufficientWrap(uint256 _received, uint256 _needed);

  /*///////////////////////////////////////////////////////////////
                          MUTATIVE FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Supplies the underlying to Aave and wraps the resulting aToken into pp-shares for `_receiver`
  /// @param _underlyingAmount The underlying to pull from the caller
  /// @param _receiver The address that receives the minted pp-shares
  /// @return _shares The pp-shares minted
  function depositUnderlying(uint256 _underlyingAmount, address _receiver) external returns (uint256 _shares);

  /// @notice Supplies the underlying to Aave and mints EXACTLY `_shares` pp-shares to `_receiver`
  /// @dev Exact-output counterpart of {depositUnderlying}: the share count is hit exactly while the
  ///      underlying spent floats up to `_maxUnderlyingIn` (rate drift between quote and execution). The
  ///      mint is driven off `previewMint`, never off this contract's balance, so a stray aToken float
  ///      cannot skew the amount; the ≤ buffer wei of aToken dust is forwarded to `_receiver` so the zap
  ///      stays stateless.
  /// @param _shares The pp-shares to mint (the exact output)
  /// @param _receiver The address that receives the minted pp-shares (and any aToken dust)
  /// @param _maxUnderlyingIn The maximum underlying the caller authorizes (slippage / validity bound)
  /// @return _underlyingIn The underlying actually pulled from the caller
  function buyFixedYieldToken(
    uint256 _shares,
    address _receiver,
    uint256 _maxUnderlyingIn
  ) external returns (uint256 _underlyingIn);

  /// @notice Redeems pp-shares to aTokens and withdraws the underlying from Aave to `_receiver`
  /// @param _shares The pp-shares to pull from the caller
  /// @param _receiver The address that receives the underlying
  /// @return _underlyingOut The underlying returned
  function redeemToUnderlying(uint256 _shares, address _receiver) external returns (uint256 _underlyingOut);

  /*///////////////////////////////////////////////////////////////
                          IMMUTABLES
  ///////////////////////////////////////////////////////////////*/

  /// @notice The PPYieldToken wrapper
  /// @return _vault The wrapper
  function VAULT() external view returns (IPPYieldToken _vault);

  /// @notice The Aave v3 pool
  /// @return _pool The pool
  function POOL() external view returns (IAavePool _pool);

  /// @notice The underlying token supplied to Aave (e.g. USDC)
  /// @return _underlying The underlying token
  function UNDERLYING() external view returns (IERC20 _underlying);

  /// @notice The Aave aToken (the wrapper's asset)
  /// @return _aToken The aToken
  function A_TOKEN() external view returns (IERC20 _aToken);

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The underlying needed to mint exactly `_shares` pp-shares, at the live rate
  /// @dev Callers should pass `maxUnderlyingIn >= underlyingNeeded` to {buyFixedYieldToken}, with a small
  ///      margin for the rate moving further between this read and execution. Adds the supply buffer so
  ///      the exact `mint` can never revert on Aave's index round-trip.
  /// @param _shares The pp-shares to mint
  /// @return _underlyingNeeded The underlying the zap would pull (`previewMint(shares) + buffer`)
  function quoteBuy(uint256 _shares) external view returns (uint256 _underlyingNeeded);
}
