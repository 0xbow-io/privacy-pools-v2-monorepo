// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Constants} from 'src/utils/Constants.sol';
import {Note, NoteCreationParams} from 'test/handlers/HandlerBase.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {RagequitProofMemory, TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

/// @notice Integration tests for AuthType validation (key rotation + transact/ragequit)
/// @dev Verifies that the authType=0 (Direct Key) authorization mechanism works end-to-end
///      after key rotations, exercising keystore updates, proof generation, and on-chain verification.
contract AuthTypeIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();

    alice = _registerInKeystore(alice);
  }

  /*///////////////////////////////////////////////////////////////
                        KEY ROTATION + TRANSACT
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice registers, deposits, rotates her revocable key, then withdraws with the new key
  /// @dev Exercises the full auth rotation flow: updateAuthPolicy → new keystoreRoot → ZK proof → withdraw
  function test_transact_succeeds_afterKeyRotation() external {
    // ── Step 1: Alice deposits ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Rotate Alice's revocable key ──
    uint256 _newPrivRevocableKey = uint256(keccak256('alice_rotated_revocable_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _newPrivRevocableKey);

    // ── Step 3: Withdraw full value using the new key ──
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) = _buildTransactProof({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, _note.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: alice.addr
    });

    uint256 _aliceBalanceBefore = _token.balanceOf(alice.addr);

    vm.prank(alice.addr);
    _poolVault.transact(_proof, _params, _defaultTransactNoteData);

    // ── Assertions ──
    assertEq(
      _poolVault.spentNullifiers(_proof.nullifierHashes()[0]),
      vm.getBlockTimestamp(),
      'Nullifier spend timestamp mismatch'
    );

    _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after withdraw with rotated key'
    );

    assertEq(_token.balanceOf(alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should receive withdrawn value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after withdrawal');
  }

  /*///////////////////////////////////////////////////////////////
                      KEY ROTATION + RAGEQUIT
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice registers, deposits, transacts (self-transfer), rotates her key, then ragequits
  /// @dev Proves ragequit's auth verification uses the current keystore state after rotation
  function test_ragequit_succeeds_afterKeyRotation() external {
    // ── Step 1: Alice deposits ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Alice self-transfers (creates a new commitment she can ragequit) ──
    (Note memory _transferNote,) = _transact({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, _note.inputLabel),
      _amountOut: 0
    });
    uint256 _transactTimestamp = vm.getBlockTimestamp();
    uint256 _outputCommitment = _transferNote.outputCommitment;

    // ── Step 3: Rotate Alice's revocable key ──
    uint256 _newPrivRevocableKey = uint256(keccak256('alice_ragequit_rotated_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _newPrivRevocableKey);

    // ── Step 4: Alice ragequits with the new key ──
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _transferNote);

    // Pre-ragequit check: ragequit nullifier should not be spent yet
    assertEq(_poolVault.commitments(_outputCommitment), _transactTimestamp, 'Output commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Ragequit nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _token.balanceOf(alice.addr);

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr, address(_token), SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    vm.prank(alice.addr);
    _poolVault.ragequit(_rqProof);

    // ── Assertions ──
    assertEq(_token.balanceOf(alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should recover full value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after ragequit');
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), vm.getBlockTimestamp(), 'Ragequit nullifier should be spent'
    );
  }

  /*///////////////////////////////////////////////////////////////
                    MULTIPLE KEY ROTATIONS + TRANSACT
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice registers, deposits, rotates her key twice, then withdraws with the latest key
  /// @dev Verifies auth validation against the most recent keystore leaf after successive rotations
  function test_transact_succeeds_afterMultipleKeyRotations() external {
    // ── Step 1: Alice deposits ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: First key rotation (A → B) ──
    uint256 _keyB = uint256(keccak256('alice_key_B')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _keyB);

    // ── Step 3: Second key rotation (B → C) ──
    uint256 _keyC = uint256(keccak256('alice_key_C')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _keyC);

    // ── Step 4: Withdraw full value using key C ──
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) = _buildTransactProof({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, _note.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: alice.addr
    });

    uint256 _aliceBalanceBefore = _token.balanceOf(alice.addr);

    vm.prank(alice.addr);
    _poolVault.transact(_proof, _params, _defaultTransactNoteData);

    // ── Assertions ──
    assertEq(
      _poolVault.spentNullifiers(_proof.nullifierHashes()[0]),
      vm.getBlockTimestamp(),
      'Nullifier spend timestamp mismatch'
    );

    _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after withdraw with double-rotated key'
    );

    assertEq(_token.balanceOf(alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should receive withdrawn value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after withdrawal');
  }

  /*///////////////////////////////////////////////////////////////
                    KEY ROTATION + CHAINED TRANSACT
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice rotates key, transacts to Bob, Bob spends — full chain after rotation
  /// @dev Ensures key rotation doesn't break downstream transfers: the keystore proof
  ///      uses the updated root, and Bob's transact references the same state tree.
  function test_chainedTransact_afterKeyRotation() external {
    bob = _registerInKeystore(bob);

    // ── Step 1: Alice deposits ──
    Note memory _aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Alice rotates key ──
    uint256 _newKey = uint256(keccak256('alice_chained_rotated_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _newKey);

    // ── Step 3: Alice transacts to Bob (with rotated key) ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory _bobNote, uint256 _aliceNullifier) = _transact({
      _note: _aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // ── Step 4: Bob spends the note Alice sent him ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (ProofLibV2.TransactProof memory _bobProof, IPoolVault.TransactParams memory _bobParams) = _buildTransactProof({
      _note: _bobNote,
      _spender: bob,
      _noteCreationParams: bob.receiveNote(0, _bobNote.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: bob.addr
    });

    uint256 _bobBalanceBefore = _token.balanceOf(bob.addr);

    vm.prank(bob.addr);
    _poolVault.transact(_bobProof, _bobParams, _defaultTransactNoteData);

    // ── Assertions ──
    assertGt(_poolVault.spentNullifiers(_aliceNullifier), 0, 'Alice nullifier should be spent');
    assertGt(_poolVault.spentNullifiers(_bobProof.nullifierHashes()[0]), 0, 'Bob nullifier should be spent');

    _mirrorTransactLeaves(_bobProof.outputCommitments(), _bobProof.nullifierHashes());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after chained transact with rotated key'
    );

    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after full withdrawal');
    assertEq(_token.balanceOf(bob.addr), _bobBalanceBefore + SAMPLE_VALUE, 'Bob should receive withdrawn tokens');
  }

  /*///////////////////////////////////////////////////////////////
                  RECIPIENT KEY ROTATION + SPEND
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice sends to Bob, Bob rotates his key, then Bob withdraws with the new key
  /// @dev Verifies that a recipient can rotate their auth key between receiving and spending a note
  function test_recipientTransact_afterKeyRotation() external {
    bob = _registerInKeystore(bob);

    // ── Step 1: Alice deposits ──
    Note memory _aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Alice transacts to Bob ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory _bobNote,) = _transact({
      _note: _aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // ── Step 3: Bob rotates his key BEFORE spending ──
    uint256 _bobNewKey = uint256(keccak256('bob_rotated_key')) % SNARK_SCALAR_FIELD;
    bob = _rotateKey(bob, _bobNewKey);

    // ── Step 4: Bob spends the note using his new key ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (ProofLibV2.TransactProof memory _bobProof, IPoolVault.TransactParams memory _bobParams) = _buildTransactProof({
      _note: _bobNote,
      _spender: bob,
      _noteCreationParams: bob.receiveNote(0, _bobNote.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: bob.addr
    });

    uint256 _bobBalanceBefore = _token.balanceOf(bob.addr);

    vm.prank(bob.addr);
    _poolVault.transact(_bobProof, _bobParams, _defaultTransactNoteData);

    // ── Assertions ──
    assertGt(_poolVault.spentNullifiers(_bobProof.nullifierHashes()[0]), 0, 'Bob nullifier should be spent');

    _mirrorTransactLeaves(_bobProof.outputCommitments(), _bobProof.nullifierHashes());
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()),
      _stateTreeMirror.root(),
      'State root mismatch after recipient key rotation'
    );

    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after full withdrawal');
    assertEq(_token.balanceOf(bob.addr), _bobBalanceBefore + SAMPLE_VALUE, 'Bob should receive withdrawn tokens');
  }

  /*///////////////////////////////////////////////////////////////
              PRE-ROTATION PROOF + ROOT LIVENESS
  ///////////////////////////////////////////////////////////////*/

  /// @notice A proof generated before key rotation remains valid while the old keystoreRoot is within liveness
  /// @dev Validates the root liveness grace period: proof references keystoreRoot_old, which is still
  ///      known after a single rotation (within the liveness window).
  function test_transact_succeeds_withPreRotationProof() external {
    // ── Step 1: Alice deposits ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Generate a valid proof with the current key (before rotation) ──
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) = _buildTransactProof({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, _note.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: alice.addr
    });

    // ── Step 3: Rotate Alice's key AFTER proof generation ──
    uint256 _newPrivRevocableKey = uint256(keccak256('alice_post_proof_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _newPrivRevocableKey);

    // ── Step 4: Submit the pre-rotation proof — succeeds because old keystoreRoot is still within liveness ──
    uint256 _aliceBalanceBefore = _token.balanceOf(alice.addr);

    vm.prank(alice.addr);
    _poolVault.transact(_proof, _params, _defaultTransactNoteData);

    // ── Assertions ──
    assertEq(
      _poolVault.spentNullifiers(_proof.nullifierHashes()[0]),
      vm.getBlockTimestamp(),
      'Nullifier spend timestamp mismatch'
    );

    _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());

    assertEq(_token.balanceOf(alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should receive withdrawn value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after withdrawal');
  }

  /// @notice A pre-rotation proof reverts once the old keystoreRoot expires past its liveness window
  /// @dev A single rotation supersedes the original keystoreRoot, then warping past
  ///      `keystoreRootLiveness` makes it unknown and causes an on-chain revert.
  function test_transact_reverts_withPreRotationProof_afterLivenessExpiry() external {
    // ── Step 1: Alice deposits ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Generate a valid proof with the current key ──
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) = _buildTransactProof({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, _note.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: alice.addr
    });

    // ── Step 3: Rotate once so the old keystoreRoot is superseded, then warp past liveness ──
    uint256 _nextKey = uint256(keccak256(abi.encodePacked('expiry_key_', uint256(0)))) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _nextKey);
    vm.warp(block.timestamp + _keystore.keystoreRootLiveness() + 1);

    // ── Step 4: Submit the stale proof — reverts because old keystoreRoot expired ──
    vm.expectRevert(IPoolVault.PoolVault_UnknownKeystoreRoot.selector);

    vm.prank(alice.addr);
    _poolVault.transact(_proof, _params, _defaultTransactNoteData);
  }

  /*///////////////////////////////////////////////////////////////
              UNSUPPORTED AUTH TYPE + RECOVERY
  ///////////////////////////////////////////////////////////////*/

  /// @notice Updating to authType=1 makes proof generation fail; recovering to authType=0 restores spending
  /// @dev The Keystore accepts any authDigest (no authType validation on-chain), but the Transact circuit
  ///      hardcodes authType=0. An authType=1 digest produces a keystore leaf the circuit can't reproduce,
  ///      so proof generation fails. Recovery is possible via another updateAuthPolicy back to authType=0.
  function test_transact_recovers_fromUnsupportedAuthType() external {
    // ── Step 1: Alice deposits (authType=0, normal) ──
    Note memory _note = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── Step 2: Update to authType=1 (unsupported — no circuit exists for it) ──
    uint256 _unsupportedKey = uint256(keccak256('unsupported_bjj_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _unsupportedKey, 1);

    // ── Step 3: Proof generation fails — circuit computes Poseidon(0, key) but tree has Poseidon(1, key) ──
    NoteCreationParams memory _outputNote = alice.receiveNote(0, _note.inputLabel);
    ProofGenerator.TransactInputs memory _scenario = _buildTransactInputs(_note, alice, _outputNote, SAMPLE_VALUE);

    _assertTransactProofReverts(_scenario, 'Proof generation should fail with unsupported authType=1');

    // Without a valid proof we can't transact our funds

    // ── Step 4: Recover back to authType=0 ──
    uint256 _recoveryKey = uint256(keccak256('alice_recovery_key')) % SNARK_SCALAR_FIELD;
    alice = _rotateKey(alice, _recoveryKey);

    // ── Step 5: Withdraw successfully with recovered key ──
    (ProofLibV2.TransactProof memory _proof, IPoolVault.TransactParams memory _params) = _buildTransactProof({
      _note: _note,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, _note.inputLabel),
      _amountOut: SAMPLE_VALUE,
      _processor: alice.addr
    });

    uint256 _aliceBalanceBefore = _token.balanceOf(alice.addr);

    vm.prank(alice.addr);
    _poolVault.transact(_proof, _params, _defaultTransactNoteData);

    // ── Assertions ──
    assertEq(
      _poolVault.spentNullifiers(_proof.nullifierHashes()[0]),
      vm.getBlockTimestamp(),
      'Nullifier spend timestamp mismatch'
    );

    _mirrorTransactLeaves(_proof.outputCommitments(), _proof.nullifierHashes());

    assertEq(_token.balanceOf(alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should receive withdrawn value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after withdrawal');
  }

  /*///////////////////////////////////////////////////////////////
                      KEY ROTATION HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Rotates a user's key with default authType=0 (Direct Key)
  function _rotateKey(
    UserIdentityLib.UserIdentity memory _user,
    uint256 _newPrivRevocableKey
  ) internal returns (UserIdentityLib.UserIdentity memory) {
    return _rotateKey(_user, _newPrivRevocableKey, Constants.AUTH_TYPE_DIRECT_KEY);
  }

  /// @dev Rotates a user's key: updates on-chain keystore and local mirror tree
  function _rotateKey(
    UserIdentityLib.UserIdentity memory _user,
    uint256 _newPrivRevocableKey,
    uint256 _authType
  ) internal returns (UserIdentityLib.UserIdentity memory) {
    uint256 _oldAuthDigest = _user.authDigest;
    uint256 _newAuthDigest = PoseidonT3.hash([_authType, _newPrivRevocableKey]);

    // generateProof returns siblings zero-padded to KEYSTORE_MAX_DEPTH (for circuits),
    // but LeanIMT._update expects only the real siblings, so we trim to proof.depth.
    MerkleTree.MerkleProof memory _keystoreProof =
      _keystoreTreeMirror.generateProof(_user.keystoreIndex, ProofGenerator.KEYSTORE_MAX_DEPTH);
    uint256[] memory _siblings = new uint256[](_keystoreProof.depth);
    for (uint256 i; i < _keystoreProof.depth; ++i) {
      _siblings[i] = _keystoreProof.siblings[i];
    }

    // On-chain keystore update
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicyUpdated(_user.addr, _oldAuthDigest, _newAuthDigest);

    vm.prank(_user.addr);
    _keystore.updateAuthPolicy(_oldAuthDigest, _newAuthDigest, _siblings);

    // Mirror the update locally
    uint256 _newLeaf = PoseidonT4.hash([_user.ownerAddress, _user.nullifyingKeyHash, _newAuthDigest]);
    _keystoreTreeMirror.update(_user.keystoreIndex, _newLeaf);

    // Update identity with new key
    _user.authDigest = _newAuthDigest;
    _user.privRevocableKey = _newPrivRevocableKey;

    return _user;
  }
}
