// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Vm} from 'forge-std/Vm.sol';
import {PoseidonT3} from 'poseidon-solidity/PoseidonT3.sol';

import {IntegrationBase} from './IntegrationBase.t.sol';
import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {SNARK_SCALAR_FIELD} from 'lean-imt/Constants.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {_calcFee} from 'test/handlers/HandlerBase.sol';
import {ProofGenerator} from 'test/helpers/ProofGenerator.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {Constants} from 'utils/Constants.sol';

/// @notice Integration tests for label registration via deposit and direct ASPRegistry call
/// @dev Exercises the two paths described in contracts-tech-design §3.1 and §3.2:
///      1. Bundled: Entrypoint.deposit() with non-empty _aspCiphertext → ASPRegistry.registerLabel()
///      2. Isolated: ASPRegistry.registerLabel() called directly (permissionless)
contract LabelRegistrationIntegration is IntegrationBase {
  using ProofLibV2 for ProofLibV2.DepositProof;
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  bytes internal constant SAMPLE_CIPHERTEXT = hex'deadbeefcafe';
  bytes32 internal constant LABEL_REGISTERED_TOPIC = keccak256('LabelRegistered(bytes)');

  /*///////////////////////////////////////////////////////////////
                  BUNDLED PATH: DEPOSIT + LABEL REGISTRATION
  ///////////////////////////////////////////////////////////////*/

  /// @notice ETH deposit with non-empty ciphertext emits Deposited then LabelRegistered (ordering per §3.2)
  function test_deposit_withCiphertext_emitsLabelRegistered_eth() external {
    (ProofLibV2.DepositProof memory _proof, IPoolVault.NoteData memory _noteData, uint256 _totalAmount) =
      _buildDepositProof(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.deal(alice.addr, _totalAmount);

    vm.expectEmit(address(_entrypoint));
    emit IEntrypoint.Deposited(
      Constants.NATIVE_ASSET, alice.addr, SAMPLE_VALUE, _calcFee(Constants.NATIVE_ASSET, SAMPLE_VALUE)
    );

    vm.expectEmit(address(_aspRegistry));
    emit IASPRegistry.LabelRegistered(SAMPLE_CIPHERTEXT);

    vm.prank(alice.addr);
    _entrypoint.deposit{value: _totalAmount}(_proof, _noteData, SAMPLE_CIPHERTEXT);
  }

  /// @notice Deposit with empty ciphertext does NOT emit LabelRegistered
  function test_deposit_withEmptyCiphertext_doesNotEmitLabelRegistered() external {
    vm.recordLogs();
    _deposit(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);
    Vm.Log[] memory _logs = vm.getRecordedLogs();

    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].topics.length > 0) {
        assertTrue(
          _logs[i].topics[0] != LABEL_REGISTERED_TOPIC, 'LabelRegistered should not be emitted with empty ciphertext'
        );
      }
    }
  }

  /*///////////////////////////////////////////////////////////////
                  DIRECT PATH: ASPRegistry.registerLabel()
  ///////////////////////////////////////////////////////////////*/

  /// @notice Direct registerLabel emits LabelRegistered with correct ciphertext
  function test_registerLabel_directCall_emitsEvent() external {
    vm.expectEmit(address(_aspRegistry));
    emit IASPRegistry.LabelRegistered(SAMPLE_CIPHERTEXT);

    _aspRegistry.registerLabel(SAMPLE_CIPHERTEXT);
  }

  /*///////////////////////////////////////////////////////////////
              EQUIVALENCE: BOTH PATHS REACH SAME END STATE
  ///////////////////////////////////////////////////////////////*/

  /// @notice Both paths emit identical LabelRegistered event for the same ciphertext
  function test_bothPaths_emitIdenticalLabelRegisteredEvent() external {
    // Path A: Direct call to ASPRegistry
    vm.recordLogs();
    _aspRegistry.registerLabel(SAMPLE_CIPHERTEXT);
    Vm.Log[] memory _directLogs = vm.getRecordedLogs();

    // Path B: Via Entrypoint.deposit()
    (ProofLibV2.DepositProof memory _proof, IPoolVault.NoteData memory _noteData, uint256 _totalAmount) =
      _buildDepositProof(alice, Constants.NATIVE_ASSET, SAMPLE_VALUE);

    vm.deal(alice.addr, _totalAmount);
    vm.recordLogs();
    vm.prank(alice.addr);
    _entrypoint.deposit{value: _totalAmount}(_proof, _noteData, SAMPLE_CIPHERTEXT);
    Vm.Log[] memory _depositLogs = vm.getRecordedLogs();

    // Extract LabelRegistered events from both paths
    Vm.Log memory _directEvent = _extractLabelRegisteredEvent(_directLogs);
    Vm.Log memory _depositEvent = _extractLabelRegisteredEvent(_depositLogs);

    // Both events emitted by the same contract (ASPRegistry)
    assertEq(_directEvent.emitter, _depositEvent.emitter, 'Emitter mismatch');
    assertEq(_directEvent.emitter, address(_aspRegistry), 'Event should come from ASPRegistry');

    // Same event signature
    assertEq(_directEvent.topics[0], _depositEvent.topics[0], 'Event topic mismatch');

    // Same event data (ciphertext forwarded faithfully through Entrypoint)
    assertEq(keccak256(_directEvent.data), keccak256(_depositEvent.data), 'Event data mismatch');
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL HELPERS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Build a deposit proof without executing the deposit on-chain
  function _buildDepositProof(
    UserIdentityLib.UserIdentity storage _user,
    address _tokenAddr,
    uint256 _value
  )
    internal
    returns (ProofLibV2.DepositProof memory _proof, IPoolVault.NoteData memory _noteData, uint256 _totalAmount)
  {
    (uint256 _noteSecret, uint256 _depositSecret) = _user.newSecrets();
    uint256 _noteAddressHash = PoseidonT3.hash([_user.ownerAddress, _noteSecret]);

    _noteData = _defaultNoteData;
    uint256 _depositContext = uint256(keccak256(abi.encode(_noteData))) % SNARK_SCALAR_FIELD;

    _proof = ProofGenerator.generateDepositProof(_tokenAddr, _value, _noteAddressHash, _depositSecret, _depositContext);
    _totalAmount = _value + _calcFee(_tokenAddr, _value);
  }

  /// @dev Extract the single LabelRegistered event from a log array (reverts if missing or duplicated)
  function _extractLabelRegisteredEvent(Vm.Log[] memory _logs) internal pure returns (Vm.Log memory _event) {
    bool _found;
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].topics.length > 0 && _logs[i].topics[0] == LABEL_REGISTERED_TOPIC) {
        require(!_found, 'LabelRegistered emitted more than once');
        _event = _logs[i];
        _found = true;
      }
    }
    require(_found, 'LabelRegistered event not found in logs');
  }
}
