// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note} from './IntegrationBase.t.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {_calcFee} from 'test/handlers/HandlerBase.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for PoolVault.deposit() using real ZK proofs
/// @dev Generates proofs at runtime via FFI calls to test/helper/DepositProofGenerator.mjs
contract PoolVaultDepositIntegration is IntegrationBase {
  using ProofLibV2 for ProofLibV2.DepositProof;

  /*///////////////////////////////////////////////////////////////
                        VERIFIER TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Test that the real verifier accepts a valid ERC20 deposit proof
  function test_verifier_acceptsValidProof_erc20() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      address(_token),
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    bool isValid = _poolVault.depositVerifier().verifyProof(proof.pA, proof.pB, proof.pC, proof.pubSignals);
    assertTrue(isValid, 'Valid ERC20 proof should be accepted');
  }

  /// @notice Test that the real verifier accepts a valid ETH deposit proof
  function test_verifier_acceptsValidProof_eth() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      Constants.NATIVE_ASSET,
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    bool isValid = _poolVault.depositVerifier().verifyProof(proof.pA, proof.pB, proof.pC, proof.pubSignals);
    assertTrue(isValid, 'Valid ETH proof should be accepted');
  }

  /// @notice Test that corrupted proofs are rejected
  function test_verifier_rejectsCorruptedProof() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      address(_token),
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    proof.pA[0] = proof.pA[0] + 1;

    bool isValid = _poolVault.depositVerifier().verifyProof(proof.pA, proof.pB, proof.pC, proof.pubSignals);
    assertFalse(isValid, 'Corrupted proof should be rejected');
  }

  /// @notice Test that wrong public signals cause rejection
  function test_verifier_rejectsWrongPublicSignals() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      address(_token),
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    proof.pubSignals[0] = proof.pubSignals[0] + 1;

    bool isValid = _poolVault.depositVerifier().verifyProof(proof.pA, proof.pB, proof.pC, proof.pubSignals);
    assertFalse(isValid, 'Proof with wrong public signals should be rejected');
  }

  /*///////////////////////////////////////////////////////////////
                        DEPOSIT FLOW TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Test full deposit flow with ERC20 token via Entrypoint
  function test_deposit_happyPath_erc20() external {
    uint32 rootIndexBefore = _poolVault.currentRootIndex();

    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    uint256 fee = _calcFee(SAMPLE_VALUE);

    // Verify deposit value went to PoolVault
    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE, 'PoolVault should hold deposited value');

    // Verify vetting fee stayed in Entrypoint
    assertEq(_token.balanceOf(address(_entrypoint)), fee, 'Entrypoint should hold vetting fee');

    // Verify state tree was updated (root index increments with wrap-around)
    uint32 rootIndexAfter = _poolVault.currentRootIndex();
    uint32 historySize = _poolVault.rootHistorySize();
    uint32 expectedIndex = (rootIndexBefore + 1) % historySize;
    assertEq(rootIndexAfter, expectedIndex, 'Root index should increment after deposit');

    // Verify the new root matches the deposit leaf (first deposit, so root = leaf)
    uint256 newRoot = _poolVault.roots(rootIndexAfter);
    assertEq(newRoot, deposit.depositLeaf, 'Root should equal deposit leaf for first deposit');
    assertTrue(_poolVault.isKnownRoot(newRoot), 'New root should be known');
  }

  /// @notice Test full deposit flow with native ETH via Entrypoint
  function test_deposit_happyPath_eth() external {
    uint32 rootIndexBefore = _poolVault.currentRootIndex();

    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    uint256 fee = _calcFee(Constants.NATIVE_ASSET, SAMPLE_VALUE);

    // Verify deposit value went to PoolVault
    assertEq(address(_poolVault).balance, SAMPLE_VALUE, 'PoolVault should hold deposited value');

    // Verify vetting fee stayed in Entrypoint
    assertEq(address(_entrypoint).balance, fee, 'Entrypoint should hold vetting fee');

    // Verify state tree was updated (root index increments with wrap-around)
    uint32 rootIndexAfter = _poolVault.currentRootIndex();
    uint32 historySize = _poolVault.rootHistorySize();
    uint32 expectedIndex = (rootIndexBefore + 1) % historySize;
    assertEq(rootIndexAfter, expectedIndex, 'Root index should increment after deposit');

    // Verify the new root matches the deposit leaf (first deposit, so root = leaf)
    uint256 newRoot = _poolVault.roots(rootIndexAfter);
    assertEq(newRoot, deposit.depositLeaf, 'Root should equal deposit leaf for first deposit');
    assertTrue(_poolVault.isKnownRoot(newRoot), 'New root should be known');
  }

  /// @notice Test deposit reverts when caller lacks DEPOSITOR_ROLE
  /// @dev Normal users should go through the Entrypoint, not call PoolVault directly
  function test_deposit_revertsWhenUnauthorized() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      address(_token),
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    vm.prank(alice.addr);
    vm.expectRevert(IPermissioned.Permissioned_NotAuthorized.selector);
    _poolVault.deposit(proof, _defaultNoteData);
  }

  /// @notice Test deposit reverts with invalid proof
  function test_deposit_revertsWithInvalidProof() external {
    ProofLibV2.DepositProof memory proof = ProofGenerator.generateDepositProof(
      address(_token),
      SAMPLE_VALUE,
      PoseidonT3.hash([alice.ownerAddress, alice.noteSecrets[0]]),
      alice.depositSecrets[0],
      uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD
    );

    proof.pA[0] = proof.pA[0] + 1;

    vm.prank(address(_entrypoint));
    vm.expectRevert(IPoolVault.PoolVault_InvalidDepositProof.selector);
    _poolVault.deposit(proof, _defaultNoteData);
  }

  /// @notice Test multiple deposits grow the Merkle tree correctly
  /// @dev Tests: Alice deposits twice, then Bob deposits once
  function test_deposit_multipleDeposits_growsTree() external {
    uint256[3] memory leaves;
    uint256[3] memory roots;

    // DEPOSIT 1: Alice's first deposit
    {
      Note memory note = _deposit(alice, address(_token), SAMPLE_VALUE);
      leaves[0] = note.depositLeaf;
      roots[0] = _poolVault.roots(_poolVault.currentRootIndex());
    }

    // First deposit: root = leaf
    assertEq(roots[0], leaves[0], 'Root after 1st deposit should equal leaf');

    // DEPOSIT 2: Alice's second deposit
    {
      Note memory note = _deposit(alice, address(_token), SAMPLE_VALUE);
      leaves[1] = note.depositLeaf;
      roots[1] = _poolVault.roots(_poolVault.currentRootIndex());
    }

    // Second deposit: root = hash(leaf1, leaf2)
    assertEq(roots[1], PoseidonT3.hash([leaves[0], leaves[1]]), 'Root after 2nd deposit');

    // DEPOSIT 3: Bob's deposit
    {
      Note memory note = _deposit(bob, address(_token), SAMPLE_VALUE);
      leaves[2] = note.depositLeaf;
      roots[2] = _poolVault.roots(_poolVault.currentRootIndex());
    }

    // Third deposit: root = hash(hash(leaf1, leaf2), leaf3)
    assertEq(roots[2], PoseidonT3.hash([roots[1], leaves[2]]), 'Root after 3rd deposit');

    // Verify all historical roots are still known
    assertTrue(_poolVault.isKnownRoot(roots[0]), 'Root1 should still be known');
    assertTrue(_poolVault.isKnownRoot(roots[1]), 'Root2 should still be known');
    assertTrue(_poolVault.isKnownRoot(roots[2]), 'Root3 should still be known');

    // Verify total balance in PoolVault (3 deposits worth of value)
    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE * 3, 'PoolVault should hold all deposit values');

    // Verify total fees accumulated in Entrypoint (3 deposits worth of fees)
    assertEq(_token.balanceOf(address(_entrypoint)), _calcFee(SAMPLE_VALUE) * 3, 'Entrypoint should hold all fees');
  }

  /*///////////////////////////////////////////////////////////////
                  NON-CANONICAL TOKEN ID TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit via Entrypoint reverts on the on-chain canonicality check when tokenId >= 2^160
  /// @dev Circuit enforces tokenId < 2^160 via Num2Bits, so a real proof is impossible to
  ///      generate (witness generation fails for non-canonical values); uses a synthetic
  ///      proof since Entrypoint.deposit reads tokenId() before any verifier call.
  function test_deposit_revertsWhenTokenIdIsNonCanonical_viaEntrypoint() external {
    uint256 _dirtyTokenId = uint256(uint160(address(_token))) | (uint256(0xDEAD) << 160);
    uint256 _depositContext = uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD;

    ProofLibV2.DepositProof memory proof;
    proof.pubSignals[1] = _dirtyTokenId;
    proof.pubSignals[2] = SAMPLE_VALUE;
    proof.pubSignals[3] = _depositContext;

    vm.prank(alice.addr);
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirtyTokenId));
    _entrypoint.deposit(proof, _defaultNoteData, bytes(''));
  }

  /// @notice Direct PoolVault.deposit reverts on the on-chain canonicality check when tokenId >= 2^160
  /// @dev Circuit enforces tokenId < 2^160 via Num2Bits, so a real proof is impossible to
  ///      generate (witness generation fails for non-canonical values); uses a synthetic
  ///      proof and mocks verifyProof since PoolVault.deposit runs the verifier before the
  ///      canonicality check.
  function test_deposit_revertsWhenTokenIdIsNonCanonical_direct() external {
    uint256 _dirtyTokenId = uint256(uint160(address(_token))) | (uint256(0xDEAD) << 160);
    uint256 _depositContext = uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD;

    ProofLibV2.DepositProof memory proof;
    proof.pubSignals[1] = _dirtyTokenId;
    proof.pubSignals[2] = SAMPLE_VALUE;
    proof.pubSignals[3] = _depositContext;

    vm.mockCall(
      address(_poolVault.depositVerifier()),
      abi.encodeWithSelector(_poolVault.depositVerifier().verifyProof.selector),
      abi.encode(true)
    );

    vm.prank(address(_entrypoint));
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirtyTokenId));
    _poolVault.deposit(proof, _defaultNoteData);
  }
}
