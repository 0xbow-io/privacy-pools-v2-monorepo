// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @title ITreeUpdates
/// @notice Interface for offchain infrastructure to track the state of the
/// protocol's merkle trees
/// @dev Used by contracts managing Lean Incremental Merkle Trees
interface ITreeUpdates {
  /*///////////////////////////////////////////////////////////////
                              EVENTS
  //////////////////////////////////////////////////////////////*/

  /// @notice Emitted when a single leaf is inserted into the merkle tree
  /// @param _newLeaf The value of the newly inserted leaf
  /// @param _root The new merkle root after insertion
  /// @param _leafIndex The position of the inserted leaf in the leaves array
  event LeafInserted(uint256 _newLeaf, uint256 _root, uint256 _leafIndex);

  /// @notice Emitted when multiple leaves are inserted into the merkle tree
  /// @param _newLeaves The values of the newly inserted leaves
  /// @param _root The new merkle root after all insertions
  /// @param _startIndex The position of the first inserted leaf in the leaves array
  event LeavesInserted(uint256[] _newLeaves, uint256 _root, uint256 _startIndex);

  /// @notice Emitted when an existing leaf is updated in the merkle tree
  /// @param _newLeaf The new value of the updated leaf
  /// @param _root The new merkle root after the update
  /// @param _leafIndex The position of the updated leaf in the leaves array
  event LeafUpdated(uint256 _newLeaf, uint256 _root, uint256 _leafIndex);
}
