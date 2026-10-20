// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {LeafDoesNotExist, LeafGreaterThanSnarkScalarField} from '@lean-imt/InternalLeanIMT.sol';
import {Initializable} from '@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {ITreeUpdates} from 'interfaces/ITreeUpdates.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {Constants} from 'src/utils/Constants.sol';

contract KeystoreIntegration is IntegrationBase {
  function test_initialization() external {
    // ensure it has been correctly initialized
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    _keystore.initialize(10, 1 << 18);

    // implementation storage slot from ERC1967 spec
    IKeystore _implementation = IKeystore(
      address(
        bytes20(
          vm.load(address(_keystore), 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc) << 12 * 8
        )
      )
    );
    // ensure implementation has its initializer disabled
    vm.expectRevert(Initializable.InvalidInitialization.selector);
    _implementation.initialize(10, 1 << 18);
  }

  function test_deployConfiguration() external {
    assertEq(address(_keystore.ACCESS_ROUTER()), address(_accessRouter));
    assertEq(_keystore.keystoreRootLiveness(), 1200);
    assertEq(_keystore.maxKeystoreTreeSize(), 1 << 18);
  }

  function test_multipleInsertions() external {
    /// =================================================
    /// STEP 1: Alice inserts her leaf, which is the root
    /// =================================================
    uint256 _aliceLeaf = PoseidonT4.hash([alice.ownerAddress, alice.nullifyingKeyHash, alice.authDigest]);

    vm.expectEmit(address(_keystore));
    emit ITreeUpdates.LeafInserted(_aliceLeaf, _aliceLeaf, 0);
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicySet(alice.addr, alice.nullifyingKeyHash, alice.authDigest);

    vm.prank(alice.addr);
    _keystore.setAuthPolicy(alice.authDigest, alice.nullifyingKeyHash);

    /// ROOT GENERATION (Insertion 1):
    /// When Alice is the first insertion (index 0), the tree has only one leaf.
    /// The root IS the leaf itself: root = _aliceLeaf
    /// This is because a Merkle tree with one node has that node as the root.

    assertEq(_keystore.nullifyingKeys(alice.addr), alice.nullifyingKeyHash);
    assertEq(_keystore.currentRoot(), _aliceLeaf);
    assertTrue(_keystore.isKnownRoot(_aliceLeaf));

    /// ============================
    /// STEP 2: Bob inserts his leaf
    /// ============================
    uint256 _bobLeaf = PoseidonT4.hash([bob.ownerAddress, bob.nullifyingKeyHash, bob.authDigest]);

    /// ROOT GENERATION (Insertion 2):
    /// With two leaves, the root is computed by hashing them together:
    /// root = hash(aliceLeaf, bobLeaf)
    /// Tree structure:
    ///        root
    ///       /    \
    ///   alice   bob
    uint256 _root = PoseidonT3.hash([_aliceLeaf, _bobLeaf]);

    vm.expectEmit(address(_keystore));
    emit ITreeUpdates.LeafInserted(_bobLeaf, _root, 1);
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicySet(bob.addr, bob.nullifyingKeyHash, bob.authDigest);
    vm.prank(bob.addr);
    _keystore.setAuthPolicy(bob.authDigest, bob.nullifyingKeyHash);

    /// Verify old root (Alice's leaf) is still known (within liveness window)
    assertTrue(_keystore.isKnownRoot(_aliceLeaf));

    /// Verify Bob's data and new root
    assertEq(_keystore.nullifyingKeys(bob.addr), bob.nullifyingKeyHash);
    assertEq(_keystore.currentRoot(), _root); // currentRoot = hash(alice, bob)
    assertTrue(_keystore.isKnownRoot(_root));

    /// =================================
    /// STEP 3: Charlie inserts his leaf
    /// =================================
    uint256 _charlieLeaf = PoseidonT4.hash([charlie.ownerAddress, charlie.nullifyingKeyHash, charlie.authDigest]);

    /// ROOT GENERATION (Insertion 3):
    /// With three leaves, the tree becomes:
    ///           newRoot
    ///          /       \
    ///       root      charlie
    ///      /    \
    ///   alice   bob
    ///
    /// The new root is computed by hashing the previous root with Charlie's leaf:
    /// newRoot = hash(previousRoot, charlieLeaf)
    ///         = hash(hash(alice, bob), charlie)
    uint256 _newRoot = PoseidonT3.hash([_root, _charlieLeaf]);

    vm.expectEmit(address(_keystore));
    emit ITreeUpdates.LeafInserted(_charlieLeaf, _newRoot, 2);
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicySet(charlie.addr, charlie.nullifyingKeyHash, charlie.authDigest);
    vm.prank(charlie.addr);
    _keystore.setAuthPolicy(charlie.authDigest, charlie.nullifyingKeyHash);

    /// Verify all historical roots are still known (within liveness window)
    assertTrue(_keystore.isKnownRoot(_aliceLeaf));
    assertTrue(_keystore.isKnownRoot(_root));

    /// Verify Charlie's data and the latest root
    assertEq(_keystore.nullifyingKeys(charlie.addr), charlie.nullifyingKeyHash);
    assertEq(_keystore.currentRoot(), _newRoot); // currentRoot = hash(hash(alice, bob), charlie)
    assertTrue(_keystore.isKnownRoot(_newRoot));
  }

  function test_insertAndUpdate() external {
    /// =====================================
    /// STEP 1: Alice inserts her initial leaf
    /// =====================================
    uint256 _leaf = PoseidonT4.hash([alice.ownerAddress, alice.nullifyingKeyHash, alice.authDigest]);

    vm.prank(alice.addr);
    _keystore.setAuthPolicy(alice.authDigest, alice.nullifyingKeyHash);

    /// =======================================
    /// STEP 2: Alice updates her auth digest
    /// =======================================
    uint256 _nextAuthDigest =
      PoseidonT3.hash([Constants.AUTH_TYPE_DIRECT_KEY, uint256(keccak256('alice_new_revocable_key'))]);

    /// Create Alice's new leaf with the updated auth digest
    /// Note: address and nullifyingKeyHash remain the same, only authDigest can change
    uint256 _nextLeaf = PoseidonT4.hash([alice.ownerAddress, alice.nullifyingKeyHash, _nextAuthDigest]);

    /// ROOT GENERATION (Update with single leaf):
    /// Since Alice is the only leaf in the tree, updating her leaf
    /// means the new root IS the new leaf itself:
    /// The proof is empty because the path from leaf to root has length zero
    uint256[] memory _proof = new uint256[](0);

    /// Expect update events
    vm.expectEmit(address(_keystore));
    emit ITreeUpdates.LeafUpdated(_nextLeaf, _nextLeaf, 0);
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicyUpdated(alice.addr, alice.authDigest, _nextAuthDigest);

    /// Alice updates her auth policy
    vm.prank(alice.addr);
    _keystore.updateAuthPolicy(alice.authDigest, _nextAuthDigest, _proof);

    // New root is the current root (single leaf tree, so root = leaf)
    assertEq(_keystore.currentRoot(), _nextLeaf);

    // New root is recognized as valid
    assertTrue(_keystore.isKnownRoot(_nextLeaf));

    // Old root is still valid (within liveness window)
    assertTrue(_keystore.isKnownRoot(_leaf));
    // Nullifying key remains unchanged (immutable per user)
    assertEq(_keystore.nullifyingKeys(alice.addr), alice.nullifyingKeyHash);
  }

  function test_updateAuthPolicy_cannotUpdateAnotherUsersLeaf() external {
    /// STEP 1: Alice and Bob both set their auth policies
    vm.prank(alice.addr);
    _keystore.setAuthPolicy(alice.authDigest, alice.nullifyingKeyHash);

    uint256 _bobLeaf = PoseidonT4.hash([bob.ownerAddress, bob.nullifyingKeyHash, bob.authDigest]);
    vm.prank(bob.addr);
    _keystore.setAuthPolicy(bob.authDigest, bob.nullifyingKeyHash);

    /// Tree after 2 insertions:
    ///        root
    ///       /    \
    ///   alice   bob
    ///
    /// Sibling proof for Alice's position (index 0) = [bobLeaf]

    /// STEP 2: Bob tries to update Alice's leaf using her authDigest
    /// and the correct sibling proof for Alice's position.
    /// Even with all public info, the recomputed oldLeaf will be
    /// PoseidonT4(bob, aliceAuthDigest, bobNullifyingKeyHash) != aliceLeaf,
    /// so LeanIMT.update reverts because that leaf doesn't exist in the tree.
    uint256 _maliciousDigest = PoseidonT2.hash([uint256(keccak256('malicious_digest'))]);
    uint256[] memory _proof = new uint256[](1);
    _proof[0] = _bobLeaf;

    vm.prank(bob.addr);
    vm.expectRevert(LeafDoesNotExist.selector);
    _keystore.updateAuthPolicy(alice.authDigest, _maliciousDigest, _proof);
  }

  function test_updateAuthPolicy_revertsWhenMerkleProofSiblingNodeIsOutOfScalarField() external {
    // Step 1: Build a two-leaf keystore tree so Alice's update requires one sibling node.
    vm.prank(alice.addr);
    _keystore.setAuthPolicy(alice.authDigest, alice.nullifyingKeyHash);

    vm.prank(bob.addr);
    _keystore.setAuthPolicy(bob.authDigest, bob.nullifyingKeyHash);

    // Step 2: Replace Alice's Merkle proof sibling with the first value outside the SNARK scalar field.
    uint256 _nextAuthDigest =
      PoseidonT3.hash([Constants.AUTH_TYPE_DIRECT_KEY, uint256(keccak256('alice_new_revocable_key'))]);
    uint256[] memory _proof = new uint256[](1);
    _proof[0] = SNARK_SCALAR_FIELD;

    // Step 3: LeanIMT should reject the invalid Merkle proof path before recomputing the root.
    vm.expectRevert(LeafGreaterThanSnarkScalarField.selector);
    vm.prank(alice.addr);
    _keystore.updateAuthPolicy(alice.authDigest, _nextAuthDigest, _proof);
  }

  function test_updateWithLongProof() external {
    /// ================================================
    /// STEP 1: Build a tree with Alice, Bob, and Charlie
    /// ================================================

    /// Create and insert Alice's leaf (index 0)
    uint256 _aliceLeaf = PoseidonT4.hash([alice.ownerAddress, alice.nullifyingKeyHash, alice.authDigest]);
    vm.prank(alice.addr);
    _keystore.setAuthPolicy(alice.authDigest, alice.nullifyingKeyHash);

    /// Create and insert Bob's leaf (index 1)
    uint256 _bobLeaf = PoseidonT4.hash([bob.ownerAddress, bob.nullifyingKeyHash, bob.authDigest]);
    vm.prank(bob.addr);
    _keystore.setAuthPolicy(bob.authDigest, bob.nullifyingKeyHash);

    /// Create and insert Charlie's leaf (index 2)
    uint256 _charlieLeaf = PoseidonT4.hash([charlie.ownerAddress, charlie.nullifyingKeyHash, charlie.authDigest]);

    /// ROOT GENERATION (After 3 insertions):
    /// Tree structure:
    ///           newRoot
    ///          /       \
    ///    hash(A,B)    charlie
    ///      /    \
    ///   alice   bob
    ///
    /// The root is computed as: hash(hash(alice, bob), charlie)
    uint256 _newRoot = PoseidonT3.hash([PoseidonT3.hash([_aliceLeaf, _bobLeaf]), _charlieLeaf]);
    vm.prank(charlie.addr);
    _keystore.setAuthPolicy(charlie.authDigest, charlie.nullifyingKeyHash);

    assertEq(_keystore.currentRoot(), _newRoot);
    assertTrue(_keystore.isKnownRoot(_newRoot));

    /// ============================================
    /// STEP 2: Alice updates her auth digest
    /// ============================================

    /// Alice creates a new authentication digest and computes a new leaf
    uint256 _nextAuthDigest =
      PoseidonT3.hash([Constants.AUTH_TYPE_DIRECT_KEY, uint256(keccak256('alice_new_revocable_key'))]);
    uint256 _nextLeaf = PoseidonT4.hash([alice.ownerAddress, alice.nullifyingKeyHash, _nextAuthDigest]);

    /// ROOT GENERATION (After Alice's update):
    /// To update Alice's leaf at index 0, we need to recompute the root with her new leaf.
    /// Tree structure after update:
    ///              lastRoot
    ///             /        \
    ///    hash(A',B)       charlie
    ///      /    \
    ///  alice'   bob
    ///
    /// The new root is computed as: hash(hash(nextLeaf, bob), charlie)
    /// This matches the same structure, but with Alice's updated leaf.
    uint256 _lastRoot = PoseidonT3.hash([PoseidonT3.hash([_nextLeaf, _bobLeaf]), _charlieLeaf]);

    /// Build the Merkle proof for Alice's leaf (index 0)
    /// To update a leaf, we need its sibling nodes at each level:
    /// - proof[0] = _bobLeaf (Alice's sibling at the bottom level)
    /// - proof[1] = _charlieLeaf (the sibling of hash(alice, bob) at the next level)
    uint256[] memory _proof = new uint256[](2);
    _proof[0] = _bobLeaf;
    _proof[1] = _charlieLeaf;

    vm.expectEmit(address(_keystore));
    emit ITreeUpdates.LeafUpdated(_nextLeaf, _lastRoot, 0);
    vm.expectEmit(address(_keystore));
    emit IKeystore.AuthPolicyUpdated(alice.addr, alice.authDigest, _nextAuthDigest);
    vm.prank(alice.addr);
    _keystore.updateAuthPolicy(alice.authDigest, _nextAuthDigest, _proof);
  }
}
