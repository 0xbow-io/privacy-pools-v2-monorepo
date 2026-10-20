// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase, Note, NoteCreationParams} from './IntegrationBase.t.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {MerkleTree} from 'test/helpers/MerkleTree.sol';
import {TransactProofMemory} from 'test/helpers/TestUtils.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for PrivacyPoolRelay.relay() using real ZK proofs
/// @dev Deposits on-chain, then relays withdrawals (full and partial) through the relay
///      contract, verifying fund splits between recipient and fee recipient.
contract RelayIntegration is IntegrationBase {
  using MerkleTree for MerkleTree.Tree;
  using TransactProofMemory for ProofLibV2.TransactProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  uint256 internal constant RELAY_FEE = 0.05 ether;
  uint256 internal constant GAS_FUNDING = 0.01 ether;

  address internal _relayer;

  function setUp() public override {
    super.setUp();
    alice = _registerInKeystore(alice);
    _relayer = makeAddr('relayer');
  }

  /*///////////////////////////////////////////////////////////////
                  RELAY WITHDRAWAL — FULL — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit ERC20 → full withdrawal via relay with fee split
  function test_relay_fullWithdrawal_erc20() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
                  RELAY WITHDRAWAL — FULL — ETH
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit ETH → full withdrawal via relay with fee split
  function test_relay_fullWithdrawal_eth() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
            RELAY WITHDRAWAL + PRIVATE TRANSFER — ERC20
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit ERC20 → partial withdrawal via relay (change stays as note)
  function test_relay_partialWithdrawal_erc20() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE / 3,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
            RELAY WITHDRAWAL + PRIVATE TRANSFER — ETH
  ///////////////////////////////////////////////////////////////*/

  /// @notice Deposit ETH → partial withdrawal via relay (change stays as note)
  function test_relay_partialWithdrawal_eth() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE / 3,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
              RELAY ERC20 WITH GAS FUNDING (msg.value)
  ///////////////////////////////////////////////////////////////*/

  /// @notice ERC20 relay withdrawal with msg.value forwarded as gas funding to recipient
  function test_relay_erc20WithGasFunding() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: GAS_FUNDING
    });
  }

  /// @notice ETH relay withdrawal with extra msg.value forwarded to recipient
  function test_relay_ethWithMsgValue() external {
    Note memory deposit = _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: GAS_FUNDING
    });
  }

  /*///////////////////////////////////////////////////////////////
                    CHAINED: TRANSFER → RELAY WITHDRAW
  ///////////////////////////////////////////////////////////////*/

  /// @notice Alice deposits → Alice transfers to Bob privately → Bob withdraws via relay
  function test_relay_chainedTransferThenRelayWithdraw() external {
    bob = _registerInKeystore(bob);

    // Step 1: Alice deposits ERC20
    Note memory aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    // Step 2: Alice transfers to Bob (pure private transfer via _transact helper)
    vm.warp(vm.getBlockTimestamp() + 1);

    (Note memory bobNote,) = _transact({
      _note: aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, aliceDeposit.inputLabel),
      _amountOut: 0
    });

    // Step 3: Bob withdraws the full value via relay
    _relay({
      _note: bobNote,
      _spender: bob,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });
  }

  /*///////////////////////////////////////////////////////////////
                  FRONTRUN RESISTANCE (CONTEXT BINDING)
  ///////////////////////////////////////////////////////////////*/

  /// @notice Anyone can broadcast a relay tx — the context-bound processor routes funds to the intended recipient
  function test_relay_frontrunnerCannotStealFunds() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    address attacker = makeAddr('attacker');
    _relayer = attacker;

    (, IPoolVault.TransactParams memory params) = _relay({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _msgValue: 0
    });

    assertEq(params.processor, address(_privacyPoolRelay), 'Processor must be the relay');
    assertEq(_token.balanceOf(attacker), 0, 'Attacker should receive nothing'); // the other asserts are inside _relay()
  }

  /// @notice Attacker intercepts relay-bound proof and calls poolVault.transact directly — reverts
  function test_relay_directSubmitRevertsForNonProcessor() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);

    vm.warp(vm.getBlockTimestamp() + 1);

    // can't use _relay() since we expect revert

    (ProofLibV2.TransactProof memory proof, IPoolVault.TransactParams memory params) = _buildRelayProof({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _nativeGas: 0
    });

    address attacker = makeAddr('attacker');
    vm.prank(attacker);
    vm.expectRevert(IPoolVault.PoolVault_InvalidProcessor.selector);
    _poolVault.transact(proof, params, _defaultTransactNoteData);
  }

  /*///////////////////////////////////////////////////////////////
                  NON-CANONICAL TOKEN ID TESTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Relay reverts when the transact proof's tokenIdOut has dirty upper bits
  /// @dev The circuit constrains tokenIdOut === tokenId when amountOut > 0 (Transact.circom L260),
  ///      so a valid Groth16 proof with non-canonical tokenIdOut is not possible for withdrawals.
  ///      Instead, we tamper pubSignals after proof generation.
  function test_relay_revertsWhenTokenIdOutIsNonCanonical() external {
    Note memory deposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    (ProofLibV2.TransactProof memory proof, IPoolVault.TransactParams memory params) = _buildRelayProof({
      _note: deposit,
      _spender: alice,
      _recipient: bob,
      _feeRecipient: charlie.addr,
      _inputNoteValue: SAMPLE_VALUE,
      _withdrawValue: SAMPLE_VALUE,
      _feeAmount: RELAY_FEE,
      _nativeGas: 0
    });

    proof.pubSignals[6][0] = proof.pubSignals[6][0] | (uint256(0xDEAD) << 160);

    vm.prank(_relayer);
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, proof.pubSignals[6][0]));
    _privacyPoolRelay.relay(proof, params, _defaultTransactNoteData);
  }

  /*///////////////////////////////////////////////////////////////
                          HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Build relay proof, execute relay, mirror state tree, and assert all postconditions
  function _relay(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    UserIdentityLib.UserIdentity storage _recipient,
    address _feeRecipient,
    uint256 _inputNoteValue,
    uint256 _withdrawValue,
    uint256 _feeAmount,
    uint256 _msgValue
  ) internal returns (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) {
    vm.warp(vm.getBlockTimestamp() + 1);

    address _tokenAddr = address(uint160(_note.tokenId));
    uint256 _recipientBefore = _balanceOf(_tokenAddr, _recipient.addr);
    uint256 _recipientEthBefore = _recipient.addr.balance;
    uint256 _feeRecipientBefore = _balanceOf(_tokenAddr, _feeRecipient);
    uint256 _poolVaultBefore = _balanceOf(_tokenAddr, address(_poolVault));

    (_txProof, _params) = _buildRelayProof({
      _note: _note,
      _spender: _spender,
      _recipient: _recipient,
      _feeRecipient: _feeRecipient,
      _inputNoteValue: _inputNoteValue,
      _withdrawValue: _withdrawValue,
      _feeAmount: _feeAmount,
      _nativeGas: _msgValue
    });

    vm.expectEmit();
    emit IPrivacyPoolRelay.Relayed(
      _tokenAddr, _recipient.addr, _withdrawValue - _feeAmount, _feeRecipient, _feeAmount, _msgValue
    );

    vm.deal(_relayer, _msgValue);
    vm.prank(_relayer);
    _privacyPoolRelay.relay{value: _msgValue}(_txProof, _params, _defaultTransactNoteData);

    _assertProofWasSpent(_txProof, vm.getBlockTimestamp());
    _assertStateRootSync(_txProof);

    bool _isNativeAsset = _tokenAddr == Constants.NATIVE_ASSET;
    uint256 _expectedRecipientDelta = _withdrawValue - _feeAmount + (_isNativeAsset ? _msgValue : 0);

    assertEq(
      _balanceOf(_tokenAddr, _recipient.addr),
      _recipientBefore + _expectedRecipientDelta,
      'Recipient should receive withdrawal minus fee'
    );
    assertEq(
      _balanceOf(_tokenAddr, _feeRecipient), _feeRecipientBefore + _feeAmount, 'Fee recipient should receive relay fee'
    );
    assertEq(
      _balanceOf(_tokenAddr, address(_poolVault)), _poolVaultBefore - _withdrawValue, 'PoolVault balance mismatch'
    );
    assertEq(_balanceOf(_tokenAddr, address(_privacyPoolRelay)), 0, 'Relay should hold no funds');

    if (!_isNativeAsset && _msgValue > 0) {
      assertEq(_recipient.addr.balance, _recipientEthBefore + _msgValue, 'Recipient should receive gas funding ETH');
    }
    assertEq(address(_privacyPoolRelay).balance, 0, 'Relay should hold no ETH');
  }

  /// @dev Build relay proof for a given spender, recipient, and fee recipient.
  ///      Circuit enforces: inputValue = outputValue + amountOut, where outputValue = _inputNoteValue - _withdrawValue.
  ///      The _feeAmount is NOT a circuit constraint — it's deducted from amountOut by the relay contract
  ///      via PayoutRouting (recipient gets amountOut - fee, feeRecipient gets fee).
  function _buildRelayProof(
    Note memory _note,
    UserIdentityLib.UserIdentity memory _spender,
    UserIdentityLib.UserIdentity storage _recipient,
    address _feeRecipient,
    uint256 _inputNoteValue,
    uint256 _withdrawValue,
    uint256 _feeAmount,
    uint256 _nativeGas
  ) internal returns (ProofLibV2.TransactProof memory _txProof, IPoolVault.TransactParams memory _params) {
    _params = IPoolVault.TransactParams({
      processor: address(_privacyPoolRelay),
      data: abi.encode(
        IPrivacyPoolRelay.PayoutRouting({
          recipient: _recipient.addr, feeRecipient: _feeRecipient, feeAmount: _feeAmount, nativeGas: _nativeGas
        })
      )
    });

    NoteCreationParams memory _outputNote = _recipient.receiveNote(_inputNoteValue - _withdrawValue, _note.inputLabel);

    Note[] memory _notes = new Note[](1);
    _notes[0] = _note;
    NoteCreationParams[] memory _outputNotes = new NoteCreationParams[](1);
    _outputNotes[0] = _outputNote;

    _txProof = _buildTransactProof({
      _notes: _notes,
      _spender: _spender,
      _noteCreationParams: _outputNotes,
      _amountOut: _withdrawValue,
      _context: _hashTransactContext(_params, _defaultTransactNoteData)
    });
  }

  receive() external payable {}
}
