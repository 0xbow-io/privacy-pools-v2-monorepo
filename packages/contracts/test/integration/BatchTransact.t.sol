// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for PrivacyPoolRelay.relayBatch() using real ZK proofs
/// @dev Deposits several notes on-chain, builds one transact proof per note against the SAME
///      pre-batch root snapshot (no intermediate-root chaining), then withdraws the entire
///      balance to a single recipient in one transaction with one aggregated fee.
contract BatchTransactIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  uint256 internal constant RELAY_FEE = 0.05 ether;

  address internal _relayer;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    _relayer = makeAddr('relayer');
  }

  /*///////////////////////////////////////////////////////////////
                  BATCH FULL WITHDRAWAL — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit 3 ERC20 notes, then withdraw the entire balance to bob in one batch.
  ///         The whole relayer fee is loaded onto the first item; the rest carry zero fee.
  function test_relayBatch_fullWithdrawal_erc20() external {
    uint256 _n = 3;
    Note[] memory _notes = new Note[](_n);
    for (uint256 _i; _i < _n; ++_i) {
      vm.warp(vm.getBlockTimestamp() + 1);
      _notes[_i] = _deposit(alice, address(_token), SAMPLE_VALUE);
    }

    uint256[] memory _fees = new uint256[](_n);
    _fees[0] = RELAY_FEE; // entire fee on the first item

    _relayBatchFullWithdraw(_notes, alice, bob, charlie.addr, _fees, false);
  }

  /*///////////////////////////////////////////////////////////////
                  BATCH FULL WITHDRAWAL — ETH
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit 2 ETH notes, then withdraw the entire balance to bob in one batch.
  function test_relayBatch_fullWithdrawal_eth() external {
    uint256 _n = 2;
    Note[] memory _notes = new Note[](_n);
    for (uint256 _i; _i < _n; ++_i) {
      vm.warp(vm.getBlockTimestamp() + 1);
      _notes[_i] = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);
    }

    uint256[] memory _fees = new uint256[](_n);
    _fees[0] = RELAY_FEE;

    _relayBatchFullWithdraw(_notes, alice, bob, charlie.addr, _fees, true);
  }

  /*///////////////////////////////////////////////////////////////
                  MAX BATCH (10 ITEMS) — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit 10 notes (the `_MAX_BATCH` cap), then withdraw them all in a SINGLE relayBatch of
  ///         10 items. This exercises the core safety argument directly — `_MAX_BATCH` (10) is strictly
  ///         below the pool's `rootHistorySize` (16), so every one of the 10 real transact proofs is
  ///         built against, and validates against, the SAME shared pre-batch state-root snapshot even as
  ///         each intermediate `transact` pushes a new root. Asserts all 10 spend, the aggregate
  ///         payout/fee are exact, and the on-chain state root re-syncs with the mirror.
  function test_relayBatch_maxBatch_erc20() external {
    uint256 _n = _privacyPoolRelay.MAX_BATCH(); // 10
    assertEq(_n, 10, 'MAX_BATCH is 10');
    Note[] memory _notes = new Note[](_n);
    for (uint256 _i; _i < _n; ++_i) {
      vm.warp(vm.getBlockTimestamp() + 1);
      _notes[_i] = _deposit(alice, address(_token), SAMPLE_VALUE);
    }

    uint256[] memory _fees = new uint256[](_n);
    _fees[0] = RELAY_FEE; // entire fee on the first item; the rest carry zero fee

    _relayBatchFullWithdraw(_notes, alice, bob, charlie.addr, _fees, false);
  }

  /*///////////////////////////////////////////////////////////////
                  SINGLE-ITEM BATCH (REGRESSION)
  ///////////////////////////////////////////////////////////////*/

  /// @notice A single-item batch withdraws one note's full value, mirroring relay() behavior.
  function test_relayBatch_singleItem_erc20() external {
    Note[] memory _notes = new Note[](1);
    vm.warp(vm.getBlockTimestamp() + 1);
    _notes[0] = _deposit(alice, address(_token), SAMPLE_VALUE);

    uint256[] memory _fees = new uint256[](1);
    _fees[0] = RELAY_FEE;

    _relayBatchFullWithdraw(_notes, alice, bob, charlie.addr, _fees, false);
  }

  /*///////////////////////////////////////////////////////////////
              ATOMIC ABORT — MID-BATCH REVERT (real proofs)
  ///////////////////////////////////////////////////////////////*/

  /// @notice A mid-batch revert must atomically unwind the REAL transacts of every earlier item.
  /// @dev Deposit 3 notes and build 3 real proofs against the shared pre-batch snapshot. Items 0-1
  ///      pay bob; item 2 pays charlie — its context binds charlie, so item 2's proof is itself
  ///      valid, but the batch loop's `PrivacyPoolRelay_InconsistentRecipient` guard fires on item 2
  ///      AFTER items 0-1 have already called `POOL.transact` (real nullifier spend + leaf insert).
  ///      Closes the no-mock-only gap: the only prior mid-batch-revert tests mock item 0's transact,
  ///      so nothing real was ever rolled back. Here items 0-1's real state mutations must revert.
  function test_relayBatch_midBatchRevert_rollsBackEarlierTransacts() external {
    uint256 _n = 3;
    Note[] memory _notes = new Note[](_n);
    for (uint256 _i; _i < _n; ++_i) {
      vm.warp(vm.getBlockTimestamp() + 1);
      _notes[_i] = _deposit(alice, address(_token), SAMPLE_VALUE);
    }
    address _tokenAddr = address(_token);

    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](_n);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](_n);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](_n);

    // Items 0-1 -> bob; item 2 -> charlie (divergent recipient), each bound into its own context.
    for (uint256 _i; _i < _n; ++_i) {
      (ProofLibV2.TransactProof memory _p, IPoolVault.TransactParams memory _pp) = _i < 2
        ? _buildBatchRelayItem(_notes[_i], alice, bob, charlie.addr, SAMPLE_VALUE, 0)
        : _buildBatchRelayItem(_notes[_i], alice, charlie, charlie.addr, SAMPLE_VALUE, 0);
      _proofs[_i] = _p;
      _params[_i] = _pp;
      _noteData[_i] = _defaultTransactNoteData;
    }

    // Pre-batch snapshot
    uint256 _poolBefore = _balanceOf(_tokenAddr, address(_poolVault));
    uint256 _bobBefore = _balanceOf(_tokenAddr, bob.addr);
    uint256 _rootBefore = _poolVault.roots(_poolVault.currentRootIndex());

    vm.prank(_relayer);
    vm.expectRevert(IPrivacyPoolRelay.PrivacyPoolRelay_InconsistentRecipient.selector);
    _privacyPoolRelay.relayBatch(_proofs, _params, _noteData);

    // Items 0-1's REAL transacts rolled back: nullifiers unspent, output commitments absent.
    for (uint256 _i; _i < 2; ++_i) {
      assertEq(
        _poolVault.spentNullifiers(_proofs[_i].nullifierHashes()[0]),
        0,
        'Earlier nullifier must be unspent after revert'
      );
      assertEq(
        _poolVault.commitments(_proofs[_i].outputCommitments()[0]),
        0,
        'Earlier output commitment must be absent after revert'
      );
    }

    // Balances, recipient, and state root unchanged — the whole batch is atomic.
    assertEq(_balanceOf(_tokenAddr, address(_poolVault)), _poolBefore, 'PoolVault balance must be unchanged');
    assertEq(_balanceOf(_tokenAddr, bob.addr), _bobBefore, 'Recipient must receive nothing on revert');
    assertEq(_poolVault.roots(_poolVault.currentRootIndex()), _rootBefore, 'State root must be unchanged after revert');
    assertEq(_balanceOf(_tokenAddr, address(_privacyPoolRelay)), 0, 'Relay must hold no funds');
  }

  /*///////////////////////////////////////////////////////////////
                          HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Build one full-withdrawal relay proof per note (each spends its whole value), submit them
  ///      as one relayBatch, and assert the aggregate payout, nullifier spends, and state-root sync.
  function _relayBatchFullWithdraw(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    UserIdentityLib.UserIdentity storage _recipient,
    address _feeRecipient,
    uint256[] memory _fees,
    bool _isNative
  ) internal {
    uint256 _n = _notes.length;
    address _tokenAddr = address(uint160(_notes[0].tokenId));

    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](_n);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](_n);
    IPoolVault.NoteData[][] memory _noteData = new IPoolVault.NoteData[][](_n);

    uint256 _totalWithdraw;
    uint256 _totalFee;
    // Build every proof against the same pre-batch snapshot (no submission between builds)
    for (uint256 _i; _i < _n; ++_i) {
      (ProofLibV2.TransactProof memory _p, IPoolVault.TransactParams memory _pp) =
        _buildBatchRelayItem(_notes[_i], _spender, _recipient, _feeRecipient, SAMPLE_VALUE, _fees[_i]);
      _proofs[_i] = _p;
      _params[_i] = _pp;
      _noteData[_i] = _defaultTransactNoteData;
      _totalWithdraw += SAMPLE_VALUE;
      _totalFee += _fees[_i];
    }

    uint256 _recipientBefore = _balanceOf(_tokenAddr, _recipient.addr);
    uint256 _feeRecipientBefore = _balanceOf(_tokenAddr, _feeRecipient);
    uint256 _poolBefore = _balanceOf(_tokenAddr, address(_poolVault));
    uint256 _recipientAmount = _totalWithdraw - _totalFee;

    vm.expectEmit();
    emit IPrivacyPoolRelay.RelayedBatch(_tokenAddr, _recipient.addr, _recipientAmount, _feeRecipient, _totalFee, 0, _n);

    vm.prank(_relayer);
    _privacyPoolRelay.relayBatch(_proofs, _params, _noteData);

    // Every nullifier spent and every output commitment recorded at this block
    for (uint256 _i; _i < _n; ++_i) {
      assertEq(
        _poolVault.spentNullifiers(_proofs[_i].nullifierHashes()[0]),
        vm.getBlockTimestamp(),
        'Nullifier spend timestamp mismatch'
      );
      assertEq(
        _poolVault.commitments(_proofs[_i].outputCommitments()[0]),
        vm.getBlockTimestamp(),
        'Output commitment timestamp mismatch'
      );
    }

    // Mirror every item's leaves in submission order and assert the on-chain root matches
    for (uint256 _i; _i < _n; ++_i) {
      _mirrorTransactLeaves(_proofs[_i].outputCommitments(), _proofs[_i].nullifierHashes());
    }
    assertEq(
      _poolVault.roots(_poolVault.currentRootIndex()), _stateTreeMirror.root(), 'State root mismatch after relayBatch'
    );

    // Aggregate payout is exact and the relay holds nothing afterwards
    assertEq(
      _balanceOf(_tokenAddr, _recipient.addr), _recipientBefore + _recipientAmount, 'Recipient aggregate mismatch'
    );
    assertEq(_balanceOf(_tokenAddr, _feeRecipient), _feeRecipientBefore + _totalFee, 'Fee recipient aggregate mismatch');
    assertEq(_balanceOf(_tokenAddr, address(_poolVault)), _poolBefore - _totalWithdraw, 'PoolVault balance mismatch');
    assertEq(_balanceOf(_tokenAddr, address(_privacyPoolRelay)), 0, 'Relay should hold no funds');
    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay should hold no ETH');
    _isNative; // silence unused warning; native vs ERC20 share the same aggregate assertions here
  }

  /// @dev Build a single full-withdrawal relay proof+params for one note (output change note value 0).
  ///      Mirrors Relay.t.sol::_buildRelayProof but specialized to a full withdrawal.
  function _buildBatchRelayItem(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    UserIdentityLib.UserIdentity storage _recipient,
    address _feeRecipient,
    uint256 _inputNoteValue,
    uint256 _feeAmount
  ) internal returns (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) {
    _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _recipient.addr, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: 0
        })
      )
    });

    // Full withdrawal: change note value is zero
    NoteCreationParams memory _outputNote = _recipient.receiveNote(0, _note.inputLabel);

    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _outputNotes = new NoteCreationParams[](1);
    _outputNotes[0] = _outputNote;

    _txProof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _outputNotes,
      _amountOut: _inputNoteValue,
      _context: uint256(keccak256(abi.encode(_params, _defaultTransactNoteData))) % SNARK_SCALAR_FIELD
    });
  }

  receive() external payable {}
}
