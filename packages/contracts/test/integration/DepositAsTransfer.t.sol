// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {RagequitProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for deposit-as-transfer:
///         Alice deposits a note addressed to Bob. Only Bob (the keystore holder) can spend it.
contract DepositAsTransferIntegration is IntegrationBase {
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
  }

  /*///////////////////////////////////////////////////////////////
                    HAPPY PATH — BOB CAN SPEND
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits for Bob (ERC20) → Bob transacts (pure transfer, proving spendability)
  function test_depositAsTransfer_bobCanSpend_erc20() external {
    Note memory bobsNote = _deposit(alice, bob, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    // Then, off-chain, Alice shares `bobsNote` with Bob
    // (noteSecret, depositSecret, value, label, tokenId)
    // so he can reconstruct the Note and spend it.

    _transact({
      _note: bobsNote,
      _spender: bob,
      _recipient: bob,
      _outputValue: SAMPLE_VALUE,
      _outputLabel: bobsNote.inputLabel,
      _amountOut: 0
    });

    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE, 'Balance changed on pure transfer');
  }

  /// @notice Alice deposits for Bob (ETH) → Bob transacts (pure transfer)
  function test_depositAsTransfer_bobCanSpend_eth() external {
    Note memory bobsNote = _deposit(alice, bob, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    // Then, off-chain, Alice shares `bobsNote` with Bob
    // (noteSecret, depositSecret, value, label, tokenId)
    // so he can reconstruct the Note and spend it.

    _transact({
      _note: bobsNote,
      _spender: bob,
      _recipient: bob,
      _outputValue: SAMPLE_VALUE,
      _outputLabel: bobsNote.inputLabel,
      _amountOut: 0
    });

    assertEq(address(_poolVault).balance, SAMPLE_VALUE, 'ETH balance changed on pure transfer');
  }

  /*///////////////////////////////////////////////////////////////
            NEGATIVE — ALICE CANNOT SPEND BOB'S NOTE
  ///////////////////////////////////////////////////////////////*/

  /// @notice Depositor (Alice) cannot spend a note she created for Bob
  /// @dev Alice has the note secrets (noteSecret, depositSecret, label, value, tokenId) because
  ///      she generated them during _deposit.
  ///
  ///       Despite this, she cannot spend the note:
  ///
  ///      - Transact: the circuit requires Bob's privateNullifyingKey and privateRevocableKey to
  ///        satisfy the keystore membership constraint. Alice doesn't have these — only Bob does.
  ///        Proof generation fails at the circuit level (see ColdStart.t.sol for analogous tests).
  ///
  ///      - Ragequit: same circuit constraint (needs Bob's private keys), plus the contract
  ///        enforces msg.sender == ownerAddress. We test the latter below: Bob generates a valid
  ///        ragequit proof, Alice frontruns the tx, and the msg.sender check blocks her.
  function test_depositAsTransfer_depositorCannotSpend() external {
    // ── Step 1: Alice deposits a note addressed to Bob ──
    Note memory bobsNote = _deposit(alice, bob, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    // ── Step 2: Alice tries to transact Bob's note — circuit rejects (wrong keys) ──
    NoteCreationParams memory _aliceOutput = alice.receiveNote(SAMPLE_VALUE, bobsNote.inputLabel);
    ProofGenerator.TransactInputs memory _scenario = _buildTransactInputs(bobsNote, alice, _aliceOutput, 0);

    _assertTransactProofReverts(
      _scenario, 'Alice cannot generate transact proof; noteAddressHash is keyed to Bob, not Alice'
    );

    // ── Step 3: Bob generates a valid ragequit proof (requires his private keystore keys) ──
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(bob, bobsNote);

    // ── Step 4: Alice frontruns Bob's ragequit — blocked by msg.sender != ownerAddress ──
    vm.prank(alice.addr);
    vm.expectRevert(IPoolVault.PoolVault_InvalidOwnerAddress.selector);
    _poolVault.ragequit(_rqProof);

    // Confirm the note is NOT spent
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent');

    // ── Step 5: Bob's original ragequit succeeds ──
    uint256 _bobBalanceBefore = _token.balanceOf(bob.addr);
    _submitRagequit(bob, _rqProof);

    assertEq(_token.balanceOf(bob.addr), _bobBalanceBefore + SAMPLE_VALUE, 'Bob should recover full value');
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be empty');
  }

  receive() external payable {}
}
