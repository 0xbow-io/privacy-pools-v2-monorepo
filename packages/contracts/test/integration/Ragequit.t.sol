// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {RagequitProofMemory, TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for PoolVault.ragequit() using real ZK proofs
/// @dev Exercises ragequit from different entry states: direct after deposit,
///      after a private transfer (self-transfer), and when the ragequitter
///      is not the original depositor.
contract RagequitIntegration is IntegrationBase {
  using TransactProofMemory for ProofLibV2.TransactProof;
  using MerkleTree for MerkleTree.Tree;
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  Note internal _aliceDepositErc20;
  Note internal _aliceDepositEth;
  uint256 internal _depositTimestamp;

  function setUp() public override {
    super.setUp();

    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);

    _aliceDepositErc20 = _deposit(alice, address(_token), SAMPLE_VALUE);
    _aliceDepositEth = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    _depositTimestamp = block.timestamp;
    vm.warp(block.timestamp + 1);
  }

  /*///////////////////////////////////////////////////////////////
                  DEPOSIT -> RAGEQUIT (ERC20)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits ERC20 and ragequits directly (no transact in between)
  function test_ragequit_depositThenRagequit_erc20() external {
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositErc20);

    assertEq(_poolVault.commitments(_rqProof.commitment()), _depositTimestamp, 'Deposit commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _balanceOf(address(_token), alice.addr);
    uint256 _poolBalanceBefore = _balanceOf(address(_token), address(_poolVault));

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr, address(_token), SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    _submitRagequit(alice, _rqProof);

    assertEq(
      _balanceOf(address(_token), alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should recover full value'
    );
    assertEq(
      _balanceOf(address(_token), address(_poolVault)), _poolBalanceBefore - SAMPLE_VALUE, 'Pool should be drained'
    );
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
                  DEPOSIT -> RAGEQUIT (ETH)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits ETH and ragequits directly (no transact in between)
  function test_ragequit_depositThenRagequit_eth() external {
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositEth);

    assertEq(_poolVault.commitments(_rqProof.commitment()), _depositTimestamp, 'Deposit commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _balanceOf(Constants.NATIVE_ASSET, alice.addr);
    uint256 _poolBalanceBefore = _balanceOf(Constants.NATIVE_ASSET, address(_poolVault));

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr,
      Constants.NATIVE_ASSET,
      SAMPLE_VALUE,
      _rqProof.commitment(),
      _rqProof.nullifierHash(),
      _rqProof.label()
    );

    _submitRagequit(alice, _rqProof);

    assertEq(
      _balanceOf(Constants.NATIVE_ASSET, alice.addr),
      _aliceBalanceBefore + SAMPLE_VALUE,
      'Alice should recover full ETH value'
    );
    assertEq(
      _balanceOf(Constants.NATIVE_ASSET, address(_poolVault)),
      _poolBalanceBefore - SAMPLE_VALUE,
      'Pool ETH should be drained'
    );
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
              DEPOSIT -> TRANSFER -> RAGEQUIT (ERC20)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits, self-transfers (creating a new note), then ragequits the new note
  function test_ragequit_depositTransferThenRagequit_erc20() external {
    // ── Self-transfer ──
    NoteCreationParams memory _outputNote = alice.receiveNote(SAMPLE_VALUE, _aliceDepositErc20.inputLabel);
    ProofLibV2.TransactProof memory _txProof = _buildTransactProof({
      _note: _aliceDepositErc20, _spender: alice, _noteCreationParams: _outputNote, _amountOut: 0
    });
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);

    uint256 _outputCommitment = _txProof.outputCommitments()[0];
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Ragequit the transferred note (output uses a different noteSecret than the deposit struct)
    Note memory _noteToQuitErc20 = _aliceDepositErc20;
    _noteToQuitErc20.noteSecret = _outputNote.noteSecret;
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _noteToQuitErc20);

    assertEq(_rqProof.commitment(), _outputCommitment, 'Ragequit commitment should match transact output');
    assertEq(_poolVault.commitments(_outputCommitment), block.timestamp, 'Output commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _balanceOf(address(_token), alice.addr);

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr, address(_token), SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    _submitRagequit(alice, _rqProof);

    assertEq(
      _balanceOf(address(_token), alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should recover full value'
    );
    assertEq(_balanceOf(address(_token), address(_poolVault)), 0, 'Pool should be empty after ragequit');
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
              DEPOSIT -> TRANSFER -> RAGEQUIT (ETH)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits ETH, self-transfers, then ragequits the new note
  function test_ragequit_depositTransferThenRagequit_eth() external {
    // ── Self-transfer ──
    NoteCreationParams memory _outputNote = alice.receiveNote(SAMPLE_VALUE, _aliceDepositEth.inputLabel);
    ProofLibV2.TransactProof memory _txProof =
      _buildTransactProof({_note: _aliceDepositEth, _spender: alice, _noteCreationParams: _outputNote, _amountOut: 0});
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);

    uint256 _outputCommitment = _txProof.outputCommitments()[0];
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Ragequit the transferred note (output uses a different noteSecret than the deposit struct)
    Note memory _noteToQuitEth = _aliceDepositEth;
    _noteToQuitEth.noteSecret = _outputNote.noteSecret;
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _noteToQuitEth);

    assertEq(_rqProof.commitment(), _outputCommitment, 'Ragequit commitment should match transact output');
    assertEq(_poolVault.commitments(_outputCommitment), block.timestamp, 'Output commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _balanceOf(Constants.NATIVE_ASSET, alice.addr);

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr,
      Constants.NATIVE_ASSET,
      SAMPLE_VALUE,
      _rqProof.commitment(),
      _rqProof.nullifierHash(),
      _rqProof.label()
    );

    _submitRagequit(alice, _rqProof);

    assertEq(
      _balanceOf(Constants.NATIVE_ASSET, alice.addr),
      _aliceBalanceBefore + SAMPLE_VALUE,
      'Alice should recover full ETH value'
    );
    assertEq(_balanceOf(Constants.NATIVE_ASSET, address(_poolVault)), 0, 'Pool ETH should be empty after ragequit');
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
          RAGEQUITTER IS NOT DEPOSITOR (ERC20)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits and transfers to Bob, then Bob ragequits
  function test_ragequit_ragequitterIsNotDepositor_erc20() external {
    // ── Alice transfers to Bob ──
    NoteCreationParams memory _bobNote = bob.receiveNote(SAMPLE_VALUE, _aliceDepositErc20.inputLabel);
    ProofLibV2.TransactProof memory _txProof =
      _buildTransactProof({_note: _aliceDepositErc20, _spender: alice, _noteCreationParams: _bobNote, _amountOut: 0});
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);

    uint256 _bobCommitment = _txProof.outputCommitments()[0];
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Bob ragequits (Bob's noteSecret vs Alice's deposit template)
    Note memory _bobRageNoteErc20 = _aliceDepositErc20;
    _bobRageNoteErc20.noteSecret = _bobNote.noteSecret;
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(bob, _bobRageNoteErc20);

    assertEq(_rqProof.commitment(), _bobCommitment, 'Ragequit commitment should match Bob note');
    assertEq(_poolVault.commitments(_bobCommitment), block.timestamp, 'Bob commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Bob nullifier should not be spent yet');

    uint256 _bobBalanceBefore = _balanceOf(address(_token), bob.addr);
    uint256 _poolBalanceBefore = _balanceOf(address(_token), address(_poolVault));

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      bob.addr, address(_token), SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    _submitRagequit(bob, _rqProof);

    assertEq(_balanceOf(address(_token), bob.addr), _bobBalanceBefore + SAMPLE_VALUE, 'Bob should recover full value');
    assertEq(
      _balanceOf(address(_token), address(_poolVault)), _poolBalanceBefore - SAMPLE_VALUE, 'Pool should be empty'
    );
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Bob ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
          RAGEQUITTER IS NOT DEPOSITOR (ETH)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits ETH and transfers to Bob, then Bob ragequits
  function test_ragequit_ragequitterIsNotDepositor_eth() external {
    // ── Alice transfers to Bob ──
    NoteCreationParams memory _bobNote = bob.receiveNote(SAMPLE_VALUE, _aliceDepositEth.inputLabel);
    ProofLibV2.TransactProof memory _txProof =
      _buildTransactProof({_note: _aliceDepositEth, _spender: alice, _noteCreationParams: _bobNote, _amountOut: 0});
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);

    uint256 _bobCommitment = _txProof.outputCommitments()[0];
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Bob ragequits (Bob's noteSecret vs Alice's deposit template)
    Note memory _bobRageNoteEth = _aliceDepositEth;
    _bobRageNoteEth.noteSecret = _bobNote.noteSecret;
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(bob, _bobRageNoteEth);

    assertEq(_rqProof.commitment(), _bobCommitment, 'Ragequit commitment should match Bob note');
    assertEq(_poolVault.commitments(_bobCommitment), block.timestamp, 'Bob commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Bob nullifier should not be spent yet');

    uint256 _bobBalanceBefore = _balanceOf(Constants.NATIVE_ASSET, bob.addr);
    uint256 _poolBalanceBefore = _balanceOf(Constants.NATIVE_ASSET, address(_poolVault));

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      bob.addr, Constants.NATIVE_ASSET, SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    _submitRagequit(bob, _rqProof);

    assertEq(
      _balanceOf(Constants.NATIVE_ASSET, bob.addr),
      _bobBalanceBefore + SAMPLE_VALUE,
      'Bob should recover full ETH value'
    );
    assertEq(
      _balanceOf(Constants.NATIVE_ASSET, address(_poolVault)),
      _poolBalanceBefore - SAMPLE_VALUE,
      'Pool ETH should be empty'
    );
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Bob ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
                  RAGEQUIT WHILE PAUSED
  ///////////////////////////////////////////////////////////////*/

  /// @notice Ragequit succeeds even when PoolVault is paused
  /// @dev This is the defining property of ragequit: it is NOT pausable,
  ///      guaranteeing users can always exit the protocol.
  function test_ragequit_succeedsWhilePaused() external {
    // Pause the contract
    vm.prank(_config.pausers[0]);
    _poolVault.pause();

    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositErc20);

    assertEq(_poolVault.commitments(_rqProof.commitment()), _depositTimestamp, 'Deposit commitment should exist');
    assertEq(_poolVault.spentNullifiers(_rqProof.nullifierHash()), 0, 'Nullifier should not be spent yet');

    uint256 _aliceBalanceBefore = _balanceOf(address(_token), alice.addr);
    uint256 _poolBalanceBefore = _balanceOf(address(_token), address(_poolVault));

    vm.expectEmit(address(_poolVault));
    emit IPoolVault.Ragequit(
      alice.addr, address(_token), SAMPLE_VALUE, _rqProof.commitment(), _rqProof.nullifierHash(), _rqProof.label()
    );

    _submitRagequit(alice, _rqProof);

    assertEq(
      _balanceOf(address(_token), alice.addr), _aliceBalanceBefore + SAMPLE_VALUE, 'Alice should recover full value'
    );
    assertEq(
      _balanceOf(address(_token), address(_poolVault)), _poolBalanceBefore - SAMPLE_VALUE, 'Pool should be drained'
    );
    assertEq(
      _poolVault.spentNullifiers(_rqProof.nullifierHash()), block.timestamp, 'Ragequit nullifier should be spent'
    );
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after ragequit'
    );
  }

  /*///////////////////////////////////////////////////////////////
                        REVERT TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Ragequit reverts when caller is not the note owner (ERC20)
  function test_ragequit_revertsWhenCallerIsNotOwner_erc20() external {
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositErc20);

    vm.expectRevert(IPoolVault.PoolVault_InvalidOwnerAddress.selector);
    vm.prank(bob.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Ragequit reverts when caller is not the note owner (ETH)
  function test_ragequit_revertsWhenCallerIsNotOwner_eth() external {
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositEth);

    vm.expectRevert(IPoolVault.PoolVault_InvalidOwnerAddress.selector);
    vm.prank(bob.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Ragequit reverts on double-spend (same note ragequit twice, ERC20)
  function test_ragequit_revertsOnDoubleRagequit_erc20() external {
    ProofLibV2.RagequitProof memory _rqProof = _ragequit(alice, _aliceDepositErc20);

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    vm.prank(alice.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Ragequit reverts on double-spend (same note ragequit twice, ETH)
  function test_ragequit_revertsOnDoubleRagequit_eth() external {
    ProofLibV2.RagequitProof memory _rqProof = _ragequit(alice, _aliceDepositEth);

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    vm.prank(alice.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Ragequit reverts when the note was already spent via transact (ERC20)
  function test_ragequit_revertsAfterTransactSpendsNote_erc20() external {
    // ── Alice spends the note via transact (self-transfer) ──
    ProofLibV2.TransactProof memory _txProof = _buildTransactProof({
      _note: _aliceDepositErc20,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, _aliceDepositErc20.inputLabel),
      _amountOut: 0
    });
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Alice tries to ragequit the *original* deposit note (already spent via transact) ──
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositErc20);

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    vm.prank(alice.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Ragequit reverts when the note was already spent via transact (ETH)
  function test_ragequit_revertsAfterTransactSpendsNote_eth() external {
    // ── Alice spends the note via transact (self-transfer) ──
    ProofLibV2.TransactProof memory _txProof = _buildTransactProof({
      _note: _aliceDepositEth,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, _aliceDepositEth.inputLabel),
      _amountOut: 0
    });
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);
    _mirrorTransactLeaves(_txProof.outputCommitments(), _txProof.nullifierHashes());

    // ── Alice tries to ragequit the *original* deposit note (already spent via transact) ──
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _aliceDepositEth);

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    vm.prank(alice.addr);
    _poolVault.ragequit(_rqProof);
  }

  /// @notice Transact reverts when the note was already spent via ragequit (ERC20)
  function test_ragequit_transactRevertsAfterRagequitSpendsNote_erc20() external {
    // ── Alice ragequits the deposit note ──
    _ragequit(alice, _aliceDepositErc20);

    // ── Alice tries to transact the same note (already spent via ragequit) ──
    vm.warp(block.timestamp + 1);

    ProofLibV2.TransactProof memory _txProof = _buildTransactProof({
      _note: _aliceDepositErc20,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, _aliceDepositErc20.inputLabel),
      _amountOut: 0
    });

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);
  }

  /// @notice Transact reverts when the note was already spent via ragequit (ETH)
  function test_ragequit_transactRevertsAfterRagequitSpendsNote_eth() external {
    // ── Alice ragequits the deposit note ──
    _ragequit(alice, _aliceDepositEth);

    // ── Alice tries to transact the same note (already spent via ragequit) ──
    vm.warp(block.timestamp + 1);

    ProofLibV2.TransactProof memory _txProof = _buildTransactProof({
      _note: _aliceDepositEth,
      _spender: alice,
      _noteCreationParams: alice.receiveNote(SAMPLE_VALUE, _aliceDepositEth.inputLabel),
      _amountOut: 0
    });

    vm.expectRevert(IPoolVault.PoolVault_NullifierAlreadySpent.selector);
    _poolVault.transact(_txProof, _defaultTransactParams, _defaultTransactNoteData);
  }
}
