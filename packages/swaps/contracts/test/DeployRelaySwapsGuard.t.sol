// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {DeployRelaySwaps} from "../script/DeployRelaySwaps.s.sol";
import {MockPool} from "../src/MockPool.sol";

/// @notice Empty contract with non-zero bytecode, distinct from MockPool's, standing in for
///   a real (non-mock) pool address.
contract NonMockPoolStub {}

/// @notice Verifies the deploy-time guard added for issue #7 (Arbitrum WithdrawAndSwap wired
///   to MockPool with no ZK proof verification): deploying RelaySwaps against a detected
///   MockPool must require an explicit IS_TEST_DEPLOYMENT=true acknowledgement, and must never
///   block a deployment against a real (non-MockPool) address.
/// @dev All four scenarios live in ONE test function, deliberately. `vm.setEnv` mutates the
///   real process environment (not per-test EVM state), and Foundry runs test functions in
///   parallel by default — splitting these into separate functions caused a genuine race where
///   one test's env vars leaked into another's, producing a flaky false failure. A single
///   sequential function sidesteps that entirely rather than depending on `--threads 1`.
contract DeployRelaySwapsGuardTest is Test {
    address internal constant UPGRADER = address(0xB055);
    address internal constant ROUTER = address(0xB0B);

    function _setCommonEnv(address _pool, address _entrypoint) internal {
        vm.setEnv("POOL_ADDRESS", vm.toString(_pool));
        vm.setEnv("ENTRYPOINT_ADDRESS", vm.toString(_entrypoint));
        vm.setEnv("UPGRADER_ROLE", vm.toString(UPGRADER));
        vm.setEnv("ROUTER", vm.toString(ROUTER));
        vm.setEnv("APPROVAL_ADDRESS", vm.toString(address(0)));
    }

    function test_DeployRelaySwapsGuard() public {
        MockPool _mockPool = new MockPool();
        NonMockPoolStub _realPool = new NonMockPoolStub();
        DeployRelaySwaps _script;

        // 1. MockPool as POOL_ADDRESS, no flag — must revert.
        // Note: construction and the call are deliberately separate statements — vm.expectRevert()
        // only watches the single NEXT external call, and `(new DeployRelaySwaps()).run()` would
        // make the constructor call (which never reverts) that "next call" instead of run().
        _setCommonEnv(address(_mockPool), address(_mockPool));
        vm.setEnv("IS_TEST_DEPLOYMENT", "false");
        _script = new DeployRelaySwaps();
        vm.expectRevert();
        _script.run();

        // 2. MockPool as ENTRYPOINT_ADDRESS only, no flag — must also revert.
        _setCommonEnv(address(_realPool), address(_mockPool));
        vm.setEnv("IS_TEST_DEPLOYMENT", "false");
        _script = new DeployRelaySwaps();
        vm.expectRevert();
        _script.run();

        // 3. MockPool on both, WITH the flag — must succeed.
        _setCommonEnv(address(_mockPool), address(_mockPool));
        vm.setEnv("IS_TEST_DEPLOYMENT", "true");
        _script = new DeployRelaySwaps();
        _script.run();

        // 4. Real (non-MockPool) address, no flag — must succeed; the guard must never
        //    false-positive on a legitimate deployment.
        _setCommonEnv(address(_realPool), address(_realPool));
        vm.setEnv("IS_TEST_DEPLOYMENT", "false");
        _script = new DeployRelaySwaps();
        _script.run();
    }
}
