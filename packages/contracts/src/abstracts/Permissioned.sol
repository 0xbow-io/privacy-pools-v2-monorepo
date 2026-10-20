// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ERC165Checker} from '@openzeppelin/contracts/utils/introspection/ERC165Checker.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';

/// @title Permissioned
/// @notice Single point of implementation for checking msg.sender permissions
/// on access router
abstract contract Permissioned is IPermissioned {
  /*///////////////////////////////////////////////////////////////
                            IMMUTABLES
  ///////////////////////////////////////////////////////////////*/
  /// @inheritdoc IPermissioned
  IAccessControl public immutable ACCESS_ROUTER;

  /*///////////////////////////////////////////////////////////////
                            MODIFIERS
  ///////////////////////////////////////////////////////////////*/
  /// @notice Checks if the caller has the required role
  /// @param _role The role to check
  modifier checkAccess(bytes32 _role) {
    _checkAccess(_role);
    _;
  }

  /// @notice Initializes the Permissioned contract with the access router
  /// @param _accessRouter The access control router contract
  constructor(IAccessControl _accessRouter) {
    require(
      ERC165Checker.supportsInterface(address(_accessRouter), type(IAccessControl).interfaceId),
      Permissioned_InvalidAccessRouter()
    );
    ACCESS_ROUTER = _accessRouter;
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Checks if the caller has the required role
  /// @param _role The role to check
  function _checkAccess(bytes32 _role) internal view {
    require(ACCESS_ROUTER.hasRole(_role, msg.sender), Permissioned_NotAuthorized());
  }
}
