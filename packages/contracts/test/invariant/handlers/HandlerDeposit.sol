// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PausableUpgradeable} from '@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol';

import {HandlerCommon} from './HandlerCommon.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';
import {Note} from 'test/handlers/HandlerBase.sol';
import {_calcFee} from 'test/handlers/HandlerBase.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';

abstract contract HandlerDeposit is HandlerCommon {
  using UserIdentityLib for UserIdentityLib.UserIdentity;
  using ProofLibV2 for ProofLibV2.DepositProof;
  using MerkleTree for MerkleTree.Tree;

  /*///////////////////////////////////////////////////////////////
                        GUIDED HANDLERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fuzz target: deposit a bound value from a random actor, to a random actor, on a random asset
  function handler_guided_deposit(
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint128 _value,
    uint256 _assetSeed
  ) external {
    _value = uint128(bound(_value, MIN_AMOUNT, type(uint128).max));
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);
    address _asset = _pickAsset(_assetSeed);
    Note memory _note = _deposit(_getActor(_broadcasterSeed), _getActor(_recipientSeed), _asset, _value);

    // Store the note for future ragequit/transact
    _addNote(_recipientSeed, _note);
    ghost_depositCount++;
    ghost_depositSum[_asset] += _value;
    ghost_feeSum[_asset] += _calcFee(_value);
    _recordDepositLabel(_note.inputLabel, _value);
  }

  /*///////////////////////////////////////////////////////////////
                        UNGUIDED HANDLERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fuzz target: deposit a bounded value from a random actor on a random asset
  function handler_unguided_deposit(
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint128 _value,
    uint256 _assetSeed
  ) external {
    vm.warp(block.timestamp + 1);
    UserIdentityLib.UserIdentity storage _broadcaster = _getActor(_broadcasterSeed);
    Note memory _note;
    UserIdentityLib.UserIdentity storage _recipient = _getActor(_recipientSeed);
    address _asset = _pickAsset(_assetSeed);
    (uint256 _noteSecret, uint256 _depositSecret) = _recipient.newSecrets();
    _note.value = _value;
    _note.noteSecret = _noteSecret;
    _note.depositSecret = _depositSecret;
    _note.noteAddressHash = PoseidonT3.hash([_recipient.ownerAddress, _noteSecret]);
    _note.tokenId = uint256(uint160(_asset));

    uint256 _depositContext = uint256(keccak256(abi.encode(_defaultNoteData))) % SNARK_SCALAR_FIELD;

    try this.external_generateDepositProof(
      _asset, _value, _note.noteAddressHash, _depositSecret, _depositContext
    ) returns (
      ProofLibV2.DepositProof memory _proof
    ) {
      try this.external_submitDepositProof(_broadcaster, _note, _proof) returns (Note memory _output) {
        _addNote(_recipientSeed, _output);
        ghost_depositCount++;
        ghost_depositSum[_asset] += _value;
        ghost_feeSum[_asset] += _calcFee(_value);
        _recordDepositLabel(_output.inputLabel, _value);
      } catch (bytes memory _err) {
        bytes4 _sel = bytes4(_err);
        IEntrypoint.AssetConfig memory _cfg = _entrypoint.assets(_asset);

        if (_sel == IEntrypoint.Entrypoint_AssetNotEnabled.selector) {
          assertFalse(_cfg.enabled, 'AssetNotEnabled only when asset disabled');
        } else if (_sel == IEntrypoint.Entrypoint_BelowMinAmount.selector) {
          assertLe(_value, _cfg.minAmount, 'BelowMinAmount only when value < minAmount');
        } else if (_sel == PausableUpgradeable.EnforcedPause.selector) {
          assertTrue(_poolVault.paused(), 'EnforcedPause only when paused');
        } else {
          assertTrue(false, 'unexplained deposit revert');
        }
      }
    } catch (bytes memory _err) {
      assertEq(
        bytes4(_err),
        bytes4(keccak256('CheatcodeError(string)')),
        'Proof generation error should be an FFI (CheatcodeError) revert'
      );
      // deposit circuit constrains value < 2^128 (Num2Bits(128) range check in templates/Deposit.circom)
      assertTrue(_value > type(uint128).max, 'deposit proof generation should never fail for value <= uint128.max');
    }
  }

  /*///////////////////////////////////////////////////////////////
                  EXTERNAL FUNCTIONS FOR ERROR HANDLING
  ///////////////////////////////////////////////////////////////*/

  function external_generateDepositProof(
    address _token,
    uint256 _value,
    uint256 _noteAddressHash,
    uint256 _depositSecret,
    uint256 _context
  ) external returns (ProofLibV2.DepositProof memory proof_) {
    return ProofGenerator.generateDepositProof(_token, _value, _noteAddressHash, _depositSecret, _context);
  }

  function external_submitDepositProof(
    UserIdentityLib.UserIdentity memory _broadcaster,
    Note memory _incompleteNote,
    ProofLibV2.DepositProof memory _proof
  ) external returns (Note memory) {
    return _submitDepositProof(_broadcaster, _incompleteNote, _proof);
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  function _recordDepositLabel(uint256 _label, uint256 _value) internal {
    _labelBalance(_label).deposited += _value;
  }
}
