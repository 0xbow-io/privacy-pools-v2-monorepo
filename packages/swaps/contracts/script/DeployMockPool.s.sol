// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from "forge-std/Script.sol";
import {MockPool} from "../src/MockPool.sol";

/// @notice Deploys MockPool + Groth16 deposit verifier and wires them together.
///   Usage:
///     forge script script/DeployMockPool.s.sol --rpc-url <RPC> --broadcast --private-key <KEY>
///   Optional env vars:
///     RELAYER_ADDRESS — address to approve as relayer (defaults to deployer)
///   After deploy, enable assets via cast:
///     cast send <pool> "setAssetConfig(address,bool,uint256,uint256,uint256,uint256)" <token> true <min> <vettingBPS> <maxRelayFee> <maxAmount> --private-key <KEY>
contract DeployMockPool is Script {
    function run() external {
        address _deployer = msg.sender;
        address _relayer = vm.envOr("RELAYER_ADDRESS", _deployer);

        vm.startBroadcast();

        // 1. Deploy Groth16 deposit verifier from its compiled artifact: the verifier is GPL-3.0, so this
        //    BUSL script does not import its source (see src/verifiers/VerifierArtifacts.sol)
        address _verifier = vm.deployCode("VerifierArtifacts.sol:DepositVerifier");
        console.log("Groth16Verifier deployed at:", _verifier);

        // 2. Deploy MockPool
        MockPool _pool = new MockPool();
        console.log("MockPool deployed at:", address(_pool));

        // 3. Wire: set deposit verifier
        _pool.setDepositVerifier(_verifier);
        console.log("Deposit verifier set");

        // 4. Wire: approve relayer
        _pool.setRelayer(_relayer, true);
        console.log("Relayer approved:", _relayer);

        vm.stopBroadcast();

        console.log("--- Done ---");
        console.log("Owner:", _deployer);
    }
}
