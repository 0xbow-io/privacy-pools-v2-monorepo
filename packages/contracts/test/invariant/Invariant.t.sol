// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Setup} from './Setup.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {Constants as ProtocolConstants} from 'utils/Constants.sol';

contract Invariant is Setup {
  /// @notice PP2-3: per-asset PoolVault balance equals total deposited minus ragequit minus withdrawn
  /// @dev Looped over every asset registered by Setup so each asset's pool conservation is checked
  ///      independently — a wrong-token sweep or cross-asset leak would surface as a mismatch here.
  function invariant_PP2_3_poolVaultBalance() external view {
    for (uint256 _i; _i < _handler.assetsLength(); ++_i) {
      address _asset = _handler.assets(_i);
      assertEq(
        _balanceOf(_asset, address(_poolVault)),
        _handler.ghost_depositSum(_asset) - _handler.ghost_ragequitSum(_asset) - _handler.ghost_withdrawnSum(_asset),
        'PP2-3: PoolVault balance mismatch'
      );
    }
  }

  /// @notice PP2-4: per-asset Entrypoint balance equals accumulated vetting fees minus sweeps
  function invariant_PP2_4_entrypointBalance() external view {
    for (uint256 _i; _i < _handler.assetsLength(); ++_i) {
      address _asset = _handler.assets(_i);
      assertEq(
        _balanceOf(_asset, address(_entrypoint)),
        _handler.ghost_feeSum(_asset) - _handler.ghost_feeSwept(_asset),
        'PP2-4: Entrypoint balance mismatch'
      );
    }
  }

  /// @notice PP2-5: per-asset relay balance must be zero between calls
  /// @dev    The relay receives `amountOut` mid-call and immediately splits it to
  ///         (recipient, feeRecipient). At handler boundaries the balance must always be zero
  ///         for every supported asset.
  function invariant_PP2_5_relayBalance() external view {
    for (uint256 _i; _i < _handler.assetsLength(); ++_i) {
      address _asset = _handler.assets(_i);
      assertEq(_balanceOf(_asset, address(_privacyPoolRelay)), 0, 'PP2-5: Relay balance should be zero');
    }
  }

  /// @notice PP2-6: per-label unspent equals deposited minus withdrawn minus ragequit
  function invariant_PP2_6_labelValueConservation() external view {
    for (uint256 _i; _i < _handler.ghost_labelsLength(); ++_i) {
      uint256 _label = _handler.ghost_labels(_i);
      (, uint256 _deposited, uint256 _withdrawn, uint256 _ragequit, uint256 _unspent) =
        _handler.ghost_labelBalance(_label);
      assertEq(_unspent, _deposited - _withdrawn - _ragequit, 'PP2-6: label balance mismatch');
    }
  }

  /// @notice PP2-8: per-asset sum of unspent commitment values equals PoolVault balance
  function invariant_PP2_8_unspentCommitmentSum() external view {
    for (uint256 _i; _i < _handler.assetsLength(); ++_i) {
      address _asset = _handler.assets(_i);
      assertEq(
        _handler.ghost_unspentCommitmentValueSum(_asset),
        _balanceOf(_asset, address(_poolVault)),
        'PP2-8: unspent commitment sum mismatch'
      );
    }
  }

  /// @notice PP2-11: per-asset, per-actor balance reconciliation. An actor's balance of any asset
  ///         equals the total received from withdraws + ragequits + swept fees + relay payouts.
  ///         No extra value ever lands on users.
  function invariant_PP2_11_noFreeWithdrawal() external view {
    for (uint256 _a; _a < _handler.assetsLength(); ++_a) {
      address _asset = _handler.assets(_a);
      bool _isNative = _asset == ProtocolConstants.NATIVE_ASSET;
      uint256 _withdrawnSum;
      uint256 _ragequitSum;
      uint256 _sweptSum;
      uint256 _relayedRecipientSum;
      uint256 _relayedFeeSum;
      for (uint256 _i; _i < _handler.actorsLength(); ++_i) {
        address _actor = _handler.actors(_i);
        uint256 _withdrawnToActor = _handler.ghost_withdrawnTo(_asset, _actor);
        uint256 _ragequitToActor = _handler.ghost_ragequitTo(_asset, _actor);
        uint256 _sweptToActor = _handler.ghost_sweptTo(_asset, _actor);
        uint256 _relayedRecipientToActor = _handler.ghost_relayedRecipientTo(_asset, _actor);
        uint256 _relayedFeeToActor = _handler.ghost_relayedFeeTo(_asset, _actor);
        // We need to add the gas forwarded to the accounting to addr.balance done below
        uint256 _relayedNativeGasToActor = _isNative ? _handler.ghost_relayedNativeGasTo(_actor) : 0;
        _withdrawnSum += _withdrawnToActor;
        _ragequitSum += _ragequitToActor;
        _sweptSum += _sweptToActor;
        _relayedRecipientSum += _relayedRecipientToActor;
        _relayedFeeSum += _relayedFeeToActor;
        assertEq(
          _balanceOf(_asset, _actor),
          _withdrawnToActor + _ragequitToActor + _sweptToActor + _relayedRecipientToActor + _relayedFeeToActor
            + _relayedNativeGasToActor,
          'PP2-11: actor balance mismatch'
        );
      }

      assertEq(
        _withdrawnSum + _relayedRecipientSum + _relayedFeeSum,
        _handler.ghost_withdrawnSum(_asset),
        'PP2-11: withdrawn sum mismatch (direct + relayed)'
      );
      assertEq(_ragequitSum, _handler.ghost_ragequitSum(_asset), 'PP2-11: ragequit sum mismatch');
      assertEq(
        _sweptSum, _handler.ghost_feeSwept(_asset), 'PP2-11: swept sum mismatch (sweep recipient outside _actors?)'
      );
    }
  }

  /// @notice PP2-14: On-chain root must match mirror state tree root
  function invariant_PP2_14_rootMatchesMirror() external view {
    if (_handler.ghost_depositCount() == 0) {
      assertEq(
        _poolVault.roots(_poolVault.currentRootIndex()), 0, 'PP2-14: On-chain root != zero before there is any deposit'
      );
    } else {
      assertEq(
        _poolVault.roots(_poolVault.currentRootIndex()),
        _handler.ghost_stateTreeRoot(),
        'PP2-14: On-chain root != mirror tree root'
      );
    }
  }

  /// @notice PP2-15: on-chain commitments exist as leaves in the mirror state tree
  /// @dev If commitments[C] != 0, then the commitment state leaf
  ///      Poseidon(COMMITMENT_LEAF_TAG, C, commitments[C])
  ///      must exist in the real state tree.
  function invariant_PP2_15_commitmentsInMirror() external view {
    for (uint256 _a; _a < _handler.actorsLength(); ++_a) {
      address _actor = _handler.actors(_a);
      for (uint256 _i; _i < _handler.ghost_actorNoteCount(_actor); ++_i) {
        (uint256 _commitment, uint256 _leafIndex) = _handler.ghost_actorNote(_actor, _i);
        if (_poolVault.commitments(_commitment) == 0) continue;
        assertEq(
          _handler.ghost_stateTreeLeafAt(_leafIndex),
          _expectedCommitmentStateLeaf(_commitment),
          'PP2-15: commitment leaf missing from mirror'
        );
      }
    }
  }

  /// @notice PP2-16: on-chain spent nullifiers exist as leaves in the mirror state tree
  /// @dev If spentNullifiers[N] != 0, then the nullifier state leaf
  ///      Poseidon(NULLIFIER_LEAF_TAG, N, spentNullifiers[N])
  ///      must exist in the real state tree.
  function invariant_PP2_16_nullifiersInMirror() external view {
    for (uint256 _i; _i < _handler.ghost_trackedNullifierCount(); ++_i) {
      (uint256 _nullifier, uint256 _leafIndex) = _handler.ghost_trackedNullifier(_i);
      if (_poolVault.spentNullifiers(_nullifier) == 0) continue;
      assertEq(
        _handler.ghost_stateTreeLeafAt(_leafIndex),
        _expectedNullifierStateLeaf(_nullifier),
        'PP2-16: nullifier leaf missing from mirror'
      );
    }
  }

  /// @notice PP2-18: Mirror state tree size matches deposit + transact + ragequit leaf inserts
  function invariant_PP2_18_stateTreeSize() external view {
    assertEq(
      _handler.ghost_stateTreeSize(),
      _handler.ghost_depositCount() + _handler.ghost_ragequitCount() + _handler.ghost_transactLeafInserts(),
      'PP2-18: state tree size mismatch'
    );
  }

  /// @notice PP2-17: every relay payout split reconciled (recipient / feeRecipient deltas).
  /// @dev Load-bearing counterpart to the (swallowed) on-handler `_assertRelaySplit`. The handler sets a
  ///      sticky `ghost_relaySplitViolated` flag on any mismatch — a plain storage write that survives the
  ///      `fail_on_revert = false` swallow — and this GLOBAL invariant fails the run if it was ever set.
  function invariant_relaySplitConsistent() external view {
    assertFalse(_handler.ghost_relaySplitViolated(), 'PP2-17: a relay payout split did not reconcile');
  }

  /// @notice The on-chain state root matched the mirror after every relay path (single / batch / register).
  /// @dev Load-bearing counterpart to the (swallowed) on-handler "State root mismatch" asserts.
  function invariant_relayStateRootConsistent() external view {
    assertFalse(_handler.ghost_relayStateRootViolated(), 'relay: on-chain state root diverged from mirror');
  }

  /// @notice `registerAndRelay` registered the fresh account's nullifying key on-chain every time.
  /// @dev Load-bearing counterpart to the (swallowed) on-handler `nullifyingKeys` assert.
  function invariant_registerKeystoreConsistent() external view {
    assertFalse(_handler.ghost_registerKeystoreViolated(), 'registerAndRelay: fresh account not registered on-chain');
  }

  /// @notice Relay-handler execution coverage is observed via Foundry's per-handler run stats, NOT a
  ///         hard in-test assertion.
  /// @dev The handler exposes `ghost_relayBatchOk()` / `ghost_registerAndRelayOk()` (incremented only
  ///      after the external `relayBatch` / `registerAndRelay` call returns) purely for observability.
  ///      A hard `afterInvariant` floor (`assertGt(..., 0)`) is intentionally NOT used: it cannot
  ///      distinguish "handler never selected" (benign — seed-dependent under the shallow `invariant-ci`
  ///      profile's ~45 calls across all handlers) from "handler always reverts" (the real regression),
  ///      because under `fail_on_revert = false` an always-reverting handler rolls back its own entry
  ///      state too, so no in-test counter survives to tell them apart. That distinction lives only in
  ///      Foundry's external `Calls/Discards/Reverts` per-handler table. Verify batch/register coverage
  ///      there, or under the deeper `invariant-campaign` profile where selection is reliable; the
  ///      load-bearing correctness checks are the global `invariant_relay*Consistent` /
  ///      `invariant_register*Consistent` / PP2-* invariants (which fail regardless of `fail_on_revert`).

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  function _expectedCommitmentStateLeaf(uint256 _commitment) internal view returns (uint256 expectedStateLeaf) {
    uint256 _createdAt = _poolVault.commitments(_commitment);
    expectedStateLeaf = PoseidonT4.hash([ProtocolConstants.COMMITMENT_LEAF_TAG, _commitment, _createdAt]);
  }

  function _expectedNullifierStateLeaf(uint256 _nullifierHash) internal view returns (uint256 expectedStateLeaf) {
    uint256 _spentAt = _poolVault.spentNullifiers(_nullifierHash);
    expectedStateLeaf = PoseidonT4.hash([ProtocolConstants.NULLIFIER_LEAF_TAG, _nullifierHash, _spentAt]);
  }
}
