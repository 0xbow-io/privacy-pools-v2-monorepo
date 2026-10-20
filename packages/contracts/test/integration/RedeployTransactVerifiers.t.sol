// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IntegrationBase} from './IntegrationBase.t.sol';
import {Vm} from 'forge-std/Vm.sol';

import {RedeployTransactVerifiers} from 'script/RedeployTransactVerifiers.s.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @notice Integration test that exercises the RedeployTransactVerifiers script
contract RedeployTransactVerifiersIntegration is IntegrationBase {
  RedeployTransactVerifiers internal _script;

  function setUp() public override {
    super.setUp();
    _script = new RedeployTransactVerifiers();
  }

  function test_redeployTransactVerifiers() external {
    // Store old verifier addresses from the initial deploy
    address[25] memory _oldAddresses;
    uint256 _idx;
    for (uint8 _n = 1; _n <= 5; ++_n) {
      for (uint8 _m = 1; _m <= 5; ++_m) {
        _oldAddresses[_idx] = _getVerifierAddr(_n, _m);
        assertTrue(_oldAddresses[_idx] != address(0), 'Pre-existing verifier should be configured');
        ++_idx;
      }
    }

    // Grant UPGRADER_ROLE to the script so it can call setVerifier on PoolVault
    vm.prank(_config.defaultAdmin);
    _accessRouter.grantRole(UPGRADER_ROLE, address(_script));

    // Run the redeploy script and record logs
    vm.recordLogs();
    _script.redeploy(_poolVault);

    // Verify 25 VerifierConfigured events were emitted
    Vm.Log[] memory _logs = vm.getRecordedLogs();
    bytes32 _eventSig = keccak256('VerifierConfigured(uint256,uint256,address,bytes4)');
    uint256 _eventCount;
    for (uint256 i; i < _logs.length; ++i) {
      if (_logs[i].topics[0] == _eventSig) ++_eventCount;
    }
    assertEq(_eventCount, 25, 'Should emit 25 VerifierConfigured events');

    // Verify all 25 verifiers are configured with new (different) addresses
    _idx = 0;
    for (uint8 _n = 1; _n <= 5; ++_n) {
      for (uint8 _m = 1; _m <= 5; ++_m) {
        address _newAddr = _getVerifierAddr(_n, _m);
        assertTrue(_newAddr != address(0), 'Verifier address should be non-zero');
        assertTrue(_newAddr != _oldAddresses[_idx], 'Verifier should have been replaced');
        ++_idx;
      }
    }
  }
}
