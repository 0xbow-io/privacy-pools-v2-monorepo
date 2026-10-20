// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {GovernanceConfig} from 'script/registries/ChainConfigRegistry.sol';
import {DEFAULT_ADMIN_ROLE, UPGRADER_ROLE} from 'src/utils/RolesConstants.sol';

/// @title CanonGuardDeployIntegration
/// @notice Verifies that fullDeploy() produces a properly configured Canon Guard Safe
///         wired as defaultAdmin + upgrader on the AccessRouter.
///         Extends IntegrationBase so all assertions run against the actual deployment output.
contract CanonGuardDeployIntegration is IntegrationBase {
  bytes32 internal constant GUARD_STORAGE_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8;

  function setUp() public override {
    super.setUp();
    if (_usingSepoliaDeployment) vm.skip(true);
  }

  /*///////////////////////////////////////////////////////////////
                  CANON GUARD SAFE FROM FULL DEPLOY
  ///////////////////////////////////////////////////////////////*/

  function test_fullDeploy_createsValidSafe() external view {
    GovernanceConfig memory _gov = _mainnetGovernance();
    ISafe _safe = _canonGuardSafe;

    assertTrue(address(_safe) != address(0), 'Safe address should not be zero');
    assertTrue(address(_safe).code.length > 0, 'Safe should be a contract');

    address[] memory _owners = _safe.getOwners();
    assertEq(_owners.length, _gov.owners.length, 'owner count mismatch');
    for (uint256 _i; _i < _gov.owners.length; ++_i) {
      assertTrue(_safe.isOwner(_gov.owners[_i]), 'expected owner not found');
    }
    assertEq(_safe.getThreshold(), _gov.threshold, 'threshold mismatch');
  }

  function test_fullDeploy_installsGuard() external view {
    // Safe v1.4.1 has no getGuard() — read the guard address directly from storage
    address _guard = address(uint160(uint256(vm.load(address(_canonGuardSafe), GUARD_STORAGE_SLOT))));
    assertTrue(_guard != address(0), 'Canon Guard should be installed');
    assertTrue(_guard.code.length > 0, 'Canon Guard should be a contract');
  }

  function test_fullDeploy_safeHoldsAdminRoles() external view {
    address _safe = address(_canonGuardSafe);
    assertTrue(_accessRouter.hasRole(DEFAULT_ADMIN_ROLE, _safe), 'Safe should hold DEFAULT_ADMIN_ROLE');
    assertTrue(_accessRouter.hasRole(UPGRADER_ROLE, _safe), 'Safe should hold UPGRADER_ROLE');
  }

  function test_fullDeploy_configPointsToSafe() external view {
    assertEq(_config.defaultAdmin, address(_canonGuardSafe), 'config.defaultAdmin should be the Safe');
    assertEq(_config.upgrader, address(_canonGuardSafe), 'config.upgrader should be the Safe');
  }
}
