// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';
import {console} from 'forge-std/Script.sol';

import {Deploy} from 'script/Deploy.s.sol';
import {ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {GovernanceConfig, SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';

/// @title DeployStaging
/// @notice Staging deployment entrypoint for chains without a Canon Guard factory (e.g. Base, Arbitrum).
///
/// @dev Identical to `Deploy.run()` except that the Canon Guard Safe step is skipped when
///      `_canonGuardFactoryForChain()` returns `address(0)`. In that case `defaultAdmin` and
///      `upgrader` come directly from the registry (EOA governance — staging only, not
///      production-grade). `Deploy.run()` is left untouched so its guardrails remain in place
///      for production chains.
///
/// Usage: forge script DeployStaging --sig "runStaging()" --rpc-url $RPC --account $DEPLOYER_NAME \
///          --libraries poseidon-solidity/PoseidonT3.sol:PoseidonT3:0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93 \
///          --libraries poseidon-solidity/PoseidonT4.sol:PoseidonT4:0x4443338EF595F44e0121df4C21102677B142ECF0 \
///          --broadcast -vvvvv
contract DeployStaging is Deploy {
  function runStaging() external returns (Deployment memory _deployment) {
    SystemConfig memory _config = _configForChain(block.chainid);
    ChainAssets memory _assets = _assetsForChain(block.chainid);

    vm.startBroadcast();

    // Step 0: Deploy Canon Guard Safe only if a factory is registered for this chain.
    //         On staging chains (Base, Arbitrum) the factory is address(0): skip Safe deployment
    //         and use defaultAdmin/upgrader from the registry as-is (EOA governance, staging only).
    address _canonGuardSafeAddr;
    if (_canonGuardFactoryForChain(block.chainid) != address(0)) {
      GovernanceConfig memory _gov = _governanceForChain(block.chainid);
      _canonGuardSafeAddr = _deployCanonGuardSafe(_gov);
      _config.defaultAdmin = _canonGuardSafeAddr;
      _config.upgrader = _canonGuardSafeAddr;
    } else {
      console.log('WARNING: no Canon Guard factory on this chain - EOA governance from registry (staging only)');
    }

    // Steps 1-7: Deploy all protocol contracts
    _deployment = _deploy(_config, msg.sender);
    _deployment.canonGuardSafe = ISafe(_canonGuardSafeAddr);
    _deployment.deployer = msg.sender;

    // Step 8: Configure assets
    _configureAssets({
      _entrypoint: _deployment.entrypoint,
      _accessRouter: _deployment.accessRouter,
      _chain: _assets,
      _deployer: msg.sender,
      _entrypointManager: _config.entrypointManager
    });

    // Step 9: Transfer admin roles
    _transferAdmin(_deployment.accessRouter, _config, msg.sender);

    vm.stopBroadcast();

    _logDeployment(_deployment, _config, _canonGuardSafeAddr);
  }
}
