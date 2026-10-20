// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerBase, Note} from './HandlerBase.sol';
import {IERC20} from 'forge-std/interfaces/IERC20.sol';
import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {PoseidonT5} from 'poseidon-solidity/PoseidonT5.sol';
import {SafeTransferLib} from 'solady/src/utils/SafeTransferLib.sol';

import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

contract HandlerDeposit is HandlerBase {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using MerkleTree for MerkleTree.Tree;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /*///////////////////////////////////////////////////////////////
                        DEPOSIT HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _createDepositProof(
    UserIdentityLib.UserIdentity storage _user,
    address _tokenAddr,
    uint256 _value
  ) internal returns (ProofLibV2.DepositProof memory _proof, Note memory _incompleteNote) {
    (uint256 _noteSecret, uint256 _depositSecret) = _user.newSecrets();
    _incompleteNote.value = _value;
    _incompleteNote.noteSecret = _noteSecret;
    _incompleteNote.depositSecret = _depositSecret;
    _incompleteNote.noteAddressHash = PoseidonT3.hash([_user.ownerAddress, _noteSecret]);
    _incompleteNote.tokenId = uint256(uint160(_tokenAddr));

    uint256 _depositContext = uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD;

    return (
      ProofGenerator.generateDepositProof(
        _tokenAddr, _value, _incompleteNote.noteAddressHash, _depositSecret, _depositContext
      ),
      _incompleteNote
    );
  }

  function _submitDepositProof(
    UserIdentityLib.UserIdentity memory _broadcaster,
    Note memory _incompleteNote,
    ProofLibV2.DepositProof memory _proof
  ) internal returns (Note memory) {
    address _token = address(uint160(_incompleteNote.tokenId));
    uint256 totalAmount = _incompleteNote.value + _calcFee(_token, _incompleteNote.value);
    if (_token == Constants.NATIVE_ASSET) {
      // _increase_ balance; preserves any pre-existing ETH the broadcaster accumulated
      vm.deal(_broadcaster.addr, _broadcaster.addr.balance + totalAmount);
      vm.prank(_broadcaster.addr);
      _entrypoint.deposit{value: totalAmount}(_proof, _defaultNoteData, bytes(''));
    } else {
      // _increase_ balance instead of blindly setting it
      deal(_token, _broadcaster.addr, IERC20(_token).balanceOf(_broadcaster.addr) + totalAmount);
      vm.prank(_broadcaster.addr);
      SafeTransferLib.safeApprove(_token, address(_entrypoint), totalAmount);
      vm.prank(_broadcaster.addr);
      _entrypoint.deposit(_proof, _defaultNoteData, bytes(''));
    }

    _incompleteNote.outputCommitment = _proof.outputCommitment();
    _incompleteNote.depositLeaf = _commitmentLeaf(_incompleteNote.outputCommitment);

    // Mirror state tree: deposit inserts a single timestamped leaf
    _stateTreeMirror.insert(_incompleteNote.depositLeaf);
    _incompleteNote.stateLeafIndex = _stateTreeMirror.size - 1;

    return _registerInASP(_incompleteNote, DEFAULT_NOTE_METADATA);
  }

  ///@dev note metadata and discovery data are set to zero, per HandlerBase
  function _deposit(
    UserIdentityLib.UserIdentity storage _broadcaster,
    UserIdentityLib.UserIdentity storage _recipient,
    address _tokenAddr,
    uint256 _value
  ) internal returns (Note memory) {
    (ProofLibV2.DepositProof memory _proof, Note memory _note) = _createDepositProof(_recipient, _tokenAddr, _value);
    return _submitDepositProof(_broadcaster, _note, _proof);
  }

  /// @dev Compute label from deposit data, register in ASP, and mirror ASP tree
  function _registerInASP(Note memory _note, uint256 _metadata) internal returns (Note memory) {
    _note.timestamp = vm.getBlockTimestamp();

    uint256 precommitment = PoseidonT5.hash([_note.noteAddressHash, _note.tokenId, _note.value, _metadata]);
    _note.inputLabel = PoseidonT3.hash([precommitment, _note.depositSecret]);

    // Mirror ASP tree: leaf = Poseidon(label)
    uint256 aspLeaf = PoseidonT2.hash([_note.inputLabel]);
    _aspTreeMirror.insert(aspLeaf);
    _note.aspLeafIndex = _aspTreeMirror.size - 1;
    _aspLeafIndexForLabel[_note.inputLabel] = _note.aspLeafIndex;

    // Submit the ASP tree root on-chain
    vm.prank(_postman);
    _aspRegistry.updateASPRoot(_aspTreeMirror.root(), bytes('ipfs://test'));

    return _note;
  }
}
