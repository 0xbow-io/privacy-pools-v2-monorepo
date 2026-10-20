// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from 'forge-std/Script.sol';

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {AllTransactVerifiers} from 'script/helpers/AllTransactVerifiers.sol';
import {ChainDeploymentRegistry} from 'script/registries/ChainDeploymentRegistry.sol';
import {Deployment} from 'script/registries/ChainDeploymentRegistry.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @notice Redeploys all 25 transact verifiers (1x1 through 5x5) and overwrites the
///   TransactVerifierRouter config on PoolVault.
/// @dev Required after any change to the Transact circuit template (Transact.circom),
///   since new proving/verification keys invalidate all existing verifier contracts.
///   The broadcaster must hold UPGRADER_ROLE on the AccessRouter.
///
///   forge script script/RedeployTransactVerifiers.s.sol \
///     --rpc-url $SEPOLIA_RPC_URL --private-key $DEPLOYER_PK --broadcast -vvvv
contract RedeployTransactVerifiers is Script, AllTransactVerifiers, ChainDeploymentRegistry {
  /*///////////////////////////////////////////////////////////////
                        SCRIPT ENTRYPOINTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Production entrypoint — resolves PoolVault from ChainDeploymentRegistry by chain ID.
  ///   Only the deploy + setVerifier calls are broadcast; pre-flight and post-deploy
  ///   verification are view calls that run off-chain.
  function run() external {
    Deployment memory _deployment = _deploymentForChain(block.chainid);

    _checkUpgraderRole(_deployment);

    vm.startBroadcast();
    ITransactVerifierRouter.VerifierConfig[] memory _configs = redeploy(_deployment.poolVault);
    vm.stopBroadcast();

    _verifyDeployment(_deployment.poolVault, _configs);
  }

  /// @notice Deploys 25 new verifier contracts and configures the router.
  ///   Called directly by tests, or wrapped in broadcast by run().
  function redeploy(IPoolVault _poolVault) public returns (ITransactVerifierRouter.VerifierConfig[] memory _configs) {
    _configs = _allTransactVerifiers();

    for (uint256 i; i < _configs.length; ++i) {
      ITransactVerifierRouter(address(_poolVault)).setVerifier(_configs[i].n, _configs[i].m, _configs[i].verifier);
      // solhint-disable-next-line named-parameters-function
      console.log('Configured %dx%d -> %s', _configs[i].n, _configs[i].m, _configs[i].verifier.addr);
    }
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL LOGIC
  ///////////////////////////////////////////////////////////////*/

  /// @dev Reverts if neither msg.sender nor this contract holds UPGRADER_ROLE.
  ///   Short-circuit: in broadcast mode msg.sender (EOA) satisfies the first
  ///   branch; in test mode the role is granted to address(this) instead.
  function _checkUpgraderRole(Deployment memory _deployment) internal view {
    IAccessControl _accessRouter = _deployment.accessRouter;
    bytes32 _role = UPGRADER_ROLE;
    require(
      _accessRouter.hasRole(_role, msg.sender) || _accessRouter.hasRole(_role, address(this)),
      'RedeployTransactVerifiers: caller lacks UPGRADER_ROLE'
    );
  }

  /// @dev Reads back all 25 verifier slots and asserts they match the newly deployed addresses
  function _verifyDeployment(
    IPoolVault _poolVault,
    ITransactVerifierRouter.VerifierConfig[] memory _configs
  ) internal view {
    for (uint256 i; i < _configs.length; ++i) {
      bytes32 _key = keccak256(abi.encode(uint256(_configs[i].n), uint256(_configs[i].m)));
      address _actual = ITransactVerifierRouter(address(_poolVault)).verifiers(_key).addr;
      require(_actual == _configs[i].verifier.addr, 'RedeployTransactVerifiers: post-deploy verification failed');
    }
  }
}
