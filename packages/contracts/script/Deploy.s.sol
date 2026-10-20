// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {ERC1967Proxy} from '@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol';
import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';
import {SafeProxy} from '@safe-smart-account/proxies/SafeProxy.sol';
import {SafeProxyFactory} from '@safe-smart-account/proxies/SafeProxyFactory.sol';
import {Script, console} from 'forge-std/Script.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IERC5564Announcer} from 'interfaces/IERC5564Announcer.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {IRagequitVerifier} from 'interfaces/IRagequitVerifier.sol';
import {AllTransactVerifiers} from 'script/helpers/AllTransactVerifiers.sol';
import {CanonGuardSetupDelegator} from 'script/helpers/CanonGuardSetupDelegator.sol';
import {DeploymentVerifier} from 'script/helpers/DeploymentVerifier.sol';
import {AssetEntry, ChainAssetRegistry, ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {ChainConfigRegistry, GovernanceConfig, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';
import {ASPRegistry} from 'src/contracts/ASPRegistry.sol';
import {AccessRouter} from 'src/contracts/AccessRouter.sol';
import {ERC5564Announcer} from 'src/contracts/ERC5564Announcer.sol';
import {Entrypoint} from 'src/contracts/Entrypoint.sol';
import {Keystore} from 'src/contracts/Keystore.sol';
import {PoolVault} from 'src/contracts/PoolVault.sol';
import {PrivacyPoolRelay} from 'src/contracts/PrivacyPoolRelay.sol';
import {
  DEFAULT_ADMIN_ROLE,
  DEPOSITOR_ROLE,
  ENTRYPOINT_MANAGER_ROLE,
  OPS_ADMIN_ROLE
} from 'src/utils/RolesConstants.sol';

/// @title Deploy
/// @notice Privacy Pools V2 deployment script
///
/// Deployment flow:
///   0. Canon Guard Safe   — deploys a Gnosis Safe with Canon Guard installed.
///                           The factory address is resolved per-chain via
///                           `ChainConfigRegistry._canonGuardFactoryForChain`.
///   1. AccessRouter       — deploys with _tempAdmin as DEFAULT_ADMIN so the script can wire roles
///   2. Keystore (proxy)   — UUPS proxy, initialized with root history size
///   3. ASPRegistry (proxy)— UUPS proxy, initialized (empty state)
///   4. PoolVault (proxy)  — UUPS proxy, atomically initialized with root history, 25 transact
///                           verifiers, and pre-computed Entrypoint address (CREATE nonce prediction)
///   5. Entrypoint (proxy) — UUPS proxy, initialized with PoolVault and ASPRegistry refs
///   6. PrivacyPoolRelay   — stateless relay, immutable refs to PoolVault / Entrypoint / ERC-5564 Announcer
///   7. Grant DEPOSITOR_ROLE to Entrypoint (so it can call PoolVault.deposit)
///   8. Configure chain-specific assets on Entrypoint (only in broadcast mode)
///   9. Transfer DEFAULT_ADMIN_ROLE + OPS_ADMIN_ROLE from deployer to config holders (last step)
///
/// End state:
///   - All proxies are initialized and ready to accept deposits / transacts
///   - Entrypoint holds DEPOSITOR_ROLE on AccessRouter
///   - PoolVault.entrypoint is wired to the Entrypoint
///   - The deployer EOA has no admin roles after deploy
///   - The relay is ready to relay withdrawals through PoolVault
///   - Assets for the target chain are enabled on Entrypoint
///   - DEFAULT_ADMIN_ROLE and UPGRADER_ROLE sit behind the Canon Guard Safe.
contract Deploy is Script, AllTransactVerifiers, ChainAssetRegistry, ChainConfigRegistry {
  /// @dev Safe v1.4.1 canonical deployments (same address across all chains)
  // solhint-disable-next-line private-vars-leading-underscore
  address internal constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
  /// @dev Safe v1.4.1 SafeProxyFactory canonical address — used to atomically deploy and initialise
  ///      see https://github.com/safe-global/safe-deployments
  // solhint-disable-next-line private-vars-leading-underscore
  address internal constant SAFE_PROXY_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
  // solhint-disable-next-line private-vars-leading-underscore
  address internal constant MULTISEND_CALL_ONLY = 0x9641d764fc13c8B624c04430C7356C1C7C8102e2;
  /// @dev Canonical ERC-5564 Announcer singleton — same address across all live chains
  ///      (see https://eips.ethereum.org/EIPS/eip-5564). Used by PrivacyPoolRelay.relayAndAnnounce.
  // solhint-disable-next-line private-vars-leading-underscore
  address internal constant CANONICAL_ERC5564_ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;

  /*///////////////////////////////////////////////////////////////
                          SCRIPT ENTRYPOINTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Production entrypoint — broadcast real transactions.
  ///         Deploys a Canon Guard Safe, then deploys all protocol contracts with the
  ///         Safe as `defaultAdmin` and `upgrader`.
  ///         Resolves role config + asset list + governance config by chain ID via the registries.
  ///         Reverts for unsupported chains — add an entry in ChainConfigRegistry first.
  /// @dev Usage: forge script Deploy --rpc-url $RPC --broadcast --verify
  function run() external returns (Deployment memory _deployment) {
    // Pre-flight config validation on the production broadcast path (finding #131 / AW-M-01):
    // run() is the only broadcast entrypoint, so validate here rather than inside fullDeploy — which
    // tests call directly with fork/placeholder configs. A placeholder or invalid config reverts the
    // run before any contract is broadcast, instead of shipping an ungovernable/misconfigured deployment.
    DeploymentVerifier.validateSystemConfig(_configForChain(block.chainid));
    DeploymentVerifier.validateGovernanceConfig(_governanceForChain(block.chainid));
    DeploymentVerifier.validateChainAssets(_assetsForChain(block.chainid));

    SystemConfig memory _config;
    vm.startBroadcast();
    (_deployment, _config) = fullDeploy(msg.sender);
    vm.stopBroadcast();

    // Post-deploy verification: assert every role landed on its configured holder, the deployer
    // relinquished temp admin, and assets are wired — reverting the run rather than logging a broken deploy.
    DeploymentVerifier.verifyDeployment(_deployment, _config, msg.sender);
    DeploymentVerifier.verifyAssets(_deployment, _assetsForChain(block.chainid));

    _logDeployment(_deployment, _config, address(_deployment.canonGuardSafe));
  }

  /// @notice Full deployment pipeline: Canon Guard Safe, all contracts, asset config, admin transfer.
  ///         run() wraps this with vm.startBroadcast(); tests call it directly.
  function fullDeploy(address _deployer) public returns (Deployment memory _deployment, SystemConfig memory _config) {
    _config = _configForChain(block.chainid);
    ChainAssets memory _assets = _assetsForChain(block.chainid);

    // Step 0: Deploy Canon Guard Safe and use it as both `defaultAdmin` and `upgrader`.
    GovernanceConfig memory _gov = _governanceForChain(block.chainid);
    address _canonGuardSafeAddr = _deployCanonGuardSafe(_gov);
    _config.defaultAdmin = _canonGuardSafeAddr;
    _config.upgrader = _canonGuardSafeAddr;

    // Steps 1-7: Deploy all protocol contracts (deployer retains temp admin)
    _deployment = _deploy(_config, _deployer);
    _deployment.canonGuardSafe = ISafe(_canonGuardSafeAddr);
    _deployment.deployer = _deployer;

    // Step 8: Configure assets (requires ENTRYPOINT_MANAGER_ROLE via temp OPS_ADMIN)
    _configureAssets({
      _entrypoint: _deployment.entrypoint,
      _accessRouter: _deployment.accessRouter,
      _chain: _assets,
      _deployer: _deployer,
      _entrypointManager: _config.entrypointManager
    });

    // Step 9: Transfer admin roles — deployer relinquishes all authority
    _transferAdmin(_deployment.accessRouter, _config, _deployer);
  }

  /// @notice Test entrypoint — deploy with an explicit config (no broadcast, no asset config).
  function deployWithConfig(SystemConfig memory _config) public returns (Deployment memory _deployment) {
    DeploymentVerifier.validateSystemConfig(_config);
    _deployment = _deploy(_config, address(this));
    _deployment.deployer = address(this);
    _transferAdmin(_deployment.accessRouter, _config, address(this));
    DeploymentVerifier.verifyDeployment(_deployment, _config, address(this));
  }

  /// @notice Test entrypoint — deploy a Canon Guard Safe from a GovernanceConfig (no broadcast).
  function deployCanonGuardSafe(GovernanceConfig memory _gov) public returns (address) {
    return _deployCanonGuardSafe(_gov);
  }

  /*///////////////////////////////////////////////////////////////
                      INTERNAL DEPLOY PIPELINE
  ///////////////////////////////////////////////////////////////*/

  /// @dev Core deployment pipeline — deterministic order, no external calls besides contract creation.
  ///
  /// Step-by-step with init status:
  ///   1. AccessRouter       — constructed (no proxy, no init); two-tier admin model
  ///   2. Keystore proxy     — initialized: liveness-gated root scheme of duration `_config.keystoreRootLiveness`
  ///   3. ASPRegistry proxy  — initialized: empty association set array
  ///   4. PoolVault proxy    — initialized: root buffer + 25 transact verifiers + Entrypoint (pre-computed)
  ///   5. Entrypoint proxy   — initialized: PoolVault + ASPRegistry refs
  ///   6. PrivacyPoolRelay   — constructed (no proxy, stateless — immutable refs to PoolVault/Entrypoint/Announcer)
  ///   7. AccessRouter roles — DEPOSITOR_ROLE granted to Entrypoint
  ///   8. Admin transfer     — DEFAULT_ADMIN_ROLE + OPS_ADMIN_ROLE moved from _tempAdmin to config holders
  function _deploy(SystemConfig memory _config, address _tempAdmin) internal returns (Deployment memory _deployment) {
    // Step 1: AccessRouter with _tempAdmin as temporary DEFAULT_ADMIN + OPS_ADMIN
    // so the script can grant DEPOSITOR_ROLE to Entrypoint before transferring admin away
    AccessRouter _accessRouter = new AccessRouter({
      _defaultAdmin: _tempAdmin,
      _opsAdmin: _tempAdmin,
      _opsAdminRoles: _config.opsAdminRoles,
      _upgrader: _config.upgrader,
      _pausers: _config.pausers,
      _unpausers: _config.unpausers,
      _entrypointManager: _config.entrypointManager,
      _postman: _config.postman
    });

    _deployment.accessRouter = _accessRouter;

    // Steps 2-5: Deploy and initialize all proxied contracts
    _deployment.keystore = _deployKeystore(_accessRouter, _config.keystoreRootLiveness, _config.maxKeystoreTreeSize);
    _deployment.aspRegistry = _deployASPRegistry(_accessRouter);
    _deployment.poolVault = _deployPoolVault({
      _accessRouter: _accessRouter,
      _aspRegistry: _deployment.aspRegistry,
      _keystore: _deployment.keystore,
      _rootHistorySize: _config.rootHistorySize,
      _maxStateTreeSize: _config.maxStateTreeSize
    });
    _deployment.entrypoint = _deployEntrypoint(_accessRouter, _deployment.poolVault);

    // Step 6: Deploy relay (needs PoolVault and Entrypoint to be ready) with the resolved ERC-5564 Announcer
    _deployment.relay = _deployRelay(_deployment.poolVault, _deployment.entrypoint, _resolveAnnouncer());

    // Step 7: Entrypoint needs DEPOSITOR_ROLE to call PoolVault.deposit()
    _accessRouter.grantRole(DEPOSITOR_ROLE, address(_deployment.entrypoint));
  }

  /// @dev Transfers admin roles from the temporary deployer to the configured holders.
  ///      Must be called AFTER any operations that require deployer authority (e.g. asset configuration).
  function _transferAdmin(IAccessControl _accessRouter, SystemConfig memory _config, address _tempAdmin) internal {
    if (_config.opsAdmin != _tempAdmin) {
      _accessRouter.grantRole(OPS_ADMIN_ROLE, _config.opsAdmin);
      _accessRouter.revokeRole(OPS_ADMIN_ROLE, _tempAdmin);
    }
    if (_config.defaultAdmin != _tempAdmin) {
      _accessRouter.grantRole(DEFAULT_ADMIN_ROLE, _config.defaultAdmin);
      _accessRouter.revokeRole(DEFAULT_ADMIN_ROLE, _tempAdmin);
    }
  }

  /*///////////////////////////////////////////////////////////////
                    INDIVIDUAL CONTRACT DEPLOYERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Deploys Keystore behind a UUPS proxy and initializes with a liveness-gated root scheme.
  ///      Post-init: keystoreTree is empty, superseded roots will be valid for `_keystoreRootLiveness` seconds,
  ///      and `maxKeystoreTreeSize` bounds tree growth
  function _deployKeystore(
    AccessRouter _accessRouter,
    uint256 _keystoreRootLiveness,
    uint256 _maxKeystoreTreeSize
  ) internal returns (IKeystore _keystore) {
    Keystore _impl = new Keystore(_accessRouter);
    ERC1967Proxy _proxy = new ERC1967Proxy(
      address(_impl), abi.encodeCall(Keystore.initialize, (_keystoreRootLiveness, _maxKeystoreTreeSize))
    );
    _keystore = IKeystore(address(_proxy));
  }

  /// @dev Deploys ASPRegistry behind a UUPS proxy and initializes.
  ///      Post-init: _associationSets array is empty, ready for postman to submit roots.
  function _deployASPRegistry(AccessRouter _accessRouter) internal returns (IASPRegistry _aspRegistry) {
    ASPRegistry _impl = new ASPRegistry(_accessRouter);
    ERC1967Proxy _proxy = new ERC1967Proxy(address(_impl), abi.encodeCall(ASPRegistry.initialize, ()));
    _aspRegistry = IASPRegistry(address(_proxy));
  }

  /// @dev Deploys PoolVault behind a UUPS proxy and initializes with verifiers.
  ///      Post-init: root buffer ready, 25 transact verifiers (1x1..5x5) registered,
  ///      deposit and ragequit verifiers configured, state tree empty, and `maxStateTreeSize`
  ///      bounds tree growth. `aspRegistry` is set here and read by Entrypoint on demand.
  function _deployPoolVault(
    AccessRouter _accessRouter,
    IASPRegistry _aspRegistry,
    IKeystore _keystore,
    uint32 _rootHistorySize,
    uint256 _maxStateTreeSize
  ) internal returns (IPoolVault _poolVault) {
    // Deployed from their compiled artifacts: the verifiers are GPL-3.0, so this BUSL script does not
    // import their source (see src/verifiers/VerifierArtifacts.sol). One CREATE each, as before.
    IRagequitVerifier _ragequitVerifier = IRagequitVerifier(vm.deployCode('VerifierArtifacts.sol:RagequitVerifier'));
    IDepositVerifier _depositVerifier = IDepositVerifier(vm.deployCode('VerifierArtifacts.sol:DepositVerifier'));
    PoolVault _impl = new PoolVault(_accessRouter);
    ERC1967Proxy _proxy = new ERC1967Proxy(
      address(_impl),
      abi.encodeCall(
        PoolVault.initialize,
        (
          _rootHistorySize,
          _allTransactVerifiers(),
          _aspRegistry,
          _keystore,
          _ragequitVerifier,
          _depositVerifier,
          _maxStateTreeSize
        )
      )
    );
    _poolVault = IPoolVault(address(_proxy));
  }

  /// @dev Deploys Entrypoint behind a UUPS proxy and initializes.
  ///      Post-init: UUPS base initialized, asset config mapping is empty.
  function _deployEntrypoint(
    AccessRouter _accessRouter,
    IPoolVault _poolVault
  ) internal returns (IEntrypoint _entrypoint) {
    Entrypoint _impl = new Entrypoint(_accessRouter);
    ERC1967Proxy _proxy = new ERC1967Proxy(address(_impl), abi.encodeCall(Entrypoint.initialize, (_poolVault)));
    _entrypoint = IEntrypoint(address(_proxy));
  }

  /// @dev Deploys PrivacyPoolRelay (no proxy — stateless contract).
  ///      The relay holds immutable references to PoolVault, Entrypoint, and the ERC-5564 Announcer.
  function _deployRelay(
    IPoolVault _poolVault,
    IEntrypoint _entrypoint,
    IERC5564Announcer _announcer
  ) internal returns (IPrivacyPoolRelay _relay) {
    _relay = IPrivacyPoolRelay(address(new PrivacyPoolRelay(_poolVault, _entrypoint, _announcer)));
  }

  /// @dev Resolves the ERC-5564 Announcer used by relayAndAnnounce. Live chains host the canonical
  ///      singleton at a fixed address, so reuse it. A local deploy (anvil, or a fork predating the
  ///      singleton) has no code there, so deploy a fresh minimal announcer to keep relayAndAnnounce
  ///      functional. Keying off on-chain code presence (rather than the chain id) means fork-based
  ///      integration tests transparently get whichever announcer actually exists at that block.
  function _resolveAnnouncer() internal returns (IERC5564Announcer _announcer) {
    if (CANONICAL_ERC5564_ANNOUNCER.code.length != 0) {
      return IERC5564Announcer(CANONICAL_ERC5564_ANNOUNCER);
    }
    // No canonical singleton at this address. Deploying a fresh stand-in is only acceptable on a local
    // chain (anvil, chainid 31337): on any real chain it would fragment the ERC-5564 anonymity set, so
    // refuse rather than silently pin a non-canonical announcer (audit L-B). Fork tests pin a block where
    // the singleton already exists, so they take the branch above and never reach this guard.
    require(block.chainid == 31_337, 'Deploy: canonical ERC-5564 Announcer absent on a non-local chain');
    _announcer = IERC5564Announcer(address(new ERC5564Announcer()));
  }

  /*///////////////////////////////////////////////////////////////
                        ASSET CONFIGURATION
  ///////////////////////////////////////////////////////////////*/

  /// @dev Configures chain-specific assets on the Entrypoint.
  ///      Temporarily grants ENTRYPOINT_MANAGER_ROLE to the deployer (via OPS_ADMIN)
  ///      only when the deployer is not already the configured manager.
  function _configureAssets(
    IEntrypoint _entrypoint,
    IAccessControl _accessRouter,
    ChainAssets memory _chain,
    address _deployer,
    address _entrypointManager
  ) internal {
    bool _usesTemporaryRole = _deployer != _entrypointManager;
    if (_usesTemporaryRole) _accessRouter.grantRole(ENTRYPOINT_MANAGER_ROLE, _deployer);

    for (uint256 _i; _i < _chain.assets.length; ++_i) {
      AssetEntry memory _entry = _chain.assets[_i];
      _entrypoint.setAssetConfiguration(_entry.token, _entry.config);
      console.log('  Asset configured: %s (%s)', _entry.label, _entry.token);
    }

    if (_usesTemporaryRole) _accessRouter.revokeRole(ENTRYPOINT_MANAGER_ROLE, _deployer);
  }

  /*///////////////////////////////////////////////////////////////
                    CANON GUARD SAFE DEPLOYMENT
  ///////////////////////////////////////////////////////////////*/

  /// @dev Deploys a Gnosis Safe with Canon Guard installed in a single transaction.
  ///
  ///      Uses `SafeProxyFactory.createProxyWithNonce` so the proxy deployment AND the
  ///      `Safe.setup` call happen atomically inside the factory.
  ///
  ///      Safe.setup's `to`/`data` delegatecall is used to install Canon Guard atomically
  ///      with the rest of init.
  ///      The chain's factory address is resolved from `ChainConfigRegistry._canonGuardFactoryForChain`
  function _deployCanonGuardSafe(GovernanceConfig memory _gov) internal returns (address) {
    address _factory = _canonGuardFactoryForChain(block.chainid);
    CanonGuardSetupDelegator _delegator = new CanonGuardSetupDelegator();

    bytes memory _setupData = abi.encodeCall(
      CanonGuardSetupDelegator.setupCanonGuard,
      (
        _factory,
        MULTISEND_CALL_ONLY,
        _gov.shortDelay,
        _gov.longDelay,
        _gov.expiryDelay,
        _gov.maxApprovalDuration,
        _gov.emergencyCaller,
        _gov.emergencyTrigger
      )
    );

    bytes memory _initializer = abi.encodeCall(
      ISafe.setup,
      (
        _gov.owners,
        _gov.threshold,
        address(_delegator),
        _setupData,
        address(0), /* fallbackHandler */
        address(0), /* paymentToken    */
        0, /* payment         */
        payable(address(0)) /* paymentReceiver */
      )
    );

    SafeProxyFactory _proxyFactory = SafeProxyFactory(SAFE_PROXY_FACTORY);
    SafeProxy _proxy =
      _proxyFactory.createProxyWithNonce({_singleton: SAFE_SINGLETON, initializer: _initializer, saltNonce: 0});

    return address(_proxy);
  }

  /*///////////////////////////////////////////////////////////////
                        DEPLOYMENT LOGGING
  ///////////////////////////////////////////////////////////////*/

  /// @dev Logs all deployed addresses for verification and record-keeping
  function _logDeployment(Deployment memory _d, SystemConfig memory _c, address _canonGuardSafe) internal pure {
    console.log('');
    console.log('=== Privacy Pools V2 - Deployed Contracts ===');
    console.log('  AccessRouter:     ', address(_d.accessRouter));
    console.log('  Keystore:         ', address(_d.keystore));
    console.log('  ASPRegistry:      ', address(_d.aspRegistry));
    console.log('  PoolVault:        ', address(_d.poolVault));
    console.log('  Entrypoint:       ', address(_d.entrypoint));
    console.log('  PrivacyPoolRelay: ', address(_d.relay));
    console.log('');
    console.log('=== Governance ===');
    console.log('  Canon Guard Safe: ', _canonGuardSafe);
    console.log('');
    console.log('=== Role Holders ===');
    console.log('  DEFAULT_ADMIN:       ', _c.defaultAdmin);
    console.log('  OPS_ADMIN:           ', _c.opsAdmin);
    console.log('  UPGRADER:            ', _c.upgrader);
    console.log('  ENTRYPOINT_MANAGER:  ', _c.entrypointManager);
    console.log('  POSTMAN:             ', _c.postman);
    for (uint256 _i; _i < _c.pausers.length; ++_i) {
      console.log('  PAUSER:              ', _c.pausers[_i]);
    }
    for (uint256 _i; _i < _c.unpausers.length; ++_i) {
      console.log('  UNPAUSER:            ', _c.unpausers[_i]);
    }
    console.log('  rootHistorySize:       ', uint256(_c.rootHistorySize));
    console.log('  keystoreRootLiveness:  ', _c.keystoreRootLiveness);
    console.log('  maxKeystoreTreeSize:   ', _c.maxKeystoreTreeSize);
    console.log('  maxStateTreeSize:      ', _c.maxStateTreeSize);
    console.log('=======================================');
    console.log('');
  }
}
