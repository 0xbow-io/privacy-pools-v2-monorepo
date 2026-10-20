// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerCommon} from './HandlerCommon.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {Note} from 'test/handlers/HandlerBase.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {RagequitProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

abstract contract HandlerRagequit is HandlerCommon {
  using RagequitProofMemory for ProofLibV2.RagequitProof;
  using MerkleTree for MerkleTree.Tree;

  /*///////////////////////////////////////////////////////////////
                        HANDLER FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fuzz target: ragequit a random existing note from a random actor
  function handler_guided_ragequit(uint256 _actorSeed, uint256 _noteSeed) external {
    Note memory _note = _getNote(_actorSeed, _noteSeed);
    vm.assume(!_spentNotes[_note.outputCommitment]);
    vm.assume(_note.value > 0);
    UserIdentityLib.UserIdentity storage _actor = _getActor(_actorSeed);

    // Advance timestamp so the ragequit leaf is distinct from the deposit leaf
    vm.warp(block.timestamp + 1);

    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(_actor, _note);

    uint256 _sizeBefore = _stateTreeMirror.size;
    _submitRagequit(_actor, _rqProof);
    _markSpent(_note);
    address _asset = _assetOf(_note);
    ghost_ragequitCount++;
    ghost_ragequitSum[_asset] += _note.value;
    ghost_ragequitTo[_asset][_actor.addr] += _note.value;
    _recordRagequitLabel(_note.inputLabel, _note.value);

    // ── PP2-12: on-handler check ──
    assert(_stateTreeMirror.size - _sizeBefore == 1);
  }

  /// @dev Fuzz target: ragequit with broadcaster decoupled from note owner. Asserts revert reason.
  function handler_unguided_ragequit(uint256 _broadcasterSeed, uint256 _noteOwnerSeed, uint256 _noteSeed) external {
    UserIdentityLib.UserIdentity storage _broadcaster = _getActor(_broadcasterSeed);
    UserIdentityLib.UserIdentity storage _noteOwner = _getActor(_noteOwnerSeed);

    Note memory _note = _getNote(_noteOwnerSeed, _noteSeed);

    vm.warp(block.timestamp + 1);

    ProofLibV2.RagequitProof memory _rqProof;
    try this.external_generateRagequitProof(_noteOwner, _note) returns (ProofLibV2.RagequitProof memory _p) {
      _rqProof = _p;
      uint256 _sizeBefore = _stateTreeMirror.size;

      vm.prank(_broadcaster.addr);
      try _poolVault.ragequit(_rqProof) {
        // Mirror state, mark spent, ghost
        _stateTreeMirror.insert(_nullifierLeaf(_rqProof.nullifierHash()));
        _trackNullifierLeaf(_rqProof.nullifierHash(), _stateTreeMirror.size - 1);
        _markSpent(_note);
        address _asset = _assetOf(_note);
        ghost_ragequitCount++;
        ghost_ragequitSum[_asset] += _note.value;
        ghost_ragequitTo[_asset][_broadcaster.addr] += _note.value;
        _recordRagequitLabel(_note.inputLabel, _note.value);
        assert(_stateTreeMirror.size - _sizeBefore == 1);
      } catch (bytes memory _err) {
        bytes4 _sel = bytes4(_err);
        bool _wrongOwner = _broadcaster.addr != _noteOwner.addr;
        bool _alreadySpent = _spentNotes[_note.outputCommitment];

        if (_sel == IPoolVault.PoolVault_InvalidOwnerAddress.selector) {
          assertTrue(_wrongOwner, 'InvalidOwnerAddress only when broadcaster != noteOwner');
        } else if (_sel == IPoolVault.PoolVault_ZeroValueRagequit.selector) {
          assertEq(_note.value, 0, 'PoolVault_ZeroValueRagequit only on notes with zero value');
        } else if (_sel == IPoolVault.PoolVault_NullifierAlreadySpent.selector) {
          assertTrue(_alreadySpent, 'NullifierAlreadySpent only when note already ragequit');
        } else {
          assertTrue(false, 'unexplained ragequit revert');
        }
      }
    } catch {
      assertTrue(false, 'ragequit proof generation should never fail for a real note');
    }
  }

  /*///////////////////////////////////////////////////////////////
                  EXTERNAL FUNCTIONS FOR ERROR HANDLING
  ///////////////////////////////////////////////////////////////*/

  function external_generateRagequitProof(
    UserIdentityLib.UserIdentity memory _user,
    Note memory _note
  ) external returns (ProofLibV2.RagequitProof memory) {
    return _buildAndGenerateRagequitProof(_user, _note);
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  function _recordRagequitLabel(uint256 _label, uint256 _value) internal {
    _labelBalance(_label).ragequit += _value;
  }
}
