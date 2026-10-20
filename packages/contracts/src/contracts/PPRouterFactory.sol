// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAToken} from 'interfaces/IAToken.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPRouterFactory} from 'interfaces/IPPRouterFactory.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {PPRouter} from 'contracts/PPRouter.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title PPRouterFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks one {PPRouter} per `PPYieldToken`
/// wrapper, for wrappers over a single trusted Aave v3 pool shielding into a single entrypoint. The
/// caller supplies only the wrapper: the underlying is derived from its aToken
/// (`UNDERLYING_ASSET_ADDRESS`), and the pool / entrypoint / dust recipient come from this factory.
/// The `aToken.POOL()` check anchors genuineness; a wrapper lying about `asset()` only yields a useless
/// router (owner self-harm). Mirrors `PPYieldTokenZapFactory`.
contract PPRouterFactory is Ownable, IPPRouterFactory {
  /*///////////////////////////////////////////////////////////////
                          STATE VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPRouterFactory
  IAavePool public immutable POOL;

  /// @inheritdoc IPPRouterFactory
  IEntrypoint public immutable ENTRYPOINT;

  /// @inheritdoc IPPRouterFactory
  IPoolVault public immutable POOL_VAULT;

  /// @inheritdoc IPPRouterFactory
  address public immutable DUST_RECIPIENT;

  /// @inheritdoc IPPRouterFactory
  mapping(address _vault => address _router) public routerFor;

  /// @dev All routers in deployment order
  address[] internal _allRouters;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  /// @param _pool The trusted Aave v3 pool whose wrappers may get a router
  /// @param _entrypoint The privacy-pool entrypoint every router deposits through
  /// @param _poolVault The privacy-pool vault every router processes withdrawals against
  /// @param _dustRecipient The fixed dust recipient every router is given
  /// @param _owner The factory owner (may deploy routers)
  constructor(
    IAavePool _pool,
    IEntrypoint _entrypoint,
    IPoolVault _poolVault,
    address _dustRecipient,
    address _owner
  ) Ownable(_owner) {
    require(
      address(_pool) != address(0) && address(_entrypoint) != address(0) && address(_poolVault) != address(0)
        && _dustRecipient != address(0),
      PPRouterFactory_ZeroAddress()
    );
    POOL = _pool;
    ENTRYPOINT = _entrypoint;
    POOL_VAULT = _poolVault;
    DUST_RECIPIENT = _dustRecipient;
  }

  /*///////////////////////////////////////////////////////////////
                          ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPRouterFactory
  function createRouter(address _vault, address _zap) external onlyOwner returns (address _router) {
    _router = _createRouter(_vault, _zap, false);
  }

  /// @inheritdoc IPPRouterFactory
  function createRouterNative(address _vault, address _zap) external onlyOwner returns (address _router) {
    _router = _createRouter(_vault, _zap, true);
  }

  /*///////////////////////////////////////////////////////////////
                          VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @inheritdoc IPPRouterFactory
  function routersCount() external view returns (uint256 _count) {
    _count = _allRouters.length;
  }

  /// @inheritdoc IPPRouterFactory
  function allRouters(uint256 _i) external view returns (address _router) {
    _router = _allRouters[_i];
  }

  /// @notice Ownership is transferable but cannot be renounced, so the owner-gated `createRouter` is never bricked
  /// @dev Mirrors the renounce-freeze on {PPYieldToken}; reverts unconditionally
  function renounceOwnership() public view override onlyOwner {
    revert PPRouterFactory_RenounceDisabled();
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Validates the wrapper and deploys its router in the requested mode
  /// @dev Shared body of {createRouter} and {createRouterNative}: the aToken genuineness check, the
  /// one-router-per-wrapper guard, and the registry write are identical in both modes; only the
  /// router's `_nativeMode` constructor flag differs (native mode is additionally probed by the
  /// router's own constructor — see {PPRouter}).
  /// @param _vault The PPYieldToken wrapper to build a router for
  /// @param _zap The zap (for `_vault`) the router wraps/unwraps through
  /// @param _nativeMode Whether the router serves a wrapped-native underlying with native-coin edges
  /// @return _router The deployed router
  function _createRouter(address _vault, address _zap, bool _nativeMode) internal returns (address _router) {
    address _aToken = IPPYieldToken(_vault).asset();
    require(IAToken(_aToken).POOL() == address(POOL), PPRouterFactory_NotAavePoolAToken());
    require(routerFor[_vault] == address(0), PPRouterFactory_AlreadyDeployed());
    address _underlying = IAToken(_aToken).UNDERLYING_ASSET_ADDRESS();

    // The router's constructor validates that `_zap` wraps this exact `(vault, underlying)` pair.
    _router = address(
      new PPRouter({
        _vault: IPPYieldToken(_vault),
        _pool: POOL,
        _underlying: IERC20(_underlying),
        _entrypoint: ENTRYPOINT,
        _dustRecipient: DUST_RECIPIENT,
        _zap: IPPYieldTokenZap(_zap),
        _poolVault: POOL_VAULT,
        _nativeMode: _nativeMode
      })
    );
    routerFor[_vault] = _router;
    _allRouters.push(_router);

    emit RouterCreated(_vault, _router, _underlying);
  }
}
