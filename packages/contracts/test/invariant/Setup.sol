// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {Constants} from './Constants.sol';
import {HandlerDeposit} from './handlers/HandlerDeposit.sol';
import {HandlerRagequit} from './handlers/HandlerRagequit.sol';
import {HandlerTarget} from './handlers/HandlerTarget.sol';
import {HandlerTransact} from './handlers/HandlerTransact.sol';
import {StdInvariant} from 'forge-std/StdInvariant.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {Deploy} from 'script/Deploy.s.sol';
import {SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';
import {VETTING_FEE_BPS} from 'test/handlers/HandlerBase.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {Constants as ProtocolConstants} from 'utils/Constants.sol';
import {ENTRYPOINT_MANAGER_ROLE, PAUSER_ROLE, POSTMAN_ROLE} from 'utils/RolesConstants.sol';

contract Setup is Test, Constants {
  HandlerTarget internal _handler;

  /// @dev Protocol contracts kept for invariant assertions
  IPoolVault internal _poolVault;
  IEntrypoint internal _entrypoint;
  IPrivacyPoolRelay internal _privacyPoolRelay;

  function setUp() public virtual {
    MockERC20 _token1 = new MockERC20('Mock Token 1', 'TOKEN1', 18);
    MockERC20 _token2 = new MockERC20('Mock Token 2', 'TOKEN2', 18);
    SystemConfig memory _cfg = _buildInvariantConfig();

    // Deploy protocol via test entrypoint, skipping cannon guard setup
    Deploy _deployer = new Deploy();
    Deployment memory _d = _deployer.deployWithConfig(_cfg);

    // Store references needed by invariant checks
    _poolVault = _d.poolVault;
    _entrypoint = _d.entrypoint;
    _privacyPoolRelay = _d.relay;

    // Configure supported assets on the entrypoint
    IEntrypoint.AssetConfig memory _assetConfig = IEntrypoint.AssetConfig({
      enabled: true, minAmount: MIN_AMOUNT, vettingFeeBPS: VETTING_FEE_BPS, maxRelayFee: MAX_RELAY_FEE
    });
    vm.startPrank(_cfg.entrypointManager);
    _entrypoint.setAssetConfiguration(ProtocolConstants.NATIVE_ASSET, _assetConfig);
    _entrypoint.setAssetConfiguration(address(_token1), _assetConfig);
    _entrypoint.setAssetConfiguration(address(_token2), _assetConfig);
    vm.stopPrank();

    address[] memory _assetList = new address[](3);
    _assetList[0] = ProtocolConstants.NATIVE_ASSET;
    _assetList[1] = address(_token1);
    _assetList[2] = address(_token2);

    _handler = new HandlerTarget(
      _d.entrypoint,
      _d.poolVault,
      _d.relay,
      _d.aspRegistry,
      _d.keystore,
      _d.accessRouter,
      _cfg.postman,
      _cfg.pausers[0],
      _cfg.unpausers[0],
      _cfg.entrypointManager,
      _assetList
    );
    targetContract(address(_handler));
    bytes4[] memory _selectors = new bytes4[](5);
    _selectors[0] = HandlerDeposit.external_generateDepositProof.selector;
    _selectors[1] = HandlerDeposit.external_submitDepositProof.selector;
    _selectors[2] = HandlerRagequit.external_generateRagequitProof.selector;
    _selectors[3] = HandlerTransact.external_generateTransactProof.selector;
    _selectors[4] = HandlerTransact.external_submitTransact.selector;
    excludeSelector(StdInvariant.FuzzSelector({addr: address(_handler), selectors: _selectors}));
  }

  /// @dev Asset-agnostic balance helper used by per-asset invariants.
  function _balanceOf(address _asset, address _account) internal view returns (uint256) {
    return _asset == ProtocolConstants.NATIVE_ASSET ? _account.balance : SafeTransferLib.balanceOf(_asset, _account);
  }

  /// @dev Address of the 1st ERC-20 (TOKEN1). Resolved through the asset list rather than a
  ///      storage handle so deployment + accounting share a single source of truth (`_assets`).
  function _token1() internal view returns (address) {
    return _handler.assets(1);
  }

  /// @dev Address of the 2nd ERC-20 (TOKEN2). Same rationale as `_token1`.
  function _token2() internal view returns (address) {
    return _handler.assets(2);
  }

  /// @dev Build a SystemConfig with deterministic test addresses (no chain registry needed)
  function _buildInvariantConfig() internal returns (SystemConfig memory _cfg) {
    bytes32[] memory _opsRoles = new bytes32[](3);
    _opsRoles[0] = PAUSER_ROLE;
    _opsRoles[1] = ENTRYPOINT_MANAGER_ROLE;
    _opsRoles[2] = POSTMAN_ROLE;

    address[] memory _pausers = new address[](1);
    _pausers[0] = makeAddr('pauser');
    address[] memory _unpausers = new address[](1);
    _unpausers[0] = makeAddr('unpauser');

    _cfg = SystemConfig({
      defaultAdmin: makeAddr('defaultAdmin'),
      opsAdmin: makeAddr('opsAdmin'),
      opsAdminRoles: _opsRoles,
      upgrader: makeAddr('upgrader'),
      pausers: _pausers,
      unpausers: _unpausers,
      entrypointManager: makeAddr('entrypointManager'),
      postman: makeAddr('postman'),
      // consider treating this as a hyperparameter ; running the campaign with
      // this set to what we'll eventually set in the various chains
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }
}
