// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {console2} from 'forge-std/Script.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {Deploy} from 'script/Deploy.s.sol';
import {DeploymentVerifier} from 'script/helpers/DeploymentVerifier.sol';
import {SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';
import {Constants} from 'src/utils/Constants.sol';
import {ENTRYPOINT_MANAGER_ROLE, PAUSER_ROLE, POSTMAN_ROLE} from 'src/utils/RolesConstants.sol';

/// @title DeployE2ELocal
/// @notice Deploys the core protocol stack (AccessRouter, Keystore, ASPRegistry, PoolVault,
/// Entrypoint, PrivacyPoolRelay) to a local anvil Sepolia fork for the evm-sdk e2e suite
/// (see packages/evm-sdk/e2e/), then enables native ETH on the Entrypoint (skipped by the
/// no-broadcast `_deploy` pipeline this otherwise mirrors — see `deployWithConfig`'s doc comment
/// — but required for the e2e suite's deposit/withdraw/transfer flow to work at all). Skips the
/// Canon Guard Safe, so it has no dependency beyond the canonical ERC-5564 Announcer singleton
/// (already present on any current Sepolia RPC; no archive/paid RPC required).
/// @dev Every SystemConfig role is the same single deployer address on purpose — this is a
/// throwaway local fork, not a real deployment, so there's no reason to juggle separate role
/// keys. That address also becomes `postman`, so the e2e suite's ASP writer can sign
/// `updateASPRoot` directly instead of needing `anvil_impersonateAccount`.
/// @dev Inherits `Deploy` (rather than `new Deploy()`-ing a separate instance, as
/// `test/invariant/Setup.sol` does in a non-broadcast test context) and calls its internal
/// `_deploy`/`_transferAdmin` helpers directly — exactly how `Deploy.run()` itself calls
/// `fullDeploy()`. Deploying a *separate* `Deploy` instance while broadcasting would try to
/// actually put that ~165KB script contract on-chain (over EIP-170's 24576-byte limit) — `Deploy`
/// (the script) is never meant to be a deployed contract, only the individual contracts it
/// constructs are.
/// @dev Deliberately does NOT call `deployWithConfig` (the shape this otherwise mirrors): that
/// wrapper passes `address(this)` as the temp admin, which forge's broadcast safety check rejects
/// ("Usage of `address(this)` detected in script contract... ephemeral") — it's a genuine
/// non-broadcast test entrypoint, not meant to run under `vm.startBroadcast()`. `_deploy`/
/// `_transferAdmin` take an explicit `_tempAdmin` address instead (this script's real deployer),
/// which is what makes `run()`'s own broadcast path safe — same fix, applied here directly.
/// @dev `run()` is deliberately not reused as the entrypoint name: it's declared on `Deploy`
/// without `virtual`, so a subclass can't override it. Invoke with `--sig "runLocal()"`.
/// Env: PRIVATE_KEY (deployer/postman, e.g. the e2e suite's own fixed test key).
/// Usage: forge script script/DeployE2ELocal.s.sol --sig "runLocal()" --rpc-url <local fork> \
///   --broadcast \
///   --libraries poseidon-solidity/PoseidonT3.sol:PoseidonT3:0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93 \
///   --libraries poseidon-solidity/PoseidonT4.sol:PoseidonT4:0x4443338EF595F44e0121df4C21102677B142ECF0
/// (see script/README.md's "Poseidon Library Linking" section for why those two flags are required —
/// PoolVault/Keystore link against PoseidonT3/PoseidonT4, which also exceed the 24576-byte limit and
/// must resolve to their canonical, already-deployed CREATE2 addresses instead of being deployed fresh.)
contract DeployE2ELocal is Deploy {
  function runLocal() external returns (Deployment memory _deployment) {
    uint256 _pk = vm.envUint('PRIVATE_KEY');
    address _deployer = vm.addr(_pk);

    SystemConfig memory _cfg = _buildLocalConfig(_deployer);
    DeploymentVerifier.validateSystemConfig(_cfg);

    vm.startBroadcast(_pk);
    _deployment = _deploy(_cfg, _deployer);
    _deployment.deployer = _deployer;

    // `_deploy` alone (unlike `fullDeploy`'s Step 8) never configures any assets — `_deployer`
    // already permanently holds ENTRYPOINT_MANAGER_ROLE (it IS `_cfg.entrypointManager`, and
    // `_transferAdmin` below never touches that role), so no temporary-role dance is needed here,
    // unlike `_configureAssets`'s general case. Only native ETH: it's the only asset this e2e
    // suite's flow (packages/evm-sdk/e2e/evm-e2e.test.ts) exercises. Same config values as
    // `ChainAssetRegistry._sepoliaConfig()`'s real ETH entry.
    _deployment.entrypoint
      .setAssetConfiguration(
        Constants.NATIVE_ASSET,
        IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
      );

    _transferAdmin(_deployment.accessRouter, _cfg, _deployer);
    vm.stopBroadcast();

    DeploymentVerifier.verifyDeployment(_deployment, _cfg, _deployer);

    console2.log('ACCESSROUTER', address(_deployment.accessRouter));
    console2.log('KEYSTORE', address(_deployment.keystore));
    console2.log('ASPREGISTRY', address(_deployment.aspRegistry));
    console2.log('POOLVAULT', address(_deployment.poolVault));
    console2.log('ENTRYPOINT', address(_deployment.entrypoint));
    console2.log('PRIVACYPOOLRELAY', address(_deployment.relay));
    console2.log('POSTMAN', _deployer);
    console2.log('DEPLOYBLOCK', block.number);
  }

  /// @dev Mirrors test/invariant/Setup.sol's `_buildInvariantConfig` — same shape, but every
  /// role resolves to a real address (the deployer) instead of a `makeAddr` cheatcode-only one,
  /// since this runs as a real broadcast against a live (forked) chain, not inside a forge test.
  function _buildLocalConfig(address _deployer) internal pure returns (SystemConfig memory _cfg) {
    bytes32[] memory _opsRoles = new bytes32[](3);
    _opsRoles[0] = PAUSER_ROLE;
    _opsRoles[1] = ENTRYPOINT_MANAGER_ROLE;
    _opsRoles[2] = POSTMAN_ROLE;

    address[] memory _pausers = new address[](1);
    _pausers[0] = _deployer;
    address[] memory _unpausers = new address[](1);
    _unpausers[0] = _deployer;

    _cfg = SystemConfig({
      defaultAdmin: _deployer,
      opsAdmin: _deployer,
      opsAdminRoles: _opsRoles,
      upgrader: _deployer,
      pausers: _pausers,
      unpausers: _unpausers,
      entrypointManager: _deployer,
      postman: _deployer,
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }
}
