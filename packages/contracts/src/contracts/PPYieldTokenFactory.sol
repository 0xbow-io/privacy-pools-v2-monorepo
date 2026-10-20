// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAToken} from 'interfaces/IAToken.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenFactory} from 'interfaces/IPPYieldTokenFactory.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';

/// @title PPYieldTokenFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks `PPYieldToken` wrappers for the aTokens of a
/// single trusted Aave v3 pool (e.g. ppUSDC / ppUSDT / ppWETH). Restricting to one pool's aTokens
/// keeps every wrapped asset trusted and hook-free. Each wrapper is seeded at creation with
/// permanently-locked dead shares so it is never empty, which neutralizes the ERC-4626
/// first-depositor inflation attack independently of the asset's decimals offset.
/// @dev Genuineness is enforced two ways: `_aToken.POOL()` must equal this factory's pool, and the
/// seed is routed through the real `POOL.supply(underlying)` - which mints the canonical aToken, so a
/// spoofed aToken would fail the subsequent wrapper deposit. Wrappers are independent and immutable;
/// their admin/fee/rewardsController are set per instance (the factory holds no power over them).
contract PPYieldTokenFactory is Ownable, IPPYieldTokenFactory {
  using SafeERC20 for IERC20;

  /*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @dev Burn address that receives the seed shares (locked forever; never `address(0)` since the
  /// ERC-20 forbids transfers to it).
  address internal constant _DEAD = address(0xdEaD);

  /// @inheritdoc IPPYieldTokenFactory
  IAavePool public immutable POOL;

  /// @inheritdoc IPPYieldTokenFactory
  mapping(address _aToken => address _wrapper) public wrapperFor;

  /// @dev All wrappers in deployment order
  address[] internal _allWrappers;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @param _pool The trusted Aave v3 pool whose aTokens may be wrapped
  /// @param _owner The factory owner (may deploy wrappers)
  constructor(IAavePool _pool, address _owner) Ownable(_owner) {
    require(address(_pool) != address(0), PPYieldTokenFactory_ZeroAddress());
    POOL = _pool;
  }

  /*///////////////////////////////////////////////////////////////
                          ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenFactory
  /// @dev Order: validate the aToken + uniqueness -> deploy and record the wrapper -> seed dead
  /// shares. The seed pulls `_seedAssets` underlying from the caller, supplies it to the real pool
  /// for the canonical aToken (a spoofed `_aToken` then has zero balance and the wrapper deposit
  /// reverts), and deposits the minted aTokens to `_DEAD` so they are locked forever.
  function createWrapper(
    address _aToken,
    uint256 _feeBps,
    address _admin,
    string calldata _name,
    string calldata _symbol,
    uint256 _seedAssets
  ) external onlyOwner returns (address _wrapper) {
    require(IAToken(_aToken).POOL() == address(POOL), PPYieldTokenFactory_NotAavePoolAToken());
    require(wrapperFor[_aToken] == address(0), PPYieldTokenFactory_AlreadyDeployed());
    require(_seedAssets != 0, PPYieldTokenFactory_ZeroSeed());
    address _underlying = IAToken(_aToken).UNDERLYING_ASSET_ADDRESS();

    _wrapper = address(
      new PPYieldToken({
        _aToken: IERC20(_aToken), _initialFeeBps: _feeBps, _admin: _admin, _name: _name, _symbol: _symbol
      })
    );
    wrapperFor[_aToken] = _wrapper;
    _allWrappers.push(_wrapper);

    // Seed locked dead shares: pull underlying, supply to the REAL pool for the canonical aToken
    // (self-validates `_aToken`), then deposit those aTokens into the wrapper to a burn address.
    // We deposit the factory's full post-supply aToken balance; on real (rebasing) Aave a wei of
    // interim interest could otherwise be stranded here - harmless dust, never user funds.
    IERC20(_underlying).safeTransferFrom(msg.sender, address(this), _seedAssets);
    IERC20(_underlying).forceApprove(address(POOL), _seedAssets);
    POOL.supply({_asset: _underlying, _amount: _seedAssets, _onBehalfOf: address(this), _referralCode: 0});
    uint256 _aBal = IERC20(_aToken).balanceOf(address(this));
    IERC20(_aToken).forceApprove(_wrapper, _aBal);
    IPPYieldToken(_wrapper).deposit(_aBal, _DEAD);

    emit WrapperCreated({_underlying: _underlying, _aToken: _aToken, _wrapper: _wrapper, _admin: _admin});
  }

  /*///////////////////////////////////////////////////////////////
                          VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPYieldTokenFactory
  function wrappersCount() external view returns (uint256 _count) {
    _count = _allWrappers.length;
  }

  /// @inheritdoc IPPYieldTokenFactory
  function allWrappers(uint256 _i) external view returns (address _wrapper) {
    _wrapper = _allWrappers[_i];
  }

  /// @notice Ownership is transferable but cannot be renounced, so the owner-gated `createWrapper` is never bricked
  /// @dev Mirrors the renounce-freeze on {PPYieldToken}; reverts unconditionally
  function renounceOwnership() public view override onlyOwner {
    revert PPYieldTokenFactory_RenounceDisabled();
  }
}
