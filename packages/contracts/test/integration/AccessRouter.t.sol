// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {
  DEFAULT_ADMIN_ROLE,
  DEPOSITOR_ROLE,
  ENTRYPOINT_MANAGER_ROLE,
  OPS_ADMIN_ROLE,
  PAUSER_ROLE,
  POSTMAN_ROLE,
  UNPAUSER_ROLE,
  UPGRADER_ROLE
} from 'src/utils/RolesConstants.sol';

contract AccessRouterIntegration is IntegrationBase {
  function test_deployPermissions() external view {
    assertTrue(_accessRouter.hasRole(DEFAULT_ADMIN_ROLE, _config.defaultAdmin));
    assertTrue(_accessRouter.hasRole(OPS_ADMIN_ROLE, _config.opsAdmin));
    assertTrue(_accessRouter.hasRole(UPGRADER_ROLE, _config.upgrader));
    assertTrue(_accessRouter.hasRole(PAUSER_ROLE, _config.pausers[0]));
    assertTrue(_accessRouter.hasRole(PAUSER_ROLE, _config.pausers[1]));
    assertTrue(_accessRouter.hasRole(UNPAUSER_ROLE, _config.unpausers[0]));
    assertTrue(_accessRouter.hasRole(ENTRYPOINT_MANAGER_ROLE, _config.entrypointManager));
    assertTrue(_accessRouter.hasRole(POSTMAN_ROLE, _config.postman));
    assertTrue(_accessRouter.hasRole(POSTMAN_ROLE, _postman));
    assertTrue(_accessRouter.hasRole(DEPOSITOR_ROLE, address(_entrypoint)));
  }

  function test_roleAdminTiers() external view {
    assertEq(_accessRouter.getRoleAdmin(DEFAULT_ADMIN_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(OPS_ADMIN_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(UPGRADER_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(UNPAUSER_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(DEPOSITOR_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(PAUSER_ROLE), OPS_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(ENTRYPOINT_MANAGER_ROLE), OPS_ADMIN_ROLE);
    assertEq(_accessRouter.getRoleAdmin(POSTMAN_ROLE), OPS_ADMIN_ROLE);
  }

  function test_opsAdminCanGrantOperationalRoles(address _grantee) external {
    vm.startPrank(_config.opsAdmin);
    _accessRouter.grantRole(PAUSER_ROLE, _grantee);
    _accessRouter.grantRole(ENTRYPOINT_MANAGER_ROLE, _grantee);
    _accessRouter.grantRole(POSTMAN_ROLE, _grantee);
    vm.stopPrank();

    assertTrue(_accessRouter.hasRole(PAUSER_ROLE, _grantee));
    assertTrue(_accessRouter.hasRole(ENTRYPOINT_MANAGER_ROLE, _grantee));
    assertTrue(_accessRouter.hasRole(POSTMAN_ROLE, _grantee));
  }

  function test_opsAdminCannotGrantCriticalRoles(address _grantee) external {
    bytes memory _err = abi.encodeWithSelector(
      IAccessControl.AccessControlUnauthorizedAccount.selector, _config.opsAdmin, DEFAULT_ADMIN_ROLE
    );

    vm.startPrank(_config.opsAdmin);

    vm.expectRevert(_err);
    _accessRouter.grantRole(DEFAULT_ADMIN_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(OPS_ADMIN_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(UPGRADER_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(UNPAUSER_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(DEPOSITOR_ROLE, _grantee);

    vm.stopPrank();
  }

  /// @dev By design: ops roles have OPS_ADMIN as their roleAdmin (via _setRoleAdmin in constructor),
  ///      so DEFAULT_ADMIN cannot grant them directly. It retains indirect control by being able to
  ///      replace the OPS_ADMIN holder.
  function test_defaultAdminCannotGrantOperationalRoles(address _grantee) external {
    bytes memory _err = abi.encodeWithSelector(
      IAccessControl.AccessControlUnauthorizedAccount.selector, _config.defaultAdmin, OPS_ADMIN_ROLE
    );

    vm.startPrank(_config.defaultAdmin);

    vm.expectRevert(_err);
    _accessRouter.grantRole(PAUSER_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(ENTRYPOINT_MANAGER_ROLE, _grantee);
    vm.expectRevert(_err);
    _accessRouter.grantRole(POSTMAN_ROLE, _grantee);

    vm.stopPrank();
  }

  function test_newRolesCanBeCreated(bytes32 _newRole, address _grantee) external {
    // Exclude opsAdminRoles — their admin is OPS_ADMIN, not DEFAULT_ADMIN
    vm.assume(_newRole != PAUSER_ROLE);
    vm.assume(_newRole != ENTRYPOINT_MANAGER_ROLE);
    vm.assume(_newRole != POSTMAN_ROLE);

    vm.prank(_config.defaultAdmin);
    _accessRouter.grantRole(_newRole, _grantee);

    assertTrue(_accessRouter.hasRole(_newRole, _grantee));
    assertEq(_accessRouter.getRoleAdmin(_newRole), DEFAULT_ADMIN_ROLE);
  }

  function test_opsAdminCannotCreateNewRoles(bytes32 _newRole, address _grantee) external {
    // Exclude opsAdminRoles — opsAdmin CAN grant these, so expectRevert would fail
    vm.assume(_newRole != PAUSER_ROLE);
    vm.assume(_newRole != ENTRYPOINT_MANAGER_ROLE);
    vm.assume(_newRole != POSTMAN_ROLE);

    vm.prank(_config.opsAdmin);
    vm.expectRevert(
      abi.encodeWithSelector(
        IAccessControl.AccessControlUnauthorizedAccount.selector, _config.opsAdmin, DEFAULT_ADMIN_ROLE
      )
    );
    _accessRouter.grantRole(_newRole, _grantee);
  }
}
