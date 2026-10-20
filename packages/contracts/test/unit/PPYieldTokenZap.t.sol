// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';
import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title UnitPPYieldTokenZap
/// @notice Dedicated unit tests for PPYieldTokenZap. Each test asserts an exact invariant of the
/// zap: receiver crediting, input-validation reverts, and rebasing aToken balance handling.
contract UnitPPYieldTokenZap is Test {
  MockAaveMultiPool internal pool;
  MockERC20 internal usdc;
  MockAaveAToken internal aUSDC;
  PPYieldToken internal vault;
  PPYieldTokenZap internal zap;

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');

  uint256 internal constant FEE = 1000; // 10%
  uint256 internal constant ONE = 1e6; // 1 USDC (6 decimals)

  function setUp() public {
    vm.label(address(this), 'test');
    vm.label(admin, 'admin');
    vm.label(alice, 'alice');
    vm.label(bob, 'bob');

    pool = new MockAaveMultiPool();
    usdc = new MockERC20('USD Coin', 'USDC', 6);
    aUSDC = pool.addReserve(IERC20Metadata(address(usdc)), 'Aave USDC', 'aUSDC');

    vm.label(address(pool), 'pool');
    vm.label(address(usdc), 'usdc');
    vm.label(address(aUSDC), 'aUSDC');

    vault = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    zap = new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(pool)), IERC20(address(usdc)));

    vm.label(address(vault), 'vault');
    vm.label(address(zap), 'zap');
  }

  // Internal helper: mint USDC to a caller, approve the zap, and deposit.
  // Returns the pp-share count the vault emitted.
  function _depositAs(address _caller, uint256 _amount, address _receiver) internal returns (uint256 _shares) {
    usdc.mint(_caller, _amount);
    vm.startPrank(_caller);
    usdc.approve(address(zap), _amount);
    _shares = zap.depositUnderlying(_amount, _receiver);
    vm.stopPrank();
  }

  // Internal helper: give _caller the specified share count and redeem to _receiver.
  function _redeemAs(address _caller, uint256 _shares, address _receiver) internal returns (uint256 _out) {
    vm.startPrank(_caller);
    IERC20(address(vault)).approve(address(zap), _shares);
    _out = zap.redeemToUnderlying(_shares, _receiver);
    vm.stopPrank();
  }

  // Internal helper: donate `_amount` of aUSDC directly to the (stateless) zap, simulating a griefer
  // pre-funding the zap's aToken balance. MockAaveAToken only lets its pool mint, so we supply through
  // the pool to this test contract and transfer the received aUSDC to the zap.
  function _donateATokensToZap(uint256 _amount) internal {
    usdc.mint(address(this), _amount);
    usdc.approve(address(pool), _amount);
    pool.supply(address(usdc), _amount, address(this), 0);
    aUSDC.transfer(address(zap), aUSDC.balanceOf(address(this)));
  }

  /*///////////////////////////////////////////////////////////////
                          constructor
  ///////////////////////////////////////////////////////////////*/

  // The constructor rejects a zero address for each argument; these tests assert the revert fires
  // per argument.

  function test_Constructor_RevertsWhenVaultIsZero() external {
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAddress.selector);
    new PPYieldTokenZap(IPPYieldToken(address(0)), IAavePool(address(pool)), IERC20(address(usdc)));
  }

  function test_Constructor_RevertsWhenPoolIsZero() external {
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAddress.selector);
    new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(0)), IERC20(address(usdc)));
  }

  function test_Constructor_RevertsWhenUnderlyingIsZero() external {
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAddress.selector);
    new PPYieldTokenZap(IPPYieldToken(address(vault)), IAavePool(address(pool)), IERC20(address(0)));
  }

  /*///////////////////////////////////////////////////////////////
                          depositUnderlying
  ///////////////////////////////////////////////////////////////*/

  // A zero-amount deposit must revert; this test asserts the revert.

  function test_DepositUnderlying_RevertsOnZeroAmount() external {
    vm.prank(alice);
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAmount.selector);
    zap.depositUnderlying(0, alice);
  }

  // Deposited shares must be credited to the named receiver, not the caller. Bob calls
  // depositUnderlying with alice as receiver; the test asserts alice's balance increased and bob's
  // did NOT.

  function test_DepositUnderlying_CreditsReceiverNotCaller() external {
    uint256 _amount = 100 * ONE;
    uint256 _shares = _depositAs(bob, _amount, alice);

    assertGt(_shares, 0, 'shares must be positive');
    assertEq(vault.balanceOf(alice), _shares, 'alice must hold all minted shares');
    assertEq(vault.balanceOf(bob), 0, 'bob (caller) must hold no shares');
  }

  // C-7 regression: the zap must credit the receiver with only the aTokens THIS supply produced
  // (the balance delta), NOT the absolute aToken balance. Crediting balanceOf would let an attacker
  // pre-donate aTokens to the (stateless) zap and have the next caller sweep the donation into their
  // shares — a "last-caller-wins" griefing / accounting-corruption vector.
  //
  // Mechanism: donate aUSDC directly to the zap before the deposit. With the delta fix the receiver's
  // shares reflect only their own 100-USDC supply; the donated dust stays stranded in the zap.

  function test_DepositUnderlying_IgnoresDonatedATokens_NoGriefing() external {
    uint256 _donation = 5 * ONE;
    _donateATokensToZap(_donation);
    assertEq(aUSDC.balanceOf(address(zap)), _donation, 'zap must hold the donated aUSDC');

    uint256 _depositAmount = 100 * ONE;
    uint256 _shares = _depositAs(alice, _depositAmount, alice);

    // Shares must reflect the 100-USDC deposit only, never the 105 the zap transiently held.
    uint256 _sharesFor100 = vault.convertToShares(_depositAmount);
    uint256 _sharesFor105 = vault.convertToShares(_donation + _depositAmount);
    assertApproxEqAbs(_shares, _sharesFor100, 1, 'receiver credited only for its own deposit');
    assertLt(_shares, _sharesFor105, 'donated aTokens must NOT be credited to the receiver');
    assertApproxEqAbs(aUSDC.balanceOf(address(zap)), _donation, 2, 'donation stays stranded (not swept)');
    assertEq(vault.balanceOf(alice), _shares, 'all issued shares go to alice');
  }

  /*///////////////////////////////////////////////////////////////
                          redeemToUnderlying
  ///////////////////////////////////////////////////////////////*/

  // A zero-share redeem must revert; this test asserts the revert fires.

  function test_RedeemToUnderlying_RevertsOnZeroShares() external {
    vm.prank(alice);
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAmount.selector);
    zap.redeemToUnderlying(0, alice);
  }

  // The withdrawn underlying must go to the named receiver, not the caller. Alice first deposits to
  // build a position, then bob redeems alice's shares with alice as receiver. The test asserts
  // alice's USDC increased and bob's USDC did NOT change from before the redeem.

  function test_RedeemToUnderlying_SendsUnderlyingToReceiverNotCaller() external {
    // alice acquires shares via zap
    uint256 _amount = 100 * ONE;
    uint256 _shares = _depositAs(alice, _amount, alice);
    assertGt(_shares, 0, 'alice must have shares after deposit');

    // transfer shares to bob so bob can be the caller for the redeem
    vm.prank(alice);
    IERC20(address(vault)).transfer(bob, _shares);
    assertEq(vault.balanceOf(bob), _shares, 'bob must hold the shares');

    uint256 _bobUsdcBefore = usdc.balanceOf(bob);
    uint256 _aliceUsdcBefore = usdc.balanceOf(alice);

    // bob calls redeemToUnderlying specifying alice as the receiver
    uint256 _out = _redeemAs(bob, _shares, alice);

    assertGt(_out, 0, 'output must be positive');
    assertEq(usdc.balanceOf(alice), _aliceUsdcBefore + _out, 'alice (receiver) must get the USDC');
    assertEq(usdc.balanceOf(bob), _bobUsdcBefore, 'bob (caller) USDC balance must be unchanged');
  }

  // C-7 regression: a redeem must withdraw only the aTokens THIS redeem produced (balance delta),
  // never the absolute balance — otherwise a donated aToken balance is swept to the redeemer.

  function test_RedeemToUnderlying_IgnoresDonatedATokens_NoGriefing() external {
    // alice builds a position, then bob acquires the shares.
    uint256 _amount = 100 * ONE;
    uint256 _shares = _depositAs(alice, _amount, alice);
    vm.prank(alice);
    IERC20(address(vault)).transfer(bob, _shares);

    // A griefer donates aUSDC to the zap right before bob redeems.
    uint256 _donation = 5 * ONE;
    _donateATokensToZap(_donation);

    uint256 _out = _redeemAs(bob, _shares, bob);

    // bob receives only what his shares are worth (~100 USDC), NOT 105 including the donation.
    assertApproxEqAbs(_out, _amount, 2, 'redeemer gets only its own position, not the donation');
    assertLt(_out, _donation + _amount, 'donated aTokens must NOT be swept to the redeemer');
    assertApproxEqAbs(aUSDC.balanceOf(address(zap)), _donation, 2, 'donation stays stranded (not withdrawn)');
  }

  /*///////////////////////////////////////////////////////////////
                    buyFixedYieldToken / quoteBuy
  ///////////////////////////////////////////////////////////////*/

  // buyFixedYieldToken + quoteBuy are the EXACT-share entrypoints unique to this repo (added for
  // PPRouter.depositExactShares). Unlike depositUnderlying they mint an exact share count and forward
  // the <= SUPPLY_ROUNDING_BUFFER (2) wei of aToken dust to the receiver. The router path always
  // passes maxUnderlyingIn == the exact quote, so the zap's own slippage/zero guards are only
  // reachable by a direct caller — these tests exercise them directly.

  function test_BuyFixedYieldToken_MintsExactSharesToReceiver() external {
    uint256 _shares = vault.previewDeposit(ONE);
    uint256 _needed = zap.quoteBuy(_shares);
    usdc.mint(alice, _needed);

    vm.startPrank(alice);
    usdc.approve(address(zap), _needed);
    vm.expectEmit(address(zap));
    emit IPPYieldTokenZap.ZappedInExact(alice, bob, _needed, _shares);
    uint256 _underlyingIn = zap.buyFixedYieldToken(_shares, bob, _needed);
    vm.stopPrank();

    assertEq(_underlyingIn, _needed, 'underlyingIn must equal the quote');
    assertEq(vault.balanceOf(bob), _shares, 'receiver must get EXACTLY the requested shares');
    assertLe(aUSDC.balanceOf(bob), 2, 'at most SUPPLY_ROUNDING_BUFFER wei of aToken dust forwarded to receiver');
    assertEq(usdc.balanceOf(address(zap)), 0, 'zap must hold no USDC (stateless)');
    assertEq(aUSDC.balanceOf(address(zap)), 0, 'zap must hold no aToken (stateless)');
  }

  function test_BuyFixedYieldToken_RevertsWhenMaxUnderlyingTooLow() external {
    uint256 _shares = vault.previewDeposit(ONE);
    uint256 _needed = zap.quoteBuy(_shares);
    usdc.mint(alice, _needed);

    vm.startPrank(alice);
    usdc.approve(address(zap), _needed);
    vm.expectRevert(
      abi.encodeWithSelector(IPPYieldTokenZap.PPYieldTokenZap_SlippageExceeded.selector, _needed, _needed - 1)
    );
    zap.buyFixedYieldToken(_shares, bob, _needed - 1);
    vm.stopPrank();
  }

  // C-7 regression: buyFixedYieldToken must measure the wrap via the supply delta, so a donated
  // aToken balance can neither (falsely) satisfy the InsufficientWrap check nor be swept to the
  // receiver as "dust". The receiver gets exactly the requested shares plus at most the rounding
  // buffer; the donation stays stranded in the zap.

  function test_BuyFixedYieldToken_IgnoresDonatedATokens_NoGriefing() external {
    uint256 _donation = 5 * ONE;
    _donateATokensToZap(_donation);

    uint256 _shares = vault.previewDeposit(ONE);
    uint256 _needed = zap.quoteBuy(_shares);
    usdc.mint(alice, _needed);

    vm.startPrank(alice);
    usdc.approve(address(zap), _needed);
    zap.buyFixedYieldToken(_shares, bob, _needed);
    vm.stopPrank();

    assertEq(vault.balanceOf(bob), _shares, 'receiver must get EXACTLY the requested shares');
    assertLe(aUSDC.balanceOf(bob), 2, 'receiver gets only this-call rounding dust, not the donation');
    assertApproxEqAbs(aUSDC.balanceOf(address(zap)), _donation, 2, 'donation stays stranded (not swept)');
  }

  function test_BuyFixedYieldToken_RevertsWhenSharesIsZero() external {
    vm.expectRevert(IPPYieldTokenZap.PPYieldTokenZap_ZeroAmount.selector);
    zap.buyFixedYieldToken(0, alice, type(uint256).max);
  }

  // C-7 regression (wrap-check side): the InsufficientWrap guard must measure the SUPPLY DELTA, not the
  // absolute aToken balance. This is invisible on the 1:1 mock (supply always credits exactly what was
  // supplied), so it needs a pool that under-credits by MORE than the rounding buffer AND a pre-donated
  // aToken balance in the zap. With the delta measurement the wrap comes up 1 wei short and reverts
  // PPYieldTokenZap_InsufficientWrap. A mutant that checked `A_TOKEN.balanceOf(this) >= _aNeeded` instead
  // would see the donation cover the shortfall and pass the guard — minting shares backed by the griefer's
  // donation. Uses a dedicated under-crediting pool (the shared MockAaveMulti is exactly 1:1 and cannot
  // under-credit).
  function test_BuyFixedYieldToken_RevertsOnUnderCreditedWrap_DonationCannotCover() external {
    // Under-credit by 3 wei aToken per supply — one more than the zap's _SUPPLY_ROUNDING_BUFFER (2), so a
    // supply of `_aNeeded + 2` yields only `_aNeeded - 1` aTokens: the wrap is genuinely short.
    uint256 _shortfall = 3;
    MockUnderCreditingPool _uPool = new MockUnderCreditingPool(IERC20Metadata(address(usdc)), _shortfall);
    MockAaveAToken _uAToken = _uPool.A_TOKEN();
    PPYieldToken _uVault = new PPYieldToken(IERC20(address(_uAToken)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    PPYieldTokenZap _uZap =
      new PPYieldTokenZap(IPPYieldToken(address(_uVault)), IAavePool(address(_uPool)), IERC20(address(usdc)));

    uint256 _shares = _uVault.previewDeposit(ONE);
    uint256 _aNeeded = _uVault.previewMint(_shares); // aTokens the wrap must produce
    uint256 _needed = _uZap.quoteBuy(_shares); // == _aNeeded + buffer; also the slippage cap

    // Griefer pre-donates a large aToken balance straight to the stateless zap. An absolute-balance wrap
    // check would be (wrongly) satisfied by donation + this-supply; the delta check ignores it.
    uint256 _donateSupply = 10 * ONE;
    usdc.mint(address(this), _donateSupply);
    usdc.approve(address(_uPool), _donateSupply);
    _uPool.supply(address(usdc), _donateSupply, address(this), 0);
    _uAToken.transfer(address(_uZap), _uAToken.balanceOf(address(this)));
    assertGt(_uAToken.balanceOf(address(_uZap)), _aNeeded, 'donation must exceed the wrap need');

    usdc.mint(alice, _needed);
    vm.startPrank(alice);
    usdc.approve(address(_uZap), _needed);
    // Correct (delta) code reverts: this supply produced only `_aNeeded - 1`.
    vm.expectRevert(
      abi.encodeWithSelector(IPPYieldTokenZap.PPYieldTokenZap_InsufficientWrap.selector, _aNeeded - 1, _aNeeded)
    );
    _uZap.buyFixedYieldToken(_shares, bob, _needed);
    vm.stopPrank();
  }

  function test_QuoteBuy_EqualsPreviewMintPlusRoundingBuffer() external {
    uint256 _shares = vault.previewDeposit(ONE);
    // SUPPLY_ROUNDING_BUFFER == 2 (over-supply so the exact mint can never revert on Aave's round-trip).
    assertEq(zap.quoteBuy(_shares), vault.previewMint(_shares) + 2, 'quoteBuy must be previewMint + buffer');
  }
}

/// @title MockUnderCreditingPool
/// @notice Aave-pool mock that credits `_amount - _SHORTFALL` aTokens on supply (never underflowing).
/// Models a pool whose scaledBalance round-trip under-credits by more than the zap's rounding buffer, so
/// a supply comes up short of the requested wrap. Exists because the shared `MockAaveMultiPool` is exactly
/// 1:1 and can never under-credit, which hides the difference between a SUPPLY-DELTA wrap check and an
/// ABSOLUTE-balance one. Over-collects underlying (takes `_amount`, mints less), so `withdraw` is always
/// covered.
contract MockUnderCreditingPool {
  MockAaveAToken public immutable A_TOKEN;
  uint256 internal immutable _SHORTFALL;

  constructor(IERC20Metadata _underlying, uint256 _shortfall) {
    A_TOKEN = new MockAaveAToken('Aave USDC', 'aUSDC', _underlying.decimals(), address(_underlying));
    _SHORTFALL = _shortfall;
  }

  function supply(address _asset, uint256 _amount, address _onBehalfOf, uint16) external {
    IERC20(_asset).transferFrom(msg.sender, address(this), _amount);
    uint256 _credit = _amount > _SHORTFALL ? _amount - _SHORTFALL : 0;
    A_TOKEN.poolMint(_onBehalfOf, _credit);
  }

  function withdraw(address _asset, uint256 _amount, address _to) external returns (uint256) {
    if (_amount == type(uint256).max) _amount = A_TOKEN.balanceOf(msg.sender);
    A_TOKEN.poolBurn(msg.sender, _amount);
    IERC20(_asset).transfer(_to, _amount);
    return _amount;
  }
}
