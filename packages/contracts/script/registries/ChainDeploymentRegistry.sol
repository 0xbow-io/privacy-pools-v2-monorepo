// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';
import {ISafe} from '@safe-smart-account/interfaces/ISafe.sol';

import {IASPRegistry} from 'interfaces/IASPRegistry.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IKeystore} from 'interfaces/IKeystore.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {IPrivacyPoolRelay} from 'interfaces/IPrivacyPoolRelay.sol';

/// @notice Full deployment output — every contract address the system needs
struct Deployment {
  IAccessControl accessRouter;
  IASPRegistry aspRegistry;
  IEntrypoint entrypoint;
  IKeystore keystore;
  IPoolVault poolVault;
  IPrivacyPoolRelay relay;
  ISafe canonGuardSafe;
  address deployer;
}

/// @title ChainDeploymentRegistry
/// @notice Per-chain deployed contract addresses — kept separate from deploy logic so
///         operational scripts (redeploy verifiers, configure assets, etc.) can resolve
///         targets by chain ID without hardcoding addresses in each script.
///
/// @dev To add a new chain:
///   1. Add a `_<chain>Deployment()` function returning a populated `Deployment`
///   2. Add an `if` branch in `_deploymentForChain()` keyed on chain ID
///
/// To update addresses after a redeployment:
///   Edit the relevant `_<chain>Deployment()` function with the new proxy addresses.
///   `Deploy.run()` also logs paste-ready lines for this file after a broadcast deploy.
contract ChainDeploymentRegistry {
  /*///////////////////////////////////////////////////////////////
                      SEPOLIA (chainId 11155111)
  ///////////////////////////////////////////////////////////////*/

  function _sepoliaDeployment() internal pure returns (Deployment memory _d) {
    _d.accessRouter = IAccessControl(0xfe61D9D43418e23e2Add1069D1A8CcA4fd3906A2);
    _d.aspRegistry = IASPRegistry(0x35D29EFDCf067599ab4A53cf40229477f0b1cA9c);
    _d.entrypoint = IEntrypoint(0xEB3e3961008952348445513e418ad6F43C23ca9a);
    _d.keystore = IKeystore(0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73);
    _d.poolVault = IPoolVault(0x09b94d3127019298757A6ceeB7911922085f7C01);
    _d.relay = IPrivacyPoolRelay(0x762665Dc7aAeeA25DC1759AEBef1F61730497f6e);
    _d.canonGuardSafe = ISafe(0xD9BaFC442C00bAd122802b38498c8a39CBA1697e);
    _d.deployer = 0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39;
  }

  /*///////////////////////////////////////////////////////////////
                   ARBITRUM (chainId 42161)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Staging deployment (2026-07-10), EOA-governed — no Canon Guard Safe.
  function _arbitrumDeployment() internal pure returns (Deployment memory _d) {
    _d.accessRouter = IAccessControl(0x2409a0bE47272C036B0deebCadc3683C3411E258);
    _d.aspRegistry = IASPRegistry(0x75A93132393a6956A1F354176c0aab6917ec05cf);
    _d.entrypoint = IEntrypoint(0xa845D793C0D01ba8803A49a3d17c749Fef781D51);
    _d.keystore = IKeystore(0x813eb92c6217e0447601f6463A2A83304108f1fD);
    _d.poolVault = IPoolVault(0xFf11c6d8e4176f0987FEf10cC904A5D3eeDCbB51);
    _d.relay = IPrivacyPoolRelay(0xE9D64494021257849F96F8F00e59D42B67EF22C2);
    _d.canonGuardSafe = ISafe(address(0));
    _d.deployer = 0xcF38221886f36522dA520669ACc24E32cE5E4f2c;
  }

  /*///////////////////////////////////////////////////////////////
                      BASE (chainId 8453)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Staging deployment (2026-08-12), EOA-governed — no Canon Guard Safe.
  function _baseDeployment() internal pure returns (Deployment memory _d) {
    _d.accessRouter = IAccessControl(0x5F14bF01171E74024D8196b8ffe00cec8098064A);
    _d.aspRegistry = IASPRegistry(0x554996AEe52b284F1a695C77009D67a468ee9130);
    _d.entrypoint = IEntrypoint(0xe7fd6c857639E3a7cCf3Cd765B5816Cfc95C0890);
    _d.keystore = IKeystore(0x249661AA9929F02b19dCa2fb04430Bad3655E893);
    _d.poolVault = IPoolVault(0xE10c77548c31356805597Fc2c8430aB5b6Dfb56A);
    _d.relay = IPrivacyPoolRelay(0x6996F478DF754Dc65bB437dc2df4272AFD647dB2);
    _d.canonGuardSafe = ISafe(address(0));
    _d.deployer = 0xa60748B7E7BBdE1D97b5c258f1b317E748E6FccF;
  }

  /*///////////////////////////////////////////////////////////////
    MAINNET (chainId 1)
  ///////////////////////////////////////////////////////////////*/

  function _mainnetDeployment() internal pure returns (Deployment memory) {
    revert('ChainDeploymentRegistry: mainnet not deployed yet');
  }

  /*///////////////////////////////////////////////////////////////
                          CHAIN RESOLVER
  ///////////////////////////////////////////////////////////////*/

  /// @dev Returns the deployed addresses for the given chain ID.
  ///      Reverts for unknown or unpopulated chains.
  function _deploymentForChain(uint256 _chainId) internal pure returns (Deployment memory _d) {
    if (_chainId == 11_155_111) _d = _sepoliaDeployment();
    else if (_chainId == 1) _d = _mainnetDeployment();
    else if (_chainId == 42_161) _d = _arbitrumDeployment();
    else if (_chainId == 8453) _d = _baseDeployment();
    else revert('ChainDeploymentRegistry: unsupported chain');

    require(address(_d.poolVault) != address(0), 'ChainDeploymentRegistry: PoolVault not set for this chain');
    require(address(_d.accessRouter) != address(0), 'ChainDeploymentRegistry: AccessRouter not set for this chain');
    require(address(_d.aspRegistry) != address(0), 'ChainDeploymentRegistry: ASPRegistry not set for this chain');
    require(address(_d.entrypoint) != address(0), 'ChainDeploymentRegistry: Entrypoint not set for this chain');
    require(address(_d.keystore) != address(0), 'ChainDeploymentRegistry: Keystore not set for this chain');
    require(address(_d.relay) != address(0), 'ChainDeploymentRegistry: Relay not set for this chain');
  }
}
