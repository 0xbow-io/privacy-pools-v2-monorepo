// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerBase, Note} from './HandlerBase.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {RagequitProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

contract HandlerRagequit is HandlerBase {
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using ProofLibV2 for ProofLibV2.RagequitProof;
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /// @dev Executes a ragequit and mirrors the resulting state-tree leaf
  function _submitRagequit(
    UserIdentityLib.UserIdentity memory _user,
    ProofLibV2.RagequitProof memory _rqProof
  ) internal {
    uint256 _stateTreeSizeBefore = _stateTreeMirror.size;

    vm.prank(_user.addr);
    _poolVault.ragequit(_rqProof);
    _stateTreeMirror.insert(_nullifierLeaf(_rqProof.nullifierHash()));
    _trackNullifierLeaf(_rqProof.nullifierHash(), _stateTreeMirror.size - 1);

    assertEq(_stateTreeMirror.size - _stateTreeSizeBefore, 1, 'Ragequit should insert exactly one state tree leaf');
  }

  /// @dev Builds proof, executes ragequit, and mirrors the state tree in one step
  function _ragequit(
    UserIdentityLib.UserIdentity memory _user,
    Note memory _note
  ) internal returns (ProofLibV2.RagequitProof memory _rqProof) {
    _rqProof = _buildAndGenerateRagequitProof(_user, _note);
    _submitRagequit(_user, _rqProof);
  }

  /// @dev maps into `ProofGenerator.RagequitInputs`, called from the `_buildRagequitInputs` overloads
  function _assembleRagequitInputs(
    UserIdentityLib.UserIdentity memory _user,
    uint256 _value,
    uint256 _noteSecret,
    uint256 _tokenId,
    uint256 _label,
    uint256 _keystoreRoot,
    MerkleTree.MerkleProof memory _ksProof
  ) private pure returns (ProofGenerator.RagequitInputs memory inputs_) {
    inputs_ = ProofGenerator.RagequitInputs({
      keystoreRoot: _keystoreRoot,
      ownerAddress: _user.ownerAddress,
      value: _value,
      tokenId: _tokenId,
      label: _label,
      noteSecret: _noteSecret,
      metadata: DEFAULT_NOTE_METADATA,
      privateNullifyingKey: _user.privNullifyingKey,
      privateRevocableKey: _user.privRevocableKey,
      keystoreLeafIndex: _ksProof.index,
      keystoreSiblings: _ksProof.siblings,
      keystoreTreeDepth: _ksProof.depth
    });
  }

  /// @dev Default path: on-chain keystore root and proof at `_user.keystoreIndex`; value, noteSecret,
  ///      tokenId, and label are read from `_note`
  function _buildRagequitInputs(
    UserIdentityLib.UserIdentity memory _user,
    Note memory _note
  ) internal view returns (ProofGenerator.RagequitInputs memory) {
    MerkleTree.MerkleProof memory _ksProof =
      _keystoreTreeMirror.generateProof(_user.keystoreIndex, ProofGenerator.KEYSTORE_MAX_DEPTH);
    return _assembleRagequitInputs(
      _user, _note.value, _note.noteSecret, _note.tokenId, _note.inputLabel, _keystore.currentRoot(), _ksProof
    );
  }

  /// @dev Same as default but with explicit `_keystoreRoot` and Merkle path;
  function _buildRagequitInputs(
    UserIdentityLib.UserIdentity memory _user,
    Note memory _note,
    uint256 _keystoreRoot,
    MerkleTree.MerkleProof memory _ksProof
  ) internal pure returns (ProofGenerator.RagequitInputs memory) {
    return _assembleRagequitInputs(
      _user, _note.value, _note.noteSecret, _note.tokenId, _note.inputLabel, _keystoreRoot, _ksProof
    );
  }

  /// @dev Builds RagequitInputs and generates the proof in one step
  function _buildAndGenerateRagequitProof(
    UserIdentityLib.UserIdentity memory _user,
    Note memory _note
  ) internal returns (ProofLibV2.RagequitProof memory) {
    return ProofGenerator.generateRagequitProof(_buildRagequitInputs(_user, _note));
  }
}
