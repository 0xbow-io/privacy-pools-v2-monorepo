// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Script, console} from 'forge-std/Script.sol';

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {IDepositVerifier} from 'interfaces/IDepositVerifier.sol';
import {IPermissioned} from 'interfaces/IPermissioned.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IRagequitVerifier} from 'interfaces/IRagequitVerifier.sol';
import {ITransactVerifierRouter} from 'interfaces/ITransactVerifierRouter.sol';
import {AllTransactVerifiers} from 'script/helpers/AllTransactVerifiers.sol';
import {UPGRADER_ROLE} from 'utils/RolesConstants.sol';

/// @notice Deploys all 27 verifiers (deposit, ragequit and transact 1x1..5x5) from the circuit keys
///   committed in packages/circuits/build and points an existing PoolVault at them.
/// @dev Required whenever the proving/verification keys change (e.g. dev keys -> trusted-setup ceremony
///   keys), since every verifier contract embeds its verification key. RedeployTransactVerifiers only
///   covers the 25 transact verifiers. The PoolVault is passed explicitly because the production stack
///   (same address on every production chain) is not in ChainDeploymentRegistry. The broadcaster must
///   hold UPGRADER_ROLE on the PoolVault's AccessRouter.
///
///   forge script script/RotateVerifiers.s.sol --sig 'run(address)' <poolVault> \
///     --rpc-url $RPC --account <keystore account> --broadcast -vvvv
contract RotateVerifiers is Script, AllTransactVerifiers {
  /*///////////////////////////////////////////////////////////////
                        SCRIPT ENTRYPOINTS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Production entrypoint. Only the deploys and setter calls are broadcast; the pre-flight
  ///   role check and the post-rotation read-back are view calls.
  /// @param _poolVault The PoolVault to rotate
  function run(IPoolVault _poolVault) external {
    require(address(_poolVault).code.length != 0, 'RotateVerifiers: PoolVault has no code');
    _checkUpgraderRole(_poolVault);

    vm.startBroadcast();
    (
      IDepositVerifier _depositVerifier,
      IRagequitVerifier _ragequitVerifier,
      ITransactVerifierRouter.VerifierConfig[] memory _transactConfigs
    ) = rotate(_poolVault);
    vm.stopBroadcast();

    _verifyRotation({
      _poolVault: _poolVault,
      _depositVerifier: _depositVerifier,
      _ragequitVerifier: _ragequitVerifier,
      _transactConfigs: _transactConfigs
    });
  }

  /// @notice Deploys the 27 verifiers and configures them on the PoolVault.
  ///   Called directly by tests, or wrapped in broadcast by run().
  /// @param _poolVault The PoolVault to rotate
  /// @return _depositVerifier The new deposit verifier
  /// @return _ragequitVerifier The new ragequit verifier
  /// @return _transactConfigs The new transact verifier configs, 1x1..5x5
  function rotate(IPoolVault _poolVault)
    public
    returns (
      IDepositVerifier _depositVerifier,
      IRagequitVerifier _ragequitVerifier,
      ITransactVerifierRouter.VerifierConfig[] memory _transactConfigs
    )
  {
    _depositVerifier = IDepositVerifier(vm.deployCode('VerifierArtifacts.sol:DepositVerifier'));
    _ragequitVerifier = IRagequitVerifier(vm.deployCode('VerifierArtifacts.sol:RagequitVerifier'));
    _transactConfigs = _allTransactVerifiers();

    // solhint-disable named-parameters-function
    console.log('Deposit:  %s -> %s', address(_poolVault.depositVerifier()), address(_depositVerifier));
    _poolVault.setDepositVerifier(_depositVerifier);
    console.log('Ragequit: %s -> %s', address(_poolVault.ragequitVerifier()), address(_ragequitVerifier));
    _poolVault.setRagequitVerifier(_ragequitVerifier);
    for (uint256 i; i < _transactConfigs.length; ++i) {
      ITransactVerifierRouter(address(_poolVault))
        .setVerifier(_transactConfigs[i].n, _transactConfigs[i].m, _transactConfigs[i].verifier);
      console.log(
        'Configured %dx%d -> %s', _transactConfigs[i].n, _transactConfigs[i].m, _transactConfigs[i].verifier.addr
      );
    }
    // solhint-enable named-parameters-function
  }

  /*///////////////////////////////////////////////////////////////
                          INTERNAL LOGIC
  ///////////////////////////////////////////////////////////////*/

  /// @dev Reverts if neither msg.sender nor this contract holds UPGRADER_ROLE.
  ///   Short-circuit: in broadcast mode msg.sender (EOA) satisfies the first
  ///   branch; in test mode the role is granted to address(this) instead.
  function _checkUpgraderRole(IPoolVault _poolVault) internal view {
    IAccessControl _accessRouter = IPermissioned(address(_poolVault)).ACCESS_ROUTER();
    require(
      _accessRouter.hasRole(UPGRADER_ROLE, msg.sender) || _accessRouter.hasRole(UPGRADER_ROLE, address(this)),
      'RotateVerifiers: caller lacks UPGRADER_ROLE'
    );
  }

  /// @dev Reads back all 27 verifier slots and asserts they point at the newly deployed contracts
  function _verifyRotation(
    IPoolVault _poolVault,
    IDepositVerifier _depositVerifier,
    IRagequitVerifier _ragequitVerifier,
    ITransactVerifierRouter.VerifierConfig[] memory _transactConfigs
  ) internal view {
    require(
      address(_poolVault.depositVerifier()) == address(_depositVerifier), 'RotateVerifiers: deposit verifier not set'
    );
    require(
      address(_poolVault.ragequitVerifier()) == address(_ragequitVerifier), 'RotateVerifiers: ragequit verifier not set'
    );
    for (uint256 i; i < _transactConfigs.length; ++i) {
      bytes32 _key = keccak256(abi.encode(uint256(_transactConfigs[i].n), uint256(_transactConfigs[i].m)));
      ITransactVerifierRouter.Verifier memory _actual = ITransactVerifierRouter(address(_poolVault)).verifiers(_key);
      require(
        _actual.addr == _transactConfigs[i].verifier.addr && _actual.selector == _transactConfigs[i].verifier.selector,
        'RotateVerifiers: transact verifier not set'
      );
    }
  }
}
