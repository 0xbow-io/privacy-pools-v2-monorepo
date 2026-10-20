// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test, Vm} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {PPYieldTokenZapFactory} from 'contracts/PPYieldTokenZapFactory.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldTokenZapFactory} from 'interfaces/IPPYieldTokenZapFactory.sol';
import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title UnitPPYieldTokenZapFactory
/// @notice The zap factory deploys + tracks one stateless PPYieldTokenZap per wrapper, for wrappers
/// over the trusted pool's aTokens, deriving the underlying + pool automatically. See PPYieldTokenZapFactory.tree.
contract UnitPPYieldTokenZapFactory is Test {
  MockAaveMultiPool internal pool;
  MockERC20 internal usdc;
  MockERC20 internal weth;
  MockAaveAToken internal aUSDC;
  MockAaveAToken internal aWETH;
  PPYieldToken internal ppusdc;
  PPYieldToken internal ppweth;
  PPYieldTokenZapFactory internal factory;

  address internal owner = makeAddr('owner');
  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  uint256 internal constant FEE = 1000;

  function setUp() external {
    pool = new MockAaveMultiPool();
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    weth = new MockERC20('Wrapped Ether', 'WETH', 18);
    aUSDC = pool.addReserve(IERC20Metadata(address(usdc)), 'Aave USDC', 'aUSDC');
    aWETH = pool.addReserve(IERC20Metadata(address(weth)), 'Aave WETH', 'aWETH');
    ppusdc = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    ppweth = new PPYieldToken(IERC20(address(aWETH)), FEE, admin, 'Privacy Pool WETH', 'ppWETH');
    factory = new PPYieldTokenZapFactory(IAavePool(address(pool)), owner);
  }

  function _createZap(PPYieldToken _vault) internal returns (PPYieldTokenZap _zap) {
    vm.prank(owner);
    _zap = PPYieldTokenZap(factory.createZap(address(_vault)));
  }

  /*///////////////////////////////////////////////////////////////
                          createZap
  ///////////////////////////////////////////////////////////////*/

  function test_CreateZap_DeploysTracksAndWires() external {
    PPYieldTokenZap _zap = _createZap(ppusdc);

    // It tracks the zap
    assertEq(factory.zapFor(address(ppusdc)), address(_zap));
    assertEq(factory.zapsCount(), 1);
    assertEq(factory.allZaps(0), address(_zap));

    // It wires the zap to the wrapper, pool, underlying, and aToken
    assertEq(address(_zap.VAULT()), address(ppusdc));
    assertEq(address(_zap.POOL()), address(pool));
    assertEq(address(_zap.UNDERLYING()), address(usdc));
    assertEq(address(_zap.A_TOKEN()), address(aUSDC));
  }

  function test_CreateZap_EmitsZapCreated() external {
    // It emits ZapCreated with the vault + underlying topics (the zap address is created in-call)
    vm.prank(owner);
    vm.expectEmit(true, false, true, false, address(factory));
    emit IPPYieldTokenZapFactory.ZapCreated(address(ppusdc), address(0), address(usdc));
    factory.createZap(address(ppusdc));
  }

  function test_CreateZap_EmitsZapCreatedWithExactZapTopic() external {
    // The indexed zap topic must be the deployed zap address, not the factory. The base emit test
    // leaves topic2 unchecked because the zap address is created in-call; here we capture the log
    // and compare topic2 to the returned zap.
    vm.recordLogs();
    vm.prank(owner);
    address _zap = factory.createZap(address(ppusdc));

    Vm.Log[] memory _logs = vm.getRecordedLogs();
    bytes32 _sig = keccak256('ZapCreated(address,address,address)');
    bool _found;
    for (uint256 _i; _i < _logs.length; ++_i) {
      if (_logs[_i].emitter != address(factory) || _logs[_i].topics[0] != _sig) continue;
      _found = true;
      assertEq(address(uint160(uint256(_logs[_i].topics[1]))), address(ppusdc), 'vault topic');
      assertEq(address(uint160(uint256(_logs[_i].topics[2]))), _zap, 'zap topic is the deployed zap');
      assertEq(address(uint160(uint256(_logs[_i].topics[3]))), address(usdc), 'underlying topic');
    }
    assertTrue(_found, 'ZapCreated emitted by the factory');
  }

  function test_CreateZap_MultipleWrappers() external {
    PPYieldTokenZap _zUsdc = _createZap(ppusdc);
    PPYieldTokenZap _zWeth = _createZap(ppweth);

    assertEq(factory.zapsCount(), 2);
    assertTrue(address(_zUsdc) != address(_zWeth));
    assertEq(factory.allZaps(0), address(_zUsdc)); // enumeration order preserved
    assertEq(factory.allZaps(1), address(_zWeth));
    assertEq(address(_zUsdc.UNDERLYING()), address(usdc));
    assertEq(address(_zWeth.UNDERLYING()), address(weth));
  }

  function test_CreateZap_ZapIsFunctional() external {
    PPYieldTokenZap _zap = _createZap(ppusdc);

    // a user round-trips USDC -> ppUSDC -> USDC through the factory-created zap
    usdc.mint(alice, 100e6);
    vm.startPrank(alice);
    usdc.approve(address(_zap), 100e6);
    uint256 _shares = _zap.depositUnderlying(100e6, alice);
    IERC20(address(ppusdc)).approve(address(_zap), _shares);
    uint256 _out = _zap.redeemToUnderlying(_shares, alice);
    vm.stopPrank();

    assertGt(_shares, 0);
    assertApproxEqAbs(_out, 100e6, 2, 'round-trips ~1:1 through the zap (no yield)');
  }

  function test_CreateZap_RevertsWhenNotOwner() external {
    // It should revert (Ownable)
    vm.expectRevert();
    factory.createZap(address(ppusdc));
  }

  function test_CreateZap_RevertsForForeignPoolWrapper() external {
    // a wrapper whose aToken belongs to a DIFFERENT pool
    MockAaveMultiPool _other = new MockAaveMultiPool();
    MockAaveAToken _aOther = _other.addReserve(IERC20Metadata(address(usdc)), 'a', 'a');
    PPYieldToken _ppOther = new PPYieldToken(IERC20(address(_aOther)), FEE, admin, 'x', 'y');
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenZapFactory.PPYieldTokenZapFactory_NotAavePoolAToken.selector);
    factory.createZap(address(_ppOther));
  }

  function test_CreateZap_RevertsWhenAlreadyDeployed() external {
    _createZap(ppusdc);
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenZapFactory.PPYieldTokenZapFactory_AlreadyDeployed.selector);
    factory.createZap(address(ppusdc));
  }

  function test_Constructor_RevertsOnZeroPool() external {
    vm.expectRevert(IPPYieldTokenZapFactory.PPYieldTokenZapFactory_ZeroAddress.selector);
    new PPYieldTokenZapFactory(IAavePool(address(0)), owner);
  }

  function test_AllZaps_RevertsOutOfBounds() external {
    vm.expectRevert();
    factory.allZaps(0);
  }

  /// @notice Ownership cannot be renounced (would brick the owner-gated createZap).
  function test_RenounceOwnership_RevertsWhenCalled() external {
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenZapFactory.PPYieldTokenZapFactory_RenounceDisabled.selector);
    factory.renounceOwnership();
  }
}
