// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {HandlerTransact} from './HandlerTransact.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {PoseidonT4} from 'poseidon-solidity/PoseidonT4.sol';
import {Note, NoteCreationParams} from 'test/handlers/HandlerBase.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants as ProtocolConstants} from 'utils/Constants.sol';

/// @title HandlerRelay
/// @notice Fuzz handlers that route withdrawals through `PrivacyPoolRelay.relay()`. The relay
///         performs a `PoolVault.transact`, receives the proof's `amountOut`, then splits it
///         between the routed `recipient` and the `feeRecipient` (which falls back to msg.sender
///         when zero). Covers PP2-17 fee conservation on-handler.
abstract contract HandlerRelay is HandlerTransact {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  /// @dev Max items per fuzzed `relayBatch`. Kept <= the relay's `_MAX_BATCH` (10) and strictly below the
  ///      pool's `rootHistorySize` (16 in Setup) so every item anchors to the shared pre-batch state root.
  uint256 internal constant RELAY_BATCH_CAP = 4;

  /// @dev Scratch storage for the current `registerAndRelay` fresh account. `receiveNote`/`newSecrets` and
  ///      `_deposit` mutate the identity, so it must live in storage (libraries write through `self`).
  UserIdentityLib.UserIdentity internal _relayFreshAccount;

  /// @dev Guards fresh-account reuse across fuzz calls: once registered, an account can't register again.
  mapping(address _account => bool _used) internal _relayFreshAccountUsed;

  /// @dev Carries resolved routing/amounts between the two halves of the registerAndRelay handler,
  ///      keeping either half's local stack shallow (avoids stack-too-deep under via-IR).
  struct RegisterRelayCtx {
    address broadcaster;
    address recipient;
    address feeRecipient;
    address effectiveFeeRecipient;
    address asset;
    uint256 withdraw;
    uint256 fee;
  }

  /*///////////////////////////////////////////////////////////////
                    GHOST VIOLATION FLAGS + COVERAGE
  ///////////////////////////////////////////////////////////////*/

  /// @dev The invariant profiles set `fail_on_revert = false`, which also SWALLOWS on-handler
  ///      `assert*` failures (a reverting handler is merely counted, the campaign stays green). So the
  ///      critical relay postconditions below cannot live in on-handler asserts — they are recorded as
  ///      sticky violation flags (plain storage writes survive the swallow) and asserted false by the
  ///      GLOBAL `invariant_relay*Consistent` functions, which DO fail the run. Each flag is only ever
  ///      set true, so a single violating (committed) handler call trips the matching invariant.

  /// @notice Set when a relay payout split (recipient / feeRecipient deltas) did not reconcile (PP2-17).
  bool public ghost_relaySplitViolated;

  /// @notice Set when the on-chain state root diverged from the mirror after a relay path.
  bool public ghost_relayStateRootViolated;

  /// @notice Set when `registerAndRelay` failed to register the fresh account's nullifying key on-chain.
  bool public ghost_registerKeystoreViolated;

  /// @notice Times `PrivacyPoolRelay.relayBatch` returned successfully (coverage floor; asserted > 0 in
  ///         `afterInvariant`). Incremented only after the external call returns, so a call that later
  ///         reverts (and is rolled back) does not count.
  uint256 public ghost_relayBatchOk;

  /// @notice Times `PrivacyPoolRelay.registerAndRelay` returned successfully (coverage floor).
  uint256 public ghost_registerAndRelayOk;

  /*///////////////////////////////////////////////////////////////
                        GUIDED HANDLERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Single-note withdrawal routed through `PrivacyPoolRelay`
  function handler_guided_relaySingleNote(
    uint256 _noteOwnerSeed,
    uint256 _inputSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed,
    uint256 _nativeGasSeed
  ) public {
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);

    UserIdentityLib.UserIdentity storage _spender = _getActor(_noteOwnerSeed);
    Note memory _note = _getNote(_noteOwnerSeed, _inputSeed);
    vm.assume(!_spentNotes[_note.outputCommitment]);
    vm.assume(_note.value > 0);

    address _broadcaster = _getActor(_broadcasterSeed).addr;
    address _recipient = _getActor(_recipientSeed).addr;

    // 1/4 chance of `address(0)` ⇒ the protocol falls back to msg.sender (PrivacyPoolRelay.sol:69).
    address _feeRecipient = _feeRecipientSeed % 4 == 0 ? address(0) : _getActor(_feeRecipientSeed).addr;
    address _effectiveFeeRecipient = _feeRecipient == address(0) ? _broadcaster : _feeRecipient;

    uint256 _withdrawValue = bound(_withdrawValueSeed, 1, _note.value);
    uint256 _feeCap = _withdrawValue < MAX_RELAY_FEE ? _withdrawValue : MAX_RELAY_FEE;
    uint256 _feeAmount = bound(_feeAmountSeed, 0, _feeCap);
    uint256 _recipientAmount = _withdrawValue - _feeAmount;

    // 50/50 split:
    // 50% no nativeGas forwarding
    // 50% [1, 0.1 ether] nativeGas forwarding
    uint256 _nativeGas = _nativeGasSeed % 2 == 0 ? 0 : bound(_nativeGasSeed, 1, 0.1 ether);

    IPoolVault.TransactParams memory _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: _nativeGas
        })
      )
    });
    Note[] memory _inputs = new Note[](1);
    _inputs[0] = _note;
    NoteCreationParams[] memory _noteCreationParams = new NoteCreationParams[](1);
    _noteCreationParams[0] = _spender.receiveNote(_note.value - _withdrawValue, _note.inputLabel);
    _assertTransactValueConserved(_inputs, _noteCreationParams, _withdrawValue);

    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    uint256 _sizeBefore = _stateTreeMirror.size;
    address _asset = _assetOf(_note);
    uint256 _recipientBefore = _balanceOf(_asset, _recipient);
    uint256 _feeRecipientBefore = _balanceOf(_asset, _effectiveFeeRecipient);

    (Note[] memory _newNotes,) = _submitRelay({
      _broadcaster: _broadcaster,
      _proof: _buildTransactProof({
        _notes: _inputs,
        _spender: _spender,
        _noteCreationParams: _noteCreationParams,
        _amountOut: _withdrawValue,
        _context: _hashTransactContext(_params, _payload)
      }),
      _noteCreationParams: _noteCreationParams,
      _tokenId: _note.tokenId,
      _params: _params,
      _payload: _payload,
      _nativeGas: _nativeGas
    });

    _markSpent(_note);
    _addNoteForAddress(_spender.addr, _newNotes[0]);
    _recordTransactLabelWithdrawals(_inputs, _noteCreationParams);

    ghost_withdrawnSum[_asset] += _withdrawValue;
    ghost_relayedRecipientTo[_asset][_recipient] += _recipientAmount;
    ghost_relayedFeeTo[_asset][_effectiveFeeRecipient] += _feeAmount;
    ghost_relayedNativeGasTo[_recipient] += _nativeGas;
    ghost_transactLeafInserts += 2; // N+M = 1 input nullifier + 1 change-note commitment

    // ── PP2-9: on-handler check ──
    assertEq(_stateTreeMirror.size - _sizeBefore, 2, 'PP2-9: relay must insert exactly N+M leaves');

    // ── PP2-17: on-handler check ──
    _assertRelaySplit(
      _asset,
      _recipient,
      _effectiveFeeRecipient,
      _recipientBefore,
      _feeRecipientBefore,
      _withdrawValue,
      _feeAmount,
      _asset == ProtocolConstants.NATIVE_ASSET ? _nativeGas : 0
    );
  }

  /// @dev Batched withdrawal: N (2..RELAY_BATCH_CAP) single-note transacts sharing ONE recipient, asset
  ///      and feeRecipient, submitted through `PrivacyPoolRelay.relayBatch`. Every item spends a distinct
  ///      unspent note of `_spender` with the same tokenId; the aggregate payout/fee/gas fold into the same
  ///      ghost variables the single-note path uses, so PP2-5/PP2-11/PP2-17 apply to the batch path too.
  /// @dev The asset is fixed up front; the batch prefers organic unspent notes and self-seeds any shortfall
  ///      with fresh deposits to `_spender`, so `relayBatch` is exercised even at shallow fuzz depth (where an
  ///      actor rarely already holds >=2 same-asset notes). All deposits happen before any proof is built, so
  ///      every item anchors to the same post-deposit / pre-batch state root.
  function handler_guided_relayBatch(
    uint256 _spenderSeed,
    uint256 _inputSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _countSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed,
    uint256 _nativeGasSeed
  ) public {
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);

    UserIdentityLib.UserIdentity storage _spender = _getActor(_spenderSeed);
    uint256 _count = bound(_countSeed, 2, RELAY_BATCH_CAP);
    address _asset = _pickAsset(uint256(keccak256(abi.encode(_spenderSeed, _inputSeed, 'batchAsset'))));
    uint256 _tokenId = uint256(uint160(_asset));

    // Gather up to `_count` organic unspent notes of this asset (value > 0), then self-seed the shortfall
    // with fresh deposits to `_spender` so the batch always has exactly `_count` distinct spendable notes.
    Note[] memory _buf = new Note[](_count);
    uint256 _have;
    uint256 _consumed;
    while (_have < _count) {
      (bool _ok, Note memory _note, uint256 _newConsumed) =
        _findNextUnspentNote(_spenderSeed, _inputSeed, _consumed, _tokenId, true);
      if (!_ok) break;
      _consumed = _newConsumed;
      if (_note.value == 0) continue;
      _buf[_have++] = _note;
    }
    for (; _have < _count; ++_have) {
      uint256 _dv = bound(uint256(keccak256(abi.encode(_countSeed, _have, 'batchSeed'))), MIN_AMOUNT, type(uint128).max);
      Note memory _dep = _deposit(_getActor(_broadcasterSeed), _spender, _asset, _dv);
      _addNoteForAddress(_spender.addr, _dep);
      ghost_depositCount++;
      ghost_depositSum[_asset] += _dv;
      ghost_feeSum[_asset] += _calcFee(_dv);
      _labelBalance(_dep.inputLabel).deposited += _dv;
      _buf[_have] = _dep;
    }

    address _broadcaster = _getActor(_broadcasterSeed).addr;
    address _recipient = _getActor(_recipientSeed).addr;
    // 1/4 chance of `address(0)` => the protocol falls back to msg.sender (PrivacyPoolRelay.sol:145).
    address _feeRecipient = _feeRecipientSeed % 4 == 0 ? address(0) : _getActor(_feeRecipientSeed).addr;
    address _effectiveFeeRecipient = _feeRecipient == address(0) ? _broadcaster : _feeRecipient;

    // Build one single-note transact proof per item, all anchored to the shared pre-batch state root
    // (nothing is submitted until every proof is built, so the on-chain root is constant here).
    ProofLibV2.TransactProof[] memory _proofs = new ProofLibV2.TransactProof[](_count);
    IPoolVault.TransactParams[] memory _params = new IPoolVault.TransactParams[](_count);
    IPoolVault.NoteData[][] memory _payloads = new IPoolVault.NoteData[][](_count);
    NoteCreationParams[][] memory _changeParams = new NoteCreationParams[][](_count);
    uint256 _totalAmountOut;
    uint256 _totalFee;
    uint256 _totalNativeGas;

    for (uint256 _i; _i < _count; ++_i) {
      uint256 _withdraw = bound(uint256(keccak256(abi.encode(_withdrawValueSeed, _i))), 1, _buf[_i].value);
      uint256 _feeCap = _withdraw < MAX_RELAY_FEE ? _withdraw : MAX_RELAY_FEE;
      uint256 _fee = bound(uint256(keccak256(abi.encode(_feeAmountSeed, _i))), 0, _feeCap);
      uint256 _gas =
        _nativeGasSeed % 2 == 0 ? 0 : bound(uint256(keccak256(abi.encode(_nativeGasSeed, _i))), 1, MAX_RELAY_FEE);

      Note[] memory _inputs = new Note[](1);
      _inputs[0] = _buf[_i];
      NoteCreationParams[] memory _ncp = new NoteCreationParams[](1);
      _ncp[0] = _spender.receiveNote(_buf[_i].value - _withdraw, _buf[_i].inputLabel);
      _assertTransactValueConserved(_inputs, _ncp, _withdraw);

      IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
      IPoolVault.TransactParams memory _param = IPoolVault.TransactParams({
        processor: address(_privacyPoolRelay),
        data: abi.encode(
          IPrivacyPoolRelay.PayoutRouting({
            recipient: _recipient, feeRecipient: _feeRecipient, feeAmount: _fee, nativeGas: _gas
          })
        )
      });

      _proofs[_i] = _buildTransactProof({
        _notes: _inputs,
        _spender: _spender,
        _noteCreationParams: _ncp,
        _amountOut: _withdraw,
        _context: _hashTransactContext(_param, _payload)
      });
      _params[_i] = _param;
      _payloads[_i] = _payload;
      _changeParams[_i] = _ncp;
      _totalAmountOut += _withdraw;
      _totalFee += _fee;
      _totalNativeGas += _gas;
    }

    uint256 _sizeBefore = _stateTreeMirror.size;
    uint256 _recipientBefore = _balanceOf(_asset, _recipient);
    uint256 _feeRecipientBefore = _balanceOf(_asset, _effectiveFeeRecipient);

    if (_totalNativeGas > 0) vm.deal(_broadcaster, _broadcaster.balance + _totalNativeGas);
    vm.prank(_broadcaster);
    _privacyPoolRelay.relayBatch{value: _totalNativeGas}(_proofs, _params, _payloads);
    ghost_relayBatchOk++; // coverage floor: relayBatch actually executed (see afterInvariant)

    // Mirror each item's leaves in submit order (pool processes items sequentially) and update ghosts.
    for (uint256 _i; _i < _count; ++_i) {
      Note[] memory _newNotes = _mirrorRelayOutputs(_proofs[_i], _changeParams[_i], _buf[_i].tokenId);
      _markSpent(_buf[_i]);
      _addNoteForAddress(_spender.addr, _newNotes[0]);
      Note[] memory _inputs = new Note[](1);
      _inputs[0] = _buf[_i];
      _recordTransactLabelWithdrawals(_inputs, _changeParams[_i]);
    }

    ghost_withdrawnSum[_asset] += _totalAmountOut;
    ghost_relayedRecipientTo[_asset][_recipient] += _totalAmountOut - _totalFee;
    ghost_relayedFeeTo[_asset][_effectiveFeeRecipient] += _totalFee;
    ghost_relayedNativeGasTo[_recipient] += _totalNativeGas;
    ghost_transactLeafInserts += 2 * _count; // each item inserts N+M = 1 nullifier + 1 change note

    // ── PP2-9: on-handler check ──
    assertEq(_stateTreeMirror.size - _sizeBefore, 2 * _count, 'PP2-9: relayBatch must insert exactly sum(N+M) leaves');
    // Sticky flag (not assert): swallowed under fail_on_revert=false. See invariant_relayStateRootConsistent.
    if (_poolVault.roots(_poolVault.currentRootIndex()) != _stateTreeMirror.root()) {
      ghost_relayStateRootViolated = true;
    }

    // ── PP2-17: on-handler check (aggregate split) ──
    _assertRelaySplit(
      _asset,
      _recipient,
      _effectiveFeeRecipient,
      _recipientBefore,
      _feeRecipientBefore,
      _totalAmountOut,
      _totalFee,
      _asset == ProtocolConstants.NATIVE_ASSET ? _totalNativeGas : 0
    );
  }

  /// @dev Atomic register-then-withdraw: a fresh signable account is funded by a self-deposit, authorizes
  ///      its keystore registration via an EIP-712 `SetAuthPolicy` signature (WITH deadline), and withdraws
  ///      through `PrivacyPoolRelay.registerAndRelay`. The transact proof anchors to the PREDICTED
  ///      post-registration keystore root (mirror insert before proving; the on-chain insert happens inside
  ///      `registerAndRelay`), matching `RegisterAndRelay.t.sol`.
  function handler_guided_registerAndRelay(
    uint256 _freshSeed,
    uint256 _broadcasterSeed,
    uint256 _recipientSeed,
    uint256 _feeRecipientSeed,
    uint256 _assetSeed,
    uint256 _depositValueSeed,
    uint256 _withdrawValueSeed,
    uint256 _feeAmountSeed
  ) public {
    vm.assume(!_poolVault.paused());
    vm.warp(block.timestamp + 1);

    UserIdentityLib.UserIdentity storage _fresh = _newFreshAccount(_freshSeed);
    vm.assume(_keystore.nullifyingKeys(_fresh.addr) == 0);

    RegisterRelayCtx memory _ctx;
    _ctx.asset = _pickAsset(_assetSeed);
    _ctx.broadcaster = _getActor(_broadcasterSeed).addr;
    _ctx.recipient = _getActor(_recipientSeed).addr;
    _ctx.feeRecipient = _feeRecipientSeed % 4 == 0 ? address(0) : _getActor(_feeRecipientSeed).addr;
    _ctx.effectiveFeeRecipient = _ctx.feeRecipient == address(0) ? _ctx.broadcaster : _ctx.feeRecipient;

    uint256 _depositValue = bound(_depositValueSeed, MIN_AMOUNT, type(uint128).max);
    _ctx.withdraw = bound(_withdrawValueSeed, 1, _depositValue);
    _ctx.fee = bound(_feeAmountSeed, 0, _ctx.withdraw < MAX_RELAY_FEE ? _ctx.withdraw : MAX_RELAY_FEE);

    // 1. Self-fund: deposit a note the fresh account owns (deposits skip the keystore).
    Note memory _note = _deposit(_getActor(_broadcasterSeed), _fresh, _ctx.asset, _depositValue);
    _addNoteForAddress(_fresh.addr, _note);
    ghost_depositCount++;
    ghost_depositSum[_ctx.asset] += _depositValue;
    ghost_feeSum[_ctx.asset] += _calcFee(_depositValue);
    // Same as invariant HandlerDeposit._recordDepositLabel (not in this branch of the inheritance tree).
    _labelBalance(_note.inputLabel).deposited += _depositValue;

    vm.warp(block.timestamp + 1);
    _submitRegisterAndRelay(_fresh, _note, _depositValue, _ctx);
  }

  /// @dev Second half of `handler_guided_registerAndRelay`: predicts the post-registration keystore root,
  ///      builds+signs the proof, submits `registerAndRelay`, and folds the withdrawal into the shared relay
  ///      ghosts. Split out purely to keep either half's stack shallow (via-IR stack-too-deep).
  function _submitRegisterAndRelay(
    UserIdentityLib.UserIdentity storage _fresh,
    Note memory _note,
    uint256 _depositValue,
    RegisterRelayCtx memory _ctx
  ) internal {
    // Predict the post-registration keystore root: mirror the account's leaf now; the matching on-chain
    // insert happens inside `registerAndRelay`, so the proof's keystoreRoot becomes current before transact.
    _keystoreTreeMirror.insert(PoseidonT4.hash([_fresh.ownerAddress, _fresh.nullifyingKeyHash, _fresh.authDigest]));
    _fresh.keystoreIndex = _keystoreTreeMirror.size - 1;

    Note[] memory _inputs = new Note[](1);
    _inputs[0] = _note;
    NoteCreationParams[] memory _ncp = new NoteCreationParams[](1);
    _ncp[0] = _fresh.receiveNote(_depositValue - _ctx.withdraw, _note.inputLabel);
    _assertTransactValueConserved(_inputs, _ncp, _ctx.withdraw);

    IPoolVault.NoteData[] memory _payload = new IPoolVault.NoteData[](1);
    IPoolVault.TransactParams memory _param = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _ctx.recipient, feeRecipient: _ctx.feeRecipient, feeAmount: _ctx.fee, nativeGas: 0
        })
      )
    });

    ProofLibV2.TransactProof memory _proof;
    {
      // Build the proof against the predicted keystore root (not the stale on-chain root that lacks the leaf).
      ProofGenerator.TransactInputs memory _txInputs =
        _buildTransactInputs(_inputs, _fresh, _hashTransactContext(_param, _payload), _ncp, _ctx.withdraw);
      _txInputs.keystoreRoot = _keystoreTreeMirror.root();
      _proof = ProofGenerator.generateTransactProof(_txInputs);
    }

    uint256 _sizeBefore = _stateTreeMirror.size;
    uint256 _recipientBefore = _balanceOf(_ctx.asset, _ctx.recipient);
    uint256 _feeRecipientBefore = _balanceOf(_ctx.asset, _ctx.effectiveFeeRecipient);

    {
      uint256 _deadline = block.timestamp + 1 days;
      bytes memory _signature = _signSetAuthPolicy(_fresh, _deadline);
      vm.prank(_ctx.broadcaster);
      _privacyPoolRelay.registerAndRelay(
        _fresh.addr, _fresh.authDigest, _fresh.nullifyingKeyHash, _deadline, _signature, _proof, _param, _payload
      );
      ghost_registerAndRelayOk++; // coverage floor: registerAndRelay actually executed (see afterInvariant)
    }

    // Mirror + ghosts, mirroring the single-note path.
    Note[] memory _newNotes = _mirrorRelayOutputs(_proof, _ncp, _note.tokenId);
    _markSpent(_note);
    _addNoteForAddress(_fresh.addr, _newNotes[0]);
    _recordTransactLabelWithdrawals(_inputs, _ncp);

    ghost_withdrawnSum[_ctx.asset] += _ctx.withdraw;
    ghost_relayedRecipientTo[_ctx.asset][_ctx.recipient] += _ctx.withdraw - _ctx.fee;
    ghost_relayedFeeTo[_ctx.asset][_ctx.effectiveFeeRecipient] += _ctx.fee;
    ghost_transactLeafInserts += 2; // 1 input nullifier + 1 change-note commitment

    // ── PP2-9: on-handler check ──
    assertEq(_stateTreeMirror.size - _sizeBefore, 2, 'PP2-9: registerAndRelay must insert exactly N+M leaves');
    // Sticky flags (not asserts): swallowed under fail_on_revert=false. See the global invariants
    // invariant_relayStateRootConsistent / invariant_registerKeystoreConsistent.
    if (_poolVault.roots(_poolVault.currentRootIndex()) != _stateTreeMirror.root()) {
      ghost_relayStateRootViolated = true;
    }
    if (_keystore.nullifyingKeys(_fresh.addr) != _fresh.nullifyingKeyHash) ghost_registerKeystoreViolated = true;

    // ── PP2-17: on-handler check (nativeGas is 0 on this path) ──
    _assertRelaySplit(
      _ctx.asset,
      _ctx.recipient,
      _ctx.effectiveFeeRecipient,
      _recipientBefore,
      _feeRecipientBefore,
      _ctx.withdraw,
      _ctx.fee,
      0
    );
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev PP2-17 split check: the recipient nets `amountOut - fee` (+ nativeGain for the NATIVE asset) and
  ///      the fee recipient nets `fee`. When both collapse to one address, the combined delta is `amountOut`
  ///      (+ nativeGain). `_nativeGain` must be 0 for non-native assets (gas is forwarded as ETH).
  /// @dev Records a sticky `ghost_relaySplitViolated` flag on ANY mismatch instead of asserting — an
  ///      on-handler `assertEq` here would be swallowed under `fail_on_revert = false`. The global
  ///      `invariant_relaySplitConsistent` asserts the flag stays false. Not `view`: it writes the flag.
  function _assertRelaySplit(
    address _asset,
    address _recipient,
    address _effectiveFeeRecipient,
    uint256 _recipientBefore,
    uint256 _feeRecipientBefore,
    uint256 _amountOut,
    uint256 _fee,
    uint256 _nativeGain
  ) internal {
    if (_recipient == _effectiveFeeRecipient) {
      if (_balanceOf(_asset, _recipient) - _recipientBefore != _amountOut + _nativeGain) {
        ghost_relaySplitViolated = true;
      }
    } else {
      if (_balanceOf(_asset, _recipient) - _recipientBefore != _amountOut - _fee + _nativeGain) {
        ghost_relaySplitViolated = true;
      }
      if (_balanceOf(_asset, _effectiveFeeRecipient) - _feeRecipientBefore != _fee) {
        ghost_relaySplitViolated = true;
      }
    }
  }

  /// @dev Relay-side twin of `_submitTransact`: pranks the broadcaster onto `relay()`, mirrors the
  ///      same tree leaves the underlying `transact` inserts, builds output `Note` records, and
  ///      asserts the same nullifier/commitment/root postconditions as the direct-transact path.
  function _submitRelay(
    address _broadcaster,
    ProofLibV2.TransactProof memory _proof,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _tokenId,
    IPoolVault.TransactParams memory _params,
    IPoolVault.NoteData[] memory _payload,
    uint256 _nativeGas
  ) internal returns (Note[] memory _newNotes, uint256[] memory _nullifierHashes) {
    _nullifierHashes = _proof.nullifierHashes();
    if (_nativeGas > 0) vm.deal(_broadcaster, _broadcaster.balance + _nativeGas);
    vm.prank(_broadcaster);
    _privacyPoolRelay.relay{value: _nativeGas}(_proof, _params, _payload);

    _newNotes = _mirrorRelayOutputs(_proof, _noteCreationParams, _tokenId);
    // Sticky flag (not assert): swallowed under fail_on_revert=false. See invariant_relayStateRootConsistent.
    if (_poolVault.roots(_poolVault.currentRootIndex()) != _stateTreeMirror.root()) {
      ghost_relayStateRootViolated = true;
    }
  }

  /// @dev Mirror a single transact's leaves into the local state tree, build the output `Note` records, and
  ///      assert the per-transact nullifier/commitment timestamp postconditions. Shared by every relay path
  ///      (single, batch, register). The state-root match is checked by the caller — once per call for the
  ///      single/register paths, once after all items for the batch path.
  function _mirrorRelayOutputs(
    ProofLibV2.TransactProof memory _proof,
    NoteCreationParams[] memory _noteCreationParams,
    uint256 _tokenId
  ) internal returns (Note[] memory _newNotes) {
    uint256[] memory _nullifierHashes = _proof.nullifierHashes();
    uint256[] memory _outputLeafIndices = _mirrorTransactLeaves(_proof.outputCommitments(), _nullifierHashes);
    _newNotes = new Note[](_noteCreationParams.length);
    for (uint256 i = 0; i < _noteCreationParams.length; i++) {
      _newNotes[i] = Note({
        value: _noteCreationParams[i].value,
        noteSecret: _noteCreationParams[i].noteSecret,
        depositSecret: _noteCreationParams[i].depositSecret,
        noteAddressHash: _noteCreationParams[i].noteAddressHash,
        inputLabel: _noteCreationParams[i].label,
        timestamp: vm.getBlockTimestamp(),
        tokenId: _tokenId,
        depositLeaf: _commitmentLeaf(_proof.outputCommitments()[i]),
        outputCommitment: _proof.outputCommitments()[i],
        stateLeafIndex: _outputLeafIndices[i],
        aspLeafIndex: _aspLeafIndexForLabel[_noteCreationParams[i].label]
      });
    }

    for (uint256 i = 0; i < _nullifierHashes.length; i++) {
      assertEq(_poolVault.spentNullifiers(_nullifierHashes[i]), vm.getBlockTimestamp(), 'Nullifier timestamp mismatch');
    }
    for (uint256 i = 0; i < _noteCreationParams.length; i++) {
      assertEq(
        _poolVault.commitments(_proof.outputCommitments()[i]), vm.getBlockTimestamp(), 'Commitment timestamp mismatch'
      );
    }
  }

  /// @dev Load `_relayFreshAccount` with a fresh signable identity derived from `_seed`, and mark it used so
  ///      it is never re-registered (a second `setAuthPolicyWithSig` on the same account would revert).
  function _newFreshAccount(uint256 _seed) internal returns (UserIdentityLib.UserIdentity storage) {
    _relayFreshAccount = UserIdentityLib.createSignableIdentity(string.concat('relayFresh_', vm.toString(_seed)));
    vm.assume(!_relayFreshAccountUsed[_relayFreshAccount.addr]);
    _relayFreshAccountUsed[_relayFreshAccount.addr] = true;
    return _relayFreshAccount;
  }

  /// @dev Produce the EIP-712 `SetAuthPolicy` signature `_account` would create off-chain, reconstructing the
  ///      keystore domain (name "PrivacyPoolsKeystore", version "1", chainId, verifyingContract). Mirrors
  ///      `RegisterAndRelay.t.sol`; the typehash now binds the `deadline`.
  function _signSetAuthPolicy(
    UserIdentityLib.UserIdentity storage _account,
    uint256 _deadline
  ) internal view returns (bytes memory) {
    bytes32 _domainSeparator = keccak256(
      abi.encode(
        keccak256('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
        keccak256(bytes('PrivacyPoolsKeystore')),
        keccak256(bytes('1')),
        block.chainid,
        address(_keystore)
      )
    );
    bytes32 _structHash = keccak256(
      abi.encode(
        keccak256('SetAuthPolicy(address account,uint256 authDigest,uint256 nullifyingKeyHash,uint256 deadline)'),
        _account.addr,
        _account.authDigest,
        _account.nullifyingKeyHash,
        _deadline
      )
    );
    bytes32 _digest = keccak256(abi.encodePacked(hex'1901', _domainSeparator, _structHash));
    (uint8 _v, bytes32 _r, bytes32 _s) = vm.sign(_account.signingKey, _digest);
    return abi.encodePacked(_r, _s, _v);
  }
}
