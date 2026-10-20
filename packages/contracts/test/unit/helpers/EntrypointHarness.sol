// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IAccessControl} from '@openzeppelin/contracts/access/IAccessControl.sol';

import {Entrypoint} from 'contracts/Entrypoint.sol';

contract EntrypointHarness is Entrypoint {
  constructor(IAccessControl _accessRouter) Entrypoint(_accessRouter) {}

  function setAssetConfigForTesting(address _asset, AssetConfig calldata _config) external {
    _getEntrypointStorage().assetConfigs[_asset] = _config;
  }
}
