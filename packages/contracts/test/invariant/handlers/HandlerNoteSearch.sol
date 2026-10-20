// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerCommon} from './HandlerCommon.sol';
import {Note} from 'test/handlers/HandlerBase.sol';

/// @dev Transact-oriented helpers for scanning `_actorNotes` / `_spentNotes`.
///      Kept out of `HandlerCommon` so deposit/ragequit handlers do not inherit merge/transact search noise.
abstract contract HandlerNoteSearch is HandlerCommon {
  /*///////////////////////////////////////////////////////////////
                        NOTE SEARCH
  ///////////////////////////////////////////////////////////////*/

  /// @dev Find the next unspent note for an actor in rotational order from `_baseSeed`,
  ///      skipping the first `_alreadyConsumed` candidates.
  ///      When `_enforceToken` is set, only notes whose `tokenId == _tokenId` are eligible
  ///      Returns `(found, note, newConsumed)`; feed `newConsumed` back in to continue the search
  ///      past this hit.
  function _findNextUnspentNote(
    uint256 _actorSeed,
    uint256 _baseSeed,
    uint256 _alreadyConsumed,
    uint256 _tokenId,
    bool _enforceToken
  ) internal view returns (bool _found, Note memory _note, uint256 _newConsumed) {
    uint256 _len = _getNotes(_actorSeed).length;
    for (uint256 _k = _alreadyConsumed; _k < _len; ++_k) {
      Note memory _candidate = _getNote(_actorSeed, _baseSeed + _k);
      if (_spentNotes[_candidate.outputCommitment]) continue;
      if (_enforceToken && _candidate.tokenId != _tokenId) continue;
      return (true, _candidate, _k + 1);
    }
    return (false, _note, _len);
  }

  /// @dev Among `_actorSeed`'s unspent notes, pick index `_unspentPickSeed % unspentCount` and return its `inputLabel`.
  function _pickUnspentNoteLabel(uint256 _actorSeed, uint256 _unspentPickSeed) internal returns (uint256 _label) {
    Note[] storage _notes = _getNotes(_actorSeed);
    uint256 _unspentCount;
    for (uint256 _i; _i < _notes.length; ++_i) {
      if (!_spentNotes[_notes[_i].outputCommitment]) {
        _unspentCount++;
      }
    }
    vm.assume(_unspentCount > 0);
    uint256 _pick = _unspentPickSeed % _unspentCount;
    uint256 _seen;
    for (uint256 _i; _i < _notes.length; ++_i) {
      if (!_spentNotes[_notes[_i].outputCommitment]) {
        if (_seen == _pick) {
          return _notes[_i].inputLabel;
        }
        _seen++;
      }
    }
    revert('unreachable: unspent note label pick');
  }

  function _countUnspentNotesWithLabel(uint256 _actorSeed, uint256 _label) internal view returns (uint256 _count) {
    Note[] storage _notes = _getNotes(_actorSeed);
    for (uint256 _i; _i < _notes.length; ++_i) {
      Note storage _note = _notes[_i];
      if (!_spentNotes[_note.outputCommitment] && _note.inputLabel == _label) {
        _count++;
      }
    }
  }

  /// @dev Exactly `_inputCount` unspent notes with `_label`, scanning from `_inputSeed % length`.
  function _collectUnspentNotesWithLabel(
    uint256 _actorSeed,
    uint256 _label,
    uint256 _inputCount,
    uint256 _inputSeed
  ) internal view returns (Note[] memory _inputs) {
    Note[] storage _notes = _getNotes(_actorSeed);
    _inputs = new Note[](_inputCount);
    uint256 _filled;
    uint256 _offset = _notes.length == 0 ? 0 : _inputSeed % _notes.length;
    for (uint256 _j; _j < _notes.length && _filled < _inputCount; ++_j) {
      Note storage _note = _notes[(_offset + _j) % _notes.length];
      if (!_spentNotes[_note.outputCommitment] && _note.inputLabel == _label) {
        _inputs[_filled++] = _note;
      }
    }
    require(_filled == _inputCount, 'collectUnspentNotesWithLabel: insufficient notes');
  }
}
