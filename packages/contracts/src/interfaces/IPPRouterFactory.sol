// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

/// @title IPPRouterFactory
/// @author 0xbow
/// @notice Owner-gated factory that deploys and tracks one {PPRouter} per `PPYieldToken`
/// wrapper, for wrappers whose aToken belongs to a single trusted Aave v3 pool and shielding into a
/// single privacy-pool entrypoint. Mirrors `PPYieldTokenZapFactory` (single responsibility; the
/// router's creation code is not embedded in any other factory) but additionally binds the entrypoint
/// and the dust recipient every router needs. Routers hold no funds beyond wei-level supply dust, so
/// deployment carries no custody risk.
interface IPPRouterFactory {
  /*///////////////////////////////////////////////////////////////
                            EVENTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a new router is deployed
  /// @param _vault The PPYieldToken wrapper the router shields into
  /// @param _router The deployed PPRouter
  /// @param _underlying The underlying token the router supplies to Aave
  event RouterCreated(address indexed _vault, address indexed _router, address indexed _underlying);

  /*///////////////////////////////////////////////////////////////
                            ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when a constructor argument is the zero address
  error PPRouterFactory_ZeroAddress();

  /// @notice Thrown when the wrapper's aToken does not belong to this factory's trusted Aave pool
  error PPRouterFactory_NotAavePoolAToken();

  /// @notice Thrown when a router already exists for the wrapper
  error PPRouterFactory_AlreadyDeployed();

  /// @notice Thrown when renouncing ownership is attempted; the owner is transferable but never renounceable so the deploy function is never bricked
  error PPRouterFactory_RenounceDisabled();

  /*///////////////////////////////////////////////////////////////
                            ACTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deploys a {PPRouter} for `_vault`, unwrapping withdrawals through `_zap` (owner only)
  /// @dev Reverts `PPRouterFactory_NotAavePoolAToken` if the wrapper's `asset()` aToken does not
  /// report this factory's pool, and `PPRouterFactory_AlreadyDeployed` if a router exists. The
  /// underlying is derived from the aToken; the pool, entrypoint, pool vault, and dust recipient from
  /// this factory. The router's constructor validates that `_zap` wraps this exact `(vault, underlying)`.
  /// @param _vault The PPYieldToken wrapper to build a router for
  /// @param _zap The zap (for `_vault`) the router unwraps withdrawals through
  /// @return _router The deployed router
  function createRouter(address _vault, address _zap) external returns (address _router);

  /// @notice Deploys a NATIVE-MODE {PPRouter} for `_vault` (owner only) — same wiring and guards as
  ///         {createRouter}, but the router accepts `msg.value` deposits and pays withdrawals in the
  ///         native coin
  /// @dev The wrapper's underlying must be the chain's wrapped-native (WETH9-style) token: the
  /// router's constructor probes it with a zero-value `deposit()`, so a plain-ERC-20 underlying fails
  /// here at deploy time rather than failing the first user. One router per wrapper, regardless of mode.
  /// @param _vault The PPYieldToken wrapper (over the wrapped-native aToken) to build a router for
  /// @param _zap The zap (for `_vault`) the router wraps/unwraps through
  /// @return _router The deployed native-mode router
  function createRouterNative(address _vault, address _zap) external returns (address _router);

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The trusted Aave v3 pool; only wrappers over its aTokens can get a router here
  /// @return _pool The pool address
  function POOL() external view returns (IAavePool _pool);

  /// @notice The privacy-pool entrypoint every router deposits through
  /// @return _entrypoint The entrypoint
  function ENTRYPOINT() external view returns (IEntrypoint _entrypoint);

  /// @notice The privacy-pool vault every router processes withdrawals against
  /// @return _poolVault The pool vault
  function POOL_VAULT() external view returns (IPoolVault _poolVault);

  /// @notice The fixed dust recipient every router is given
  /// @return _recipient The dust recipient
  function DUST_RECIPIENT() external view returns (address _recipient);

  /// @notice The router deployed for a given wrapper (zero if none)
  /// @param _vault The wrapper
  /// @return _router The router address
  function routerFor(address _vault) external view returns (address _router);

  /// @notice The number of routers deployed
  /// @return _count The count
  function routersCount() external view returns (uint256 _count);

  /// @notice The router at index `_i` in deployment order
  /// @param _i The index
  /// @return _router The router address
  function allRouters(uint256 _i) external view returns (address _router);
}
