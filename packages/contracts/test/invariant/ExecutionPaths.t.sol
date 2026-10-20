// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Setup} from './Setup.sol';
import {_calcFee} from 'test/handlers/HandlerBase.sol';
import {Constants as ProtocolConstants} from 'utils/Constants.sol';

contract ExecutionPaths is Setup {
  /// @notice Known-good: single deposit produces expected vault balance
  function test_singleDeposit() external {
    uint128 _value = 1 ether;
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after 1 deposit');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _calcFee(_value), 'Entrypoint fee after 1 deposit');
  }

  /// @notice Known-good: deposits from 3 actors accumulate correctly
  function test_threeDepositsAccumulate() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 1, _recipientSeed: 2, _value: _value, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 2, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 3 * _value, 'Vault balance after 3 deposits');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), 3 * _calcFee(_value), 'Fee balance after 3 deposits');
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'Relay should hold nothing');
  }

  /// @notice Known-good: deposit then ragequit returns funds to zero
  function test_depositThenRagequit() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault balance should be zero after ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _value, 'Ragequit sum');
  }

  /// @notice Known-good: deposit then withdraw returns funds to zero
  function test_depositThenWithdrawFull() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    _handler.handler_guided_transact({
      _actorSeed: 1,
      _inputSeed: 0,
      _newNoteAmountSeeds: [uint256(0), 0, 0, 0, 0],
      _recipientSeeds: [uint256(1), 0, 0, 0, 0],
      _inputCutoff: 1
    });
    assertEq(
      _balanceOf(_token1(), address(_poolVault)), 0, 'Vault balance should be zero after transacting all funds out'
    );
    assertEq(_handler.ghost_withdrawnSum(_token1()), _value, 'Withdrawn sum not tracked');
  }

  /// @notice Known-good: deposit then partial withdraw + ragequit returns funds to zero
  function test_depositThenWithdrawPartialThenRagequit() external {
    uint128 _withdrawValue = 1 ether;
    uint128 _ragequitValue = 2 ether;

    _handler.handler_guided_deposit({
      _broadcasterSeed: 0, _recipientSeed: 1, _value: _withdrawValue + _ragequitValue, _assetSeed: 1
    });
    assertEq(_balanceOf(_token1(), address(_poolVault)), _withdrawValue + _ragequitValue, 'Vault balance after deposit');

    // ragequit value is kept in the pool
    _handler.handler_guided_transact({
      _actorSeed: 1,
      _inputSeed: 0,
      _newNoteAmountSeeds: [uint256(_ragequitValue), 0, 0, 0, 0],
      _recipientSeeds: [uint256(1), 0, 0, 0, 0],
      _inputCutoff: 1
    });
    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdrawValue, 'Withdrawn sum not tracked');

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault balance should be zero after ragequit');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdrawValue, 'Withdrawn sum not tracked');
    assertEq(_handler.ghost_ragequitSum(_token1()), _ragequitValue, 'Ragequit sum not tracked');
  }

  /// @notice Known-good: unguided deposit then ragequit returns funds to zero
  function test_depositUnguidedThenRagequit() external {
    uint128 _value = 1 ether;

    _handler.handler_unguided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault balance should be zero after ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _value, 'Ragequit sum');
  }

  /// @notice Known-good: deposit then unguided ragequit (matched broadcaster) returns funds to zero
  function test_depositThenRagequitUnguided() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    // broadcaster == note owner == actor index 1
    _handler.handler_unguided_ragequit({_broadcasterSeed: 1, _noteOwnerSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault balance should be zero after ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _value, 'Ragequit sum');
  }

  /// @notice Multi-input transact: full withdraw of one note + partial of others, then drain remainder
  function test_depositMultiThenTransactMixedThenDrain() external {
    uint128 _v0 = 3 ether;
    uint128 _v1 = 2 ether;
    uint128 _v2 = 1 ether;
    uint256 _totalDeposit = _v0 + _v1 + _v2;
    uint256 _totalFee = _calcFee(_v0) + _calcFee(_v1) + _calcFee(_v2);

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v1, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v2, _assetSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), _totalDeposit, 'Vault after 3 deposits');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _totalFee, 'Entrypoint fee after 3 deposits');
    assertEq(_handler.ghost_depositSum(_token1()), _totalDeposit, 'Deposit sum');
    assertEq(_handler.ghost_depositCount(), 3, 'Deposit count');
    assertEq(_handler.ghost_feeSum(_token1()), _totalFee, 'Fee sum');

    uint256 _keep1 = 0.5 ether;
    uint256 _keep2 = 0.25 ether;
    uint256 _withdrawn1 = _v0 + (_v1 - _keep1) + (_v2 - _keep2);

    _handler.handler_guided_transact({
      _actorSeed: 1,
      _inputSeed: 0,
      _newNoteAmountSeeds: [uint256(0), _keep1, _keep2, 0, 0],
      _recipientSeeds: [uint256(1), 1, 1, 0, 0],
      _inputCutoff: 3
    });

    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdrawn1, 'Withdrawn sum after call 1');
    assertEq(_balanceOf(_token1(), address(_poolVault)), _totalDeposit - _withdrawn1, 'Vault after call 1');
    assertEq(_handler.ghost_depositSum(_token1()), _totalDeposit, 'Deposit sum unchanged');
    assertEq(_handler.ghost_ragequitSum(_token1()), 0, 'Ragequit sum still 0');
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'Relay holds nothing');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _totalFee, 'Entrypoint fee unchanged by transact');

    _handler.handler_guided_transact({
      _actorSeed: 1,
      _inputSeed: 3,
      _newNoteAmountSeeds: [uint256(0), 0, 0, 0, 0],
      _recipientSeeds: [uint256(1), 1, 1, 0, 0],
      _inputCutoff: 3
    });

    assertEq(_handler.ghost_withdrawnSum(_token1()), _totalDeposit, 'Withdrawn sum after drain');
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained');
    assertEq(_handler.ghost_ragequitSum(_token1()), 0, 'Ragequit sum still 0');
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'Relay still 0');
    assertEq(_handler.ghost_depositSum(_token1()), _totalDeposit, 'Deposit sum unchanged');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _totalFee, 'Entrypoint fee unchanged');
  }

  /// @notice Single-note full-withdraw helper drains the only deposited note
  function test_singleNoteFullWithdrawHelper() external {
    uint128 _value = 1 ether;
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});

    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 1, _inputSeed: 0});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _value, 'Withdrawn sum');
  }

  /// @notice Helper picks an unspent note across two calls (skips already-spent first deposit)
  function test_singleNoteFullWithdrawSkipsSpent() external {
    uint128 _v0 = 1 ether;
    uint128 _v1 = 2 ether;
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v1, _assetSeed: 1});

    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 1, _inputSeed: 0});
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 1, _inputSeed: 0});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained after both calls');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _v0 + _v1, 'Both notes withdrawn');
  }

  /// @notice Ragequit succeeds even when contracts are paused
  function test_pauseThenRagequitSucceeds() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    _handler.handler_pause();

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Ragequit should succeed while paused');
  }

  /// @notice Unguided transact happy path: matching seeds → full withdrawal
  function test_unguidedTransact_happy() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});

    _handler.handler_unguided_transactSingleNote({
      _broadcasterSeed: 1,
      _spenderSeed: 1,
      _noteOwnerSeed: 1,
      _noteRecipientSeed: 1,
      _inputSeed: 0,
      _labelSeed: 0,
      _leftInNoteSeed: 0
    });

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _value, 'Withdrawn sum');
  }

  /// @notice Unguided transact catches NullifierAlreadySpent when input note already spent
  function test_unguidedTransact_alreadySpent() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 1, _inputSeed: 0});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained by guided withdraw');
    uint256 _withdrawnBefore = _handler.ghost_withdrawnSum(_token1());

    _handler.handler_unguided_transactSingleNote({
      _broadcasterSeed: 1,
      _spenderSeed: 1,
      _noteOwnerSeed: 1,
      _noteRecipientSeed: 1,
      _inputSeed: 0,
      _labelSeed: 0,
      _leftInNoteSeed: 0
    });

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault unchanged after spent re-attempt');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdrawnBefore, 'Withdrawn sum unchanged');
  }

  /// @notice Unguided transact catches EnforcedPause when vault is paused
  function test_unguidedTransact_paused() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    _handler.handler_pause();

    _handler.handler_unguided_transactSingleNote({
      _broadcasterSeed: 1,
      _spenderSeed: 1,
      _noteOwnerSeed: 1,
      _noteRecipientSeed: 1,
      _inputSeed: 0,
      _labelSeed: 0,
      _leftInNoteSeed: 0
    });

    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged while paused');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn while paused');
  }

  /// @notice Reproducer: output note from unguided transact must be stored under recipient (alice),
  ///         not noteOwner (bob). Before fix, _addNote used _noteOwnerSeed so bob received a note
  ///         with alice's credentials → handler_guided_ragequit(bob) would call
  ///         _buildAndGenerateRagequitProof(bob, alice_note), which fails because the circuit checks
  ///         Poseidon(bob.addr, alice.noteSecret) == note.noteAddressHash but the note was created as
  ///         Poseidon(alice.addr, alice.noteSecret) → mismatch → FFI revert.
  ///         After fix the note lives under alice, and alice can ragequit it correctly.
  // TODO (v2): add non-zero-change variant once internal-transfer handlers land —
  // then assert recipient can spend a value-bearing change note via transact, not just ragequit a zero-value one.
  function test_reproducer_unguidedTransactNoteStoredUnderRecipient() external {
    uint128 _value = 1 ether;

    // charlie(2) deposits for bob(1)
    _handler.handler_unguided_deposit({_broadcasterSeed: 2, _recipientSeed: 1, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    // bob(noteOwnerSeed=1) spends his note; full value routed internally to alice(recipientSeed=0)
    _handler.handler_unguided_transactSingleNote({
      _broadcasterSeed: 1,
      _spenderSeed: 1,
      _noteOwnerSeed: 1,
      _noteRecipientSeed: 0,
      _inputSeed: 0,
      _labelSeed: 0,
      _leftInNoteSeed: type(uint256).max
    });
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged on full internal transfer');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn');

    // alice(0) spends her newly received note via guided full-withdraw → drains vault under her credentials
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 0, _inputSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained by alice withdraw');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _value, 'Withdrawn sum equals deposit');
  }

  /// @notice Internal transfer: alice transfers full value to bob; bob can then ragequit it
  function test_internalTransfer_aliceToBob() external {
    uint128 _value = 1 ether;

    // alice(0) deposits her own note
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault balance after deposit');

    // alice transfers her note to bob(1)
    _handler.handler_guided_transactSingleNoteFullyInternal({_spenderSeed: 0, _recipientSeed: 1, _inputSeed: 0});

    // vault balance unchanged (no external withdraw)
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged on internal transfer');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn');
    assertEq(_handler.ghost_ragequitSum(_token1()), 0, 'Nothing ragequit yet');

    // bob now owns a note with the same value → ragequit drains the vault to bob
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained by recipient ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _value, 'Ragequit sum equals transferred value');
  }

  /// @notice Internal transfer to self: alice re-creates her own note; subsequent full withdraw works
  function test_internalTransfer_happy_aliceToSelf() external {
    uint128 _value = 1 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    // self transfer
    _handler.handler_guided_transactSingleNoteFullyInternal({_spenderSeed: 0, _recipientSeed: 0, _inputSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged on self transfer');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn on self transfer');

    // newly created note is at index 1 for alice → full withdrawal drains vault
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 0, _inputSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained after follow-up withdraw');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _value, 'Withdrawn sum equals original deposit');
  }

  /// @notice Guided transact with mixed recipients: change to alice, change to bob, plus external withdraw.
  ///         Verifies both alice's and bob's new notes are spendable afterwards.
  function test_guidedTransact_changeRecipientOther() external {
    uint128 _v0 = 1 ether; // fully withdrawn
    uint128 _v1 = 2 ether; // keep 1 ether as alice change
    uint128 _v2 = 3 ether; // keep 1 ether as bob change
    uint256 _keep1 = 1 ether;
    uint256 _keep2 = 1 ether;
    uint256 _withdraw = _v0 + (_v1 - _keep1) + (_v2 - _keep2);
    uint256 _totalDeposit = uint256(_v0) + _v1 + _v2;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _v1, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _v2, _assetSeed: 1});

    _handler.handler_guided_transact({
      _actorSeed: 0,
      _inputSeed: 0,
      _newNoteAmountSeeds: [uint256(0), _keep1, _keep2, 0, 0],
      // input0 change goes to alice (zero-value), input1 change to alice, input2 change to bob
      _recipientSeeds: [uint256(0), 0, 1, 0, 0],
      _inputCutoff: 3
    });

    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdraw, 'Withdrawn sum matches non-kept value');
    assertEq(_balanceOf(_token1(), address(_poolVault)), _totalDeposit - _withdraw, 'Vault holds kept value');

    // alice's _keep1-value note (index 4 in alice's storage; 0..2 are spent deposits, 3 is zero-value change)
    // bob's _keep2-value note (index 0 in bob's storage) — drain both via ragequit
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _keep1, 'Vault holds only alice change after bob ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _keep2, 'Ragequit sum tracks bob');

    _handler.handler_guided_ragequit({_actorSeed: 0, _noteSeed: 4});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained after alice ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _keep1 + _keep2, 'Ragequit sum tracks both');
  }

  /// @notice Internal-transfer helper skips already-spent notes
  function test_internalTransfer_skipsSpent() external {
    uint128 _v0 = 1 ether;
    uint128 _v1 = 2 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _v1, _assetSeed: 1});

    // Both transfers from alice → bob; second call must skip the first (now spent) note
    _handler.handler_guided_transactSingleNoteFullyInternal({_spenderSeed: 0, _recipientSeed: 1, _inputSeed: 0});
    assertEq(
      _balanceOf(_token1(), address(_poolVault)), uint256(_v0) + _v1, 'Vault balance unchanged after internal transfer'
    );
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn');

    _handler.handler_guided_transactSingleNoteFullyInternal({_spenderSeed: 0, _recipientSeed: 1, _inputSeed: 0});
    assertEq(
      _balanceOf(_token1(), address(_poolVault)), uint256(_v0) + _v1, 'Vault unchanged across two internal transfers'
    );
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn');

    // bob's two received notes drain the vault when ragequitted
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained by recipient ragequits');
    assertEq(_handler.ghost_ragequitSum(_token1()), uint256(_v0) + _v1, 'Ragequit sum equals transferred sum');
  }

  /// @notice Unguided transact catches FFI proof failure on label mismatch (zero-value input)
  function test_unguidedTransact_labelMismatchZeroValue() external {
    uint128 _v0 = 1 ether;
    uint128 _v1 = 2 ether;

    // alice note[0] labelA
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v0, _assetSeed: 1});
    // alice note[1] labelB
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v1, _assetSeed: 1});

    // Drain note[0] → alice note[2] = 0-value, labelA
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 1, _inputSeed: 0});

    uint256 _sizeBefore = _handler.ghost_stateTreeSize();
    // Input = note[2] (labelA, value 0). Supplied label sourced from note[1] (labelB).
    _handler.handler_unguided_transactSingleNote({
      _broadcasterSeed: 1,
      _spenderSeed: 1,
      _noteOwnerSeed: 1,
      _noteRecipientSeed: 1,
      _inputSeed: 2,
      _labelSeed: 1,
      _leftInNoteSeed: 0
    });

    assertEq(_sizeBefore, _handler.ghost_stateTreeSize(), 'transact skipped due to proof generation reverting');
  }

  /// @notice Partial transfer helper: alice keeps 0.25 ether as bob-owned note, withdraws 0.75 ether
  function test_singleNotePartialTransfer() external {
    uint128 _value = 1 ether;
    uint256 _keep = 0.25 ether;
    uint256 _withdraw = uint256(_value) - _keep;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    _handler.handler_guided_transferSingleNote({_spenderSeed: 0, _recipientSeed: 1, _inputSeed: 0, _amountSeed: _keep});

    assertEq(_balanceOf(_token1(), address(_poolVault)), _keep, 'Vault holds bob change after partial transfer');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdraw, 'Withdrawn sum equals non-kept value');

    // bob ragequits the 0.25 ether change note → vault drains
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained after bob ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _keep, 'Ragequit sum equals kept value');
  }

  /// @notice Split: one input note → two same-label outputs. Both outputs are spendable.
  function test_split_singleInputTwoSameLabelOutputs() external {
    uint128 _value = 1 ether;
    uint256 _firstOut = 0.3 ether;
    uint256 _secondOut = 0.5 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    // Split alice's note[0] into 2 same-label outputs
    _handler.handler_guided_split({
      _spenderSeed: 0,
      _inputSeed: 0,
      _outputAmountSeeds: [_firstOut, _secondOut, 0, 0, 0],
      _recipientSeeds: [uint256(0), 1, 2, 0, 0],
      _outputCount: 3
    });

    // Vault unchanged (zero external withdrawal)
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged on split');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn on split');

    // withdraw every position separately
    _handler.handler_guided_ragequit({_actorSeed: 0, _noteSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value - _firstOut);
    assertEq(_handler.ghost_ragequitSum(_token1()), _firstOut);

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value - _firstOut - _secondOut);
    assertEq(_handler.ghost_ragequitSum(_token1()), _firstOut + _secondOut);

    _handler.handler_guided_ragequit({_actorSeed: 2, _noteSeed: 0});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0);
    assertEq(_handler.ghost_ragequitSum(_token1()), _value);
  }

  /// @notice Merge: split into two same-label notes on one actor, then N×1 transact into one note.
  function test_mergeSameLabel_afterSplit() external {
    uint128 _value = 1 ether;
    uint256 _firstOut = 0.4 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    _handler.handler_guided_split({
      _spenderSeed: 0,
      _inputSeed: 0,
      _outputAmountSeeds: [_firstOut, 0, 0, 0, 0],
      _recipientSeeds: [uint256(0), 0, 0, 0, 0],
      _outputCount: 2
    });

    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged after split');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn after split');

    _handler.handler_guided_mergeSameLabel({
      _spenderSeed: 0, _labelSeed: 0, _inputSeed: 0, _recipientSeed: 0, _inputCountSeed: 2
    });

    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault unchanged after merge');
    assertEq(_handler.ghost_withdrawnSum(_token1()), 0, 'Nothing withdrawn after merge');

    // Only the merged note remains unspent on alice (index 3 after deposit + split + merge)
    _handler.handler_guided_ragequit({_actorSeed: 0, _noteSeed: 3});
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'Vault drained after ragequit merged note');
    assertEq(_handler.ghost_ragequitSum(_token1()), _value, 'Full value ragequit after merge');
  }

  /// @notice Known-good: deposits accumulate fees on the Entrypoint, sweeps drain them to registered actors
  function test_depositsThenSweepsToDifferentActors() external {
    uint128 _value1 = 1 ether;
    uint128 _value2 = 3 ether;
    uint256 _fee1 = _calcFee(_value1);
    uint256 _fee2 = _calcFee(_value2);

    address _bob = _handler.actors(1);
    address _charlie = _handler.actors(2);
    uint256 _bobOpening = _balanceOf(_token1(), _bob);
    uint256 _charlieOpening = _balanceOf(_token1(), _charlie);

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value1, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _fee1, 'Entrypoint holds first fee pre-sweep');
    assertEq(_handler.ghost_feeSwept(_token1()), 0, 'ghost_feeSwept is zero before any sweep');

    _handler.handler_unguided_sweep({_recipientSeed: 1, _assetSeed: 1}); // → bob
    assertEq(_balanceOf(_token1(), address(_entrypoint)), 0, 'Entrypoint drained after first sweep');
    assertEq(_balanceOf(_token1(), _bob) - _bobOpening, _fee1, 'Bob credited first fee');

    _handler.handler_guided_deposit({_broadcasterSeed: 1, _recipientSeed: 1, _value: _value2, _assetSeed: 1});
    _handler.handler_unguided_sweep({_recipientSeed: 2, _assetSeed: 1}); // → charlie
    assertEq(_balanceOf(_token1(), _charlie) - _charlieOpening, _fee2, 'Charlie credited second fee');

    // Per-actor ghost mapping stays partitioned across recipients
    assertEq(_handler.ghost_sweptTo(_token1(), _bob), _fee1, 'ghost_sweptTo[bob] holds first sweep only');
    assertEq(_handler.ghost_sweptTo(_token1(), _charlie), _fee2, 'ghost_sweptTo[charlie] holds second sweep only');
    assertEq(_handler.ghost_feeSwept(_token1()), _fee1 + _fee2, 'ghost_feeSwept totals both sweeps');

    // Entrypoint balance reconciles with cumulative fees minus what's been swept out.
    assertEq(
      _balanceOf(_token1(), address(_entrypoint)),
      _handler.ghost_feeSum(_token1()) - _handler.ghost_feeSwept(_token1()),
      'Entrypoint balance != ghost_feeSum - ghost_feeSwept'
    );

    // sum(ghost_sweptTo over _actors) == ghost_feeSwept
    uint256 _sumSwept;
    for (uint256 _i; _i < _handler.actorsLength(); ++_i) {
      _sumSwept += _handler.ghost_sweptTo(_token1(), _handler.actors(_i));
    }
    assertEq(_sumSwept, _handler.ghost_feeSwept(_token1()), 'sum(ghost_sweptTo) == ghost_feeSwept');
  }

  /// @notice PP2-1 normal wind-down: not paused → every unspent note fully transacted out → entrypoint
  ///         fees swept → all three protocol contracts hold zero of TOKEN1.
  function test_normalWindDown() external {
    uint128 _v0 = 2 ether;
    uint128 _v1 = 3 ether;
    uint256 _expectedFees = _calcFee(_v0) + _calcFee(_v1);

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v1, _assetSeed: 1});

    // Drain both notes in a single multi-input transact with all-zero outputs (full withdrawal).
    _handler.handler_guided_transact({
      _actorSeed: 1,
      _inputSeed: 0,
      _newNoteAmountSeeds: [uint256(0), 0, 0, 0, 0],
      _recipientSeeds: [uint256(1), 1, 0, 0, 0],
      _inputCutoff: 2
    });

    assertFalse(_poolVault.paused(), 'PP2-1 precondition: contracts not paused');
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'PP2-1 precondition: every unspent note transacted out');
    assertEq(_handler.ghost_withdrawnSum(_token1()), _v0 + _v1, 'PP2-1: full deposited value withdrawn');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), _expectedFees, 'Entrypoint still holds fees pre-sweep');

    _handler.handler_unguided_sweep({_recipientSeed: 1, _assetSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'PP2-1: PoolVault holds nothing');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), 0, 'PP2-1: Entrypoint holds nothing');
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'PP2-1: Relay holds nothing');
  }

  /// @notice PP2-2 paused wind-down: paused → every unspent note ragequit → entrypoint fees swept →
  ///         all three protocol contracts hold zero of TOKEN1.
  function test_pausedWindDown() external {
    uint128 _v0 = 2 ether;
    uint128 _v1 = 3 ether;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v0, _assetSeed: 1});
    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _v1, _assetSeed: 1});

    _handler.handler_pause();
    assertTrue(_poolVault.paused(), 'PP2-2 precondition: contracts paused');

    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'PP2-2 precondition: every unspent note ragequit');
    assertEq(_handler.ghost_ragequitSum(_token1()), _v0 + _v1, 'PP2-2: full deposited value ragequit');

    _handler.handler_unguided_sweep({_recipientSeed: 1, _assetSeed: 1});

    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'PP2-2: PoolVault holds nothing');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), 0, 'PP2-2: Entrypoint holds nothing');
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'PP2-2: Relay holds nothing');
  }

  /// @notice Relay fee conservation: deposit then withdraw via relay; recipient gets
  ///         `withdrawValue - feeAmount`, feeRecipient gets `feeAmount`, relay ends at zero.
  ///          also NativeGas tracking.
  function test_relayFeeConservation() external {
    uint128 _value = 5 ether;
    uint256 _withdrawValue = 2 ether;
    uint256 _feeAmount = 0.005 ether; // below MAX_RELAY_FEE (0.01 ether)
    // Seed picked so (a) `_nativeGasSeed % 2 != 0` (escapes the zero branch in the handler) and
    // (b) it already lies in `[1, 0.1 ether]`, so `bound` returns it verbatim.
    uint256 _nativeGasSeed = 12_345_679;
    uint256 _expectedNativeGas = _nativeGasSeed; // ≈ 12.3 µether

    address _alice = _handler.actors(0);
    address _bob = _handler.actors(1);
    address _charlie = _handler.actors(2);
    uint256 _bobOpening = _balanceOf(_token1(), _bob);
    uint256 _charlieOpening = _balanceOf(_token1(), _charlie);
    uint256 _aliceEthOpening = _alice.balance;
    uint256 _bobEthOpening = _bob.balance;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value, 'Vault holds deposit');

    // alice owns note[0]; bob broadcasts the relay (and seeds nativeGas via vm.deal); charlie is
    // the fee recipient (non-zero ⇒ no address(0) fallback).
    _handler.handler_guided_relaySingleNote({
      _noteOwnerSeed: 0, // alice spends her note
      _inputSeed: 0,
      _broadcasterSeed: 1, // bob pays gas
      _recipientSeed: 0, // alice receives the ERC-20 net amount AND the ETH gas-forward
      _feeRecipientSeed: 2, // charlie receives the relay fee (non-zero ⇒ no fallback)
      _withdrawValueSeed: _withdrawValue,
      _feeAmountSeed: _feeAmount,
      _nativeGasSeed: _nativeGasSeed
    });

    // PoolVault drops by the full withdrawValue (the relay siphons it through `transact`).
    assertEq(_balanceOf(_token1(), address(_poolVault)), _value - _withdrawValue, 'Vault drops by withdrawValue');
    // Relay always ends at zero — both ERC-20 protocol payout and ETH gas-forward flow through.
    assertEq(_balanceOf(_token1(), address(_privacyPoolRelay)), 0, 'Relay holds no ERC-20 post-relay');
    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay holds no ETH post-relay');

    // PP2-17: recipient + feeRecipient deltas equal amountOut in the withdrawal asset.
    assertEq(_balanceOf(_token1(), _alice), _withdrawValue - _feeAmount, 'Recipient (alice) credited net ERC-20');
    assertEq(_balanceOf(_token1(), _charlie) - _charlieOpening, _feeAmount, 'Fee recipient (charlie) credited fee');
    assertEq(_balanceOf(_token1(), _bob), _bobOpening, 'Broadcaster (bob) gets no ERC-20 (gas-only role)');

    // ETH side-channel: relay forwards `msg.value` to recipient as a separate transfer.
    assertEq(_alice.balance - _aliceEthOpening, _expectedNativeGas, 'Alice gains nativeGas in ETH (ERC-20 path)');
    assertEq(_bob.balance, _bobEthOpening, 'Broadcaster ETH unchanged (deal-up cancels msg.value)');

    // Ghost accounting: per-asset relay maps + the NativeGas
    assertEq(_handler.ghost_withdrawnSum(_token1()), _withdrawValue, 'ghost_withdrawnSum tracks relay withdrawal');
    assertEq(
      _handler.ghost_relayedRecipientTo(_token1(), _alice),
      _withdrawValue - _feeAmount,
      'ghost_relayedRecipientTo[alice]'
    );
    assertEq(_handler.ghost_relayedFeeTo(_token1(), _charlie), _feeAmount, 'ghost_relayedFeeTo[charlie]');
    assertEq(_handler.ghost_relayedNativeGasTo(_alice), _expectedNativeGas, 'ghost_relayedNativeGasTo[alice]');
    assertEq(_handler.ghost_relayedNativeGasTo(_bob), 0, 'broadcaster is not credited as gas-recipient');
    assertEq(_handler.ghost_relayedNativeGasTo(_charlie), 0, 'feeRecipient is not credited as gas-recipient');
    // nativeGas pass-through is NOT a protocol drain — must never enter ghost_withdrawnSum[NATIVE].
    assertEq(
      _handler.ghost_withdrawnSum(ProtocolConstants.NATIVE_ASSET), 0, 'nativeGas must NOT enter ghost_withdrawnSum'
    );
  }

  /// @notice fee-recipient fallback: when `feeRecipient == address(0)`, the protocol routes
  ///         the fee to `msg.sender` (the relayer). Verifies the broadcaster IS credited the fee
  ///         in this branch and that ghost accounting attributes it to the effective recipient.
  function test_relayFeeRecipientFallback() external {
    uint128 _value = 4 ether;
    uint256 _withdrawValue = 1 ether;
    uint256 _feeAmount = 0.003 ether;

    address _alice = _handler.actors(0);
    address _bob = _handler.actors(1);
    uint256 _bobOpening = _balanceOf(_token1(), _bob);

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 1});

    // _feeRecipientSeed % 4 == 0 ⇒ handler picks address(0); protocol falls back to msg.sender (bob).
    _handler.handler_guided_relaySingleNote({
      _noteOwnerSeed: 0,
      _inputSeed: 0,
      _broadcasterSeed: 1, // bob = relayer = effective feeRecipient
      _recipientSeed: 0, // alice
      _feeRecipientSeed: 0, // % 4 == 0 ⇒ address(0)
      _withdrawValueSeed: _withdrawValue,
      _feeAmountSeed: _feeAmount,
      _nativeGasSeed: 0
    });

    assertEq(_balanceOf(_token1(), _alice), _withdrawValue - _feeAmount, 'Alice credited net amount');
    assertEq(_balanceOf(_token1(), _bob) - _bobOpening, _feeAmount, 'Bob (relayer) credited the relay fee via fallback');
    assertEq(
      _handler.ghost_relayedFeeTo(_token1(), _bob),
      _feeAmount,
      'ghost_relayedFeeTo points at effective feeRecipient (bob)'
    );
  }

  /*///////////////////////////////////////////////////////////////
                            NATIVE-ASSET (ETH)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Smoke test for the NATIVE_ASSET branch of the integration deposit helper
  function test_eth_depositThenWithdraw() external {
    uint128 _value = 2 ether;
    address _eth = ProtocolConstants.NATIVE_ASSET;
    address _alice = _handler.actors(0);
    uint256 _aliceOpening = _alice.balance;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 0, _value: _value, _assetSeed: 0});
    _handler.handler_guided_transactSingleNoteFullWithdraw({_spenderSeed: 0, _inputSeed: 0});

    assertEq(address(_poolVault).balance, 0, 'Vault drained');
    assertEq(_alice.balance - _aliceOpening, _value, 'Alice credited withdraw in ETH');
    assertEq(_handler.ghost_withdrawnSum(_eth), _value, 'ghost_withdrawnSum[NATIVE]');
    assertEq(_handler.ghost_withdrawnTo(_eth, _alice), _value, 'ghost_withdrawnTo[NATIVE][alice]');
  }

  /// @notice Cross-asset isolation: a successful ETH deposit + ragequit MUST NOT touch any
  ///         ERC-20 ghost or balance. Catches accidental dead-guard / cross-asset accounting bugs.
  function test_eth_doesNotAffectErc20Accounting() external {
    uint128 _value = 1 ether;
    address _eth = ProtocolConstants.NATIVE_ASSET;

    _handler.handler_guided_deposit({_broadcasterSeed: 0, _recipientSeed: 1, _value: _value, _assetSeed: 0});
    _handler.handler_guided_ragequit({_actorSeed: 1, _noteSeed: 0});

    // ETH side moved.
    assertEq(_handler.ghost_depositSum(_eth), _value, 'ETH deposit recorded');
    assertEq(_handler.ghost_ragequitSum(_eth), _value, 'ETH ragequit recorded');

    // ERC-20 side untouched.
    assertEq(_handler.ghost_depositSum(_token1()), 0, 'ERC-20 ghost depositSum unchanged');
    assertEq(_handler.ghost_ragequitSum(_token1()), 0, 'ERC-20 ghost ragequitSum unchanged');
    assertEq(_handler.ghost_feeSum(_token1()), 0, 'ERC-20 ghost feeSum unchanged');
    assertEq(_balanceOf(_token1(), address(_poolVault)), 0, 'PoolVault ERC-20 balance unchanged');
    assertEq(_balanceOf(_token1(), address(_entrypoint)), 0, 'Entrypoint ERC-20 balance unchanged');
  }
}
