// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;
import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';

interface IPermissioned {
  /*///////////////////////////////////////////////////////////////
                              ERRORS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Thrown when the caller is not authorized to perform the action
  error Permissioned_NotAuthorized();

  /// @notice Thrown when the access router does not implement IAccessControl
  error Permissioned_InvalidAccessRouter();

  /*///////////////////////////////////////////////////////////////
                        EXTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice The access control router for permission checks
  /// @return _accessRouter The access control router
  function ACCESS_ROUTER() external view returns (IAccessControl _accessRouter);
}
