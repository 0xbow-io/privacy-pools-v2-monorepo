// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {Constants} from 'src/utils/Constants.sol';

/// @notice Per-chain asset list — kept separate from SystemConfig so adding new assets
///         (or new chains) is a localized change without touching role wiring or deploy logic.
struct ChainAssets {
  AssetEntry[] assets;
}

/// @notice Single asset to configure on the Entrypoint after deployment
struct AssetEntry {
  address token;
  string label;
  IEntrypoint.AssetConfig config;
}

/// @title ChainAssetRegistry
/// @notice Registry of per-chain asset configurations for Privacy Pools V2 deployments.
///         Inherit this in the deploy script to keep asset data separate from deploy logic.
///
/// @dev To add a new asset: append an `AssetEntry` in the relevant `_<chain>Assets()` function.
///
/// To add a new chain:
///   1. Add a `_<chain>Assets()` function returning a `ChainAssets` struct
///   2. Add an `if` branch in `_assetsForChain()` keyed on chain ID
///   3. Add the RPC and deployer name to `.env.example` and `foundry.toml`
contract ChainAssetRegistry {
  /*///////////////////////////////////////////////////////////////
                          SEPOLIA (chainId 11155111)
  ///////////////////////////////////////////////////////////////*/

  function _sepoliaAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](3);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _entries[1] = AssetEntry({
      token: 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238,
      label: 'USDC (Circle)',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _entries[2] = AssetEntry({
      token: 0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0,
      label: 'USDT (Aave)',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });

    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                          MAINNET (chainId 1)
  ///////////////////////////////////////////////////////////////*/

  function _mainnetAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](3);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _entries[1] = AssetEntry({
      token: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48,
      label: 'USDC',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _entries[2] = AssetEntry({
      token: 0xdAC17F958D2ee523a2206206994597C13D831ec7,
      label: 'USDT',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });

    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                          ARBITRUM (chainId 42161)
  ///////////////////////////////////////////////////////////////*/

  function _arbitrumAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](3);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _entries[1] = AssetEntry({
      token: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831,
      label: 'USDC',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _entries[2] = AssetEntry({
      token: 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9,
      label: 'USDT',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                          BASE (chainId 8453)
  ///////////////////////////////////////////////////////////////*/

  function _baseAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](3);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _entries[1] = AssetEntry({
      token: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913,
      label: 'USDC',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _entries[2] = AssetEntry({
      token: 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2,
      label: 'USDT',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    });
    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                          DEFAULT (chainId X)
  ///////////////////////////////////////////////////////////////*/

  /// @dev Fallback asset list: native ETH with permissive defaults.
  function _defaultAssets() internal pure returns (ChainAssets memory _chain) {
    AssetEntry[] memory _entries = new AssetEntry[](1);
    _entries[0] = AssetEntry({
      token: Constants.NATIVE_ASSET,
      label: 'ETH',
      config: IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    });
    _chain.assets = _entries;
  }

  /*///////////////////////////////////////////////////////////////
                          CHAIN RESOLVER
  ///////////////////////////////////////////////////////////////*/

  /// @dev Returns the asset list for the given chain ID.
  ///      Unsupported chains fall back to native ETH only.
  function _assetsForChain(uint256 _chainId) internal pure returns (ChainAssets memory) {
    if (_chainId == 11_155_111) return _sepoliaAssets();
    if (_chainId == 1) return _mainnetAssets();
    if (_chainId == 42_161) return _arbitrumAssets();
    if (_chainId == 8453) return _baseAssets();
    return _defaultAssets();
  }
}
