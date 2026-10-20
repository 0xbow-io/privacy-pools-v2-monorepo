// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from "forge-std/Script.sol";
import {IRelaySwaps} from "../src/IRelaySwaps.sol";

/// @notice Allowlists a PPYieldTokenZap on a deployed RelaySwaps so executeUnwrapped() can
///   redeem that wrapper's shares before swapping.
///   Usage:
///     RELAY_SWAPS_ADDRESS=0x... ZAP=0x... \
///       forge script script/ApproveZap.s.sol --rpc-url <RPC> --broadcast --private-key <OWNER_KEY>
///   The broadcaster must be the RelaySwaps owner. approveZap() itself cross-checks
///   zap.A_TOKEN() == zap.VAULT().asset(), zap.UNDERLYING() == aToken.UNDERLYING_ASSET_ADDRESS()
///   and Entrypoint enablement of the share, so a mis-wired zap reverts instead of listing.
contract ApproveZap is Script {
    function run() external {
        address relaySwapsAddress = vm.envAddress("RELAY_SWAPS_ADDRESS");
        address zap = vm.envAddress("ZAP");
        require(relaySwapsAddress != address(0) && zap != address(0), "unset env");

        IRelaySwaps relaySwaps = IRelaySwaps(relaySwapsAddress);
        require(!relaySwaps.approvedZaps(zap), "zap already approved");

        vm.startBroadcast();
        relaySwaps.approveZap(zap);
        vm.stopBroadcast();

        console.log("Zap approved on RelaySwaps", relaySwapsAddress);
        console.log("  zap:", zap);
    }
}
