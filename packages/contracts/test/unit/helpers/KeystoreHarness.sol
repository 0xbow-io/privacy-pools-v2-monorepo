// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {Keystore} from 'contracts/Keystore.sol';

contract KeystoreHarness is Keystore {
  struct UpdateTreeSpy {
    uint256 oldLeaf;
    uint256 newLeaf;
    uint256[] inclusionProof;
  }

  UpdateTreeSpy[] internal _updateTreeSpies;
  uint256[] public insertInTreeSpies;
  uint256[] public mockedRoots;
  uint256[] public mockedIndices;

  constructor(IAccessControl _accessRouter) Keystore(_accessRouter) {}

  /// @inheritdoc Keystore
  /// @dev This is a mock. It does not actually update the tree, in order to
  /// avoid running into all the edge cases of the tree, and having to build
  /// valid inclusion proofs.
  function _updateTree(
    uint256 _oldLeaf,
    uint256 _newLeaf,
    uint256[] calldata _inclusionProof
  ) internal override returns (uint256, uint256) {
    _updateTreeSpies.push(UpdateTreeSpy(_oldLeaf, _newLeaf, _inclusionProof));
    return (mockedRoots[mockedRoots.length - 1], mockedIndices[mockedIndices.length - 1]);
  }

  function mockRootInsertion(uint256 _newRoot) external {
    mockedRoots.push(_newRoot);
  }

  function mockInsertionIndex(uint256 _newIndex) external {
    mockedIndices.push(_newIndex);
  }

  function updateTreeSpies(uint256 _index) external view returns (UpdateTreeSpy memory) {
    return _updateTreeSpies[_index];
  }

  /// @inheritdoc Keystore
  /// @dev This is a mock. It does not actually update the tree, in order to
  /// avoid running into all the edge cases of the tree, and having to build
  /// valid inclusion proofs.
  function _insertInTree(uint256 _newLeaf) internal override returns (uint256, uint256) {
    insertInTreeSpies.push(_newLeaf);
    return (mockedRoots[mockedRoots.length - 1], mockedIndices[mockedIndices.length - 1]);
  }

  function setViewingKeyForTesting(address _account, bytes32 _viewingKey) external {
    _getKeystoreRootStorage().viewingKeys[_account] = _viewingKey;
  }

  function setNullifyingKeyForTesting(address _account, uint256 _nullifyingKeyHash) external {
    _getKeystoreRootStorage().nullifyingKeys[_account] = _nullifyingKeyHash;
  }

  /// @notice Writes `keystoreTree.size` directly so tests can simulate a near-capacity tree
  ///         without performing `maxKeystoreTreeSize` real insertions.
  function exposed_setKeystoreTreeSize(uint256 _size) external {
    _getKeystoreRootStorage().keystoreTree.size = _size;
  }

  function exposed_updateRoot(uint256 _newRoot) external {
    _updateRoot(_newRoot);
  }

  function exposed_setCurrentRoot(uint256 _root) external {
    _getKeystoreRootStorage().currentRoot = _root;
  }

  function exposed_setPreviousRoot(uint256 _root, uint256 _validUntil) external {
    _getKeystoreRootStorage().previousRoots[_root] = _validUntil;
  }

  /// @notice Exposes the EIP-712 typed-data digest so tests can produce matching signatures
  function exposed_hashTypedDataV4(bytes32 _structHash) external view returns (bytes32) {
    return _hashTypedDataV4(_structHash);
  }
}
