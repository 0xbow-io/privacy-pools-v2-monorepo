// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {Test} from 'forge-std/Test.sol';
import {IAccessRouter} from 'interfaces/IAccessRouter.sol';
import {AccessRouter} from 'src/contracts/AccessRouter.sol';
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

contract UnitAccessRouterConstructor is Test {
  /////////////////////////////////////////////////////////////////////////////
  //                          constructor tests                              //
  /////////////////////////////////////////////////////////////////////////////

  function _defaultOpsAdminRoles() internal pure returns (bytes32[] memory _roles) {
    _roles = new bytes32[](3);
    _roles[0] = PAUSER_ROLE;
    _roles[1] = ENTRYPOINT_MANAGER_ROLE;
    _roles[2] = POSTMAN_ROLE;
  }

  function test_WhenOpsAdminRolesContainsDEFAULT_ADMIN_ROLE(uint256 _idx) external {
    bytes32[] memory _opsRoles = _defaultOpsAdminRoles();
    _idx = bound(_idx, 0, _opsRoles.length - 1);
    _opsRoles[_idx] = DEFAULT_ADMIN_ROLE;
    vm.expectRevert(abi.encodeWithSelector(IAccessRouter.AccessRouter_AdminRoleEscalation.selector, DEFAULT_ADMIN_ROLE));
    new AccessRouter(
      address(1), address(2), _opsRoles, address(3), new address[](0), new address[](0), address(4), address(5)
    );
  }

  function test_WhenOpsAdminRolesContainsOPS_ADMIN_ROLE(uint256 _idx) external {
    bytes32[] memory _opsRoles = _defaultOpsAdminRoles();
    _idx = bound(_idx, 0, _opsRoles.length - 1);
    _opsRoles[_idx] = OPS_ADMIN_ROLE;
    vm.expectRevert(abi.encodeWithSelector(IAccessRouter.AccessRouter_AdminRoleEscalation.selector, OPS_ADMIN_ROLE));
    new AccessRouter(
      address(1), address(2), _opsRoles, address(3), new address[](0), new address[](0), address(4), address(5)
    );
  }

  function test_WhenCalledWithValidOpsAdminRoles(
    address _defaultAdmin,
    address _opsAdmin,
    address _upgrader,
    address[] memory _pausers,
    address[] memory _unpausers,
    address _entrypointManager,
    address _postman
  ) external {
    bytes32[] memory opsRoles = _defaultOpsAdminRoles();
    IAccessControl router = new AccessRouter(
      _defaultAdmin, _opsAdmin, opsRoles, _upgrader, _pausers, _unpausers, _entrypointManager, _postman
    );
    // It sets the DEFAULT_ADMIN_ROLE
    assertTrue(router.hasRole(DEFAULT_ADMIN_ROLE, _defaultAdmin));
    // It sets the OPS_ADMIN_ROLE
    assertTrue(router.hasRole(OPS_ADMIN_ROLE, _opsAdmin));
    // It sets the UPGRADER_ROLE
    assertTrue(router.hasRole(UPGRADER_ROLE, _upgrader));
    // It sets the PAUSER_ROLE
    for (uint256 i = 0; i < _pausers.length; i++) {
      assertTrue(router.hasRole(PAUSER_ROLE, _pausers[i]));
    }
    // It sets the UNPAUSER_ROLE
    for (uint256 i = 0; i < _unpausers.length; i++) {
      assertTrue(router.hasRole(UNPAUSER_ROLE, _unpausers[i]));
    }
    // It sets the ENTRYPOINT_MANAGER_ROLE
    assertTrue(router.hasRole(ENTRYPOINT_MANAGER_ROLE, _entrypointManager));
    // It sets the POSTMAN_ROLE
    assertTrue(router.hasRole(POSTMAN_ROLE, _postman));

    // It sets DEFAULT_ADMIN_ROLE to manage default (timelocked) roles
    assertEq(router.getRoleAdmin(DEFAULT_ADMIN_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(OPS_ADMIN_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(UPGRADER_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(UNPAUSER_ROLE), DEFAULT_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(DEPOSITOR_ROLE), DEFAULT_ADMIN_ROLE);

    // It sets OPS_ADMIN_ROLE to manage operational roles
    assertEq(router.getRoleAdmin(PAUSER_ROLE), OPS_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(ENTRYPOINT_MANAGER_ROLE), OPS_ADMIN_ROLE);
    assertEq(router.getRoleAdmin(POSTMAN_ROLE), OPS_ADMIN_ROLE);
  }
}
