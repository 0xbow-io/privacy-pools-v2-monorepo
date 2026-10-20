// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

/// @notice Test-only Merkle tree that stores the full tree for Merkle proof generation.
/// @dev The on-chain LeanIMT only stores sideNodes (frontier) for gas efficiency.
///      This library stores ALL nodes so we can produce (index, siblings[], depth) tuples
///      for circuit inputs. `insert` is adapted from LeanIMT._insert; everything else
///      (update, generateProof, root) is custom for the full-node-storage layout.
library MerkleTree {
  error MerkleTree_IndexOutOfBounds();

  struct MerkleProof {
    uint256 index;
    uint256[] siblings;
    uint256 depth;
  }

  struct Tree {
    uint256 size;
    uint256 depth;
    /// @dev nodes[level][position] — full binary tree storage
    mapping(uint256 => mapping(uint256 => uint256)) nodes;
  }

  /// @notice Insert a single leaf and update all affected nodes
  /// @dev Adapted from LeanIMT._insert — same depth-growth and hash-propagation logic,
  ///      but writes every node to `nodes[level][position]` instead of only the frontier.
  /// @return root_ The new root after insertion
  function insert(Tree storage _self, uint256 _leaf) internal returns (uint256 root_) {
    uint256 _index = _self.size;
    uint256 _treeDepth = _self.depth;

    if (1 << _treeDepth < _index + 1) {
      ++_treeDepth;
    }

    _self.depth = _treeDepth;
    _self.nodes[0][_index] = _leaf;

    uint256 _node = _leaf;
    uint256 _levelIndex = _index;

    for (uint256 _level; _level < _treeDepth; ++_level) {
      if (_levelIndex & 1 == 1) {
        uint256 _leftSibling = _self.nodes[_level][_levelIndex - 1];
        _node = PoseidonT3.hash([_leftSibling, _node]);
      }
      // If left child (even index) with no right sibling → parent = self (LeanIMT rule)

      _levelIndex >>= 1;
      _self.nodes[_level + 1][_levelIndex] = _node;
    }

    _self.size = _index + 1;
    root_ = _node;
  }

  /// @notice Update an existing leaf and recompute all affected parent nodes
  /// @dev Custom implementation. LeanIMT._update takes (oldLeaf, newLeaf, siblingNodes[])
  ///      and verifies against the old root. Ours takes a leaf index and reads
  ///      siblings directly from stored nodes — possible because we keep the full tree.
  /// @param _self The tree
  /// @param _leafIndex The 0-based leaf position to update
  /// @param _newLeaf The replacement leaf value
  /// @return root_ The new root after the update
  function update(Tree storage _self, uint256 _leafIndex, uint256 _newLeaf) internal returns (uint256 root_) {
    require(_leafIndex < _self.size, MerkleTree_IndexOutOfBounds());

    uint256 _treeDepth = _self.depth;
    _self.nodes[0][_leafIndex] = _newLeaf;

    uint256 _node = _newLeaf;
    uint256 _levelIndex = _leafIndex;
    uint256 _levelSize = _self.size;

    for (uint256 _level; _level < _treeDepth; ++_level) {
      if (_levelIndex & 1 == 1) {
        uint256 _leftSibling = _self.nodes[_level][_levelIndex - 1];
        _node = PoseidonT3.hash([_leftSibling, _node]);
      } else {
        uint256 _siblingIndex = _levelIndex + 1;
        if (_siblingIndex < _levelSize) {
          uint256 _rightSibling = _self.nodes[_level][_siblingIndex];
          _node = PoseidonT3.hash([_node, _rightSibling]);
        }
      }

      _levelIndex >>= 1;
      _levelSize = (_levelSize + 1) >> 1;
      _self.nodes[_level + 1][_levelIndex] = _node;
    }

    root_ = _node;
  }

  /// @notice Generate a LeanIMT-compatible inclusion proof for the leaf at the given index
  /// @dev Custom implementation — LeanIMT has no proof generation (it's on-chain only).
  ///      The proof follows LeanIMT conventions: levels where the node has no sibling
  ///      are skipped (parent = child), producing a compressed proof with a potentially
  ///      re-encoded index. Siblings are then zero-padded to _maxDepth for the circuit.
  /// @param _self The tree
  /// @param _leafIndex The 0-based leaf position
  /// @param _maxDepth The circuit's maximum depth (for padding)
  /// @return proof_ The Merkle proof with padded siblings
  function generateProof(
    Tree storage _self,
    uint256 _leafIndex,
    uint256 _maxDepth
  ) internal view returns (MerkleProof memory proof_) {
    require(_leafIndex < _self.size, MerkleTree_IndexOutOfBounds());

    uint256 _treeDepth = _self.depth;
    uint256[] memory _tempSiblings = new uint256[](_treeDepth);
    uint256[] memory _tempPath = new uint256[](_treeDepth);
    uint256 _proofLen;

    uint256 _currentIndex = _leafIndex;

    uint256 _levelSize = _self.size;

    for (uint256 _level; _level < _treeDepth; ++_level) {
      bool _isRight = (_currentIndex & 1) == 1;
      uint256 _siblingIndex = _isRight ? _currentIndex - 1 : _currentIndex + 1;

      bool _siblingExists;
      if (_isRight) {
        // Left sibling always exists if we are the right child
        _siblingExists = true;
      } else {
        _siblingExists = _siblingIndex < _levelSize;
      }

      if (_siblingExists) {
        _tempSiblings[_proofLen] = _self.nodes[_level][_siblingIndex];
        _tempPath[_proofLen] = _isRight ? 1 : 0;
        ++_proofLen;
      }

      _currentIndex >>= 1;
      _levelSize = (_levelSize + 1) >> 1;
    }

    // Reconstruct the compressed index from path bits (LeanIMT convention)
    uint256 _compressedIndex;
    for (uint256 i; i < _proofLen; ++i) {
      _compressedIndex |= _tempPath[i] << i;
    }

    // Build padded siblings array for circuit consumption
    uint256[] memory _paddedSiblings = new uint256[](_maxDepth);
    for (uint256 i; i < _proofLen; ++i) {
      _paddedSiblings[i] = _tempSiblings[i];
    }

    proof_.index = _compressedIndex;
    proof_.siblings = _paddedSiblings;
    proof_.depth = _proofLen;
  }

  /// @notice Get the current root (top-level node)
  /// @dev Custom — LeanIMT stores the root as sideNodes[depth]; we use nodes[depth][0].
  function root(Tree storage _self) internal view returns (uint256) {
    if (_self.size == 0) return 0;
    return _self.nodes[_self.depth][0];
  }

  /// @notice Leaf value stored at a given leaf index (level 0)
  function leafAt(Tree storage _self, uint256 _leafIndex) internal view returns (uint256) {
    return _self.nodes[0][_leafIndex];
  }
}
