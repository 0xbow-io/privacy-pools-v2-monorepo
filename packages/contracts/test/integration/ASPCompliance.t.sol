// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT2} from 'poseidon-solidity/PoseidonT2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integraion tests for ASP compliance:
///         - revocation → stale transact rejected → ragequit succeeds
///         - benign rotation → stale proof rejected → re-prove → transact succeeds
///         - revocation → proof generation fails (circuit level) → ragequit succeeds
contract ASPComplianceIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();

    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
  }

  /*///////////////////////////////////////////////////////////////
                      ASP COMPLIANCE TESTS
  ///////////////////////////////////////////////////////////////*/

  function test_aspCompliance_revocation_erc20() external {
    _revocationFlow(address(_token), SAMPLE_VALUE);
  }

  function test_aspCompliance_revocation_eth() external {
    _revocationFlow(Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  function test_aspCompliance_benignRotation_erc20() external {
    _benignRotationFlow(address(_token), SAMPLE_VALUE);
  }

  function test_aspCompliance_benignRotation_eth() external {
    _benignRotationFlow(Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  function test_aspCompliance_partialWithdrawal_erc20() external {
    _partialWithdrawalFlow(address(_token), SAMPLE_VALUE);
  }

  function test_aspCompliance_partialWithdrawal_eth() external {
    _partialWithdrawalFlow(Constants.NATIVE_ASSET, SAMPLE_VALUE);
  }

  /*///////////////////////////////////////////////////////////////
                      SHARED FLOW HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Publish an unrelated root, effectively revoking all previously-registered labels
  function _revokeASP() internal {
    uint256 _newAspRoot = PoseidonT2.hash([uint256(keccak256('unrelated_label'))]);
    vm.prank(_config.postman);
    _aspRegistry.updateASPRoot(_newAspRoot, bytes('ipfs://revoked'));
  }

  /// @dev Add an unrelated label to the ASP tree, advancing the root without revoking existing labels
  function _rotateASP() internal {
    uint256 _extraLeaf = PoseidonT2.hash([uint256(keccak256('extra_unrelated_label'))]);
    _aspTreeMirror.insert(_extraLeaf);
    vm.prank(_config.postman);
    _aspRegistry.updateASPRoot(_aspTreeMirror.root(), bytes('ipfs://rotation'));
  }

  /// @dev Revocation flow:
  ///      deposit → generate proof → ASP revokes →
  ///      stale transact fails (PoolVault_InvalidASPRoot) → ragequit succeeds
  function _revocationFlow(address _tokenAddr, uint256 _value) internal {
    // ── Step 1: Deposit ──
    Note memory _aliceNote = _deposit(alice, _tokenAddr, _value);

    // ── Step 2: Generate transact proof while ASP root is still valid ──
    NoteCreationParams memory _aliceOutput = alice.receiveNote(_value, _aliceNote.inputLabel);
    ProofLibV2.TransactProof memory _staleProof =
      _buildTransactProof({_note: _aliceNote, _spender: alice, _noteCreationParams: _aliceOutput, _amountOut: 0});

    // ── Step 3: ASP revokes label ──
    _revokeASP();

    // ── Step 4: Stale transact fails — proof references pre-revocation ASP root ──
    vm.expectRevert(IPoolVault.PoolVault_InvalidASPRoot.selector);
    _poolVault.transact(_staleProof, _defaultTransactParams, _defaultTransactNoteData);

    // ── Step 5: Ragequit succeeds — no ASP check
    uint256 _aliceBalanceBefore = _balanceOf(_tokenAddr, alice.addr);
    _ragequit(alice, _aliceNote);
    assertEq(_balanceOf(_tokenAddr, alice.addr), _aliceBalanceBefore + _value, 'Alice should recover full value');
  }

  /// @dev Benign rotation flow:
  ///      deposit → generate proof against R1 → unrelated label added (root advances to R2) →
  ///      stale proof rejected → re-generate against R2 → transact succeeds
  function _benignRotationFlow(address _tokenAddr, uint256 _value) internal {
    // ── Step 1: Deposit ──
    Note memory _aliceNote = _deposit(alice, _tokenAddr, _value);

    // ── Step 2: Generate transact proof against current ASP root (R1) ──
    NoteCreationParams memory _output = alice.receiveNote(_value, _aliceNote.inputLabel);
    ProofLibV2.TransactProof memory _staleProof =
      _buildTransactProof({_note: _aliceNote, _spender: alice, _noteCreationParams: _output, _amountOut: 0});

    // ── Step 3: Benign rotation — an unrelated label is added, advancing root to R2 ──
    _rotateASP();

    // ── Step 4: Stale proof rejected — references R1, contract expects R2 ──
    vm.expectRevert(IPoolVault.PoolVault_InvalidASPRoot.selector);
    _poolVault.transact(_staleProof, _defaultTransactParams, _defaultTransactNoteData);

    // ── Step 5: Re-generate proof against R2 — works since alice is still in the set ──
    ProofLibV2.TransactProof memory _freshProof =
      _buildTransactProof({_note: _aliceNote, _spender: alice, _noteCreationParams: _output, _amountOut: 0});

    // ── Step 6: Fresh proof succeeds ──
    _poolVault.transact(_freshProof, _defaultTransactParams, _defaultTransactNoteData);
    assertEq(
      _poolVault.spentNullifiers(_freshProof.nullifierHashes()[0]),
      vm.getBlockTimestamp(),
      'Nullifier should be spent after successful transact'
    );
  }

  /// @dev Partial withdrawal flow:
  ///      deposit → transact (1/3 withdraw + 2/3 to Bob) → ASP revokes →
  ///      proof generation fails (circuit level) → Bob ragequits
  function _partialWithdrawalFlow(address _tokenAddr, uint256 _value) internal {
    uint256 _withdrawValue = _value / 3;
    uint256 _bobValue = _value - _withdrawValue;

    // ── Step 1: Alice deposits ──
    Note memory _aliceNote = _deposit(alice, _tokenAddr, _value);

    // ── Step 2: Alice transacts — 1/3 withdrawal + 2/3 transfer to Bob ──
    (Note memory _bobNote,) = _transact(_aliceNote, alice, bob, _bobValue, _aliceNote.inputLabel, _withdrawValue);

    // ── Step 3: ASP revokes label ──
    _revokeASP();

    // ── Step 4: Proof generation fails ──
    // _buildTransactInputs reads the on-chain ASP root (which now has revoked bob) but builds the
    // Merkle path from _aspTreeMirror (which is stale, not updated after revocation).
    // The root/path mismatch makes the circuit unsatisfiable → FFI reverts.
    _assertTransactProofReverts(
      _buildTransactInputs(_bobNote, bob, bob.receiveNote(_bobValue, _aliceNote.inputLabel), 0),
      'Proof generation should fail after ASP revocation'
    );

    // ── Step 5: Bob ragequits to recover his portion ──
    uint256 _bobBalanceBefore = _balanceOf(_tokenAddr, bob.addr);
    _ragequit(bob, _bobNote);
    assertEq(_balanceOf(_tokenAddr, bob.addr), _bobBalanceBefore + _bobValue, 'Bob should recover his portion');
  }

  receive() external payable {}
}
