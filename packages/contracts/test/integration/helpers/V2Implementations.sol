// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';

import {ASPRegistry} from 'contracts/ASPRegistry.sol';
import {Entrypoint} from 'contracts/Entrypoint.sol';
import {Keystore} from 'contracts/Keystore.sol';
import {PoolVault} from 'contracts/PoolVault.sol';

contract PoolVaultV2 is PoolVault {
  constructor(IAccessControl _accessRouter) PoolVault(_accessRouter) {}

  function version() external pure returns (uint256) {
    return 2;
  }
}

contract EntrypointV2 is Entrypoint {
  constructor(IAccessControl _accessRouter) Entrypoint(_accessRouter) {}

  function version() external pure returns (uint256) {
    return 2;
  }
}

contract KeystoreV2 is Keystore {
  constructor(IAccessControl _accessRouter) Keystore(_accessRouter) {}

  function version() external pure returns (uint256) {
    return 2;
  }
}

contract ASPRegistryV2 is ASPRegistry {
  constructor(IAccessControl _accessRouter) ASPRegistry(_accessRouter) {}

  function version() external pure returns (uint256) {
    return 2;
  }
}
