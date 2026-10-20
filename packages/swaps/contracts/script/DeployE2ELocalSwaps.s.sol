// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console2} from "forge-std/Script.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockERC20} from "../src/MockERC20.sol";
import {MockERC20Proxy, MockLiFiExecutor} from "../src/MockLiFiExecutor.sol";

/// @notice Minimal re-declaration of the real Entrypoint's asset-configuration surface —
///   RelaySwaps.sol's own `IEntrypoint` only declares `assets()`. The real interface
///   (packages/contracts/src/interfaces/IEntrypoint.sol) can't be imported here: it transitively
///   pulls in `libraries/ProofLibV2.sol`, which this project's remappings don't resolve (only
///   `main_contracts_libs/` does, under a different prefix) — same reason RelaySwaps.sol declares
///   its own minimal copy instead of importing the real one.
interface IEntrypointFull {
    struct AssetConfig {
        bool enabled;
        uint256 minAmount;
        uint256 vettingFeeBPS;
        uint256 maxRelayFee;
    }

    function setAssetConfiguration(address _asset, AssetConfig calldata _config) external;
}

/// @title DeployE2ELocalSwaps
/// @notice Deploys a MockERC20 + MockRouter (standing in for the LiFi Diamond — LiFi has no
///   solver/liquidity on local/test chains) + RelaySwaps, for the evm-sdk e2e suite
///   (packages/evm-sdk/e2e/). Companion to packages/contracts/script/DeployE2ELocal.s.sol, run as
///   a second, independent forge script against THIS project (packages/swaps/contracts has its
///   own foundry.toml; packages/contracts has no remapping back into this project's src/).
/// @dev Does not reuse DeployRelaySwaps.s.sol: that script takes ROUTER as a pre-existing env-var
///   address, but here the router is deployed within this same run, so its address isn't known
///   ahead of time.
/// Env: PRIVATE_KEY (deployer — same fixed e2e-only key network.ts uses for the core deploy;
///   becomes RelaySwaps' owner and the sole allowlisted router/approval address is the MockRouter
///   this script deploys), POOL_ADDRESS, ENTRYPOINT_ADDRESS (from DeployE2ELocal.s.sol's output).
/// Usage: forge script script/DeployE2ELocalSwaps.s.sol --sig "runLocal()" --rpc-url <local fork> --broadcast
contract DeployE2ELocalSwaps is Script {
    function runLocal() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address poolAddress = vm.envAddress("POOL_ADDRESS");
        address entrypointAddress = vm.envAddress("ENTRYPOINT_ADDRESS");

        vm.startBroadcast(pk);
        MockERC20 token = new MockERC20("Mock USD", "mUSD", 18);
        MockRouter router = new MockRouter();
        // The constructor's `_allowedRouter` param already sets approvedRouters[router] = true —
        // no separate approveRouter() call needed, since this e2e suite uses the same MockRouter
        // address for both swapTarget and approvalAddress everywhere.
        RelaySwaps relaySwaps = new RelaySwaps(IPool(poolAddress), IEntrypoint(entrypointAddress), deployer, address(router));
        // Enables mUSD as a depositable/withdrawable Entrypoint asset — same call
        // DeployE2ELocal.s.sol already makes for native ETH. Needed so the e2e suite can deposit
        // a plain ERC20 note (mUSD), not just swap into/out of it as a MockRouter leg.
        // `deployer` already permanently holds ENTRYPOINT_MANAGER_ROLE (see DeployE2ELocal.s.sol).
        IEntrypointFull(entrypointAddress).setAssetConfiguration(
            address(token),
            IEntrypointFull.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
        );
        // Stands in for LiFi's Executor + ERC20Proxy, which the SDK composes a same-chain swap into a
        // native deposit through. The SDK requires both on the router allowlist (the executor is the
        // transaction target, the proxy the user's approval spender).
        MockERC20Proxy erc20Proxy = new MockERC20Proxy(deployer);
        MockLiFiExecutor executor = new MockLiFiExecutor(address(erc20Proxy));
        erc20Proxy.setAuthorizedCaller(address(executor), true);
        relaySwaps.approveRouter(address(executor));
        relaySwaps.approveRouter(address(erc20Proxy));
        vm.stopBroadcast();

        console2.log("RELAYSWAPS", address(relaySwaps));
        console2.log("MOCKROUTER", address(router));
        console2.log("MOCKERC20", address(token));
        console2.log("MOCKEXECUTOR", address(executor));
        console2.log("MOCKERC20PROXY", address(erc20Proxy));
    }
}
