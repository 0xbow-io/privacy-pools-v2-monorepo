// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.13;

import {Script} from "forge-std/Script.sol";
import {PrivacyPoolRelay} from "../src/contracts/PrivacyPoolRelay.sol";
import {Entrypoint} from "../src/contracts/Entrypoint.sol";

contract RelayDeployment is Script {
    PrivacyPoolRelay public relay;
    Entrypoint public entry;

    uint256 public constant MAX_FEE = 900_000_000_000_000_000;

    function setUp() public {}

    function run() public {
        vm.startBroadcast();

        relay = new PrivacyPoolRelay(MAX_FEE);
        entry = new Entrypoint(MAX_FEE);

        vm.stopBroadcast();
    }
}
