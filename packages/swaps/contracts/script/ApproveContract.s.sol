// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from "forge-std/Script.sol";
import {IRelaySwaps} from "../src/IRelaySwaps.sol";

contract ApproveContracts is Script {
    function run() external {
        address relaySwapsAddress = vm.envOr("RELAY_SWAPS_ADDRESS", address(0));
        address swapTarget = vm.envOr("SWAP_TARGET", address(0));
        address approvalAddress = vm.envOr("APPROVAL_ADDRESS", address(0));

        // Guard: an unset RELAY_SWAPS_ADDRESS would send approveRouter to address(0),
        // which succeeds silently against a codeless address and logs "Allowlisted".
        require(relaySwapsAddress != address(0), "RELAY_SWAPS_ADDRESS is unset");
        require(swapTarget != address(0) || approvalAddress != address(0), "set SWAP_TARGET and/or APPROVAL_ADDRESS");

        IRelaySwaps _relaySwaps = IRelaySwaps(relaySwapsAddress);

        vm.startBroadcast();

        // Allowlist the swap/router target (e.g. the LiFi diamond) when configured
        if (swapTarget != address(0)) {
            _relaySwaps.approveRouter(swapTarget);
            console.log("  Allowlisted swapTarget:", swapTarget);
        }

        // Allowlist the distinct ERC20-approval proxy when configured
        if (approvalAddress != address(0)) {
            _relaySwaps.approveRouter(approvalAddress);
            console.log("  Allowlisted approvalAddress:", approvalAddress);
        }

        vm.stopBroadcast();
    }
}
