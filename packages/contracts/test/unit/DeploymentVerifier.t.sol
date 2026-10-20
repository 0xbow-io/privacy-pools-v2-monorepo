// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {DeploymentVerifier} from 'script/helpers/DeploymentVerifier.sol';
import {AssetEntry, ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {GovernanceConfig, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Constants} from 'src/utils/Constants.sol';
import {ENTRYPOINT_MANAGER_ROLE, PAUSER_ROLE, POSTMAN_ROLE, UPGRADER_ROLE} from 'src/utils/RolesConstants.sol';

/// @notice External wrapper so `vm.expectRevert` can target the (otherwise internal) library functions.
contract DeploymentVerifierHarness {
  function validateSystemConfig(SystemConfig memory _config) external pure {
    DeploymentVerifier.validateSystemConfig(_config);
  }

  function validateGovernanceConfig(GovernanceConfig memory _gov) external pure {
    DeploymentVerifier.validateGovernanceConfig(_gov);
  }

  function validateChainAssets(ChainAssets memory _chain) external pure {
    DeploymentVerifier.validateChainAssets(_chain);
  }
}

/// @title UnitDeploymentVerifier
/// @notice Negative-path coverage for the pre-flight validation library. Every test mutates exactly one
///         field of an otherwise-valid baseline config so the asserted revert can only come from that
///         field. Happy paths are already exercised by every integration test (`fullDeploy()` runs the
///         same library in `setUp()`).
contract UnitDeploymentVerifier is Test {
  DeploymentVerifierHarness internal _harness;

  function setUp() public {
    _harness = new DeploymentVerifierHarness();
  }

  /*///////////////////////////////////////////////////////////////
                          BASELINE BUILDERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Valid baseline `SystemConfig` — every field individually passes validation.
  ///      Uses `makeAddr` so every address is derived from its semantic label, guaranteed to
  ///      sit far above the precompile cutoff, and shows up in traces with its name.
  function _validSystemConfig() internal returns (SystemConfig memory _config) {
    bytes32[] memory _opsRoles = new bytes32[](3);
    _opsRoles[0] = PAUSER_ROLE;
    _opsRoles[1] = ENTRYPOINT_MANAGER_ROLE;
    _opsRoles[2] = POSTMAN_ROLE;

    address[] memory _pausers = new address[](2);
    _pausers[0] = makeAddr('pauser1');
    _pausers[1] = makeAddr('pauser2');

    address[] memory _unpausers = new address[](1);
    _unpausers[0] = makeAddr('unpauser');

    _config = SystemConfig({
      defaultAdmin: makeAddr('defaultAdmin'),
      opsAdmin: makeAddr('opsAdmin'),
      opsAdminRoles: _opsRoles,
      upgrader: makeAddr('upgrader'),
      pausers: _pausers,
      unpausers: _unpausers,
      entrypointManager: makeAddr('entrypointManager'),
      postman: makeAddr('postman'),
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144,
      maxStateTreeSize: 4_194_304
    });
  }

  /// @dev Valid baseline `GovernanceConfig` — every field individually passes validation.
  function _validGovernanceConfig() internal returns (GovernanceConfig memory _gov) {
    address[] memory _owners = new address[](3);
    _owners[0] = makeAddr('safeOwner1');
    _owners[1] = makeAddr('safeOwner2');
    _owners[2] = makeAddr('safeOwner3');

    _gov = GovernanceConfig({
      owners: _owners,
      threshold: 2,
      shortDelay: 1 hours,
      longDelay: 7 days,
      expiryDelay: 7 days,
      maxApprovalDuration: 30 days,
      emergencyCaller: makeAddr('emergencyCaller'),
      emergencyTrigger: makeAddr('emergencyTrigger')
    });
  }

  /// @dev Valid baseline `ChainAssets` — single enabled native asset.
  function _validChainAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](1);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                  SYSTEM CONFIG — ADDRESS CHECKS
  ///////////////////////////////////////////////////////////////*/

  function test_validateSystemConfig_baselineValid() external {
    _harness.validateSystemConfig(_validSystemConfig());
  }

  function test_validateSystemConfig_revertsOnZeroOpsAdmin() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.opsAdmin = address(0);
    vm.expectRevert(bytes('DeploymentVerifier: opsAdmin is zero'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnPrecompileEntrypointManager() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.entrypointManager = address(9);
    vm.expectRevert(bytes('DeploymentVerifier: entrypointManager is precompile/placeholder'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnSentinelLiteralPostman() external {
    SystemConfig memory _config = _validSystemConfig();
    // `MIN_VALID_ADDRESS` is large enough that the common sentinel literals (0xdead, 0xbeef,
    // 0xA11CE, ...) all sit below the cutoff and are rejected by the precompile/placeholder check.
    _config.postman = address(0xA11CE);
    vm.expectRevert(bytes('DeploymentVerifier: postman is precompile/placeholder'));
    _harness.validateSystemConfig(_config);
  }

  /// @dev `defaultAdmin` and `upgrader` are intentionally not validated for non-zero — they're
  ///      overwritten with the Canon Guard Safe address by the deploy script, so the registry's
  ///      values are always placeholder zeros.
  function test_validateSystemConfig_allowsZeroDefaultAdminAndUpgrader() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.defaultAdmin = address(0);
    _config.upgrader = address(0);
    _harness.validateSystemConfig(_config);
  }

  /*///////////////////////////////////////////////////////////////
                  SYSTEM CONFIG — ARRAY CHECKS
  ///////////////////////////////////////////////////////////////*/

  function test_validateSystemConfig_revertsOnEmptyPausers() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.pausers = new address[](0);
    vm.expectRevert(bytes('DeploymentVerifier: pausers empty'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnPauserContainingZero() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.pausers[1] = address(0);
    vm.expectRevert(bytes('DeploymentVerifier: pauser is zero'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnDuplicatePauser() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.pausers[1] = _config.pausers[0];
    vm.expectRevert(bytes('DeploymentVerifier: duplicate pauser'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnDuplicateOpsAdminRole() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.opsAdminRoles[2] = _config.opsAdminRoles[0];
    vm.expectRevert(bytes('DeploymentVerifier: duplicate opsAdminRole'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnUnknownOpsAdminRole() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.opsAdminRoles[1] = UPGRADER_ROLE; // valid role but not in the ops-admin allowlist
    vm.expectRevert(bytes('DeploymentVerifier: unknown opsAdminRole'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnArbitraryUnknownOpsAdminRole() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.opsAdminRoles[0] = keccak256('SOME_UNKNOWN_ROLE');
    vm.expectRevert(bytes('DeploymentVerifier: unknown opsAdminRole'));
    _harness.validateSystemConfig(_config);
  }

  /*///////////////////////////////////////////////////////////////
                  SYSTEM CONFIG — NUMERICAL CHECKS
  ///////////////////////////////////////////////////////////////*/

  function test_validateSystemConfig_revertsOnZeroRootHistorySize() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.rootHistorySize = 0;
    vm.expectRevert(bytes('DeploymentVerifier: rootHistorySize zero'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnZeroKeystoreRootLiveness() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.keystoreRootLiveness = 0;
    vm.expectRevert(bytes('DeploymentVerifier: keystoreRootLiveness zero'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnKeystoreTreeSizeNotPowerOfTwo() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.maxKeystoreTreeSize = (1 << 18) + 1;
    vm.expectRevert(bytes('DeploymentVerifier: maxKeystoreTreeSize not power of two'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnStateTreeSmallerThanKeystoreTree() external {
    SystemConfig memory _config = _validSystemConfig();
    // both still powers of two, but state < keystore
    _config.maxKeystoreTreeSize = 1 << 18;
    _config.maxStateTreeSize = 1 << 16;
    vm.expectRevert(bytes('DeploymentVerifier: maxStateTreeSize must be >= maxKeystoreTreeSize'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnStateTreeSizeNotPowerOfTwo() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.maxStateTreeSize = (1 << 22) + 1;
    vm.expectRevert(bytes('DeploymentVerifier: maxStateTreeSize not power of two'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnStateTreeSizeTooBig() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.maxStateTreeSize = 1 << 33;
    vm.expectRevert(bytes('DeploymentVerifier: maxStateTreeSize too large'));
    _harness.validateSystemConfig(_config);
  }

  function test_validateSystemConfig_revertsOnStateTreeSizeTooSmall() external {
    SystemConfig memory _config = _validSystemConfig();
    _config.maxKeystoreTreeSize = 1 << 16;
    _config.maxStateTreeSize = 1 << 17;
    vm.expectRevert(bytes('DeploymentVerifier: maxStateTreeSize too small'));
    _harness.validateSystemConfig(_config);
  }

  /*///////////////////////////////////////////////////////////////
                  GOVERNANCE CONFIG CHECKS
  ///////////////////////////////////////////////////////////////*/

  function test_validateGovernanceConfig_baselineValid() external {
    _harness.validateGovernanceConfig(_validGovernanceConfig());
  }

  function test_validateGovernanceConfig_revertsOnEmptyOwners() external {
    GovernanceConfig memory _gov = _validGovernanceConfig();
    _gov.owners = new address[](0);
    vm.expectRevert(bytes('DeploymentVerifier: governance owners empty'));
    _harness.validateGovernanceConfig(_gov);
  }

  function test_validateGovernanceConfig_revertsOnZeroThreshold() external {
    GovernanceConfig memory _gov = _validGovernanceConfig();
    _gov.threshold = 0;
    vm.expectRevert(bytes('DeploymentVerifier: governance threshold zero'));
    _harness.validateGovernanceConfig(_gov);
  }

  function test_validateGovernanceConfig_revertsOnThresholdAboveOwners() external {
    GovernanceConfig memory _gov = _validGovernanceConfig();
    _gov.threshold = _gov.owners.length + 1;
    vm.expectRevert(bytes('DeploymentVerifier: governance threshold > owners'));
    _harness.validateGovernanceConfig(_gov);
  }

  function test_validateGovernanceConfig_revertsOnLongDelayBelowShort() external {
    GovernanceConfig memory _gov = _validGovernanceConfig();
    _gov.longDelay = _gov.shortDelay - 1;
    vm.expectRevert(bytes('DeploymentVerifier: longDelay < shortDelay'));
    _harness.validateGovernanceConfig(_gov);
  }

  function test_validateGovernanceConfig_revertsOnSentinelLiteralEmergencyCaller() external {
    GovernanceConfig memory _gov = _validGovernanceConfig();
    _gov.emergencyCaller = address(0xA11CE);
    vm.expectRevert(bytes('DeploymentVerifier: emergencyCaller is precompile/placeholder'));
    _harness.validateGovernanceConfig(_gov);
  }

  /*///////////////////////////////////////////////////////////////
                          CHAIN ASSET CHECKS
  ///////////////////////////////////////////////////////////////*/

  function test_validateChainAssets_baselineValid() external view {
    _harness.validateChainAssets(_validChainAssets());
  }

  function test_validateChainAssets_revertsOnEnabledZeroMinAmount() external {
    ChainAssets memory _chain = _validChainAssets();
    _chain.assets[0].config.minAmount = 0;
    vm.expectRevert(bytes('DeploymentVerifier: enabled asset has zero minAmount'));
    _harness.validateChainAssets(_chain);
  }

  function test_validateChainAssets_allowsDisabledZeroMinAmount() external view {
    ChainAssets memory _chain = _validChainAssets();
    _chain.assets[0].config.enabled = false;
    _chain.assets[0].config.minAmount = 0;
    _harness.validateChainAssets(_chain);
  }

  function test_validateChainAssets_revertsOnDuplicateToken() external {
    address _dupToken = makeAddr('dupToken');
    AssetEntry[] memory _entries = new AssetEntry[](2);
    _entries[0] = AssetEntry({
      token: _dupToken,
      label: 'A',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _entries[1] = AssetEntry({
      token: _dupToken,
      label: 'B',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    ChainAssets memory _chain;
    _chain.assets = _entries;
    vm.expectRevert(bytes('DeploymentVerifier: duplicate asset token'));
    _harness.validateChainAssets(_chain);
  }

  function test_validateChainAssets_revertsOnFeeAtCap() external {
    ChainAssets memory _chain = _validChainAssets();
    _chain.assets[0].config.vettingFeeBPS = 10_000;
    vm.expectRevert(bytes('DeploymentVerifier: vettingFeeBPS >= 100%'));
    _harness.validateChainAssets(_chain);
  }
}
