// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IGroth16Verifier} from 'interfaces/IGroth16Verifier.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';

/// @notice Integration tests for direct calls to verifier contracts
/// @dev Deposits on-chain, registers in keystore, sets ASP root, then
///    construct proofs which are valid against that state and calls the verifier
///    contracts directly, without doing an actual transact
contract VerifiersIntegration is IntegrationBase {
  using TransactProofMemory for ProofLibV2.TransactProof;
  uint8 private constant _MAX_SUPPORTED_INPUTS = 5;
  uint8 private constant _MAX_SUPPORTED_OUTPUTS = 5;
  Note[] internal deposits;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);

    for (uint256 i = 0; i < alice.depositSecrets.length; i++) {
      vm.warp(vm.getBlockTimestamp() + 1);
      deposits.push(_deposit(alice, address(_token), SAMPLE_VALUE));
    }
  }

  /*///////////////////////////////////////////////////////////////
                        VERIFIER TESTS
  ///////////////////////////////////////////////////////////////*/

  function test_verifier_acceptsValidProof_1xM() external {
    _acceptsValidProof(1);
  }

  function test_verifier_acceptsValidProof_2xM() external {
    _acceptsValidProof(2);
  }

  function test_verifier_acceptsValidProof_3xM() external {
    _acceptsValidProof(3);
  }

  function test_verifier_acceptsValidProof_4xM() external {
    _acceptsValidProof(4);
  }

  function test_verifier_acceptsValidProof_5xM() external {
    _acceptsValidProof(5);
  }

  function test_verifier_rejectsCorruptedProof_1xM() external {
    _rejectsCorruptedProof(1);
  }

  function test_verifier_rejectsCorruptedProof_2xM() external {
    _rejectsCorruptedProof(2);
  }

  function test_verifier_rejectsCorruptedProof_3xM() external {
    _rejectsCorruptedProof(3);
  }

  function test_verifier_rejectsCorruptedProof_4xM() external {
    _rejectsCorruptedProof(4);
  }

  function test_verifier_rejectsCorruptedProof_5xM() external {
    _rejectsCorruptedProof(5);
  }

  function test_verifier_rejectsWrongPublicSignals_1xM() external {
    _rejectsWrongPublicSignals(1);
  }

  function test_verifier_rejectsWrongPublicSignals_2xM() external {
    _rejectsWrongPublicSignals(2);
  }

  function test_verifier_rejectsWrongPublicSignals_3xM() external {
    _rejectsWrongPublicSignals(3);
  }

  function test_verifier_rejectsWrongPublicSignals_4xM() external {
    _rejectsWrongPublicSignals(4);
  }

  function test_verifier_rejectsWrongPublicSignals_5xM() external {
    _rejectsWrongPublicSignals(5);
  }

  function _acceptsValidProof(uint256 _n) internal {
    for (uint256 _m = 1; _m <= _MAX_SUPPORTED_OUTPUTS; _m++) {
      ProofLibV2.TransactProof memory proof = _buildNxMProof(_n, _m);

      ITransactVerifierRouter.Verifier memory _verifier = _poolVault.verifiers(keccak256(abi.encode(_n, _m)));

      assertTrue(
        _callVerifier(_verifier.addr, _verifier.selector, proof.groth16Proof(), proof.pubSignals),
        'Valid proof rejected'
      );
    }
  }

  function _rejectsCorruptedProof(uint256 _n) internal {
    for (uint256 _m = 1; _m <= _MAX_SUPPORTED_OUTPUTS; _m++) {
      ProofLibV2.TransactProof memory proof = _buildNxMProof(_n, _m);
      proof.pA[0] = proof.pA[0] + 1;

      ITransactVerifierRouter.Verifier memory _verifier = _poolVault.verifiers(keccak256(abi.encode(_n, _m)));
      assertFalse(
        _callVerifier(_verifier.addr, _verifier.selector, proof.groth16Proof(), proof.pubSignals),
        'Corrupted proof accepted'
      );
    }
  }

  function _rejectsWrongPublicSignals(uint256 _n) internal {
    for (uint256 _m = 1; _m <= _MAX_SUPPORTED_OUTPUTS; _m++) {
      ProofLibV2.TransactProof memory proof = _buildNxMProof(_n, _m);

      proof.nullifierHashes()[0] = proof.nullifierHashes()[0] + 1;

      ITransactVerifierRouter.Verifier memory _verifier = _poolVault.verifiers(keccak256(abi.encode(_n, _m)));
      assertFalse(
        _callVerifier(_verifier.addr, _verifier.selector, proof.groth16Proof(), proof.pubSignals),
        'Wrong signals accepted'
      );
    }
  }

  function _buildNxMProof(uint256 _n, uint256 _m) internal returns (ProofLibV2.TransactProof memory) {
    uint256 amountInNewNotes = 0;
    Note[] memory notes = new Note[](_n);
    for (uint256 i = 0; i < _n; i++) {
      notes[i] = deposits[i];
    }

    NoteCreationParams[] memory noteCreationParams = new NoteCreationParams[](_m);
    for (uint256 j = 0; j < _m; j++) {
      noteCreationParams[j].noteAddressHash = _sampleOutputNoteAddressHash;
      // keep half of every note in the contract
      noteCreationParams[j].value = (SAMPLE_VALUE) / (_m * 2);
      noteCreationParams[j].label = deposits[0].inputLabel;
      amountInNewNotes += noteCreationParams[j].value;
    }

    return _buildTransactProof({
      _notes: notes,
      _spender: alice,
      _noteCreationParams: noteCreationParams,
      _amountOut: SAMPLE_VALUE * _n - amountInNewNotes
    });
  }

  function _callVerifier(
    address _verifier,
    bytes4 _selector,
    IGroth16Verifier.Proof memory _proof,
    uint256[][] memory _pubSignals2D
  ) internal view returns (bool) {
    uint256 _arrayLength;
    for (uint256 i = 0; i < _pubSignals2D.length; i++) {
      _arrayLength += _pubSignals2D[i].length;
    }

    uint256 _idx;
    uint256[] memory _pubSignals = new uint256[](_arrayLength);
    for (uint256 i = 0; i < _pubSignals2D.length; i++) {
      for (uint256 j = 0; j < _pubSignals2D[i].length; j++) {
        _pubSignals[_idx++] = _pubSignals2D[i][j];
      }
    }

    (bool _success, bytes memory retdata) =
      _verifier.staticcall(abi.encodePacked(_selector, _proof.pA, _proof.pB, _proof.pC, _pubSignals));
    require(_success, 'verifier should not revert');

    return abi.decode(retdata, (bool));
  }
}
