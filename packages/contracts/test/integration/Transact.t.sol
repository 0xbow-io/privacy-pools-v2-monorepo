// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note} from './IntegrationBase.t.sol';
import {NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for PoolVault.transact() using real ZK proofs
/// @dev Deposits on-chain, registers in keystore, sets ASP root, then transacts
///      with proofs whose public roots match actual contract state.
contract TransactIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
    charlie = _registerInKeystore(charlie);
    vm.warp(vm.getBlockTimestamp() + 1);
  }

  /*///////////////////////////////////////////////////////////////
                    FULL FLOW TESTS — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice End-to-end: ERC20 deposit → transact (pure transfer, no withdrawal)
  function test_transact_happyPath_erc20() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: 0
    });

    // No withdrawal for pure transfer — PoolVault balance unchanged
    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE, 'Balance changed on pure transfer');
  }

  /*///////////////////////////////////////////////////////////////
                    FULL FLOW TESTS — ETH
  ///////////////////////////////////////////////////////////////*/

  /// @notice End-to-end: ETH deposit → transact (pure transfer, no withdrawal)
  function test_transact_happyPath_eth() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: 0
    });

    // No withdrawal for pure transfer — PoolVault ETH balance unchanged
    assertEq(address(_poolVault).balance, SAMPLE_VALUE, 'ETH balance changed on pure transfer');
  }

  /*///////////////////////////////////////////////////////////////
                      REVERT TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Transact proof generation fails when amountOut exceeds total input value
  function test_transact_proofGenerationRevertsWhenAmountOutExceedsInputValue() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    _assertTransactProofReverts(
      _buildTransactInputs({
        _note: deposit,
        _spender: alice,
        _noteCreationParams: alice.receiveNote(0, deposit.inputLabel),
        _amountOut: SAMPLE_VALUE + 1
      }),
      'Proof generation should fail when amountOut exceeds input value'
    );
  }

  /// @notice Transact reverts when context doesn't match params
  function test_transact_revertsWithContextMismatch() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    uint256 wrongContext = uint256(keccak256('wrong_context')) % SNARK_SCALAR_FIELD;

    Note[] memory _notes = new Note[](1);
    _notes[0] = deposit;
    NoteCreationParams[] memory _params = new NoteCreationParams[](1);
    _params[0] = alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
    ProofLibV2.TransactProof memory proof = _buildTransactProof({
      _notes: _notes, _spender: alice, _noteCreationParams: _params, _amountOut: 0, _context: wrongContext
    });

    vm.expectRevert(IPoolVault.PoolVault_ProofContextMismatch.selector);
    _poolVault.transact(proof, _defaultTransactParams, _defaultTransactNoteData);
  }

  /// @notice Double-spend: two proofs consuming the same input note (same nullifier, different output commitments)
  function test_transact_revertsOnDoubleSpend() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // First transact: consume the note with output commitment A
    ProofLibV2.TransactProof memory proof1 = _buildTransactProof({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: 0
    });

    // Second transact: same input note (same nullifier) but different output commitment
    ProofLibV2.TransactProof memory proof2 = _buildTransactProof({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: 0
    });

    _poolVault.transact(proof1, _defaultTransactParams, _defaultTransactNoteData);

    // Second proof has a new output commitment but the same nullifier — double spend
    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    _poolVault.transact(proof2, _defaultTransactParams, _defaultTransactNoteData);
  }

  /// @notice Double-spend: attempt to consume the same commitment twice in the same proof
  function test_transact_revertsOnDoubleSpendInSameProof() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    Note[] memory notes = new Note[](2);
    notes[0] = deposit;
    notes[1] = deposit;

    ProofLibV2.TransactProof memory proof = _buildTransactProof({
      _notes: notes,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    // Trying to spend the same commitment twice should produce the same nullifier
    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    _poolVault.transact(proof, _defaultTransactParams, _defaultTransactNoteData);
  }

  /// @notice insert the same commitment twice with different timestamps in
  ///state tree, causing them to have the same nullifier, and only one of them
  ///being spendable
  function test_transact_revertsOnDuplicatedCommitmentCreationInSeparateTransaction() external {
    Note memory deposit = _deposit(alice, address(_token), 100e18);
    Note[] memory notes = new Note[](1);
    notes[0] = deposit;
    uint256 aliceReusedSecret = uint256(keccak256('secret alice is reusing')) % SNARK_SCALAR_FIELD;
    uint256 aliceChangeNoteAddressHash = PoseidonT3.hash([alice.ownerAddress, aliceReusedSecret]);

    // alice attempts to create two commitments with the same parameters
    NoteCreationParams[] memory creationParams = new NoteCreationParams[](1);
    creationParams[0] = NoteCreationParams({
      noteSecret: aliceReusedSecret,
      depositSecret: aliceReusedSecret,
      noteAddressHash: aliceChangeNoteAddressHash,
      value: 20e18,
      label: deposit.inputLabel
    });
    (Note[] memory transacted,) = _transact({
      _notes: notes,
      _spender: alice,
      _noteCreationParams: creationParams,
      _amountOut: 80e18,
      _params: _defaultTransactParams,
      _payload: _defaultTransactNoteData
    });

    // advance timestamp so we skip the check on duplicated tree leaves implemented by the tree itself
    vm.warp(vm.getBlockTimestamp() + 1);
    // in this case we're trying to spend a zero-value commitment, but with a 1x2 transact as a precondition, we would actually be locking up funds
    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: transacted,
      _spender: alice,
      _noteCreationParams: creationParams,
      _amountOut: 0,
      _context: _hashTransactContext(_defaultTransactParams, _defaultTransactNoteData)
    });
    vm.expectRevert(IPoolVault.PoolVault_CommitmentAlreadyUsed.selector);
    _poolVault.transact(_proof, _defaultTransactParams, _defaultTransactNoteData);
  }

  /// @notice same as above, but create two commitments in the same transaction
  /// covering the full input note value but reusing their parameters
  function test_transact_revertsOnDuplicatedCommitmentCreationInSameTransaction() external {
    Note memory deposit = _deposit(alice, address(_token), 100e18);
    Note[] memory notes = new Note[](1);
    notes[0] = deposit;
    uint256 aliceReusedSecret = uint256(keccak256('secret alice is reusing')) % SNARK_SCALAR_FIELD;
    uint256 aliceChangeNoteAddressHash = PoseidonT3.hash([alice.ownerAddress, aliceReusedSecret]);
    vm.warp(vm.getBlockTimestamp() + 1);

    // alice attempts to create two commitments with the same parameters
    NoteCreationParams[] memory creationParams = new NoteCreationParams[](2);
    creationParams[0] = NoteCreationParams({
      noteSecret: aliceReusedSecret,
      depositSecret: aliceReusedSecret,
      noteAddressHash: aliceChangeNoteAddressHash,
      value: 50e18,
      label: deposit.inputLabel
    });
    creationParams[1] = creationParams[0];
    ProofLibV2.TransactProof memory _proof = _buildTransactProof({
      _notes: notes,
      _spender: alice,
      _noteCreationParams: creationParams,
      _amountOut: 0,
      _context: _hashTransactContext(_defaultTransactParams, _defaultTransactNoteData)
    });

    vm.expectRevert(IPoolVault.PoolVault_CommitmentAlreadyUsed.selector);
    _poolVault.transact(_proof, _defaultTransactParams, _defaultTransactNoteData);
  }

  /*///////////////////////////////////////////////////////////////
                    TRANSACT TESTS — NxM
  ///////////////////////////////////////////////////////////////*/
  function test_transact_NxM() external {
    Note memory aliceDeposit = _deposit(alice, Constants.NATIVE_ASSET, 2 * SAMPLE_VALUE);
    assertEq(address(_poolVault).balance, 2 * SAMPLE_VALUE);
    // TODO: simplify this to take a NoteCreationParams
    (Note memory transferredToBob,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(2 * SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });
    Note memory bobDeposit = _deposit(bob, Constants.NATIVE_ASSET, 2 * SAMPLE_VALUE);
    assertEq(address(_poolVault).balance, 4 * SAMPLE_VALUE);

    Note[] memory notes = new Note[](2);
    notes[0] = transferredToBob;
    notes[1] = bobDeposit;
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](3);
    _noteCreationParams[0] = alice.receiveNote(SAMPLE_VALUE, transferredToBob.inputLabel);
    _noteCreationParams[1] = bob.receiveNote(SAMPLE_VALUE, transferredToBob.inputLabel);
    _noteCreationParams[2] = charlie.receiveNote(SAMPLE_VALUE, bobDeposit.inputLabel);

    uint256 callerBalanceBefore = address(this).balance;
    Note[] memory finalNotes = new Note[](3);
    (finalNotes,) =
      _transact({_notes: notes, _spender: bob, _noteCreationParams: _noteCreationParams, _amountOut: SAMPLE_VALUE});

    assertEq(address(_poolVault).balance, 3 * SAMPLE_VALUE);
    assertEq(address(this).balance, callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens');

    // all created notes can be withdrawn
    callerBalanceBefore = address(this).balance;
    _transact({
      _note: finalNotes[0],
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, transferredToBob.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(address(_poolVault).balance, 2 * SAMPLE_VALUE);
    assertEq(address(this).balance, callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens');

    callerBalanceBefore = address(this).balance;
    _transact({
      _note: finalNotes[1],
      _spender: bob,
      _noteCreationParams: bob.receiveNote(0, transferredToBob.inputLabel),
      _amountOut: SAMPLE_VALUE
    });
    assertEq(address(_poolVault).balance, SAMPLE_VALUE);
    assertEq(address(this).balance, callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens');

    callerBalanceBefore = address(this).balance;
    _transact({
      _note: finalNotes[2],
      _spender: charlie,
      _noteCreationParams: charlie.receiveNote(0, bobDeposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });
    assertEq(address(_poolVault).balance, 0);
    assertEq(address(this).balance, callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens');
  }

  /*///////////////////////////////////////////////////////////////
                    WITHDRAWAL TESTS — 1xM
  ///////////////////////////////////////////////////////////////*/

  function test_transact_1xM() external {
    Note memory deposit = _deposit(alice, address(_token), 3 * SAMPLE_VALUE);
    assertEq(_token.balanceOf(address(_poolVault)), 3 * SAMPLE_VALUE);
    Note[] memory notes = new Note[](1);
    notes[0] = deposit;
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](3);
    _noteCreationParams[0] = alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
    _noteCreationParams[1] = bob.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
    _noteCreationParams[2] = charlie.receiveNote(SAMPLE_VALUE, deposit.inputLabel);

    (Note[] memory _newNotes,) = _transact({
      _notes: notes,
      _spender: alice,
      _noteCreationParams: _noteCreationParams,
      _amountOut: 0,
      _params: _defaultTransactParams,
      _payload: _defaultTransactNoteData
    });

    // ensure all created commitments are spendable
    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 callerBalanceBefore = _token.balanceOf(address(this));
    _transact({
      _note: _newNotes[0],
      _spender: alice,
      _noteCreationParams: alice.receiveNote(0, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(_token.balanceOf(address(_poolVault)), 2 * SAMPLE_VALUE);
    assertEq(
      _token.balanceOf(address(this)), callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens'
    );

    vm.warp(vm.getBlockTimestamp() + 1);
    callerBalanceBefore = _token.balanceOf(address(this));
    _transact({
      _note: _newNotes[1],
      _spender: bob,
      _noteCreationParams: bob.receiveNote(0, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE);
    assertEq(
      _token.balanceOf(address(this)), callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens'
    );

    vm.warp(vm.getBlockTimestamp() + 1);
    callerBalanceBefore = _token.balanceOf(address(this));
    _transact({
      _note: _newNotes[2],
      _spender: charlie,
      _noteCreationParams: charlie.receiveNote(0, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(_token.balanceOf(address(_poolVault)), 0);
    assertEq(
      _token.balanceOf(address(this)), callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens'
    );
  }

  /*///////////////////////////////////////////////////////////////
                    WITHDRAWAL TESTS — 1xM
  ///////////////////////////////////////////////////////////////*/

  function test_transact_1x5() external {
    Note memory deposit = _deposit(alice, address(_token), 5 * SAMPLE_VALUE);
    assertEq(_token.balanceOf(address(_poolVault)), 5 * SAMPLE_VALUE);
    assertEq(_token.balanceOf(address(this)), 0);
    Note[] memory _newNotes;
    {
      NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](5);
      _noteCreationParams[0] = alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
      _noteCreationParams[1] = bob.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
      _noteCreationParams[2] = charlie.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
      _noteCreationParams[3] = alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
      _noteCreationParams[4] = bob.receiveNote(SAMPLE_VALUE, deposit.inputLabel);
      Note[] memory notes = new Note[](1);
      notes[0] = deposit;

      (_newNotes,) = _transact({
        _notes: notes,
        _spender: alice,
        _noteCreationParams: _noteCreationParams,
        _amountOut: 0,
        _params: _defaultTransactParams,
        _payload: _defaultTransactNoteData
      });
      assertEq(_token.balanceOf(address(_poolVault)), 5 * SAMPLE_VALUE);
    }

    // ensure all created commitments are spendable
    {
      vm.warp(vm.getBlockTimestamp() + 1);
      _transact({
        _note: _newNotes[2],
        _spender: charlie,
        _noteCreationParams: charlie.receiveNote(0, deposit.inputLabel),
        _amountOut: SAMPLE_VALUE
      });
      assertEq(_token.balanceOf(address(_poolVault)), 4 * SAMPLE_VALUE);
      assertEq(_token.balanceOf(address(this)), SAMPLE_VALUE, 'Caller should receive withdrawn tokens');
    }

    {
      vm.warp(vm.getBlockTimestamp() + 1);
      Note[] memory _alicesNotes = new Note[](2);
      _alicesNotes[0] = _newNotes[0];
      _alicesNotes[1] = _newNotes[3];
      vm.warp(vm.getBlockTimestamp() + 1);
      _transact({
        _notes: _alicesNotes,
        _spender: alice,
        _params: alice.receiveNote(0, deposit.inputLabel),
        _amountOut: 2 * SAMPLE_VALUE
      });
      assertEq(_token.balanceOf(address(_poolVault)), 2 * SAMPLE_VALUE);
      assertEq(_token.balanceOf(address(this)), 3 * SAMPLE_VALUE, 'Caller should receive withdrawn tokens');
    }

    {
      vm.warp(vm.getBlockTimestamp() + 1);
      Note[] memory _bobsNotes = new Note[](2);
      _bobsNotes[0] = _newNotes[1];
      _bobsNotes[1] = _newNotes[4];
      NoteCreationParams[] memory _bobParams = new NoteCreationParams[](1);
      _bobParams[0] = bob.receiveNote(0, deposit.inputLabel);
      _transact({_notes: _bobsNotes, _spender: bob, _noteCreationParams: _bobParams, _amountOut: 2 * SAMPLE_VALUE});
      assertEq(_token.balanceOf(address(_poolVault)), 0);
      assertEq(_token.balanceOf(address(this)), 5 * SAMPLE_VALUE, 'Caller should receive withdrawn tokens');
    }
  }

  /*///////////////////////////////////////////////////////////////
                    WITHDRAWAL TESTS — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice Full withdrawal: deposit 1 ether ERC20 → withdraw entire amount
  function test_transact_fullWithdrawal_erc20() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 callerBalanceBefore = _token.balanceOf(address(this));

    // inputValue (1 ether) = outputValue (0) + amountOut (1 ether)
    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(0, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be empty after full withdrawal');
    assertEq(
      _token.balanceOf(address(this)), callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn tokens'
    );
  }

  /// @notice Partial withdrawal: deposit 1 ether ERC20 → withdraw 1/3, keep 2/3 in output note
  function test_transact_partialWithdrawal_erc20() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 withdrawAmount = SAMPLE_VALUE / 3;
    uint256 keepAmount = SAMPLE_VALUE - withdrawAmount;
    uint256 callerBalanceBefore = _token.balanceOf(address(this));

    // inputValue (1 ether) = outputValue (2/3 ether) + amountOut (1/3 ether)
    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(keepAmount, deposit.inputLabel),
      _amountOut: withdrawAmount
    });

    assertEq(_token.balanceOf(address(_poolVault)), keepAmount, 'PoolVault should hold remaining 2/3');
    assertEq(
      _token.balanceOf(address(this)), callerBalanceBefore + withdrawAmount, 'Caller should receive withdrawn 1/3'
    );
  }

  /*///////////////////////////////////////////////////////////////
                    WITHDRAWAL TESTS — ETH
  ///////////////////////////////////////////////////////////////*/

  /// @notice Full withdrawal: deposit 1 ether ETH → withdraw entire amount
  function test_transact_fullWithdrawal_eth() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 callerBalanceBefore = address(this).balance;

    // inputValue (1 ether) = outputValue (0) + amountOut (1 ether)
    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(0, deposit.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    assertEq(address(_poolVault).balance, 0, 'PoolVault should be empty after full withdrawal');
    assertEq(address(this).balance, callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive withdrawn ETH');
  }

  /// @notice Partial withdrawal: deposit 1 ether ETH → withdraw 1/3, keep 2/3 in output note
  function test_transact_partialWithdrawal_eth() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 withdrawAmount = SAMPLE_VALUE / 3;
    uint256 keepAmount = SAMPLE_VALUE - withdrawAmount;
    uint256 callerBalanceBefore = address(this).balance;

    // inputValue (1 ether) = outputValue (2/3 ether) + amountOut (1/3 ether)
    _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(keepAmount, deposit.inputLabel),
      _amountOut: withdrawAmount
    });

    assertEq(address(_poolVault).balance, keepAmount, 'PoolVault should hold remaining 2/3');
    assertEq(address(this).balance, callerBalanceBefore + withdrawAmount, 'Caller should receive withdrawn 1/3');
  }

  /*///////////////////////////////////////////////////////////////
                    CHAINED WITHDRAWAL TEST
  ///////////////////////////////////////////////////////////////*/

  /// @notice Bob spends two notes, one created by alice in a transact with him as a recipient and one deposited by him directly
  function test_transact_spendNotesFromTwoSenders() external {
    uint256 aliceDepositAmount = 100e18;
    uint256 aliceWithdrawAmount = 30e18;
    uint256 aliceTransferAmount = 70e18;
    uint256 bobDepositAmount = 10e18;
    // ── STEP 1: Alice deposits ──
    Note memory alicesDeposit = _deposit(alice, address(_token), aliceDepositAmount);

    // ── STEP 2: Alice withdraws part of her note and sends the rest to bob
    vm.warp(vm.getBlockTimestamp() + 1);
    uint256 balanceBefore = _token.balanceOf(address(this));
    (Note memory bobsTransferNote,) = _transact({
      _note: alicesDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(aliceTransferAmount, alicesDeposit.inputLabel),
      _amountOut: aliceWithdrawAmount
    });

    // ── STEP 3: Bob deposits
    vm.warp(vm.getBlockTimestamp() + 1);
    Note memory bobsDeposit = _deposit(bob, address(_token), bobDepositAmount);

    assertEq(_token.balanceOf(address(this)), balanceBefore + aliceWithdrawAmount, 'Caller should receive all tokens');

    // STEP 4: Spend both notes
    vm.warp(vm.getBlockTimestamp() + 1);
    balanceBefore = _token.balanceOf(address(this));
    Note[] memory _notes = new Note[](2);
    _notes[0] = bobsDeposit;
    _notes[1] = bobsTransferNote;
    NoteCreationParams[] memory _bobParams = new NoteCreationParams[](1);
    _bobParams[0] = bob.receiveNote(0, alicesDeposit.inputLabel);
    (, uint256[] memory _nullifierHashes) = _transact({
      _notes: _notes, _spender: bob, _noteCreationParams: _bobParams, _amountOut: bobDepositAmount + aliceTransferAmount
    });

    assertEq(_nullifierHashes.length, 2, 'transact_2x1 should spend two nullifiers');

    // Final state: vault empty, caller has the tokens
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be empty');
    assertEq(
      _token.balanceOf(address(this)),
      balanceBefore + aliceTransferAmount + bobDepositAmount,
      'Caller should receive all tokens'
    );
  }

  /// @notice Deposit → pure transfer → withdraw from the transferred note
  /// @dev Exercises the full lifecycle: Alice deposits, transfers to herself (creating a new
  ///      output note in a multi-leaf tree), then withdraws from that second note.
  function test_transact_depositTransferWithdraw() external {
    // ── STEP 1: Alice deposits ──
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── STEP 2: Alice does a pure transfer (to herself, new note with a different secret) ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory secondNote,) = _transact({
      _note: deposit,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, deposit.inputLabel),
      _amountOut: 0
    });

    // ── STEP 3: Alice withdraws from the transferred note ──
    vm.warp(vm.getBlockTimestamp() + 1);

    uint256 callerBalanceBefore = _token.balanceOf(address(this));

    _transact({
      _note: secondNote,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(0, secondNote.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    // Final state: vault empty, caller has the tokens
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be empty');
    assertEq(_token.balanceOf(address(this)), callerBalanceBefore + SAMPLE_VALUE, 'Caller should receive all tokens');
  }

  /*///////////////////////////////////////////////////////////////
                    CHAINED TRANSACT TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits → Alice transacts to Bob → Bob withdraws the full value
  /// @dev Exercises the full lifecycle: deposit → private transfer → withdrawal.
  ///      After Alice's transact the state tree has 3 leaves (deposit + output commitment
  ///      + nullifier), so Bob's input note sits at index 1 with real sibling data.
  function test_transact_chainedTransact_aliceToBobWithdraw() external {
    // ── STEP 1: Alice deposits ──
    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── STEP 2: Alice transacts to Bob ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // ── STEP 3: Bob spends the note Alice sent him ──
    vm.warp(vm.getBlockTimestamp() + 1);

    _transact({
      _note: bobNote,
      _spender: bob,
      _noteCreationParams: bob.receiveNote(0, bobNote.inputLabel),
      _amountOut: SAMPLE_VALUE
    });

    // Bob withdrew full value — PoolVault should be empty, test contract received the tokens
    assertEq(_token.balanceOf(address(_poolVault)), 0, 'PoolVault should be drained after withdrawal');
    assertEq(_token.balanceOf(address(this)), SAMPLE_VALUE, 'Test contract should have received withdrawn tokens');
  }

  /// @notice Alice deposits → Alice transacts to Bob → Bob transacts to Charlie → Charlie spends
  /// @dev Exercises a 3-hop chain: after two transacts the state tree has 5 leaves
  ///      (deposit + 2×output commitment + 2×nullifier), so Charlie's input note sits deep
  ///      in the tree with non-trivial sibling data at every level.
  function test_transact_chainedTransact_aliceToBobToCharlie() external {
    // ── STEP 1: Alice deposits ──
    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // ── STEP 2: Alice transacts to Bob ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // ── STEP 3: Bob transacts to Charlie ──
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory charlieNote,) = _transact({
      _note: bobNote,
      _spender: bob,
      _noteCreationParams: charlie.receiveNote(SAMPLE_VALUE, bobNote.inputLabel),
      _amountOut: 0
    });

    // ── STEP 4: self-transfers to prove the note is spendable
    vm.warp(vm.getBlockTimestamp() + 1);

    _transact({
      _note: charlieNote,
      _spender: charlie,
      _noteCreationParams: charlie.receiveNote(SAMPLE_VALUE, charlieNote.inputLabel),
      _amountOut: 0
    });

    // No withdrawal — balance unchanged
    assertEq(_token.balanceOf(address(_poolVault)), SAMPLE_VALUE, 'PoolVault balance should be unchanged');
  }

  receive() external payable {}
}
