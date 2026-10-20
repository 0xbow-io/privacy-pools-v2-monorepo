// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from 'forge-std/Script.sol';

import {DeploymentVerifier} from 'script/helpers/DeploymentVerifier.sol';
import {ChainAssetRegistry, ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {ChainConfigRegistry, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {ChainDeploymentRegistry, Deployment} from 'script/registries/ChainDeploymentRegistry.sol';

/// @title VerifyDeployment
/// @notice Standalone read-only verification of a live Privacy Pools V2 deployment.
///         Runs the same assertions that `Deploy.fullDeploy` performs at the end of a deploy,
///         but against the addresses already in `ChainDeploymentRegistry`
///
///         Usage:
///             forge script VerifyDeployment --rpc-url $RPC
///
///         Fails loud with a descriptive revert reason if any wiring is wrong. Useful for:
///           - Post-mainnet-deploy sanity check from a separate operator
///           - Re-verifying Sepolia after registry edits
///           - CI gate before promoting a deployment
contract VerifyDeployment is Script, ChainAssetRegistry, ChainConfigRegistry, ChainDeploymentRegistry {
  /// @notice Verifies the deployment registered for the current chain.
  /// @dev `view` — Forge will not broadcast, and the call costs nothing on the live chain.
  /// @return _deployment The deployment that was verified (for logging convenience)
  function run() external view returns (Deployment memory _deployment) {
    _deployment = _deploymentForChain(block.chainid);
    SystemConfig memory _config = _configForChain(block.chainid);
    ChainAssets memory _assets = _assetsForChain(block.chainid);

    DeploymentVerifier.verifyDeployment(_deployment, _config, _deployment.deployer);
    DeploymentVerifier.verifyAssets(_deployment, _assets);

    _log(_deployment, _config);
  }

  function _log(Deployment memory _deployment, SystemConfig memory _config) internal view {
    console.log('');
    console.log('=== Privacy Pools V2 - Deployment Verified (chainId %s) ===', block.chainid);
    console.log('  AccessRouter:     ', address(_deployment.accessRouter));
    console.log('  Keystore:         ', address(_deployment.keystore));
    console.log('  ASPRegistry:      ', address(_deployment.aspRegistry));
    console.log('  PoolVault:        ', address(_deployment.poolVault));
    console.log('  Entrypoint:       ', address(_deployment.entrypoint));
    console.log('  PrivacyPoolRelay: ', address(_deployment.relay));
    console.log('  Deployer:         ', _deployment.deployer);
    console.log('');
    console.log('=== Role Holders (as declared in ChainConfigRegistry) ===');
    console.log('  DEFAULT_ADMIN:       ', _config.defaultAdmin);
    console.log('  OPS_ADMIN:           ', _config.opsAdmin);
    console.log('  UPGRADER:            ', _config.upgrader);
    console.log('  ENTRYPOINT_MANAGER:  ', _config.entrypointManager);
    console.log('  POSTMAN:             ', _config.postman);
    console.log('');
    console.log('=== Canon Guard ===');
    console.log('  Canon Guard Safe:   ', address(_deployment.canonGuardSafe));
    console.log('================================================');
    console.log('');
  }
}
