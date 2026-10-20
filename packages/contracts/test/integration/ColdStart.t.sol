// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {IntegrationBase, Note} from './IntegrationBase.t.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {RagequitProofMemory, TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration test for the Cold Start scenario (User Flow 1.3):
///         Alice transfers to Bob (not in keystore) → Bob can't spend → Bob registers → Bob can spend
///         Two exit paths: transact and ragequit.
/// @dev Token coverage is intentionally minimal: mock ERC20 + native ETH per path only. Cold start is
///      largely token-agnostic; extra mainnet stablecoin matrices add runtime without much signal
contract ColdStartIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();

    // Only Alice is registered — Bob starts "cold" (no keystore entry)
    alice = _registerInKeystore(alice);
  }

  /*///////////////////////////////////////////////////////////////
                    COLD START — TRANSACT
  ///////////////////////////////////////////////////////////////*/

  function test_coldStart_transact_erc20() external {
    Note memory _bobNote = _coldStartSetup(address(_token), SAMPLE_VALUE);
    vm.warp(block.timestamp + 1);
    _transact({
      _note: _bobNote,
      _spender: bob,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _bobNote.inputLabel),
      _amountOut: 0
    });
  }

  function test_coldStart_transact_eth() external {
    Note memory _bobNote = _coldStartSetup(Constants.NATIVE_ASSET, SAMPLE_VALUE);
    vm.warp(block.timestamp + 1);
    _transact({
      _note: _bobNote,
      _spender: bob,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _bobNote.inputLabel),
      _amountOut: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
                    COLD START — RAGEQUIT
  ///////////////////////////////////////////////////////////////*/

  function test_coldStart_ragequit_erc20() external {
    Note memory _bobNote = _coldStartSetup(address(_token), SAMPLE_VALUE);
    vm.warp(block.timestamp + 1);
    _ragequit(bob, _bobNote);
  }

  function test_coldStart_ragequit_eth() external {
    Note memory _bobNote = _coldStartSetup(Constants.NATIVE_ASSET, SAMPLE_VALUE);
    vm.warp(block.timestamp + 1);
    _ragequit(bob, _bobNote);
  }

  /*///////////////////////////////////////////////////////////////
                            SHARED SETUP
  ///////////////////////////////////////////////////////////////*/

  /// @dev Sets up cold-start preconditions;
  ///      Alice deposits → transfers to Bob → Bob can't spend (not in keystore) → Bob registers in keystore
  function _coldStartSetup(address _tokenAddr, uint256 _value) internal returns (Note memory _bobNote) {
    // ── Step 1: Alice deposits ──
    Note memory _aliceDeposit = _deposit(alice, _tokenAddr, _value);

    // ── Step 2: Alice transfers to Bob (creating a commitment owned by Bob) ──
    vm.warp(block.timestamp + 1);

    uint256 _aliceNullifier;
    (_bobNote, _aliceNullifier) = _transact({
      _note: _aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _aliceDeposit.inputLabel),
      _amountOut: 0
    });

    assertEq(_poolVault.spentNullifiers(_aliceNullifier), _bobNote.timestamp, 'Alice nullifier should be spent');
    assertEq(
      _poolVault.commitments(_bobNote.outputCommitment),
      _bobNote.timestamp,
      'Alice output commitment should be recorded'
    );

    // ── Step 3: Verify Bob CANNOT spend (not in keystore) ──
    assertEq(_keystore.nullifyingKeys(bob.addr), 0, 'Bob should NOT be in keystore yet');

    // 3a: Proof generation fails — Bob's leaf is not in the keystore tree, so the
    //     circuit can't satisfy the keystore membership constraint.
    {
      vm.warp(block.timestamp + 1);

      // Attempt 1: Bob claims Alice's slot (index 0) — the Merkle proof is valid
      // for that position, but the circuit rejects because Bob's leaf != Alice's leaf.
      bob.keystoreIndex = 0;
      ProofGenerator.TransactInputs memory _scenario =
        _buildTransactInputs(_bobNote, bob, bob.receiveNote(_value, _bobNote.inputLabel), 0);

      _assertTransactProofReverts(
        _scenario, 'Proof generation should fail when Bob uses Alice keystore tree index (wrong leaf at a real slot)'
      );

      // Attempt 2: Bob fabricates a proof at a non-existent slot (index 1) —
      // the Merkle path doesn't resolve to the on-chain root.
      uint256[] memory _fakeSiblings = new uint256[](ProofGenerator.KEYSTORE_MAX_DEPTH);
      _scenario.keystoreLeafIndex = 1;
      _scenario.keystoreSiblings = _fakeSiblings;
      _scenario.keystoreTreeDepth = 1;

      _assertTransactProofReverts(_scenario, 'Proof generation should fail with fabricated keystore proof');

      // Attempt 3: same keystore membership constraint blocks ragequit circuit too
      MerkleTree.MerkleProof memory _ksProof = _keystoreTreeMirror.generateProof(0, ProofGenerator.KEYSTORE_MAX_DEPTH);

      _assertRagequitProofReverts(
        _buildRagequitInputs(bob, _bobNote, _keystore.currentRoot(), _ksProof),
        'Ragequit proof generation should fail - Bob not in keystore'
      );
    }

    // 3b: Even with a mathematically valid proof (built against a keystore tree that
    //     includes Bob), the contract rejects because the keystore root is unknown on-chain.
    {
      uint256 _bobKeystoreLeaf = PoseidonT4.hash([bob.ownerAddress, bob.nullifyingKeyHash, bob.authDigest]);
      _keystoreTreeMirror.insert(_bobKeystoreLeaf);
      bob.keystoreIndex = _keystoreTreeMirror.size - 1;

      vm.warp(block.timestamp + 1);

      // Build scenario via helper, then override keystore fields to use the mirror tree
      // (which includes Bob but whose root is unknown on-chain)
      ProofGenerator.TransactInputs memory _failScenario =
        _buildTransactInputs(_bobNote, bob, bob.receiveNote(_value, _bobNote.inputLabel), 0);
      _failScenario.keystoreRoot = _keystoreTreeMirror.root();
      MerkleTree.MerkleProof memory _bobKsProof =
        _keystoreTreeMirror.generateProof(bob.keystoreIndex, ProofGenerator.KEYSTORE_MAX_DEPTH);
      _failScenario.keystoreLeafIndex = _bobKsProof.index;
      _failScenario.keystoreSiblings = _bobKsProof.siblings;
      _failScenario.keystoreTreeDepth = _bobKsProof.depth;

      ProofLibV2.TransactProof memory _bobFailProof = ProofGenerator.generateTransactProof(_failScenario);

      // The proof is valid but the keystore root is not known on-chain
      vm.expectRevert(IPoolVault.PoolVault_UnknownKeystoreRoot.selector);
      _poolVault.transact(_bobFailProof, _defaultTransactParams, _defaultTransactNoteData);

      // Ragequit also reverts with unknown keystore root
      MerkleTree.MerkleProof memory _ksProofFail =
        _keystoreTreeMirror.generateProof(bob.keystoreIndex, ProofGenerator.KEYSTORE_MAX_DEPTH);

      ProofLibV2.RagequitProof memory _rqFailProof = ProofGenerator.generateRagequitProof(
        _buildRagequitInputs(bob, _bobNote, _keystoreTreeMirror.root(), _ksProofFail)
      );

      vm.expectRevert(IPoolVault.PoolVault_UnknownKeystoreRoot.selector);
      vm.prank(bob.addr);
      _poolVault.ragequit(_rqFailProof);
    }

    // ── Step 4: Bob registers in keystore ──
    // On-chain insertion catches up with the mirror tree
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicySet(bob.addr, bob.nullifyingKeyHash, bob.authDigest);

    vm.prank(bob.addr);
    _keystore.setAuthPolicy(bob.authDigest, bob.nullifyingKeyHash);

    assertEq(_keystore.nullifyingKeys(bob.addr), bob.nullifyingKeyHash, 'Bob should be in keystore');
    assertTrue(_keystore.isKnownRoot(_keystoreTreeMirror.root()), 'On-chain keystore should recognize the mirror root');
  }
}
