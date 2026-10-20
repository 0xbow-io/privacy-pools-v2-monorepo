// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouterBase} from 'test/unit/helpers/PPRouterBase.sol';

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPRouterFactory} from 'contracts/PPRouterFactory.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPRouterFactory} from 'interfaces/IPPRouterFactory.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @notice Coverage for {PPRouterFactory}: wiring of the router immutables from factory + createRouter
/// args, the `onlyOwner`/foreign-pool/duplicate guards, deployment-order tracking, and the constructor
/// zero-address checks. No Groth16 — the monorepo integration tests cover real proofs. See PPRouterFactory.tree.
contract UnitPPRouterFactory is PPRouterBase {
  PPRouterFactory internal factory;
  address internal owner = makeAddr('factoryOwner');

  function setUp() public override {
    super.setUp();
    factory = new PPRouterFactory(
      IAavePool(address(pool)), IEntrypoint(address(entrypoint)), IPoolVault(address(poolVault)), ppDust, owner
    );
  }

  function test_CreateRouter_WiresImmutables() external {
    vm.prank(owner);
    PPRouter _r = PPRouter(payable(factory.createRouter(address(vault), address(zap))));

    assertEq(factory.routerFor(address(vault)), address(_r), 'routerFor tracks the wrapper');
    assertEq(factory.routersCount(), 1, 'one router tracked');
    assertEq(factory.allRouters(0), address(_r), 'router in deployment order');
    assertEq(address(_r.VAULT()), address(vault), 'vault wired');
    assertEq(address(_r.POOL()), address(pool), 'pool wired from factory');
    assertEq(address(_r.UNDERLYING()), address(usdc), 'underlying derived from aToken');
    assertEq(address(_r.A_TOKEN()), address(aUSDC), 'aToken = vault.asset()');
    assertEq(address(_r.ENTRYPOINT()), address(entrypoint), 'entrypoint wired from factory');
    assertEq(_r.DUST_RECIPIENT(), ppDust, 'dust recipient wired from factory');
    assertEq(address(_r.ZAP()), address(zap), 'zap wired from createRouter arg');
    assertEq(address(_r.POOL_VAULT()), address(poolVault), 'pool vault wired from factory');
  }

  function test_CreateRouter_OnlyOwner() external {
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, address(this)));
    factory.createRouter(address(vault), address(zap));
  }

  function test_CreateRouter_RevertsOnForeignPoolAToken() external {
    MockAaveMultiPool _otherPool = new MockAaveMultiPool();
    MockAaveAToken _otherA = _otherPool.addReserve(IERC20Metadata(address(usdc)), 'Other aUSDC', 'oaUSDC');
    PPYieldToken _foreign = new PPYieldToken(IERC20(address(_otherA)), 0, admin, 'Foreign pp', 'fpp');

    // A zap matching the foreign vault, so the failure is the pool-aToken guard, not the zap mismatch.
    PPYieldTokenZap _foreignZap =
      new PPYieldTokenZap(IPPYieldToken(address(_foreign)), IAavePool(address(_otherPool)), IERC20(address(usdc)));
    vm.prank(owner);
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_NotAavePoolAToken.selector);
    factory.createRouter(address(_foreign), address(_foreignZap));
  }

  function test_CreateRouter_RevertsOnDuplicate() external {
    vm.startPrank(owner);
    factory.createRouter(address(vault), address(zap));
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_AlreadyDeployed.selector);
    factory.createRouter(address(vault), address(zap));
    vm.stopPrank();
  }

  /// @notice Creating a router emits `RouterCreated` with the wrapper and derived underlying.
  function test_CreateRouter_EmitsRouterCreated() external {
    vm.expectEmit(true, false, true, true, address(factory)); // router addr unknown pre-deploy
    emit IPPRouterFactory.RouterCreated(address(vault), address(0), address(usdc));
    vm.prank(owner);
    factory.createRouter(address(vault), address(zap));
  }

  /// @notice The factory tracks multiple routers in deployment order, and out-of-range reads revert.
  function test_CreateRouter_TracksMultiple() external {
    MockERC20 _dai = new MockERC20('DAI', 'DAI', 18);
    MockAaveAToken _aDai = pool.addReserve(IERC20Metadata(address(_dai)), 'Aave DAI', 'aDAI');
    PPYieldToken _vault2 = new PPYieldToken(IERC20(address(_aDai)), 0, admin, 'Privacy Pool DAI', 'ppDAI');
    PPYieldTokenZap _zap2 =
      new PPYieldTokenZap(IPPYieldToken(address(_vault2)), IAavePool(address(pool)), IERC20(address(_dai)));

    vm.startPrank(owner);
    address _r1 = factory.createRouter(address(vault), address(zap));
    address _r2 = factory.createRouter(address(_vault2), address(_zap2));
    vm.stopPrank();

    assertEq(factory.routersCount(), 2, 'two routers tracked');
    assertEq(factory.allRouters(0), _r1, 'first router');
    assertEq(factory.allRouters(1), _r2, 'second router');
    vm.expectRevert(); // out-of-range array access
    factory.allRouters(2);
  }

  function test_FactoryRouter_DepositsExactShares() external {
    vm.prank(owner);
    PPRouter _r = PPRouter(payable(factory.createRouter(address(vault), address(zap))));

    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _accrueYield(50e6);
    (uint256 _need,) = _r.quote(SHIELD_VALUE);

    usdc.mint(alice, _need);
    vm.startPrank(alice);
    usdc.approve(address(_r), _need);
    _r.depositExactShares(_p, _noteData(), bytes(''), _need);
    vm.stopPrank();

    assertEq(entrypoint.shielded(address(vault)), SHIELD_VALUE, 'factory router shields exactly the committed value');
  }

  /// @notice The factory constructor rejects a zero pool / entrypoint / pool vault / dust recipient.
  function test_Constructor_RevertsOnZeroAddress() external {
    IAavePool _p = IAavePool(address(pool));
    IPoolVault _pv = IPoolVault(address(poolVault));
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_ZeroAddress.selector);
    new PPRouterFactory(IAavePool(address(0)), IEntrypoint(address(entrypoint)), _pv, ppDust, owner);
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_ZeroAddress.selector);
    new PPRouterFactory(_p, IEntrypoint(address(0)), _pv, ppDust, owner);
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_ZeroAddress.selector);
    new PPRouterFactory(_p, IEntrypoint(address(entrypoint)), IPoolVault(address(0)), ppDust, owner);
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_ZeroAddress.selector);
    new PPRouterFactory(_p, IEntrypoint(address(entrypoint)), _pv, address(0), owner);
  }

  /// @notice Ownership cannot be renounced (would brick the owner-gated createRouter).
  function test_RenounceOwnership_RevertsWhenCalled() external {
    vm.prank(owner);
    vm.expectRevert(IPPRouterFactory.PPRouterFactory_RenounceDisabled.selector);
    factory.renounceOwnership();
  }
}
