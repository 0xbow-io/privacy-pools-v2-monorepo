// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerNoteSearch} from './HandlerNoteSearch.sol';
import {PausableUpgradeable} from '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Note, NoteCreationParams} from 'test/handlers/HandlerBase.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

abstract contract HandlerTransact is HandlerNoteSearch {
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /*///////////////////////////////////////////////////////////////
                        GUIDED HANDLERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fuzz target: withdraw a valid amount from random existing notes from a random actor.
  /// Each output (change/internal-transfer note) is routed to the actor selected by the matching
  /// `_recipientSeeds[i]`, allowing internal transfers in addition to self-routed change.
  function handler_guided_transact(
    uint256 _actorSeed,
    uint256[MAX_INPUTS] memory _newNoteAmountSeeds,
    uint128 _inputSeed,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _inputCutoff
  ) public {
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);
    UserIdentityLib.UserIdentity storage _actor = _getActor(_actorSeed);
    _inputCutoff = bound(_inputCutoff, 1, MAX_INPUTS);

    Note[] memory _inputs = new Note[](_inputCutoff);
    uint256 _consumed;
    // A transact can only spend inputs sharing one tokenId (`_buildTransactInputs`
    // The first unspent note found fixes the tokenId; every subsequent input is filtered to match
    uint256 _tokenId;
    // TODO spend notes in a random order, currently we spend them sequentially from a random offset
    for (uint256 _i; _i < _inputCutoff; ++_i) {
      (bool _found, Note memory _note, uint256 _newConsumed) =
        _findNextUnspentNote(_actorSeed, _inputSeed, _consumed, _tokenId, _i != 0);
      // TODO: consider not fully bailing, but spending a smaller amount of notes instead
      vm.assume(_found);
      if (_i == 0) _tokenId = _note.tokenId;
      _inputs[_i] = _note;
      _consumed = _newConsumed;
    }
    // TODO (v2) bound on labels, not inputs, as several inputs can share a label.
    // TODO (v2) also (optionally) compress several outputs from a single label into a single output
    uint256 _amountOut;
    uint256 _sizeBefore = _stateTreeMirror.size;

    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](_inputCutoff);
    for (uint256 _i = 0; _i < _inputCutoff; _i++) {
      uint256 _leftInNote = bound(_newNoteAmountSeeds[_i], 0, _inputs[_i].value);
      _noteCreationParams[_i] = _getActor(_recipientSeeds[_i]).receiveNote(_leftInNote, _inputs[_i].inputLabel);
      _amountOut += _inputs[_i].value - _leftInNote;
      // ValueConservation circuit is bound to uint128
      vm.assume(_amountOut < type(uint128).max);
    }
    _assertTransactValueConserved(_inputs, _noteCreationParams, _amountOut);

    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: _actor.addr, data: ''});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](_noteCreationParams.length);
    uint256 _context = _hashTransactContext(_params, _payload);
    (Note[] memory _newNotes,) = _submitTransact({
      _broadcaster: _actor.addr,
      _proof: _buildTransactProof({
        _notes: _inputs,
        _spender: _actor,
        _noteCreationParams: _noteCreationParams,
        _amountOut: _amountOut,
        _context: _context
      }),
      _noteCreationParams: _noteCreationParams,
      _tokenId: _inputs[0].tokenId,
      _params: _params,
      _payload: _payload
    });

    for (uint256 _i = 0; _i < _inputCutoff; _i++) {
      _markSpent(_inputs[_i]);
      _addNote(_recipientSeeds[_i], _newNotes[_i]);
    }
    _recordTransactLabelWithdrawals(_inputs, _noteCreationParams);

    address _asset = _assetOf(_inputs[0]);
    ghost_withdrawnSum[_asset] += _amountOut;
    ghost_withdrawnTo[_asset][_actor.addr] += _amountOut;

    ghost_transactLeafInserts += _inputs.length + _noteCreationParams.length;
    // ── PP2-9: on-handler check ──
    assertEq(_stateTreeMirror.size - _sizeBefore, _inputs.length + _noteCreationParams.length);
  }

  /// @dev Fuzz target: split a single unspent note into `_outputCount` outputs sharing the input's
  /// label. Each output's value is `bound(_outputAmountSeeds[i], 0, leftAfterPrev)`, and the final
  /// bucket receives any remaining value to keep the transact balanced (no external withdrawal).
  /// Outputs are routed per matching `_recipientSeeds[i]`.
  function handler_guided_split(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256[MAX_INPUTS] memory _outputAmountSeeds,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _outputCount
  ) public {
    vm.assume(!_poolVault.paused());
    UserIdentityLib.UserIdentity storage _actor = _getActor(_spenderSeed);
    _outputCount = bound(_outputCount, 1, MAX_INPUTS);

    Note memory _note = _getNote(_spenderSeed, _inputSeed);
    vm.assume(!_spentNotes[_note.outputCommitment]);
    vm.warp(block.timestamp + 1);

    Note[] memory _inputs = new Note[](1);
    _inputs[0] = _note;

    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](_outputCount);
    uint256 _remaining = _note.value;
    for (uint256 i = 0; i < _outputCount; i++) {
      uint256 _val = i == _outputCount - 1 ? _remaining : bound(_outputAmountSeeds[i], 0, _remaining);
      _remaining -= _val;
      _noteCreationParams[i] = _getActor(_recipientSeeds[i]).receiveNote(_val, _note.inputLabel);
    }
    _assertTransactValueConserved(_inputs, _noteCreationParams, 0);

    uint256 _sizeBefore = _stateTreeMirror.size;
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: _actor.addr, data: ''});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](_noteCreationParams.length);
    uint256 _context = _hashTransactContext(_params, _payload);
    (Note[] memory _newNotes,) = _submitTransact({
      _broadcaster: _actor.addr,
      _proof: _buildTransactProof({
        _notes: _inputs, _spender: _actor, _noteCreationParams: _noteCreationParams, _amountOut: 0, _context: _context
      }),
      _noteCreationParams: _noteCreationParams,
      _tokenId: _inputs[0].tokenId,
      _params: _params,
      _payload: _payload
    });

    _markSpent(_note);
    for (uint256 i = 0; i < _outputCount; i++) {
      _addNote(_recipientSeeds[i], _newNotes[i]);
    }
    _recordTransactLabelWithdrawals(_inputs, _noteCreationParams);
    ghost_transactLeafInserts += 1 + _outputCount;
    // tree grows by 1 nullifier + _outputCount commitments
    assertEq(_stateTreeMirror.size - _sizeBefore, 1 + _outputCount);
  }

  /// @dev Fuzz target: merge `_inputCount` unspent notes that share one label into a single same-label
  /// output (N×1 transact, zero external withdrawal). Use after split or partial transacts that leave
  /// several same-label notes on one actor.
  function handler_guided_mergeSameLabel(
    uint256 _spenderSeed,
    uint256 _labelSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed,
    uint256 _inputCountSeed
  ) public {
    vm.assume(!_poolVault.paused());
    UserIdentityLib.UserIdentity storage _actor = _getActor(_spenderSeed);

    uint256 _label = _pickUnspentNoteLabel(_spenderSeed, _labelSeed);
    uint256 _available = _countUnspentNotesWithLabel(_spenderSeed, _label);
    vm.assume(_available >= 2);
    uint256 _inputCount = bound(_inputCountSeed, 2, _available > MAX_INPUTS ? MAX_INPUTS : _available);
    vm.warp(block.timestamp + 1);

    Note[] memory _inputs = _collectUnspentNotesWithLabel(_spenderSeed, _label, _inputCount, _inputSeed);

    uint256 _mergedValue;
    for (uint256 _i; _i < _inputCount; ++_i) {
      _mergedValue += _inputs[_i].value;
      vm.assume(_mergedValue < type(uint128).max);
    }

    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] = _getActor(_recipientSeed).receiveNote(_mergedValue, _label);
    _assertTransactValueConserved(_inputs, _noteCreationParams, 0);

    uint256 _sizeBefore = _stateTreeMirror.size;
    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({processor: _actor.addr, data: ''});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    uint256 _context = _hashTransactContext(_params, _payload);
    (Note[] memory _newNotes,) = _submitTransact({
      _broadcaster: _actor.addr,
      _proof: _buildTransactProof({
        _notes: _inputs, _spender: _actor, _noteCreationParams: _noteCreationParams, _amountOut: 0, _context: _context
      }),
      _noteCreationParams: _noteCreationParams,
      _tokenId: _inputs[0].tokenId,
      _params: _params,
      _payload: _payload
    });

    for (uint256 _i; _i < _inputCount; ++_i) {
      _markSpent(_inputs[_i]);
    }
    _addNote(_recipientSeed, _newNotes[0]);
    _recordTransactLabelWithdrawals(_inputs, _noteCreationParams);

    ghost_transactLeafInserts += _inputCount + 1;
    // ── PP2-9: on-handler check ──
    assertEq(_stateTreeMirror.size - _sizeBefore, _inputCount + 1);
  }

  /// @dev Internal transfer of a single unspent note: produces one output of the same value owned by `_recipientSeed`.
  /// Thin wrapper over `handler_guided_transact` with cutoff=1, leftInNote=full value, recipient configurable.
  function handler_guided_transferSingleNote(
    uint256 _spenderSeed,
    uint256 _recipientSeed,
    uint256 _inputSeed,
    uint256 _amountSeed
  ) public {
    Note[] storage _notes = _getNotes(_spenderSeed);
    vm.assume(_notes.length > 0);
    uint256 _noteIndex = type(uint256).max;
    for (uint256 i = 0; i < _notes.length; i++) {
      uint256 _candidateIndex = (i + (_inputSeed % _notes.length)) % _notes.length;
      if (!_spentNotes[_notes[_candidateIndex].outputCommitment]) {
        _noteIndex = _candidateIndex;
        break;
      }
    }
    // only bail in the case where the user has zero unspent notes
    vm.assume(_noteIndex != type(uint256).max);
    // convenience extra logic for handers with extra guidance: allow flag value to cause a full withdrawal
    uint256 value =
      _amountSeed == type(uint256).max ? _notes[_noteIndex].value : bound(_amountSeed, 0, _notes[_noteIndex].value);
    handler_guided_transact({
      _actorSeed: _spenderSeed,
      _inputSeed: uint128(_noteIndex),
      // keep the full value in the new note → zero external withdrawal
      _newNoteAmountSeeds: [value, 0, 0, 0, 0],
      _recipientSeeds: [_recipientSeed, 0, 0, 0, 0],
      _inputCutoff: 1
    });
  }

  /// @dev Even more guided: fully self-withdraws any unspent note for a given actor.
  /// leftInNote = 0 → full external withdrawal to spender, zero-value change note routed to self.
  function handler_guided_transactSingleNoteFullWithdraw(uint256 _spenderSeed, uint256 _inputSeed) external {
    handler_guided_transferSingleNote({
      _spenderSeed: _spenderSeed, _recipientSeed: _spenderSeed, _inputSeed: _inputSeed, _amountSeed: 0
    });
  }

  /// @dev Even more guided: fully transacts out any unspent note for a given actor.
  /// leftInNote = 0 → full external withdrawal to spender, zero-value change note routed to `_recipientSeed`.
  function handler_guided_transactSingleNoteFullSend(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed
  ) external {
    handler_guided_transferSingleNote({
      _spenderSeed: _spenderSeed, _recipientSeed: _recipientSeed, _inputSeed: _inputSeed, _amountSeed: 0
    });
  }

  /// @dev Even more guided: fully internal-transfers any unspent note for a given actor.
  /// leftInNote = full value → no external withdrawal, full-value note owned by `_recipientSeed`.
  function handler_guided_transactSingleNoteFullyInternal(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed
  ) external {
    handler_guided_transferSingleNote({
      _spenderSeed: _spenderSeed, _recipientSeed: _recipientSeed, _inputSeed: _inputSeed, _amountSeed: type(uint256).max
    });
  }

  /*///////////////////////////////////////////////////////////////
                        UNGUIDED HANDLERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev an unregistered actor can deposit (deposits skip the keystore) but cannot transact
  /// The Transact circuit's keystore-inclusion constraint fails proof gen as `CheatcodeError`.
  /// Only the deposit value is fuzzed: `_leftInNote` / `_amountOut` / recipient have no effect on the
  /// outcome (proof gen reverts on the keystore witness regardless), so we hardcode a full internal
  /// transfer to keep the handler readable.
  function handler_unguided_unregisteredTransact(uint128 _depositValueSeed, uint256 _assetSeed) external {
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);
    uint128 _value = uint128(bound(_depositValueSeed, MIN_AMOUNT, type(uint128).max));
    address _asset = _pickAsset(_assetSeed);

    // Precondition: a valid deposit on the unregistered actor's name (broadcaster = recipient).
    Note memory _note = _deposit(_unregisteredActor, _unregisteredActor, _asset, _value);
    _addNoteForAddress(_unregisteredActor.addr, _note);
    ghost_depositCount++;
    ghost_depositSum[_asset] += _value;
    ghost_feeSum[_asset] += _calcFee(_value);
    _labelBalance(_note.inputLabel).deposited += _value;

    Note[] memory _inputs = new Note[](1);
    _inputs[0] = _note;

    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] = _unregisteredActor.receiveNote(_note.value, _note.inputLabel);

    IPoolVault.TransactParams memory _txParams =
      IPoolVault.TransactParams({processor: _unregisteredActor.addr, data: ''});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    uint256 _context = _hashTransactContext(_txParams, _payload);

    try this.external_generateTransactProof(_inputs, _unregisteredActor, _noteCreationParams, 0, _context) returns (
      ProofLibV2.TransactProof memory
    ) {
      assertTrue(false, 'unregistered actor must not produce a valid transact proof');
    } catch (bytes memory _err) {
      assertEq(
        bytes4(_err),
        bytes4(keccak256('CheatcodeError(string)')),
        'Proof generation error should be an FFI (CheatcodeError) revert'
      );
    }
  }

  /// @dev unguided, but concerning the full withdrawal of a single note
  function handler_unguided_transactSingleNote(
    uint256 _broadcasterSeed,
    uint256 _spenderSeed,
    uint256 _noteOwnerSeed,
    uint256 _noteRecipientSeed,
    uint256 _inputSeed,
    uint256 _labelSeed,
    uint256 _leftInNoteSeed
  ) external {
    Note memory _note = _getNote(_noteOwnerSeed, _inputSeed);
    UserIdentityLib.UserIdentity storage _spender = _getActor(_noteOwnerSeed);
    UserIdentityLib.UserIdentity storage _broadcaster = _getActor(_broadcasterSeed);
    vm.warp(block.timestamp + 1);

    Note[] memory _inputs = new Note[](1);
    _inputs[0] = _note;

    // sentinel `type(uint256).max` → full-value internal transfer (zero external withdrawal)
    uint256 _leftInNote = _leftInNoteSeed == type(uint256).max ? _note.value : bound(_leftInNoteSeed, 0, _note.value);
    uint256 _amountOut = _note.value - _leftInNote;

    // choose any label for output, to allow for ones not matching input
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] =
      _getActor(_noteRecipientSeed).receiveNote(_leftInNote, _getNote(_spenderSeed, _labelSeed).inputLabel);
    _assertTransactValueConserved(_inputs, _noteCreationParams, _amountOut);

    IPoolVault.TransactParams memory _txParams = IPoolVault.TransactParams({processor: _broadcaster.addr, data: ''});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    uint256 _context = uint256(keccak256(abi.encode(_txParams, _payload))) % SNARK_SCALAR_FIELD;
    uint256 _sizeBefore = _stateTreeMirror.size;

    try this.external_generateTransactProof(_inputs, _spender, _noteCreationParams, _amountOut, _context) returns (
      ProofLibV2.TransactProof memory _proof
    ) {
      // this showcases the ability for the transaction to be broadcast by
      // another user than the note owner. This is normally only used by the
      // relay flow, but it remains a possibility in the general case
      try this.external_submitTransact(
        _broadcaster.addr, _proof, _noteCreationParams, _note.tokenId, _txParams, _payload
      ) returns (
        Note[] memory _newNotes, uint256[] memory
      ) {
        _markSpent(_note);
        _addNote(_noteRecipientSeed, _newNotes[0]);
        _recordTransactLabelWithdrawals(_inputs, _noteCreationParams);
        address _asset = _assetOf(_note);
        ghost_withdrawnSum[_asset] += _amountOut;
        ghost_withdrawnTo[_asset][_broadcaster.addr] += _amountOut;

        ghost_transactLeafInserts += 2;
        // ── PP2-9: on-handler check ──
        assertEq(_stateTreeMirror.size - _sizeBefore, 2);
      } catch (bytes memory _err) {
        bytes4 _selector = bytes4(_err);
        if (_selector == IPoolVault.PoolVault_NullifierAlreadySpent.selector) {
          assertTrue(_spentNotes[_note.outputCommitment]);
        } else if (_selector == PausableUpgradeable.EnforcedPause.selector) {
          assertTrue(_poolVault.paused(), 'EnforcedPause should only be thrown when paused');
        } else {
          // TODO(v2) - PoolVault_InvalidTransactProof will be possible with invalid label value distribution. All other ones are out of scope for the fuzzing campaign
          assertTrue(false, 'unexplained transact revert');
        }
      }
    } catch (bytes memory _err) {
      assertEq(
        bytes4(_err),
        bytes4(keccak256('CheatcodeError(string)')),
        'Proof generation error should be an FFI (CheatcodeError) revert'
      );
      assertTrue(
        _noteCreationParams[0].label != _inputs[0].inputLabel || _amountOut > type(uint128).max,
        'proof generation must revert if there are extra labels in outputs or inputs fail range checks'
      );
    }
  }

  /// @dev NxM unguided transact
  function handler_unguided_transact(
    uint256 _spenderSeed,
    uint256 _broadcasterSeed,
    uint256 _inputCountSeed,
    uint256 _inputBaseSeed,
    uint256 _outputCountSeed,
    uint256[MAX_INPUTS] memory _outputAmountSeeds,
    uint256[MAX_INPUTS] memory _outputRecipientSeeds,
    uint256[MAX_INPUTS] memory _outputLabelSeeds,
    uint256 _processorSeed,
    uint256 _dataSeed
  ) external {
    // Everything is free-fuzzed (processor, data, broadcaster, spender, N×M, labels, recipients)
    // EXCEPT value conservation, which we pin: an unconserved proof never generates, so we'd never
    // reach `transact()` at all — pinning it is the minimum needed to keep the on-chain call fuzzable.
    vm.warp(block.timestamp + 1);
    UserIdentityLib.UserIdentity storage _spender = _getActor(_spenderSeed);
    UserIdentityLib.UserIdentity storage _broadcaster = _getActor(_broadcasterSeed);
    uint256 _inputCount = bound(_inputCountSeed, 1, MAX_INPUTS);
    uint256 _outputCount = bound(_outputCountSeed, 1, MAX_INPUTS);

    // Collect _inputCount notes from spender, all sharing tokenId. Same-tokenId is required by
    // `_buildTransactInputs` (test-helper hard guard, not protocol).
    Note[] storage _allNotes = _actorNotes[_spender.addr];
    vm.assume(_allNotes.length > 0);
    Note memory _firstNote = _allNotes[(_inputBaseSeed >> 1) % _allNotes.length];
    // ~50% of runs stay happy-path eligible, ~50% may include a spent note and trip
    // `PoolVault_NullifierAlreadySpent` on submit (the double-spend axis).
    bool _allowSpent = _inputBaseSeed % 2 == 0;
    if (!_allowSpent) vm.assume(!_spentNotes[_firstNote.outputCommitment]);
    Note[] memory _inputs = new Note[](_inputCount);
    _inputs[0] = _firstNote;
    uint256 _inputSum = _firstNote.value;
    uint256 _filled = 1;
    for (uint256 _k; _k < _allNotes.length && _filled < _inputCount; ++_k) {
      Note storage _candidate = _allNotes[((_inputBaseSeed >> 1) + 1 + _k) % _allNotes.length];
      if (_candidate.outputCommitment == _firstNote.outputCommitment) continue;
      if (!_allowSpent && _spentNotes[_candidate.outputCommitment]) continue;
      if (_candidate.tokenId != _firstNote.tokenId) continue;
      _inputs[_filled] = _candidate;
      _inputSum += _candidate.value;
      _filled++;
    }
    vm.assume(_filled == _inputCount);

    // Outputs draw from a shared budget = inputSum, so total value is conserved by construction
    // (residual flows out as `_amountOut`). Labels sample from the spender's pool: sometimes match
    // an input label (proof may succeed), sometimes don't (proof reverts with `CheatcodeError` on
    // per-label mismatch).
    NoteCreationParams[] memory _outputs = new NoteCreationParams[](_outputCount);
    uint256 _remaining = _inputSum;
    for (uint256 _i; _i < _outputCount; ++_i) {
      uint256 _val = bound(_outputAmountSeeds[_i], 0, _remaining);
      _remaining -= _val;
      uint256 _label = _getNote(_spenderSeed, _outputLabelSeeds[_i]).inputLabel;
      _outputs[_i] = _getActor(_outputRecipientSeeds[_i]).receiveNote(_val, _label);
    }
    uint256 _amountOut = _remaining;
    vm.assume(_amountOut <= type(uint128).max);

    // Same `_params` for proof context AND submit — fuzz axis is `processor == msg.sender`, NOT
    // `ProofContextMismatch`. 4-way `processor` bucket (1 sane + 3 mismatched flavors) lets the
    // fuzzer trip `PoolVault_InvalidProcessor`; `data` toggles empty vs non-empty for shape coverage.
    uint256 _processorBucket = _processorSeed % 4;
    address _processor;
    if (_processorBucket == 0) {
      _processor = _broadcaster.addr; // sane: processor == msg.sender → passes
    } else if (_processorBucket == 1) {
      _processor = address(0); // zero addr
    } else if (_processorBucket == 2) {
      _processor = _getActor(_processorSeed >> 2).addr; // some other actor
    } else {
      _processor = address(uint160(_processorSeed)); // arbitrary random addr
    }
    // `data` is opaque to the protocol so we fuzz empty vs non-empty for shape coverage.
    IPoolVault.TransactParams memory _params =
      IPoolVault.TransactParams({processor: _processor, data: _dataSeed % 2 == 0 ? bytes('') : abi.encode(_dataSeed)});
    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](_outputCount);
    uint256 _context = _hashTransactContext(_params, _payload);
    uint256 _sizeBefore = _stateTreeMirror.size;

    try this.external_generateTransactProof(_inputs, _spender, _outputs, _amountOut, _context) returns (
      ProofLibV2.TransactProof memory _proof
    ) {
      try this.external_submitTransact(
        _broadcaster.addr, _proof, _outputs, _firstNote.tokenId, _params, _payload
      ) returns (
        Note[] memory _newNotes, uint256[] memory
      ) {
        for (uint256 _i; _i < _inputCount; ++_i) {
          _markSpent(_inputs[_i]);
        }
        for (uint256 _i; _i < _outputCount; ++_i) {
          _addNote(_outputRecipientSeeds[_i], _newNotes[_i]);
        }
        _recordTransactLabelWithdrawals(_inputs, _outputs);
        address _asset = _assetOf(_firstNote);
        ghost_withdrawnSum[_asset] += _amountOut;
        ghost_withdrawnTo[_asset][_broadcaster.addr] += _amountOut;
        ghost_transactLeafInserts += _inputCount + _outputCount;
        // ── PP2-9: on-handler check ──
        assertEq(_stateTreeMirror.size - _sizeBefore, _inputCount + _outputCount);
      } catch (bytes memory _err) {
        bytes4 _selector = bytes4(_err);
        if (_selector == IPoolVault.PoolVault_InvalidProcessor.selector) {
          assertTrue(_processor != _broadcaster.addr, 'InvalidProcessor only when processor != broadcaster');
        } else if (_selector == IPoolVault.PoolVault_NullifierAlreadySpent.selector) {
          bool _someSpent;
          for (uint256 _i; _i < _inputCount; ++_i) {
            if (_spentNotes[_inputs[_i].outputCommitment]) {
              _someSpent = true;
              break;
            }
          }
          assertTrue(_someSpent, 'NullifierAlreadySpent without any tracked-spent input');
        } else if (_selector == PausableUpgradeable.EnforcedPause.selector) {
          assertTrue(_poolVault.paused(), 'EnforcedPause should only be thrown when paused');
        } else {
          assertTrue(false, 'unexplained transact submit revert');
        }
      }
    } catch (bytes memory _err) {
      assertEq(
        bytes4(_err), bytes4(keccak256('CheatcodeError(string)')), 'expected CheatcodeError on proof gen failure'
      );
      // The FFI prover reports every rejection as one opaque `CheatcodeError`, so (unlike the submit
      // switch above) we recompute the cause.
      // If it's not a known/expected cause, there is a test desync.
      bool _knownCause;
      for (uint256 _i; _i < _outputCount && !_knownCause; ++_i) {
        (uint256 _matchedInputSum, bool _inherited) = _inputValueForLabel(_inputs, _outputs[_i].label);
        if (
          !_inherited || _outputs[_i].value > _matchedInputSum || _outputs[_i].value > type(uint128).max
            || _matchedInputSum > type(uint128).max
        ) _knownCause = true;
      }
      assertTrue(_knownCause, 'CheatcodeError on proof gen with no label/range cause (possible test-harness desync)');
    }
  }

  /*///////////////////////////////////////////////////////////////
                   EXTERNAL CALLERS FOR TRY/CATCH
  ///////////////////////////////////////////////////////////////*/

  function external_generateTransactProof(
    Note[] memory _notes,
    UserIdentityLib.UserIdentity memory _spender,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _amountOut,
    uint256 _context
  ) external returns (ProofLibV2.TransactProof memory) {
    return _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _noteCreationParams,
      _amountOut: _amountOut,
      _context: _context
    });
  }

  function external_submitTransact(
    address _broadcaster,
    ProofLibV2.TransactProof memory _proof,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _tokenId,
    IPoolVault.TransactParams memory _params,
    IPoolVault.NoteData[] memory _payload
  ) external returns (Note[] memory _newNotes, uint256[] memory _nullifierHashes) {
    return _submitTransact(_broadcaster, _proof, _noteCreationParams, _tokenId, _params, _payload);
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Aggregates input-note value for a single label.
  /// @param _inputs The transact input notes to scan.
  /// @param _label The label to match against each input's `inputLabel`.
  /// @return _sum Total value of inputs carrying `_label`
  /// @return _present Whether any input carries `_label`
  function _inputValueForLabel(
    Note[] memory _inputs,
    uint256 _label
  ) internal pure returns (uint256 _sum, bool _present) {
    for (uint256 _i; _i < _inputs.length; ++_i) {
      if (_inputs[_i].inputLabel == _label) {
        _present = true;
        _sum += _inputs[_i].value;
      }
    }
  }

  /// @dev PP2-6: per label L, `withdrawn[L] += sum(inputs[L]) - sum(outputs[L])` (any N×M).
  function _recordTransactLabelWithdrawals(Note[] memory _inputs, NoteCreationParams[] memory _outputs) internal {
    for (uint256 _i; _i < _inputs.length; ++_i) {
      uint256 _label = _inputs[_i].inputLabel;

      // Each distinct label is processed exactly once, at its first occurrence in `_inputs`.
      bool _alreadyProcessed;
      for (uint256 _k; _k < _i; ++_k) {
        if (_inputs[_k].inputLabel == _label) {
          _alreadyProcessed = true;
          break;
        }
      }
      if (_alreadyProcessed) continue;

      // Total value entering the transact under this label.
      (uint256 _inSum,) = _inputValueForLabel(_inputs, _label);

      // Total value leaving the transact under this label (as new notes).
      uint256 _outSum;
      for (uint256 _j; _j < _outputs.length; ++_j) {
        if (_outputs[_j].label == _label) _outSum += _outputs[_j].value;
      }

      // Anything not re-emitted as a same-label output was externally withdrawn.
      if (_inSum > _outSum) {
        _labelBalance(_label).withdrawn += _inSum - _outSum;
      }
    }
  }

  /// @dev PP2-7: on successful transacts, input value equals outputs plus external withdrawal.
  function _assertTransactValueConserved(
    Note[] memory _inputs,
    NoteCreationParams[] memory _outputs,
    uint256 _amountOut
  ) internal pure {
    uint256 _inputSum;
    for (uint256 _i; _i < _inputs.length; ++_i) {
      _inputSum += _inputs[_i].value;
    }
    uint256 _outputSum;
    for (uint256 _i; _i < _outputs.length; ++_i) {
      _outputSum += _outputs[_i].value;
    }
    assertEq(_inputSum, _outputSum + _amountOut, 'PP2-7: transact value conservation');
  }
}
