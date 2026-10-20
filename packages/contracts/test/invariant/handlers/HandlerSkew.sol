// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerDeposit} from './HandlerDeposit.sol';
import {HandlerRagequit} from './HandlerRagequit.sol';
import {HandlerRelay} from './HandlerRelay.sol';
import {HandlerTransact} from './HandlerTransact.sol';

/// @title HandlerSkew
/// @notice Duplicate fuzz entry points so Foundry's uniform selector pick skews toward complex paths.
/// @dev Foundry picks uniformly among every `handler*` on `HandlerTarget`;
///      effective weight = 1 + number of `*_skewN` aliases below.
///
///      Target pick mix: ~60% transact · ~30% deposit+ragequit · ~10% admin (pause/sweep).
///
///      | Handler family                         | Weight |
///      |----------------------------------------|--------|
///      | guided_transact, guided_split, merge   | 3      |
///      | guided_transferSingleNote              | 3      |
///      | guided_*SingleNoteFull* (3 helpers)    | 2 each |
///      | unguided_transactSingleNote            | 1      |
///      | unguided_unregisteredTransact          | 1      |
///      | guided_relaySingleNote                 | 2      |
///      | guided_relayBatch                       | 2      |
///      | guided_registerAndRelay                 | 2      |
///      | guided_deposit                         | 3      |
///      | unguided_deposit                       | 2      |
///      | guided_ragequit                        | 2      |
///      | unguided_ragequit                      | 1      |
///      | pause, unpause                         | 1      |
///      | unguided_sweep                         | 1      |
///
///      37 total slots → transact ~60%, relay ~16%, deposit+ragequit ~21%, admin ~8%.
///      Tune: if transact discards ≫ successes, bump deposit weights.
abstract contract HandlerSkew is HandlerDeposit, HandlerRagequit, HandlerTransact, HandlerRelay {
  /// @dev Total `handler*` entry points on `HandlerTarget` (canonical handlers + skew aliases + pause/sweep).
  uint256 internal constant HANDLER_SKEW_TOTAL_SLOTS = 37;

  /*///////////////////////////////////////////////////////////////
                    TRANSACT — weight 3 (core multi-path)
  ///////////////////////////////////////////////////////////////*/

  function handler_guided_transact_skew1(
    uint256 _actorSeed,
    uint256[MAX_INPUTS] memory _newNoteAmountSeeds,
    uint128 _inputSeed,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _inputCutoff
  ) external {
    handler_guided_transact(_actorSeed, _newNoteAmountSeeds, _inputSeed, _recipientSeeds, _inputCutoff);
  }

  function handler_guided_transact_skew2(
    uint256 _actorSeed,
    uint256[MAX_INPUTS] memory _newNoteAmountSeeds,
    uint128 _inputSeed,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _inputCutoff
  ) external {
    handler_guided_transact(_actorSeed, _newNoteAmountSeeds, _inputSeed, _recipientSeeds, _inputCutoff);
  }

  function handler_guided_split_skew1(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256[MAX_INPUTS] memory _outputAmountSeeds,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _outputCount
  ) external {
    handler_guided_split(_spenderSeed, _inputSeed, _outputAmountSeeds, _recipientSeeds, _outputCount);
  }

  function handler_guided_split_skew2(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256[MAX_INPUTS] memory _outputAmountSeeds,
    uint256[MAX_INPUTS] memory _recipientSeeds,
    uint256 _outputCount
  ) external {
    handler_guided_split(_spenderSeed, _inputSeed, _outputAmountSeeds, _recipientSeeds, _outputCount);
  }

  function handler_guided_mergeSameLabel_skew1(
    uint256 _spenderSeed,
    uint256 _labelSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed,
    uint256 _inputCountSeed
  ) external {
    handler_guided_mergeSameLabel(_spenderSeed, _labelSeed, _inputSeed, _recipientSeed, _inputCountSeed);
  }

  function handler_guided_mergeSameLabel_skew2(
    uint256 _spenderSeed,
    uint256 _labelSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed,
    uint256 _inputCountSeed
  ) external {
    handler_guided_mergeSameLabel(_spenderSeed, _labelSeed, _inputSeed, _recipientSeed, _inputCountSeed);
  }

  /*///////////////////////////////////////////////////////////////
                    TRANSACT — weight 3 (single-note paths)
  ///////////////////////////////////////////////////////////////*/

  function handler_guided_transferSingleNote_skew1(
    uint256 _spenderSeed,
    uint256 _recipientSeed,
    uint256 _inputSeed,
    uint256 _amountSeed
  ) external {
    handler_guided_transferSingleNote(_spenderSeed, _recipientSeed, _inputSeed, _amountSeed);
  }

  function handler_guided_transferSingleNote_skew2(
    uint256 _spenderSeed,
    uint256 _recipientSeed,
    uint256 _inputSeed,
    uint256 _amountSeed
  ) external {
    handler_guided_transferSingleNote(_spenderSeed, _recipientSeed, _inputSeed, _amountSeed);
  }

  /*///////////////////////////////////////////////////////////////
                    TRANSACT — weight 2 (thin guided helpers)
  ///////////////////////////////////////////////////////////////*/

  function handler_guided_transactSingleNoteFullWithdraw_skew1(uint256 _spenderSeed, uint256 _inputSeed) external {
    this.handler_guided_transactSingleNoteFullWithdraw(_spenderSeed, _inputSeed);
  }

  function handler_guided_transactSingleNoteFullSend_skew1(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed
  ) external {
    this.handler_guided_transactSingleNoteFullSend(_spenderSeed, _inputSeed, _recipientSeed);
  }

  function handler_guided_transactSingleNoteFullyInternal_skew1(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _recipientSeed
  ) external {
    this.handler_guided_transactSingleNoteFullyInternal(_spenderSeed, _inputSeed, _recipientSeed);
  }

  /*///////////////////////////////////////////////////////////////
                    DEPOSIT / RAGEQUIT — weight 3/2/2/1
  ///////////////////////////////////////////////////////////////*/

  function handler_guided_deposit_skew1(
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint128 _value,
    uint256 _assetSeed
  ) external {
    this.handler_guided_deposit(_broadcasterSeed, _recipientSeed, _value, _assetSeed);
  }

  function handler_guided_deposit_skew2(
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint128 _value,
    uint256 _assetSeed
  ) external {
    this.handler_guided_deposit(_broadcasterSeed, _recipientSeed, _value, _assetSeed);
  }

  function handler_unguided_deposit_skew1(
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint128 _value,
    uint256 _assetSeed
  ) external {
    this.handler_unguided_deposit(_broadcasterSeed, _recipientSeed, _value, _assetSeed);
  }

  function handler_guided_ragequit_skew1(uint256 _actorSeed, uint256 _noteSeed) external {
    this.handler_guided_ragequit(_actorSeed, _noteSeed);
  }

  /*///////////////////////////////////////////////////////////////
                    RELAY — weight 2 (PP2-17 + new code path)
  ///////////////////////////////////////////////////////////////*/

  function handler_guided_relaySingleNote_skew1(
    uint256 _noteOwnerSeed,
    uint256 _inputSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed,
    uint256 _nativeGasSeed
  ) external {
    handler_guided_relaySingleNote(
      _noteOwnerSeed,
      _inputSeed,
      _broadcasterSeed,
      _recipientSeed,
      _feeRecipientSeed,
      _withdrawValueSeed,
      _feeAmountSeed,
      _nativeGasSeed
    );
  }

  function handler_guided_relayBatch_skew1(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _countSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed,
    uint256 _nativeGasSeed
  ) external {
    handler_guided_relayBatch(
      _spenderSeed,
      _inputSeed,
      _broadcasterSeed,
      _recipientSeed,
      _feeRecipientSeed,
      _countSeed,
      _withdrawValueSeed,
      _feeAmountSeed,
      _nativeGasSeed
    );
  }

  function handler_guided_registerAndRelay_skew1(
    uint256 _freshSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _assetSeed,
    uint256 _depositValueSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed
  ) external {
    handler_guided_registerAndRelay(
      _freshSeed,
      _broadcasterSeed,
      _recipientSeed,
      _feeRecipientSeed,
      _assetSeed,
      _depositValueSeed,
      _withdrawValueSeed,
      _feeAmountSeed
    );
  }
}
