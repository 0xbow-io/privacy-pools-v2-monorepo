// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;
import {IntegrationBase} from './IntegrationBase.t.sol';
import {Deploy} from 'script/Deploy.s.sol';
import {DeploymentVerifier} from 'script/helpers/DeploymentVerifier.sol';
import {ChainAssets} from 'script/registries/ChainAssetRegistry.sol';
import {SystemConfig} from 'script/registries/ChainConfigRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';

contract AuthTypeIntegration is IntegrationBase {
  /// @dev do NOT invoke setup, as that would cause a default deployment
  function setUp() public override {}

  function test_sepolia_newDeploymentChecks() external {
    vm.createSelectFork('sepolia', SEPOLIA_V9_DEPLOYMENT_BLOCK);
    assertEq(block.chainid, 11_155_111, 'sanity check on chainid');
    Deploy deployer = new Deploy();
    SystemConfig memory _harcodedConfig = _configForChain(block.chainid);
    ChainAssets memory _assets = _assetsForChain(block.chainid);

    // pre-deployment checks. No need to execute them _before_ deployment, but
    // they can prevent us from deploying a known invalid config
    DeploymentVerifier.validateSystemConfig(_harcodedConfig);
    DeploymentVerifier.validateChainAssets(_assets);

    (Deployment memory _deployment, SystemConfig memory _storedConfig) = deployer.fullDeploy(address(deployer));

    // Sanity checks on performed deployment
    DeploymentVerifier.verifyDeployment(_deployment, _storedConfig, address(deployer));
    DeploymentVerifier.verifyAssets(_deployment, _assets);
  }

  // TODO: make a similar one for mainnet after the mainnet deploy
  function test_sepolia_existingDeploymentChecks() external {
    vm.createSelectFork('sepolia', SEPOLIA_V9_DEPLOYMENT_BLOCK);
    assertEq(block.chainid, 11_155_111, 'sanity check on chainid');
    SystemConfig memory _storedConfig = _configForChain(block.chainid);
    ChainAssets memory _assets = _assetsForChain(block.chainid);
    (Deployment memory _deployment) = _deploymentForChain(block.chainid);

    // deployment has already been done, so we don all checks at the same time
    DeploymentVerifier.validateSystemConfig(_storedConfig);
    DeploymentVerifier.validateChainAssets(_assets);
    DeploymentVerifier.verifyDeployment(_deployment, _storedConfig, _deployment.deployer);
    DeploymentVerifier.verifyAssets(_deployment, _assets);
  }

  /// @dev ensure the environment integration tests are run in also complies
  /// with the deployent sanity checks
  /// TODO: re-enable when properly setting deployment params
  function test_default_setUpDeploymentChecks() external {
    vm.skip(true);
    vm.createSelectFork('mainnet', MAINNET_FORK_BLOCK);
    SystemConfig memory _storedConfig = _configForChain(MAINNET_CHAIN_ID);
    ChainAssets memory _assets = _assetsForChain(MAINNET_CHAIN_ID);

    DeploymentVerifier.validateSystemConfig(_storedConfig);
    DeploymentVerifier.validateChainAssets(_assets);

    super.setUp();
    assertEq(block.chainid, MAINNET_CHAIN_ID, 'sanity check on chainid: tests run on mainnet');

    DeploymentVerifier.validateGovernanceConfig(_governanceForChain(block.chainid));
    // storage config object set by fulldeploy
    DeploymentVerifier.verifyDeployment(_deployment, _config, _deployment.deployer);
    DeploymentVerifier.verifyAssets(_deployment, _assets);
  }

  /// @dev run() — the broadcast entrypoint (`forge script Deploy --broadcast`) — must reject an invalid or
  /// placeholder config BEFORE deploying, so a misconfigured mainnet launch can never ship (finding #131 / AW-M-01).
  /// This is the regression guard for the DeploymentVerifier validators being wired into run(): deleting them
  /// (validation used to live nowhere on the broadcast path) makes this test fail. The mainnet ChainConfig ships
  /// placeholder governance/ops addresses, so run()'s pre-flight validateSystemConfig reverts before any broadcast.
  function test_run_revertsOnPlaceholderMainnetConfig() external {
    vm.createSelectFork('mainnet', MAINNET_FORK_BLOCK);
    assertEq(block.chainid, MAINNET_CHAIN_ID, 'sanity check on chainid: mainnet fork');
    Deploy deployer = new Deploy();
    vm.expectRevert(bytes('DeploymentVerifier: opsAdmin is precompile/placeholder'));
    deployer.run();
  }
}
