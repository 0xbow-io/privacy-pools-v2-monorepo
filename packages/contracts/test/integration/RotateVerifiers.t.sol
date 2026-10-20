// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Note} from './IntegrationBase.t.sol';
import {Vm} from 'forge-std/Vm.sol';

import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ProofLibV2} from 'libraries/ProofLibV2.sol';
import {RotateVerifiers} from 'script/RotateVerifiers.s.sol';
import {UserIdentityLib} from 'test/helpers/UserIdentityLib.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @notice Integration test that exercises the RotateVerifiers script
contract RotateVerifiersIntegration is IntegrationBase {
  using UserIdentityLib for UserIdentityLib.UserIdentity;

  RotateVerifiers internal _script;

  function setUp() public override {
    super.setUp();
    _script = new RotateVerifiers();
    alice = _registerInKeystore(alice);
    bob = _registerInKeystore(bob);
  }

  function test_rotateVerifiers_replacesAll27() external {
    address _oldDeposit = address(_poolVault.depositVerifier());
    address _oldRagequit = address(_poolVault.ragequitVerifier());
    address[25] memory _oldTransact;
    uint256 _idx;
    for (uint8 _n = 1; _n <= 5; ++_n) {
      for (uint8 _m = 1; _m <= 5; ++_m) {
        _oldTransact[_idx++] = _getVerifierAddr(_n, _m);
      }
    }

    vm.prank(_config.defaultAdmin);
    _accessRouter.grantRole(UPGRADER_ROLE, address(_script));

    vm.recordLogs();
    _script.rotate(_poolVault);

    // 25 transact verifiers configured, plus one event per deposit and ragequit setter
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    uint256 _transactEvents;
    uint256 _setterEvents;
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].topics[0] == keccak256('VerifierConfigured(uint256,uint256,address,bytes4)')) ++_transactEvents;
      if (_logs[i].topics[0] == IPoolVault.DepositVerifierSet.selector) ++_setterEvents;
      if (_logs[i].topics[0] == IPoolVault.RagequitVerifierSet.selector) ++_setterEvents;
    }
    assertEq(_transactEvents, 25, 'Should emit 25 VerifierConfigured events');
    assertEq(_setterEvents, 2, 'Should emit DepositVerifierSet and RagequitVerifierSet');

    assertTrue(address(_poolVault.depositVerifier()) != _oldDeposit, 'Deposit verifier should have been replaced');
    assertTrue(address(_poolVault.ragequitVerifier()) != _oldRagequit, 'Ragequit verifier should have been replaced');
    _idx = 0;
    for (uint8 _n = 1; _n <= 5; ++_n) {
      for (uint8 _m = 1; _m <= 5; ++_m) {
        address _newAddr = _getVerifierAddr(_n, _m);
        assertTrue(_newAddr != address(0), 'Verifier address should be non-zero');
        assertTrue(_newAddr != _oldTransact[_idx++], 'Verifier should have been replaced');
      }
    }
  }

  function test_rotateVerifiers_proofsVerifyAfterRotation() external {
    vm.prank(_config.defaultAdmin);
    _accessRouter.grantRole(UPGRADER_ROLE, address(_script));
    _script.rotate(_poolVault);

    // Deposit, transact and ragequit proofs come from the committed circuit keys, so each one only
    // succeeds if the rotated verifier embeds the matching verification key
    vm.warp(vm.getBlockTimestamp() + 1);
    Note memory _aliceDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    Note memory _ragequitDeposit = _deposit(alice, address(_token), SAMPLE_VALUE);
    vm.warp(vm.getBlockTimestamp() + 1);

    _transact({
      _note: _aliceDeposit,
      _spender: alice,
      _noteCreationParams: bob.receiveNote(SAMPLE_VALUE, _aliceDeposit.inputLabel),
      _amountOut: 0
    });

    uint256 _balanceBefore = _token.balanceOf(alice.addr);
    ProofLibV2.RagequitProof memory _rqProof = _buildAndGenerateRagequitProof(alice, _ragequitDeposit);
    _submitRagequit(alice, _rqProof);
    assertEq(_token.balanceOf(alice.addr), _balanceBefore + SAMPLE_VALUE, 'Ragequit should return the full value');
  }

  function test_rotateVerifiers_revertsWhenCallerLacksUpgraderRole() external {
    vm.expectRevert();
    _script.rotate(_poolVault);
  }
}
