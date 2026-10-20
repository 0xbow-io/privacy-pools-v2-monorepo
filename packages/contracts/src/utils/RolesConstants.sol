// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

/// @dev Default-tier admin role. Intended to be held by **Canon Guard** (external timelock governance),
///      not by an on-chain timelock implemented inside this repo's contracts.
bytes32 constant DEFAULT_ADMIN_ROLE = 0x00;

/// @dev Operational-tier admin. Intended for a fast multisig that is **not** subject to Canon Guard's timelock.
bytes32 constant OPS_ADMIN_ROLE = keccak256('OPS_ADMIN_ROLE');

/// @dev Role for authorizing UUPS proxy upgrades. Tier assignment is configurable at deploy time — see Deploy.s.sol
bytes32 constant UPGRADER_ROLE = keccak256('UPGRADER_ROLE');

/// @dev Role for pausing protocol operations
bytes32 constant PAUSER_ROLE = keccak256('PAUSER_ROLE');

/// @dev Role for unpausing protocol operations
bytes32 constant UNPAUSER_ROLE = keccak256('UNPAUSER_ROLE');

/// @dev Role for managing Entrypoint asset configurations
bytes32 constant ENTRYPOINT_MANAGER_ROLE = keccak256('ENTRYPOINT_MANAGER_ROLE');

/// @dev Role for depositing into the PoolVault on behalf of users
bytes32 constant DEPOSITOR_ROLE = keccak256('DEPOSITOR_ROLE');

/// @dev Role for submitting ASP root updates and relay proof batches
bytes32 constant POSTMAN_ROLE = keccak256('POSTMAN_ROLE');
