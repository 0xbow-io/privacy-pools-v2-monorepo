// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {Script, console2} from 'forge-std/Script.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockAavePool, MockRebasingAToken} from 'test/integration/helpers/MockAavePool.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title DeployLocalYield
/// @notice Deploys a self-contained ppUSDC wrapper over a MOCK Aave pool to a local anvil node — no
/// Sepolia fork or RPC required. Seeds it with a supply+wrap so the ERC-4626 read surface returns
/// live values. Used by the SDK local wrapper e2e (see packages/evm-sdk/scripts/yield-e2e/).
/// @dev Addresses are recovered from the broadcast artifact (broadcast/.../run-latest.json) by the
/// runner script; also logged here for visibility. Env: PRIVATE_KEY (deployer, e.g. an anvil key).
contract DeployLocalYield is Script {
  uint256 internal constant _FEE_BPS = 1000; // 10%
  uint256 internal constant _SEED = 1000e6; // 1000 USDC (6dp)

  function run() external {
    uint256 pk = vm.envUint('PRIVATE_KEY');
    address deployer = vm.addr(pk);

    vm.startBroadcast(pk);

    MockERC20 usdc = new MockERC20('USD Coin', 'USDC', 6);
    MockAavePool pool =
      new MockAavePool({_underlying: IERC20(address(usdc)), _aName: 'Aave USDC', _aSymbol: 'aUSDC', _decimals: 6});
    MockRebasingAToken aUSDC = pool.A_TOKEN();
    PPYieldToken vault = new PPYieldToken({
      _aToken: IERC20(address(aUSDC)),
      _initialFeeBps: _FEE_BPS,
      _admin: deployer,
      _name: 'Privacy Pool USDC',
      _symbol: 'ppUSDC'
    });

    // Seed: USDC -> supply to Aave -> aUSDC -> wrap into ppUSDC, so the vault holds backing and
    // the exchange rate / previews return live values.
    usdc.mint(deployer, _SEED);
    usdc.approve(address(pool), _SEED);
    IAavePool(address(pool)).supply({_asset: address(usdc), _amount: _SEED, _onBehalfOf: deployer, _referralCode: 0});
    aUSDC.approve(address(vault), _SEED);
    vault.deposit(_SEED, deployer);

    vm.stopBroadcast();

    console2.log('PPYIELDTOKEN', address(vault));
    console2.log('UNDERLYING', address(usdc));
    console2.log('ATOKEN', address(aUSDC));
  }
}
