// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerBase, Note, NoteCreationParams} from './HandlerBase.sol';

import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

contract HandlerTransact is HandlerBase {
  using TransactProofMemory for ProofLibV2.TransactProof;
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /// @dev Submit proof on-chain, mirror tree state, and construct output Notes
  /// also asserts on postconditions common to every transact call
  function _submitTransact(
    address _broadcaster,
    ProofLibV2.TransactProof memory _proof,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _tokenId,
    IPoolVault.TransactParams memory _params,
    IPoolVault.NoteData[] memory _payload
  ) internal returns (Note[] memory _newNotes, uint256[] memory _nullifierHashes) {
    _nullifierHashes = _proof.nullifierHashes();
    vm.prank(_broadcaster);
    _poolVault.transact(_proof, _params, _payload);

    uint256[] memory _outputLeafIndices = _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());
    _newNotes = new Note[](_noteCreationParams.length);
    for (uint256 i = 0; i < _noteCreationParams.length; i++) {
      _newNotes[i] = Note({
        value: _noteCreationParams[i].value,
        noteSecret: _noteCreationParams[i].noteSecret,
        depositSecret: _noteCreationParams[i].depositSecret,
        noteAddressHash: _noteCreationParams[i].noteAddressHash,
        inputLabel: _noteCreationParams[i].label,
        timestamp: vm.getBlockTimestamp(),
        tokenId: _tokenId,
        depositLeaf: _commitmentLeaf(_proof.outputCommitments()[i]),
        outputCommitment: _proof.outputCommitments()[i],
        stateLeafIndex: _outputLeafIndices[i],
        aspLeafIndex: _aspLeafIndexForLabel[_noteCreationParams[i].label]
      });
    }

    // Verify transact postconditions
    for (uint256 i = 0; i < _nullifierHashes.length; i++) {
      assertEq(_poolVault.spentNullifiers(_nullifierHashes[i]), vm.getBlockTimestamp(), 'Nullifier timestamp mismatch');
    }
    for (uint256 i = 0; i < _noteCreationParams.length; i++) {
      assertEq(
        _poolVault.commitments(_proof.outputCommitments()[i]), vm.getBlockTimestamp(), 'Commitment timestamp mismatch'
      );
    }
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after transact'
    );
  }

  /// @dev General case: builds proof and submits in one step
  function _transact(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut,
    IPoolVault.TransactParams memory _params,
    IPoolVault.NoteData[] memory _payload
  ) internal returns (Note[] memory _newNotes, uint256[] memory _nullifierHashes) {
    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _noteCreationParams,
      _amountOut: _amountOut,
      _context: _hashTransactContext(_params, _payload)
    });
    return _submitTransact(address(this), _proof, _noteCreationParams, _notes[0].tokenId, _params, _payload);
  }

  /// @dev Resolve the verifier address for a given (n, m) pair from the TransactVerifierRouter
  function _getVerifierAddr(uint8 _n, uint8 _m) internal view returns (address) {
    bytes32 _key = keccak256(abi.encode(uint256(_n), uint256(_m)));
    return ITransactVerifierRouter(address(_poolVault)).verifiers(_key).addr;
  }

  /// @dev Validate inputs, build scenario, and generate transact proof (no on-chain interaction)
  /// @dev `_context` is the keccak hash of (params, payload) computed by the caller, to avoid passing the  full structs through the via-IR-hostile stack here.
  function _buildTransactProof(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut,
    uint256 _context
  ) internal returns (ProofLibV2.TransactProof memory _proof) {
    {
      uint256 _n = _notes.length;
      uint256 _m = _noteCreationParams.length;
      require(_n >= 1 && _m >= 1, 'zero-length inputs and outputs are not supported by design');
      for (uint256 i = 0; i < _n; i++) {
        require(_notes[i].tokenId == _notes[0].tokenId, 'trying to spend notes with different tokenIds');
      }
    }
    _proof = ProofGenerator.generateTransactProof(
      _buildTransactInputs({
        _notes: _notes,
        _spender: _spender,
        _context: _context,
        _noteCreationParams: _noteCreationParams,
        _amountOut: _amountOut
      })
    );
  }

  /// @dev Assemble TransactInputs directly from notes, spender identity, and output info
  function _buildTransactInputs(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    uint256 _context,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut
  ) internal view returns (ProofGenerator.TransactInputs memory inputs_) {
    inputs_.nInputs = _notes.length;
    inputs_.mOutputs = _noteCreationParams.length;
    inputs_.stateRoot = _poolVault.roots(_poolVault.currentRootIndex());
    inputs_.keystoreRoot = _keystore.currentRoot();
    inputs_.associationSetRoot = _aspRegistry.latestASPRoot();
    inputs_.amountOut = _amountOut;
    inputs_.tokenIdOut = _amountOut == 0 ? 0 : _notes[0].tokenId;
    inputs_.context = _context;
    inputs_.ownerAddress = _spender.ownerAddress;
    inputs_.privateNullifyingKey = _spender.privNullifyingKey;
    inputs_.privateRevocableKey = _spender.privRevocableKey;
    inputs_.tokenId = _notes[0].tokenId;

    // Keystore proof
    {
      MerkleTree.MerkleProof memory _ksProof =
        _keystoreTreeMirror.generateProof(_spender.keystoreIndex, ProofGenerator.KEYSTORE_MAX_DEPTH);
      inputs_.keystoreLeafIndex = _ksProof.index;
      inputs_.keystoreSiblings = _ksProof.siblings;
      inputs_.keystoreTreeDepth = _ksProof.depth;
    }

    // Per-input note data + Merkle proofs
    _fillInputNotes(inputs_, _notes);

    // Per-output data
    _fillOutputNotes(inputs_, _noteCreationParams);
  }

  /// @dev Transact proof context: `uint256(keccak256(abi.encode(params, payload))) % SNARK_SCALAR_FIELD` (PoolVault-bound)
  function _hashTransactContext(
    IPoolVault.TransactParams memory _params,
    IPoolVault.NoteData[] memory _payload
  ) internal pure returns (uint256) {
    return uint256(keccak256(abi.encode(_params, _payload))) % SNARK_SCALAR_FIELD;
  }

  /// @dev Populate per-input arrays on TransactInputs from Note[] (split out to avoid stack-too-deep)
  function _fillInputNotes(ProofGenerator.TransactInputs memory _inputs, Note[] memory _notes) private view {
    uint256 _n = _notes.length;
    _inputs.noteSecret = new uint256[](_n);
    _inputs.value = new uint256[](_n);
    _inputs.label = new uint256[](_n);
    _inputs.timestamp = new uint256[](_n);
    _inputs.stateLeafIndex = new uint256[](_n);
    _inputs.stateSiblings = new uint256[][](_n);
    _inputs.stateTreeDepth = new uint256[](_n);
    _inputs.associationSetLeafIndex = new uint256[](_n);
    _inputs.associationSetSiblings = new uint256[][](_n);
    _inputs.associationSetTreeDepth = new uint256[](_n);

    for (uint256 i; i < _n; ++i) {
      require(_notes[0].tokenId == _notes[i].tokenId, 'all notes in a transaction should be of the same token');
      _inputs.noteSecret[i] = _notes[i].noteSecret;
      _inputs.value[i] = _notes[i].value;
      _inputs.label[i] = _notes[i].inputLabel;
      _inputs.timestamp[i] = _notes[i].timestamp;

      MerkleTree.MerkleProof memory _sp =
        _stateTreeMirror.generateProof(_notes[i].stateLeafIndex, ProofGenerator.STATE_MAX_DEPTH);
      _inputs.stateLeafIndex[i] = _sp.index;
      _inputs.stateSiblings[i] = _sp.siblings;
      _inputs.stateTreeDepth[i] = _sp.depth;

      MerkleTree.MerkleProof memory _ap =
        _aspTreeMirror.generateProof(_notes[i].aspLeafIndex, ProofGenerator.ASP_MAX_DEPTH);
      _inputs.associationSetLeafIndex[i] = _ap.index;
      _inputs.associationSetSiblings[i] = _ap.siblings;
      _inputs.associationSetTreeDepth[i] = _ap.depth;
    }
  }

  /// @dev Populate per-output arrays on TransactInputs from NoteCreationParams[]
  function _fillOutputNotes(
    ProofGenerator.TransactInputs memory _inputs,
    NoteCreationParams[] memory _noteCreationParams
  ) private pure {
    uint256 _m = _noteCreationParams.length;
    _inputs.outputNoteAddressHash = new uint256[](_m);
    _inputs.outputValue = new uint256[](_m);
    _inputs.outputLabel = new uint256[](_m);
    for (uint256 i; i < _m; ++i) {
      _inputs.outputNoteAddressHash[i] = _noteCreationParams[i].noteAddressHash;
      _inputs.outputValue[i] = _noteCreationParams[i].value;
      _inputs.outputLabel[i] = _noteCreationParams[i].label;
    }
  }

  /// @dev Mirror transact leaves into the local state tree so its root stays in sync.
  ///      Returns the state tree indices of the output commitment leaves (needed to
  ///      build a subsequent transact that spends one of these outputs).
  function _mirrorTransactLeaves(
    uint256[] memory _outputCommitments,
    uint256[] memory _nullifierHashes
  ) internal returns (uint256[] memory outputLeafIndices_) {
    outputLeafIndices_ = new uint256[](_outputCommitments.length);
    for (uint256 i; i < _outputCommitments.length; ++i) {
      _stateTreeMirror.insert(_commitmentLeaf(_outputCommitments[i]));
      outputLeafIndices_[i] = _stateTreeMirror.size - 1;
    }
    for (uint256 i; i < _nullifierHashes.length; ++i) {
      _stateTreeMirror.insert(_nullifierLeaf(_nullifierHashes[i]));
      _trackNullifierLeaf(_nullifierHashes[i], _stateTreeMirror.size - 1);
    }
  }
}
