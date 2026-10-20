// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldTokenFactory} from 'contracts/PPYieldTokenFactory.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {Script, console2} from 'forge-std/Script.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockWETH9} from 'test/helpers/MockWETH9.sol';
import {MockAavePool} from 'test/integration/helpers/MockAavePool.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @title DeployE2ELocalYield
/// @notice Deploys two self-contained yield-over-mock-Aave stacks (factory-seeded wrapper + zap +
/// combined router each) to a local anvil fork for the evm-sdk e2e suite — no Sepolia fork, no real
/// Aave. One wraps an ERC-20 underlying (ppyUSDC over the mock `yUSDC`, also used for RelaySwaps
/// executeUnwrapped coverage); the other wraps WETH with the router in NATIVE mode (ppWETH), so the
/// shared yield ladder runs over both a token and the native coin. Modeled on DeployLocalYield.s.sol's
/// mock-Aave recipe combined with DeployYieldFork.s.sol's factory+zap+router wiring. Companion to
/// DeployE2ELocal.s.sol / packages/swaps/contracts/script/DeployE2ELocalSwaps.s.sol.
/// Env: PRIVATE_KEY (deployer — same fixed e2e-only key network.ts uses for the other two
/// deploys), ENTRYPOINT_ADDRESS, POOL_ADDRESS (from DeployE2ELocal.s.sol's output).
/// Usage: forge script script/DeployE2ELocalYield.s.sol --sig "run()" --rpc-url <local fork> --broadcast
contract DeployE2ELocalYield is Script {
  uint256 internal constant _FEE_BPS = 1000; // 10%

  /// @dev Underlying used to seed each wrapper's permanently-locked dead shares (neutralizes the
  /// ERC-4626 first-depositor inflation attack). 1 unit of the 6dp `yUSDC` is ample; for 18dp WETH the
  /// same 1e6 wei is a negligible but sufficient seed.
  uint256 internal constant _SEED_ASSETS = 1e6;

  function run() external {
    uint256 _pk = vm.envUint('PRIVATE_KEY');
    address _deployer = vm.addr(_pk);
    IEntrypoint _entrypoint = IEntrypoint(vm.envAddress('ENTRYPOINT_ADDRESS'));
    IPoolVault _poolVault = IPoolVault(vm.envAddress('POOL_ADDRESS'));

    vm.startBroadcast(_pk);

    MockERC20 _usdc = new MockERC20('Mock Yield USDC', 'yUSDC', 6);
    _usdc.mint(_deployer, _SEED_ASSETS);
    (address _wrapper, address _zap, address _router) = _deployStack({
      _underlying: _usdc,
      _decimals: 6,
      _name: 'Privacy Pool yUSDC',
      _symbol: 'ppyUSDC',
      _nativeMode: false,
      _deployer: _deployer,
      _entrypoint: _entrypoint,
      _poolVault: _poolVault
    });

    MockWETH9 _weth = new MockWETH9();
    _weth.deposit{value: _SEED_ASSETS}();
    (address _nativeWrapper, address _nativeZap, address _nativeRouter) = _deployStack({
      _underlying: _weth,
      _decimals: 18,
      _name: 'Privacy Pool WETH',
      _symbol: 'ppWETH',
      _nativeMode: true,
      _deployer: _deployer,
      _entrypoint: _entrypoint,
      _poolVault: _poolVault
    });

    vm.stopBroadcast();

    console2.log('PPYIELDTOKEN', _wrapper);
    console2.log('PPYIELDZAP', _zap);
    console2.log('PPROUTER', _router);
    console2.log('YIELDUNDERLYING', address(_usdc));
    console2.log('NATIVEYIELDTOKEN', _nativeWrapper);
    console2.log('NATIVEYIELDZAP', _nativeZap);
    console2.log('NATIVEPPROUTER', _nativeRouter);
    console2.log('NATIVEYIELDUNDERLYING', address(_weth));
  }

  /// @notice Deploys one mock Aave pool over `_underlying` and the wrapper, zap and router around it
  /// @dev The deployer must already hold `_SEED_ASSETS` of `_underlying`. The wrapper is deployed
  /// THROUGH the factory (not `new PPYieldToken(...)`) so it is seeded with locked dead shares — see
  /// PPYieldTokenFactory's own doc comment. The share is then enabled as an Entrypoint asset, which
  /// both the SDK's yield deposit flow and RelaySwaps.approveZap require; `_deployer` permanently
  /// holds ENTRYPOINT_MANAGER_ROLE (see DeployE2ELocal.s.sol).
  /// @param _underlying The asset the share wraps (WETH for a native-mode router)
  /// @param _decimals The underlying's decimals
  /// @param _name The share token's name
  /// @param _symbol The share token's symbol
  /// @param _nativeMode Whether the router takes and pays out the native coin (underlying must be WETH)
  /// @param _deployer The deployer, which seeds the wrapper and receives router dust
  /// @param _entrypoint The Entrypoint the share is enabled on
  /// @param _poolVault The pool the router shields into
  /// @return _wrapper The share token
  /// @return _zap The wrap/unwrap zap
  /// @return _router The combined router
  function _deployStack(
    IERC20 _underlying,
    uint8 _decimals,
    string memory _name,
    string memory _symbol,
    bool _nativeMode,
    address _deployer,
    IEntrypoint _entrypoint,
    IPoolVault _poolVault
  ) internal returns (address _wrapper, address _zap, address _router) {
    MockAavePool _aavePool = new MockAavePool({
      _underlying: _underlying,
      _aName: string.concat('Aave ', _symbol),
      _aSymbol: string.concat('a', _symbol),
      _decimals: _decimals
    });

    PPYieldTokenFactory _factory = new PPYieldTokenFactory(IAavePool(address(_aavePool)), _deployer);
    _underlying.approve(address(_factory), _SEED_ASSETS);
    _wrapper = _factory.createWrapper({
      _aToken: address(_aavePool.A_TOKEN()),
      _feeBps: _FEE_BPS,
      _admin: _deployer,
      _name: _name,
      _symbol: _symbol,
      _seedAssets: _SEED_ASSETS
    });
    _zap = address(new PPYieldTokenZap(IPPYieldToken(_wrapper), IAavePool(address(_aavePool)), _underlying));
    _router = address(
      new PPRouter({
        _vault: IPPYieldToken(_wrapper),
        _pool: IAavePool(address(_aavePool)),
        _underlying: _underlying,
        _entrypoint: _entrypoint,
        _dustRecipient: _deployer,
        _zap: IPPYieldTokenZap(_zap),
        _poolVault: _poolVault,
        _nativeMode: _nativeMode
      })
    );

    _entrypoint.setAssetConfiguration(
      _wrapper, IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );
  }
}
