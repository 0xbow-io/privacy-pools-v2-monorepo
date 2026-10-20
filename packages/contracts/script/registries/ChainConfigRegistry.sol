// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ENTRYPOINT_MANAGER_ROLE, PAUSER_ROLE, POSTMAN_ROLE} from 'src/utils/RolesConstants.sol';

/// @notice Per-chain system configuration consumed by the deploy script.
///         See RolesConstants.sol for role definitions.
struct SystemConfig {
  address defaultAdmin;
  address opsAdmin;
  bytes32[] opsAdminRoles;
  address upgrader;
  address[] pausers;
  address[] unpausers;
  address entrypointManager;
  address postman;
  uint32 rootHistorySize;
  uint256 keystoreRootLiveness;
  uint256 maxKeystoreTreeSize;
  uint256 maxStateTreeSize;
}

/// @notice Canon Guard Safe governance configuration.
///         The deploy script creates a Gnosis Safe with Canon Guard installed,
///         then uses the Safe address as `defaultAdmin` and `upgrader` in `SystemConfig`.
struct GovernanceConfig {
  address[] owners;
  uint256 threshold;
  uint256 shortDelay;
  uint256 longDelay;
  uint256 expiryDelay;
  uint256 maxApprovalDuration;
  address emergencyCaller;
  address emergencyTrigger;
}

// Per-chain Canon Guard factory addresses.
//
// Both chains now use the same factory ABI (`ICanonGuardFactory`); CreateX did not land
// the two deployments at the same address, so we keep one constant per chain.
address constant CANON_GUARD_FACTORY_MAINNET = 0x656c264F914bd8Fe7bbAfb9B4F2EBcB4f259F67C;
address constant CANON_GUARD_FACTORY_SEPOLIA = 0x8147ddba5949e05280BC4a97D6B844d539599a42;

/// @title ChainConfigRegistry
/// @notice Per-chain system configuration for Privacy Pools V2 deployments.
///         Inherit this in the deploy script to keep config data separate from deploy logic.
///
/// @dev To add a new chain:
///   1. Add `_<chain>Config()` returning `SystemConfig`
///   2. Add `_<chain>Governance()` returning `GovernanceConfig`
///   3. Add `if` branches in `_configForChain()` and `_governanceForChain()`
contract ChainConfigRegistry {
  /*///////////////////////////////////////////////////////////////
                      DEFAULT OPS-ADMIN ROLES
  ///////////////////////////////////////////////////////////////*/

  /// @dev Roles delegated to `OPS_ADMIN_ROLE` by default.
  ///      Override in a per-chain config when customisation is needed.
  function _defaultOpsAdminRoles() internal pure returns (bytes32[] memory) {
    return _roles(PAUSER_ROLE, ENTRYPOINT_MANAGER_ROLE, POSTMAN_ROLE);
  }

  /*///////////////////////////////////////////////////////////////
                      SEPOLIA (chainId 11155111)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Sepolia config — `defaultAdmin` and `upgrader` are set to the Canon Guard Safe at
  ///      deploy time (see `Deploy.fullDeploy`), so they're left as `address(0)` here. After
  ///      deploy, update them with the live Safe address so this registry mirrors on-chain state.
  function _sepoliaConfig() internal pure returns (SystemConfig memory _config) {
    _config = SystemConfig({
      defaultAdmin: 0xD9BaFC442C00bAd122802b38498c8a39CBA1697e,
      opsAdmin: 0x6a3452F47Cc3a881bff24F08ab242AB0c44e2916,
      opsAdminRoles: _defaultOpsAdminRoles(),
      upgrader: 0xD9BaFC442C00bAd122802b38498c8a39CBA1697e,
      pausers: _addrs(0x0AaF0241dDC869944e30a5e93469F36F3bad1d06, 0x71a2088Ad5D17f401EAcF579fb6198F07f7Eda03),
      unpausers: _addrs(0x1eDC0c3b058e55d16e7986a4307477068875AD75),
      entrypointManager: 0x295C28a0fAd0D79Ed72268d17139Fc367eDf2049,
      postman: 0x723a43064e73Bcf46cf7d9b8506C400Df8ac878b,
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }

  /*///////////////////////////////////////////////////////////////
                        MAINNET (chainId 1)
  ///////////////////////////////////////////////////////////////*/

  /// TODO: replace placeholders with real addresses. There are skipped integration tests intending to make this more evident
  /// @dev Mainnet config — placeholder addresses until real multisigs are provisioned.
  ///      `defaultAdmin` and `upgrader` are set to the Canon Guard Safe during deploy (see
  ///      `Deploy.run()`), so their values here are ignored. After deploy, update them with the
  ///      actual Safe address so this registry reflects the live state.
  function _mainnetConfig() internal pure returns (SystemConfig memory _config) {
    _config = SystemConfig({
      defaultAdmin: address(0), // set by Canon Guard Safe deployment — update here after deploy
      opsAdmin: address(9), // TODO: replace with ops multisig
      opsAdminRoles: _defaultOpsAdminRoles(),
      upgrader: address(0), // set by Canon Guard Safe deployment — update here after deploy
      pausers: _addrs(address(3), address(4)), // TODO: replace with real pausers
      unpausers: _addrs(address(5)), // TODO: replace with real unpausers
      entrypointManager: address(6), // TODO: replace with real operator
      postman: address(7), // TODO: replace with real postman
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }

  /*///////////////////////////////////////////////////////////////
                        ARBITRUM (chainId 42161)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Arbitrum staging config — a single operator EOA holds every role.
  ///      No Canon Guard factory exists on Arbitrum (`_canonGuardFactoryForChain` returns
  ///      address(0)), so `Deploy.run()` skips the Safe and uses these values as-is. NOT a
  ///      production-grade setup: the spec requires distinct multisigs for upgrade
  ///      and emergency-pause authority before a real mainnet launch.
  function _arbitrumConfig() internal pure returns (SystemConfig memory _config) {
    address _operator = 0x0967755AfA2016866D12EefB820705026842dCe8;
    _config = SystemConfig({
      defaultAdmin: _operator,
      opsAdmin: _operator,
      opsAdminRoles: _defaultOpsAdminRoles(),
      upgrader: _operator,
      pausers: _addrs(_operator),
      unpausers: _addrs(_operator),
      entrypointManager: _operator,
      postman: _operator,
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }

  /*///////////////////////////////////////////////////////////////
                        BASE (chainId 8453)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Base staging config — a single operator EOA holds every role.
  ///      No Canon Guard factory exists on Base (`_canonGuardFactoryForChain` returns
  ///      address(0)), so `Deploy.run()` skips the Safe and uses these values as-is. NOT a
  ///      production-grade setup: the spec requires distinct multisigs for upgrade
  ///      and emergency-pause authority before a real mainnet launch.
  function _baseConfig() internal pure returns (SystemConfig memory _config) {
    address _operator = 0x0967755AfA2016866D12EefB820705026842dCe8;
    _config = SystemConfig({
      defaultAdmin: _operator,
      opsAdmin: _operator,
      opsAdminRoles: _defaultOpsAdminRoles(),
      upgrader: _operator,
      pausers: _addrs(_operator),
      unpausers: _addrs(_operator),
      entrypointManager: _operator,
      postman: _operator,
      rootHistorySize: 16,
      keystoreRootLiveness: 1200,
      maxKeystoreTreeSize: 262_144, // 2**18
      maxStateTreeSize: 4_194_304 // 2**22
    });
  }

  /*///////////////////////////////////////////////////////////////
                  GOVERNANCE CONFIG (Canon Guard Safe)
  ///////////////////////////////////////////////////////////////*/

  /// TODO: replace placeholders with real addresses. There are skipped integration tests intending to make this more evident
  /// @dev Mainnet governance — placeholder addresses until real Safe owners are provisioned.
  function _mainnetGovernance() internal pure returns (GovernanceConfig memory _gov) {
    _gov = GovernanceConfig({
      owners: _addrs(address(0xA11CE)), // TODO: replace with real Safe owners
      threshold: 1, // TODO: raise to final multisig threshold
      shortDelay: 1 hours,
      longDelay: 7 days,
      expiryDelay: 7 days,
      maxApprovalDuration: 30 days,
      emergencyCaller: address(0xdead), // TODO: replace with real emergency caller
      emergencyTrigger: address(0xbeef) // TODO: replace with real emergency trigger
    });
  }

  /// TODO: replace placeholders with real addresses. There are skipped integration tests intending to make this more evident
  /// @dev Sepolia governance — placeholder addresses until real Safe owners are provisioned.
  function _sepoliaGovernance() internal pure returns (GovernanceConfig memory _gov) {
    address[] memory _owners = new address[](3);
    _owners[0] = 0xaD9Ac10E4c9cc4F32AC2c19B6b0A2451688D3C39;
    _owners[1] = 0x671929c369740A3B16721b2a0a8abDB51257A683;
    _owners[2] = 0x583B46C38829729518d6c389f9f31965E46ee0aa;
    _gov = GovernanceConfig({
      owners: _owners,
      threshold: 2,
      shortDelay: 1 hours,
      longDelay: 7 days,
      expiryDelay: 7 days,
      maxApprovalDuration: 30 days,
      emergencyCaller: 0x4FB037D0511830b70f51B6155C78fD3a29ACC792,
      emergencyTrigger: 0x045509e2c3826977cB8a57aeb441015A2b39c99d
    });
  }

  /*///////////////////////////////////////////////////////////////
                        CHAIN RESOLVER
  ///////////////////////////////////////////////////////////////*/

  /// @dev Returns the system config for the given chain ID. Reverts for unsupported chains.
  ///      Every supported chain runs Canon Guard, so the deploy script always overwrites
  ///      `defaultAdmin` and `upgrader` with the Canon Guard Safe address — the registry's
  ///      values for those two fields are placeholders and must be left as `address(0)`.
  function _configForChain(uint256 _chainId) internal pure returns (SystemConfig memory) {
    if (_chainId == 11_155_111) return _sepoliaConfig();
    if (_chainId == 1) return _mainnetConfig();
    if (_chainId == 42_161) return _arbitrumConfig();
    if (_chainId == 8453) return _baseConfig();
    revert('ChainConfigRegistry: unsupported chain');
  }

  /// @dev Returns the governance (Canon Guard Safe) config for the given chain ID.
  function _governanceForChain(uint256 _chainId) internal pure returns (GovernanceConfig memory) {
    if (_chainId == 11_155_111) return _sepoliaGovernance();
    if (_chainId == 1) return _mainnetGovernance();
    revert('ChainConfigRegistry: unsupported chain');
  }

  /// @dev Returns the `CanonGuardFactory` address deployed on the given chain.
  /// @param _chainId The chain ID to resolve.
  function _canonGuardFactoryForChain(uint256 _chainId) internal pure returns (address) {
    if (_chainId == 1) return CANON_GUARD_FACTORY_MAINNET;
    if (_chainId == 11_155_111) return CANON_GUARD_FACTORY_SEPOLIA;
    if (_chainId == 42_161) return address(0); // Arbitrum staging: no Canon Guard, EOA governance
    if (_chainId == 8453) return address(0); // Base staging: no Canon Guard, EOA governance
    revert('ChainConfigRegistry: no CanonGuardFactory for chain');
  }

  /*///////////////////////////////////////////////////////////////
                        ARRAY HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _roles(bytes32 _a, bytes32 _b, bytes32 _c) internal pure returns (bytes32[] memory _r) {
    _r = new bytes32[](3);
    _r[0] = _a;
    _r[1] = _b;
    _r[2] = _c;
  }

  function _addrs(address _a) internal pure returns (address[] memory _r) {
    _r = new address[](1);
    _r[0] = _a;
  }

  function _addrs(address _a, address _b) internal pure returns (address[] memory _r) {
    _r = new address[](2);
    _r[0] = _a;
    _r[1] = _b;
  }
}
