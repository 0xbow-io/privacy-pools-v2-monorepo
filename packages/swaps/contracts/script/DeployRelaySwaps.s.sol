// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from "forge-std/Script.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {MockPool} from "../src/MockPool.sol";

/// @notice Deploys RelaySwaps as a processor.
///   Usage:
///     forge script script/DeployRelaySwaps.s.sol --rpc-url <RPC> --broadcast --private-key <KEY>
///   Required env vars:
///     POOL_ADDRESS       — deployed PoolVault/MockPool address
///     ENTRYPOINT_ADDRESS — deployed Entrypoint address (MockPool on testnet)
///     ROUTER             — allowlisted swap target (the DEX aggregator / LiFi Diamond)
///   Optional env vars:
///     APPROVAL_ADDRESS   — the ERC20-approval target when it differs from ROUTER
///                          (e.g. LiFi v4's separate ERC20Proxy). Both swapTarget and
///                          approvalAddress must be allowlisted (H3). Leave unset when
///                          ROUTER already doubles as the approval target. Requires the
///                          broadcaster to be UPGRADER_ROLE (the owner); otherwise approve
///                          the proxy manually via approveRouter() after deploy.
///     CREATE2_SALT       — bytes32 salt. When set, RelaySwaps is deployed via CREATE2 through
///                          forge's default deterministic factory (0x4e59b44847b379578588920ca78fbf26c0b4956c),
///                          so the address depends only on (salt, initcode) and is identical on
///                          every chain where the constructor args (pool, entrypoint, owner,
///                          router) are the same. Deployer EOA / nonce do not matter. The script
///                          refuses to run if the predicted address already has code.
///     IS_TEST_DEPLOYMENT — must be "true" if POOL_ADDRESS or ENTRYPOINT_ADDRESS is a
///                          MockPool (detected by bytecode match). Deploying RelaySwaps
///                          against MockPool skips ZK proof verification entirely (see
///                          MockPool.relay()/transact()) — refusing to do that silently
///                          is the whole point of this check.
contract DeployRelaySwaps is Script {
    function run() external {
        address _poolAddress = vm.envAddress("POOL_ADDRESS");
        address _entrypointAddress = vm.envAddress("ENTRYPOINT_ADDRESS");
        address upgraderRole = vm.envAddress("UPGRADER_ROLE");
        address allowedRouter = vm.envAddress("ROUTER");
        address approvalAddress = vm.envOr("APPROVAL_ADDRESS", address(0));
        bool isTestDeployment = vm.envOr("IS_TEST_DEPLOYMENT", false);
        bytes32 create2Salt = vm.envOr("CREATE2_SALT", bytes32(0));
        bool useCreate2 = create2Salt != bytes32(0);

        // Refuse to silently wire a production-looking RelaySwaps to MockPool — MockPool
        // skips ZK proof verification, so this must be an explicit, acknowledged choice.
        bytes32 _mockPoolCodehash = keccak256(type(MockPool).runtimeCode);
        require(
            isTestDeployment || _poolAddress.codehash != _mockPoolCodehash,
            "POOL_ADDRESS is a MockPool; set IS_TEST_DEPLOYMENT=true to confirm this is a test deployment"
        );
        require(
            isTestDeployment || _entrypointAddress.codehash != _mockPoolCodehash,
            "ENTRYPOINT_ADDRESS is a MockPool; set IS_TEST_DEPLOYMENT=true to confirm this is a test deployment"
        );

        if (useCreate2) {
            bytes32 _initCodeHash = keccak256(
                abi.encodePacked(
                    type(RelaySwaps).creationCode,
                    abi.encode(_poolAddress, _entrypointAddress, upgraderRole, allowedRouter)
                )
            );
            address _predicted = vm.computeCreate2Address(create2Salt, _initCodeHash);
            console.log("CREATE2 salt:");
            console.logBytes32(create2Salt);
            console.log("CREATE2 predicted address:", _predicted);
            require(_predicted.code.length == 0, "RelaySwaps already deployed at the CREATE2 address");
        }

        vm.startBroadcast();

        RelaySwaps _relaySwaps = useCreate2
            ? new RelaySwaps{salt: create2Salt}(
                IPool(_poolAddress),
                IEntrypoint(_entrypointAddress),
                upgraderRole,
                allowedRouter
            )
            : new RelaySwaps(
                IPool(_poolAddress),
                IEntrypoint(_entrypointAddress),
                upgraderRole,
                allowedRouter
            );
        console.log("RelaySwaps deployed at:", address(_relaySwaps));
        console.log("  POOL:", _poolAddress);
        console.log("  ENTRYPOINT:", _entrypointAddress);
        console.log("  Routers whitelister", upgraderRole);
        console.log("  Allowlisted swapTarget:", allowedRouter);

        // Allowlist the distinct ERC20-approval proxy when configured (H3).
        if (approvalAddress != address(0) && approvalAddress != allowedRouter) {
            _relaySwaps.approveRouter(approvalAddress);
            console.log("  Allowlisted approvalAddress:", approvalAddress);
        }

        vm.stopBroadcast();
    }
}
