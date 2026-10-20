// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ASPRegistry} from 'contracts/ASPRegistry.sol';

contract ASPRegistryHarness is ASPRegistry {
  constructor(IAccessControl _mockAccessRouter) ASPRegistry(_mockAccessRouter) {}

  function authorizeUpgrade(address newImplementation) external {
    _authorizeUpgrade(newImplementation);
  }

  /// @notice Helper method to manually populate the associationSets array for testing
  /// @param _root The root to add
  /// @param _ipfsCID The IPFS CID associated with the root
  function addAssociationSet(uint256 _root, bytes memory _ipfsCID) external {
    _getASPRegistryStorage().associationSets.push(AssociationSetData({root: _root, ipfsCID: _ipfsCID}));
  }
}
