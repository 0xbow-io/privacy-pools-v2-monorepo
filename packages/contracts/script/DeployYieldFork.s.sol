// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenFactory} from 'contracts/PPYieldTokenFactory.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {Script, console2} from 'forge-std/Script.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @notice Deploys the yield module (ppUSDC wrapper + zap + combined PPRouter) onto a Sepolia fork,
/// wired to a freshly-deployed base protocol (ENTRYPOINT/POOL_VAULT env) and the REAL Aave v3 Sepolia
/// market. For the local real-proof e2e — see docs/YIELD_E2E_SCRIPT.md.
contract DeployYieldFork is Script {
  address internal constant _AAVE_POOL = 0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951;
  address internal constant _USDC = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
  address internal constant _AUSDC = 0x16dA4541aD1807f4443d92D26044C1147406EB80;
  uint256 internal constant _FEE_BPS = 1000; // 10%

  /// @dev Underlying used to seed the wrapper's permanently-locked dead shares. The deployer must hold
  /// at least this much USDC (the factory pulls it via `transferFrom`). 1 USDC is ample.
  uint256 internal constant _SEED_ASSETS = 1e6;

  function run() external {
    uint256 pk = vm.envUint('PRIVATE_KEY');
    address deployer = vm.addr(pk);
    IEntrypoint entrypoint = IEntrypoint(vm.envAddress('ENTRYPOINT'));
    IPoolVault poolVault = IPoolVault(vm.envAddress('POOL_VAULT'));

    vm.startBroadcast(pk);
    // Deploy the wrapper THROUGH the factory so it is seeded with locked dead shares, neutralizing the
    // ERC-4626 first-depositor inflation attack. Deploying `new PPYieldToken(...)` directly (as this
    // script previously did) skips the seed. The deployer must approve the seed USDC to the factory.
    PPYieldTokenFactory factory = new PPYieldTokenFactory(IAavePool(_AAVE_POOL), deployer);
    IERC20(_USDC).approve(address(factory), _SEED_ASSETS);
    PPYieldToken wrapper = PPYieldToken(
      factory.createWrapper({
        _aToken: _AUSDC,
        _feeBps: _FEE_BPS,
        _admin: deployer,
        _name: 'Privacy Pool USDC',
        _symbol: 'ppUSDC',
        _seedAssets: _SEED_ASSETS
      })
    );
    PPYieldTokenZap zap = new PPYieldTokenZap(IPPYieldToken(address(wrapper)), IAavePool(_AAVE_POOL), IERC20(_USDC));
    PPRouter router = new PPRouter({
      _vault: IPPYieldToken(address(wrapper)),
      _pool: IAavePool(_AAVE_POOL),
      _underlying: IERC20(_USDC),
      _entrypoint: entrypoint,
      _dustRecipient: deployer, // dust recipient
      _zap: IPPYieldTokenZap(address(zap)),
      _poolVault: poolVault,
      _nativeMode: false
    });
    vm.stopBroadcast();

    console2.log('FACTORY', address(factory));
    console2.log('PPUSDC', address(wrapper));
    console2.log('ZAP', address(zap));
    console2.log('PPROUTER', address(router));
  }
}
