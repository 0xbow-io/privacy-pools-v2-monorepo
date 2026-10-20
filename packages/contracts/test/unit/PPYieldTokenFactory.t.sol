// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenFactory} from 'contracts/PPYieldTokenFactory.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldTokenFactory} from 'interfaces/IPPYieldTokenFactory.sol';
import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/// @title UnitPPYieldTokenFactory
/// @notice The factory deploys + tracks PPYieldToken wrappers for one trusted Aave pool's aTokens,
/// across differing decimals, and seeds permanently-locked dead shares so each wrapper is never empty
/// (neutralizing the first-depositor inflation attack regardless of offset). See PPYieldTokenFactory.tree.
contract UnitPPYieldTokenFactory is Test {
  MockAaveMultiPool internal pool;
  MockERC20 internal usdc;
  MockERC20 internal weth;
  MockAaveAToken internal aUSDC;
  MockAaveAToken internal aWETH;
  PPYieldTokenFactory internal factory;

  address internal owner = makeAddr('owner');
  address internal admin = makeAddr('admin');
  address internal attacker = makeAddr('attacker');
  address internal victim = makeAddr('victim');
  address internal constant DEAD = address(0xdEaD);
  uint256 internal constant FEE = 1000;

  function setUp() external {
    pool = new MockAaveMultiPool();
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    weth = new MockERC20('Wrapped Ether', 'WETH', 18);
    aUSDC = pool.addReserve(IERC20Metadata(address(usdc)), 'Aave USDC', 'aUSDC');
    aWETH = pool.addReserve(IERC20Metadata(address(weth)), 'Aave WETH', 'aWETH');
    factory = new PPYieldTokenFactory(IAavePool(address(pool)), owner);
  }

  function _create(
    MockERC20 _u,
    MockAaveAToken _a,
    string memory _n,
    string memory _s,
    uint256 _seed
  ) internal returns (PPYieldToken _w) {
    _u.mint(owner, _seed);
    vm.startPrank(owner);
    _u.approve(address(factory), _seed);
    _w = PPYieldToken(factory.createWrapper(address(_a), FEE, admin, _n, _s, _seed));
    vm.stopPrank();
  }

  function _giveAToken(MockERC20 _u, address _who, uint256 _amt) internal {
    _u.mint(_who, _amt);
    vm.startPrank(_who);
    _u.approve(address(pool), _amt);
    pool.supply(address(_u), _amt, _who, 0);
    vm.stopPrank();
  }

  /*///////////////////////////////////////////////////////////////
                          createWrapper
  ///////////////////////////////////////////////////////////////*/

  function test_CreateWrapper_DeploysConfiguresAndSeeds() external {
    PPYieldToken _w = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);

    // It tracks the new wrapper
    assertEq(factory.wrapperFor(address(aUSDC)), address(_w));
    assertEq(factory.wrappersCount(), 1);
    assertEq(factory.allWrappers(0), address(_w));

    // It configures the wrapper (asset, admin, fee, 18-dp shares, symbol)
    assertEq(_w.asset(), address(aUSDC));
    assertEq(_w.admin(), admin);
    assertEq(_w.feeBps(), FEE);
    assertEq(_w.decimals(), 18);
    assertEq(_w.symbol(), 'ppUSDC');

    // It seeds locked dead shares so the wrapper is never empty
    assertGt(_w.totalSupply(), 0);
    assertEq(_w.balanceOf(DEAD), _w.totalSupply());
    assertEq(_w.balanceOf(DEAD), 1e6 * 1e12); // offset 12
  }

  function test_CreateWrapper_EmitsWrapperCreated() external {
    usdc.mint(owner, 1e6);
    vm.startPrank(owner);
    usdc.approve(address(factory), 1e6);
    // It emits WrapperCreated with the right underlying + aToken topics and _admin data (the wrapper
    // address topic is created in-call so it is left unchecked)
    vm.expectEmit(true, true, false, true, address(factory));
    emit IPPYieldTokenFactory.WrapperCreated(address(usdc), address(aUSDC), address(0), admin);
    factory.createWrapper(address(aUSDC), FEE, admin, 'Privacy Pool USDC', 'ppUSDC', 1e6);
    vm.stopPrank();
  }

  function test_CreateWrapper_MultipleAssetsDifferentOffsets() external {
    PPYieldToken _ppusdc = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);
    PPYieldToken _ppweth = _create(weth, aWETH, 'Privacy Pool WETH', 'ppWETH', 1e18);

    // It tracks both, and both have 18-dp shares despite different underlying decimals
    assertEq(factory.wrappersCount(), 2);
    assertEq(_ppusdc.decimals(), 18);
    assertEq(_ppweth.decimals(), 18);

    // It seeds dead shares scaled by each offset (USDC 1e6*1e12; WETH 1e18*1e0)
    assertEq(_ppusdc.balanceOf(DEAD), 1e6 * 1e12);
    assertEq(_ppweth.balanceOf(DEAD), 1e18);
  }

  function test_CreateWrapper_RevertsWhenNotOwner() external {
    usdc.mint(address(this), 1e6);
    usdc.approve(address(factory), 1e6);
    // It should revert (Ownable)
    vm.expectRevert();
    factory.createWrapper(address(aUSDC), FEE, admin, 'x', 'y', 1e6);
  }

  function test_CreateWrapper_RevertsForForeignAToken() external {
    // an aToken belonging to a DIFFERENT pool
    MockAaveMultiPool _other = new MockAaveMultiPool();
    MockAaveAToken _foreign = _other.addReserve(IERC20Metadata(address(usdc)), 'a', 'a');
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_NotAavePoolAToken.selector);
    factory.createWrapper(address(_foreign), FEE, admin, 'x', 'y', 1e6);
  }

  function test_CreateWrapper_RevertsWhenAlreadyDeployed() external {
    _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);
    usdc.mint(owner, 1e6);
    vm.startPrank(owner);
    usdc.approve(address(factory), 1e6);
    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_AlreadyDeployed.selector);
    factory.createWrapper(address(aUSDC), FEE, admin, 'Privacy Pool USDC', 'ppUSDC', 1e6);
    vm.stopPrank();
  }

  function test_CreateWrapper_RevertsOnZeroSeed() external {
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_ZeroSeed.selector);
    factory.createWrapper(address(aUSDC), FEE, admin, 'x', 'y', 0);
  }

  function test_CreateWrapper_OneWeiSeed() external {
    // Minimal non-zero seed still locks dead shares (1 wei underlying -> 10**offset dead shares)
    PPYieldToken _w = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1);
    assertEq(_w.balanceOf(DEAD), 1 * 1e12);
    assertGt(_w.totalSupply(), 0);
  }

  function test_CreateWrapper_SameATokenAcrossTwoFactories() external {
    PPYieldToken _w1 = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);

    // a second, independent factory over the same pool can wrap the same aToken; mappings are per-factory
    PPYieldTokenFactory _f2 = new PPYieldTokenFactory(IAavePool(address(pool)), owner);
    usdc.mint(owner, 1e6);
    vm.startPrank(owner);
    usdc.approve(address(_f2), 1e6);
    address _w2 = _f2.createWrapper(address(aUSDC), FEE, admin, 'Privacy Pool USDC', 'ppUSDC', 1e6);
    vm.stopPrank();

    assertTrue(address(_w1) != _w2);
    assertEq(factory.wrapperFor(address(aUSDC)), address(_w1));
    assertEq(_f2.wrapperFor(address(aUSDC)), _w2);
  }

  function test_CreateWrapper_WrapperIsFunctionalPostSeed() external {
    // a factory-deployed wrapper (seed routed through POOL.supply, dead shares minted) works
    // end-to-end: a normal user can deposit and redeem, and the dead shares remain locked.
    PPYieldToken _w = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);

    _giveAToken(usdc, victim, 100e6);
    vm.startPrank(victim);
    IERC20(address(aUSDC)).approve(address(_w), 100e6);
    uint256 _shares = _w.deposit(100e6, victim);
    uint256 _out = _w.redeem(_shares, victim, victim);
    vm.stopPrank();

    assertGt(_shares, 0);
    assertApproxEqAbs(_out, 100e6, 10, 'user round-trips ~1:1 through a factory wrapper (no yield)');
    assertEq(_w.balanceOf(DEAD), 1e6 * 1e12, 'dead shares stay locked');
  }

  function test_CreateWrapper_SeedsDeadSharesFromPostSupplyBalance() external {
    // The seed must deposit the factory's full post-supply aToken balance (_aBal), not the raw
    // _seedAssets. We pre-credit the factory with aToken dust so _aBal strictly exceeds _seedAssets;
    // the dead shares must reflect the larger balance. Seeding off only _seedAssets would lock fewer
    // dead shares.
    uint256 _seed = 1e6;
    uint256 _dust = 7; // pre-existing aUSDC sitting at the factory before createWrapper runs
    _giveAToken(usdc, address(factory), _dust);
    assertEq(aUSDC.balanceOf(address(factory)), _dust, 'pre-seed dust credited');

    PPYieldToken _w = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', _seed);

    // First (seed) deposit into an empty wrapper mints assets * 10**offset shares; offset is 12 for
    // a 6-dp underlying. The deposited assets are the full post-supply balance: _seed + _dust.
    uint256 _expectedDead = (_seed + _dust) * 1e12;
    assertEq(_w.balanceOf(DEAD), _expectedDead, 'dead shares track post-supply aToken balance (_aBal)');
    assertEq(_w.balanceOf(DEAD), _w.totalSupply(), 'all shares locked at DEAD');
    assertGt(_w.balanceOf(DEAD), _seed * 1e12, 'dead shares strictly exceed a _seedAssets-only seed');
    // The full balance was consumed by the deposit; no aToken dust stranded at the factory.
    assertEq(aUSDC.balanceOf(address(factory)), 0, 'no aToken dust stranded at factory');
  }

  function test_CreateWrapper_LeavesNoResidualAllowances() external {
    // The exact approvals to the pool (underlying) and to the wrapper (aToken) are fully consumed by
    // supply/deposit, so both residual allowances are zero after createWrapper. An unbounded (max)
    // approval would leave a residual, which these assertions forbid.
    PPYieldToken _w = _create(usdc, aUSDC, 'Privacy Pool USDC', 'ppUSDC', 1e6);

    assertEq(usdc.allowance(address(factory), address(pool)), 0, 'no residual underlying->pool allowance');
    assertEq(
      IERC20(address(aUSDC)).allowance(address(factory), address(_w)), 0, 'no residual aToken->wrapper allowance'
    );
  }

  function test_CreateWrapper_RegistersBeforeSeedTransferReentrancy() external {
    // wrapperFor must be written BEFORE the seed transfer so a re-entrant createWrapper for the same
    // aToken hits the duplicate guard. We use a malicious underlying whose transferFrom re-enters
    // createWrapper for the same aToken. With wrapperFor already set, the inner call reverts
    // AlreadyDeployed and that revert propagates to the outer call. If the registration were moved
    // after the seed, the inner call would pass the dup guard and the outer call would not revert
    // with this selector.
    ReentrantUnderlying _rUsdc = new ReentrantUnderlying();
    vm.label(address(_rUsdc), 'ReentrantUnderlying');
    MockAaveAToken _aR = pool.addReserve(IERC20Metadata(address(_rUsdc)), 'Aave rUSDC', 'arUSDC');

    // The malicious underlying owns the factory so its re-entrant call clears onlyOwner and reaches
    // the duplicate guard; arm it to re-enter for the same aToken, then kick the outer create.
    PPYieldTokenFactory _f = new PPYieldTokenFactory(IAavePool(address(pool)), address(_rUsdc));
    _rUsdc.mint(address(_rUsdc), 1e6);
    _rUsdc.arm(_f, address(_aR), admin);

    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_AlreadyDeployed.selector);
    _rUsdc.kick(1e6);
  }

  /*///////////////////////////////////////////////////////////////
                          constructor
  ///////////////////////////////////////////////////////////////*/

  function test_Constructor_RevertsOnZeroPool() external {
    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_ZeroAddress.selector);
    new PPYieldTokenFactory(IAavePool(address(0)), owner);
  }

  /*///////////////////////////////////////////////////////////////
                          allWrappers
  ///////////////////////////////////////////////////////////////*/

  function test_AllWrappers_RevertsOutOfBounds() external {
    // It reverts on an out-of-range index (array bounds), keeping enumeration honest vs wrappersCount
    vm.expectRevert();
    factory.allWrappers(0);
  }

  /*///////////////////////////////////////////////////////////////
                          deadShares
  ///////////////////////////////////////////////////////////////*/

  function test_DeadShares_NeutralizeInflationAttackOnOffsetZeroAsset() external {
    // ppWETH wraps an 18-dp asset -> offset 0, so the seed (not the offset) is the defense
    PPYieldToken _w = _create(weth, aWETH, 'Privacy Pool WETH', 'ppWETH', 1e18);

    // the attacker is NOT the first depositor (the seed already locked dead shares); they donate
    // a large amount directly to inflate the share price
    _giveAToken(weth, attacker, 100e18);
    vm.prank(attacker);
    IERC20(address(aWETH)).transfer(address(_w), 100e18);

    // a normal victim deposit still mints non-zero, sane shares (not rounded to zero)
    _giveAToken(weth, victim, 10e18);
    vm.startPrank(victim);
    IERC20(address(aWETH)).approve(address(_w), 10e18);
    uint256 _shares = _w.deposit(10e18, victim);
    vm.stopPrank();

    assertGt(_shares, 0, 'victim is not rounded to zero shares');
    // Value-neutralization: the victim can redeem ~their full deposit back (the donation accrues to
    // existing holders incl. the locked dead shares, NOT to the attacker). Without the seed an
    // offset-0 vault would let the attack strand the victim; with it the loss is dust (rounding).
    assertApproxEqAbs(_w.previewRedeem(_shares), 10e18, 1e6, 'victim recovers ~their deposit (attack neutralized)');
  }

  /*///////////////////////////////////////////////////////////////
                          renounceOwnership
  ///////////////////////////////////////////////////////////////*/

  /// @notice Ownership cannot be renounced (would brick the owner-gated createWrapper).
  function test_RenounceOwnership_RevertsWhenCalled() external {
    vm.prank(owner);
    vm.expectRevert(IPPYieldTokenFactory.PPYieldTokenFactory_RenounceDisabled.selector);
    factory.renounceOwnership();
  }
}

/// @notice A malicious underlying that is ALSO the factory owner, whose `transferFrom` (called by
/// the factory's seed at line 87) re-enters `factory.createWrapper` once for the same aToken. Owning
/// the factory lets the re-entrant call clear `onlyOwner` and reach the duplicate guard. On clean
/// source `wrapperFor` is already written before the transfer, so the re-entrant call reverts
/// `AlreadyDeployed` and that revert propagates to the outer call; if the registration were moved
/// after the seed the dup guard would pass and the outer call would not carry that selector.
contract ReentrantUnderlying is ERC20 {
  PPYieldTokenFactory public factory;
  address public aToken;
  address public admin;
  bool internal _reentered;

  constructor() ERC20('Reentrant USDC', 'rUSDC') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }

  function arm(PPYieldTokenFactory _factory, address _aToken, address _admin) external {
    factory = _factory;
    aToken = _aToken;
    admin = _admin;
  }

  /// @notice Owner-initiated outer createWrapper (this contract is the factory owner).
  function kick(uint256 _seed) external returns (address) {
    approve(address(factory), _seed);
    return factory.createWrapper(aToken, 1000, admin, 'Reentrant', 'reUSDC', _seed);
  }

  function transferFrom(address _from, address _to, uint256 _value) public override returns (bool) {
    if (!_reentered && address(factory) != address(0)) {
      _reentered = true;
      // Re-enter the factory for the SAME aToken during the outer seed transfer. msg.sender here is
      // this contract, which is the factory owner, so the call clears the onlyOwner modifier.
      factory.createWrapper(aToken, 1000, admin, 'Reentrant', 'reUSDC', _value);
    }
    return super.transferFrom(_from, _to, _value);
  }
}
