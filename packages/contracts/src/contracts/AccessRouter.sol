// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {AccessControl} from '@openzeppelin/contracts/access/AccessControl.sol';
import {IAccessRouter} from 'interfaces/IAccessRouter.sol';
import {
  DEFAULT_ADMIN_ROLE,
  ENTRYPOINT_MANAGER_ROLE,
  OPS_ADMIN_ROLE,
  PAUSER_ROLE,
  POSTMAN_ROLE,
  UNPAUSER_ROLE,
  UPGRADER_ROLE
} from 'src/utils/RolesConstants.sol';

/// @title AccessRouter
/// @notice Centralized role-based access control registry for Privacy Pools V2
/// @dev Contracts query this registry to verify caller permissions.
///
///      Two-tier admin (OpenZeppelin `AccessControl` + per-role admins set in the constructor):
///      - `DEFAULT_ADMIN_ROLE` is meant for **slow** governance (e.g. Canon Guard behind a timelock).
///        It is the admin of `OPS_ADMIN_ROLE` and of every role not listed in `_opsAdminRoles`.
///      - `OPS_ADMIN_ROLE` is meant for a **fast** operational multisig for roles listed in `_opsAdminRoles`.
///
///      **Hierarchy:** holders of `DEFAULT_ADMIN_ROLE` can grant or revoke `OPS_ADMIN_ROLE` (and thus
///      replace a compromised ops multisig). Holders of `OPS_ADMIN_ROLE` cannot administer
///      `DEFAULT_ADMIN_ROLE` or change who holds it. The constructor rejects `_opsAdminRoles` entries
///      equal to `DEFAULT_ADMIN_ROLE` or `OPS_ADMIN_ROLE` so this asymmetry cannot be configured away by mistake.
contract AccessRouter is AccessControl, IAccessRouter {
  /// @notice Initializes the AccessRouter with roles and permissions
  /// @param _defaultAdmin Address holding `DEFAULT_ADMIN_ROLE` (timelocked governance)
  /// @param _opsAdmin Address holding `OPS_ADMIN_ROLE` (fast operational multisig)
  /// @param _opsAdminRoles Roles whose `getRoleAdmin(role)` is set to `OPS_ADMIN_ROLE` instead of the default `DEFAULT_ADMIN_ROLE`
  /// @param _upgrader Address that can upgrade contracts
  /// @param _pausers Addresses that can pause the pool
  /// @param _unpausers Addresses that can unpause the pool
  /// @param _entrypointManager Address that can configure assets and sweep fees
  /// @param _postman Address that can submit ASP roots
  constructor(
    address _defaultAdmin,
    address _opsAdmin,
    bytes32[] memory _opsAdminRoles,
    address _upgrader,
    address[] memory _pausers,
    address[] memory _unpausers,
    address _entrypointManager,
    address _postman
  ) {
    for (uint256 _i; _i < _opsAdminRoles.length; ++_i) {
      bytes32 _role = _opsAdminRoles[_i];
      require(_role != DEFAULT_ADMIN_ROLE && _role != OPS_ADMIN_ROLE, AccessRouter_AdminRoleEscalation(_role));
      _setRoleAdmin(_role, OPS_ADMIN_ROLE);
    }

    _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
    _grantRole(OPS_ADMIN_ROLE, _opsAdmin);
    _grantRole(UPGRADER_ROLE, _upgrader);
    _grantRole(ENTRYPOINT_MANAGER_ROLE, _entrypointManager);
    _grantRole(POSTMAN_ROLE, _postman);

    for (uint256 _i; _i < _pausers.length; ++_i) {
      _grantRole(PAUSER_ROLE, _pausers[_i]);
    }

    for (uint256 _i; _i < _unpausers.length; ++_i) {
      _grantRole(UNPAUSER_ROLE, _unpausers[_i]);
    }
  }
}
