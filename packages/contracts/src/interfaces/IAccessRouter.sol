// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

interface IAccessRouter {
  /*///////////////////////////////////////////////////////////////
                              ERRORS
  //////////////////////////////////////////////////////////////*/

  /// @notice Thrown when an ops-admin role assignment would grant control over DEFAULT_ADMIN_ROLE or OPS_ADMIN_ROLE
  /// @param role The role that would cause escalation
  error AccessRouter_AdminRoleEscalation(bytes32 role);
}
