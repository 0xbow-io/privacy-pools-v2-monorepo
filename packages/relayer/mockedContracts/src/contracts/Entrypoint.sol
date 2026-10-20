// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.25;

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';

contract Entrypoint is  IEntrypoint {
  /// @inheritdoc IEntrypoint
    mapping(address _asset => AssetConfig _config) public assetConfig;

    address public ethereumAsset = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address public usdcAsset = 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238;
    address public usdtAsset = 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0;

    constructor(
                uint256 maxFee
    ) {
        AssetConfig memory eth = AssetConfig(ethereumAsset, 1000, 100, maxFee);
        AssetConfig memory usdc = AssetConfig(usdcAsset, 100, 10, maxFee);
        AssetConfig memory usdt = AssetConfig(usdtAsset, 100, 10, maxFee);
        assetConfig[ethereumAsset] = eth;
        assetConfig[usdtAsset] = usdt;
        assetConfig[usdcAsset] = usdc;
    }

    function assets(address _asset) public view returns ( AssetConfig memory _output ) {
       _output = assetConfig[_asset];
    }
}
