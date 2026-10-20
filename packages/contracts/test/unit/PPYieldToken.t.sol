// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC4626} from '@openzeppelin/contracts/interfaces/IERC4626.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {StdStorage, stdStorage} from 'forge-std/Test.sol';
import {Test} from 'forge-std/Test.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title UnitPPYieldToken
/// @notice Unit tests for the ppUSDC wrapper. aUSDC is mocked; yield is simulated by minting aUSDC
/// directly to the vault. See test/unit/PPYieldToken.tree.
contract UnitPPYieldToken is Test {
  using stdStorage for StdStorage;

  MockERC20 internal aUSDC;
  PPYieldToken internal vault;

  uint256 internal constant FEE = 1000; // 10%
  uint256 internal constant BPS = 10_000;
  uint256 internal constant MAX_FEE = 2000; // mirrors the contract's MAX_FEE_BPS (20%)
  uint256 internal constant ONE = 1e6; // 1 aUSDC (6 decimals)
  uint256 internal constant OFFSET = 1e12; // 10 ** _decimalsOffset()

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');
  address internal bob = makeAddr('bob');

  function setUp() external {
    aUSDC = new MockERC20('Aave USDC', 'aUSDC', 6);
    vault = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
  }

  /*///////////////////////////////////////////////////////////////
                            HELPERS
  ///////////////////////////////////////////////////////////////*/

  function _deposit(address _who, uint256 _assets) internal returns (uint256 _shares) {
    aUSDC.mint(_who, _assets);
    vm.startPrank(_who);
    aUSDC.approve(address(vault), _assets);
    _shares = vault.deposit(_assets, _who);
    vm.stopPrank();
  }

  function _accrueYield(uint256 _amount) internal {
    aUSDC.mint(address(vault), _amount);
  }

  function _fee(uint256 _delta) internal pure returns (uint256 _feeAmount) {
    _feeAmount = (_delta * FEE) / BPS;
  }

  /*///////////////////////////////////////////////////////////////
                          constructor
  ///////////////////////////////////////////////////////////////*/

  function test_Constructor_WhenAdminIsTheZeroAddress() external {
    // It should revert with OwnableInvalidOwner
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
    new PPYieldToken(IERC20(address(aUSDC)), FEE, address(0), 'Privacy Pool USDC', 'ppUSDC');
  }

  function test_Constructor_WhenInitialFeeExceedsMax() external {
    // It should revert with PPYieldToken_FeeTooHigh
    // (hoist the member-access out of the `new` args: solc 0.8.32 ICEs on an external call there)
    uint256 _tooHigh = MAX_FEE + 1;
    vm.expectRevert(IPPYieldToken.PPYieldToken_FeeTooHigh.selector);
    new PPYieldToken(IERC20(address(aUSDC)), _tooHigh, admin, 'Privacy Pool USDC', 'ppUSDC');
  }

  function test_Constructor_WhenCalledWithValidParameters() external view {
    // It sets feeBps and admin
    assertEq(vault.feeBps(), FEE);
    assertEq(vault.admin(), admin);
    assertEq(vault.owner(), admin);
    assertEq(IPPYieldToken(address(vault)).MAX_FEE_BPS(), MAX_FEE);
    // It sets the asset, name, symbol and decimals
    assertEq(vault.asset(), address(aUSDC));
    assertEq(vault.name(), 'Privacy Pool USDC');
    assertEq(vault.symbol(), 'ppUSDC');
    assertEq(vault.decimals(), 18);
    // It initializes accounting to zero
    assertEq(vault.accumulatedFees(), 0);
    assertEq(vault.lastCheckpointBalance(), 0);
    assertEq(vault.totalSupply(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          decimals
  ///////////////////////////////////////////////////////////////*/

  function test_Decimals_Returns18() external view {
    // It returns 18 (aUSDC 6 decimals + offset 12)
    assertEq(vault.decimals(), 18);
  }

  function test_Decimals_OffsetIsTwelve() external {
    // It converts the first deposit to assets * 10**offset shares
    uint256 _shares = _deposit(alice, ONE);
    assertEq(_shares, ONE * OFFSET);
  }

  /*///////////////////////////////////////////////////////////////
                          deposit
  ///////////////////////////////////////////////////////////////*/

  function test_Deposit_GivenTotalSupplyIsZero_WhenAssetsIsZero() external {
    // It should revert with PPYieldToken_ZeroShares
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroShares.selector);
    vault.deposit(0, alice);
  }

  function test_Deposit_GivenTotalSupplyIsZero_WhenCalledWithValidAssets() external {
    uint256 _amount = 100 * ONE;
    aUSDC.mint(alice, _amount);
    vm.startPrank(alice);
    aUSDC.approve(address(vault), _amount);

    // It emits a Deposit event
    vm.expectEmit(address(vault));
    emit IERC4626.Deposit(alice, alice, _amount, _amount * OFFSET);
    uint256 _shares = vault.deposit(_amount, alice);
    vm.stopPrank();

    // It mints assets * 10**offset shares (1:1 net) and pulls the assets
    assertEq(_shares, _amount * OFFSET);
    assertEq(vault.balanceOf(alice), _amount * OFFSET);
    assertEq(aUSDC.balanceOf(address(vault)), _amount);
    assertEq(aUSDC.balanceOf(alice), 0);
    // It sets lastCheckpointBalance and leaves accumulatedFees at zero
    assertEq(vault.lastCheckpointBalance(), _amount);
    assertEq(vault.accumulatedFees(), 0);
  }

  function test_Deposit_GivenTotalSupplyIsNonZero_GivenYieldHasAccrued() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    uint256 _b = 50 * ONE;

    _deposit(alice, _a);
    _accrueYield(_delta);
    _deposit(bob, _b);

    // It checkpoints fee * delta into accumulatedFees
    assertEq(vault.accumulatedFees(), _fee(_delta));
    // It sets lastCheckpointBalance to the post-deposit balance
    assertEq(vault.lastCheckpointBalance(), _a + _delta + _b);
    // It mints fewer than 1:1 shares since the rate rose, rounded down
    assertLt(vault.balanceOf(bob), _b * OFFSET);
    assertGt(vault.balanceOf(bob), 0);
  }

  function test_Deposit_GivenTotalSupplyIsNonZero_GivenNoYield() external {
    uint256 _a = 100 * ONE;
    uint256 _b = 50 * ONE;

    _deposit(alice, _a);
    uint256 _bShares = _deposit(bob, _b);

    // It leaves accumulatedFees unchanged and mints at the current ~1:1 rate
    assertEq(vault.accumulatedFees(), 0);
    assertApproxEqRel(_bShares, _b * OFFSET, 1e12); // within 1e-6
  }

  function test_Deposit_WhenTheDepositWouldMintZeroShares() external {
    // inflate the rate so a 1-unit deposit rounds to zero shares
    _deposit(alice, 1);
    _accrueYield(1e24);

    aUSDC.mint(bob, 1);
    vm.startPrank(bob);
    aUSDC.approve(address(vault), 1);
    // It should revert with PPYieldToken_ZeroShares
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroShares.selector);
    vault.deposit(1, bob);
    vm.stopPrank();
  }

  function test_Deposit_WhenTheCallerHasInsufficientAllowance() external {
    aUSDC.mint(alice, ONE);
    vm.prank(alice);
    // It should revert with ERC20InsufficientAllowance
    vm.expectRevert();
    vault.deposit(ONE, alice);
  }

  /*///////////////////////////////////////////////////////////////
                          maxDeposit
  ///////////////////////////////////////////////////////////////*/

  function test_MaxDeposit_GivenNotPaused() external view {
    // It returns type(uint256).max (no deposit cap)
    assertEq(vault.maxDeposit(alice), type(uint256).max);
  }

  function test_MaxDeposit_GivenPaused() external {
    // It returns zero while paused
    vm.prank(admin);
    vault.pause();
    assertEq(vault.maxDeposit(alice), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          mint
  ///////////////////////////////////////////////////////////////*/

  function test_Mint_WhenSharesIsZero() external {
    // It should revert with PPYieldToken_ZeroShares
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroShares.selector);
    vault.mint(0, alice);
  }

  function test_Mint_WhenCalledWithValidShares() external {
    uint256 _shares = 100 * ONE * OFFSET;
    uint256 _assets = vault.previewMint(_shares);

    aUSDC.mint(alice, _assets);
    vm.startPrank(alice);
    aUSDC.approve(address(vault), _assets);
    uint256 _paid = vault.mint(_shares, alice);
    vm.stopPrank();

    // It pulls previewMint assets and mints exactly shares
    assertEq(_paid, _assets);
    assertEq(vault.balanceOf(alice), _shares);
    assertEq(vault.lastCheckpointBalance(), _assets);
  }

  /*///////////////////////////////////////////////////////////////
                          withdraw
  ///////////////////////////////////////////////////////////////*/

  function test_Withdraw_WhenAssetsIsZero() external {
    _deposit(alice, 100 * ONE);
    // It should revert with PPYieldToken_ZeroAssets
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroAssets.selector);
    vault.withdraw(0, alice, alice);
  }

  function test_Withdraw_GivenYieldHasAccrued() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta);

    uint256 _out = 30 * ONE;
    vm.prank(alice);
    // It emits a Withdraw event
    vm.expectEmit(true, true, true, false, address(vault));
    emit IERC4626.Withdraw(alice, alice, alice, _out, 0);
    vault.withdraw(_out, alice, alice);

    // It transfers assets, checkpoints the fee and updates lastCheckpointBalance
    assertEq(aUSDC.balanceOf(alice), _out);
    assertEq(vault.accumulatedFees(), _fee(_delta));
    assertEq(vault.lastCheckpointBalance(), _a + _delta - _out);
  }

  function test_Withdraw_WhenWithdrawExceedsMaxWithdraw() external {
    _deposit(alice, 100 * ONE);
    // It should revert with ERC4626ExceededMaxWithdraw
    vm.prank(alice);
    vm.expectRevert();
    vault.withdraw(1000 * ONE, alice, alice);
  }

  function test_Withdraw_WhenWithdrawingOnBehalfWithoutAllowance() external {
    _deposit(alice, 100 * ONE);
    // It should revert with ERC20InsufficientAllowance
    vm.prank(bob);
    vm.expectRevert();
    vault.withdraw(10 * ONE, bob, alice);
  }

  /*///////////////////////////////////////////////////////////////
                          redeem
  ///////////////////////////////////////////////////////////////*/

  function test_Redeem_WhenSharesIsZero() external {
    _deposit(alice, 100 * ONE);
    // It should revert with PPYieldToken_ZeroAssets
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroAssets.selector);
    vault.redeem(0, alice, alice);
  }

  function test_Redeem_WhenRedeemWouldReturnZeroAssets() external {
    _deposit(alice, 100 * ONE);
    // It should revert with PPYieldToken_ZeroAssets (1 share of an 18-dp token rounds to 0 aUSDC)
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroAssets.selector);
    vault.redeem(1, alice, alice);
  }

  function test_Redeem_WhenCalledWithValidShares() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta);

    uint256 _shares = vault.balanceOf(alice);
    vm.prank(alice);
    uint256 _out = vault.redeem(_shares, alice, alice);

    // It returns principal + (1 - fee) * delta and checkpoints the fee
    assertApproxEqAbs(_out, _a + (_delta - _fee(_delta)), 2);
    assertEq(vault.balanceOf(alice), 0);
    assertEq(vault.accumulatedFees(), _fee(_delta));
    // It leaves the protocol fee in the vault
    assertApproxEqAbs(aUSDC.balanceOf(address(vault)), _fee(_delta), 2);
  }

  function test_Redeem_WhenRedeemExceedsMaxRedeem() external {
    uint256 _shares = _deposit(alice, 100 * ONE);
    // It should revert with ERC4626ExceededMaxRedeem
    vm.prank(alice);
    vm.expectRevert();
    vault.redeem(_shares + 1, alice, alice);
  }

  /*///////////////////////////////////////////////////////////////
                          claimFees
  ///////////////////////////////////////////////////////////////*/

  function test_ClaimFees_WhenTheCallerIsNotAdmin() external {
    // It should revert with OwnableUnauthorizedAccount
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.claimFees();
  }

  function test_ClaimFees_GivenThereAreAccumulatedAndPendingFees() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta);
    _deposit(bob, 10 * ONE); // checkpoint the fee

    assertEq(vault.accumulatedFees(), _fee(_delta));
    uint256 _rateBefore = vault.exchangeRate();
    uint256 _recipBalBefore = aUSDC.balanceOf(admin);

    vm.prank(admin);
    // It emits a FeesClaimed event
    vm.expectEmit(address(vault));
    emit IPPYieldToken.FeesClaimed(admin, _fee(_delta));
    uint256 _claimed = vault.claimFees();

    // It sweeps the fee, zeroes accumulatedFees and preserves the exchange rate
    assertEq(_claimed, _fee(_delta));
    assertEq(aUSDC.balanceOf(admin), _recipBalBefore + _fee(_delta));
    assertEq(vault.accumulatedFees(), 0);
    assertEq(vault.lastCheckpointBalance(), aUSDC.balanceOf(address(vault)));
    assertEq(vault.exchangeRate(), _rateBefore);
  }

  function test_ClaimFees_GivenThereAreOnlyPendingFees() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta); // pending, never checkpointed

    assertEq(vault.accumulatedFees(), 0);

    vm.prank(admin);
    uint256 _claimed = vault.claimFees();

    // It checkpoints and sweeps the pending portion
    assertEq(_claimed, _fee(_delta));
    assertEq(aUSDC.balanceOf(admin), _fee(_delta));
  }

  function test_ClaimFees_GivenThereAreZeroFees() external {
    _deposit(alice, 100 * ONE);

    vm.prank(admin);
    // It emits a FeesClaimed event with amount zero and transfers nothing
    vm.expectEmit(address(vault));
    emit IPPYieldToken.FeesClaimed(admin, 0);
    uint256 _claimed = vault.claimFees();

    assertEq(_claimed, 0);
    assertEq(aUSDC.balanceOf(admin), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          totalAssets
  ///////////////////////////////////////////////////////////////*/

  function test_TotalAssets_GivenNoYield() external {
    _deposit(alice, 100 * ONE);
    // It returns aUSDC balance minus accumulatedFees
    assertEq(vault.totalAssets(), 100 * ONE);
  }

  function test_TotalAssets_GivenPendingYield() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta);
    // It returns balance minus (accumulatedFees + pending fee)
    assertEq(vault.totalAssets(), _a + _delta - _fee(_delta));
  }

  function test_TotalAssets_GivenBalanceIsBelowCurrentFees() external {
    _deposit(alice, 100 * ONE);
    // force accumulatedFees above the aUSDC balance
    stdstore.target(address(vault)).sig('accumulatedFees()').checked_write(1e30);
    // It returns zero (clamped)
    assertEq(vault.totalAssets(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          exchangeRate
  ///////////////////////////////////////////////////////////////*/

  function test_ExchangeRate_WhenTotalSupplyIsZero() external view {
    // It returns 10**assetDecimals at the 1:1 base rate
    assertEq(vault.exchangeRate(), ONE);
    assertEq(vault.exchangeRate(), vault.convertToAssets(10 ** 18));
  }

  function test_ExchangeRate_WhenTotalSupplyIsNonZero() external {
    _deposit(alice, 100 * ONE);
    // It returns convertToAssets of one whole share
    assertEq(vault.exchangeRate(), vault.convertToAssets(10 ** 18));
    assertApproxEqAbs(vault.exchangeRate(), ONE, 1);
  }

  function test_ExchangeRate_GivenYieldHasAccrued() external {
    _deposit(alice, 100 * ONE);
    uint256 _before = vault.exchangeRate();
    _accrueYield(20 * ONE);
    // It increases relative to before, net of the fee
    assertGt(vault.exchangeRate(), _before);
  }

  /*///////////////////////////////////////////////////////////////
                          claimableFees
  ///////////////////////////////////////////////////////////////*/

  function test_ClaimableFees_GivenNoYield() external {
    _deposit(alice, 100 * ONE);
    // It returns accumulatedFees
    assertEq(vault.claimableFees(), 0);
  }

  function test_ClaimableFees_GivenPendingYield() external {
    uint256 _delta = 20 * ONE;
    _deposit(alice, 100 * ONE);
    _accrueYield(_delta);
    // It returns accumulatedFees plus fee * delta
    assertEq(vault.claimableFees(), _fee(_delta));
  }

  /*///////////////////////////////////////////////////////////////
                          feeAccrual
  ///////////////////////////////////////////////////////////////*/

  function test_FeeAccrual_GivenTheFeeIsNonZero() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_delta);
    _deposit(bob, 1 * ONE); // checkpoint

    // It accrues fee * delta to the protocol
    assertEq(vault.accumulatedFees(), _fee(_delta));
    // It credits (1 - fee) * delta to holders via the exchange rate
    uint256 _aliceAssets = vault.convertToAssets(vault.balanceOf(alice));
    assertApproxEqAbs(_aliceAssets, _a + (_delta - _fee(_delta)), 3);
  }

  function test_FeeAccrual_GivenTheFeeIsZero() external {
    PPYieldToken _zeroFee = new PPYieldToken(IERC20(address(aUSDC)), 0, admin, 'Privacy Pool USDC', 'ppUSDC');
    uint256 _a = 100 * ONE;
    uint256 _delta = 20 * ONE;

    aUSDC.mint(alice, _a);
    vm.startPrank(alice);
    aUSDC.approve(address(_zeroFee), _a);
    _zeroFee.deposit(_a, alice);
    vm.stopPrank();

    aUSDC.mint(address(_zeroFee), _delta);

    // It accrues no fee and credits all yield to holders
    assertEq(_zeroFee.claimableFees(), 0);
    assertEq(_zeroFee.totalAssets(), _a + _delta);
  }

  function test_FeeAccrual_GivenYieldAccruesAcrossMultipleIntervals() external {
    uint256 _a = 100 * ONE;
    uint256 _d1 = 20 * ONE;
    uint256 _d2 = 30 * ONE;

    _deposit(alice, _a);
    _accrueYield(_d1);
    _deposit(bob, ONE); // checkpoint d1
    _accrueYield(_d2);
    _deposit(bob, ONE); // checkpoint d2

    // It accumulates fees additively across checkpoints
    assertEq(vault.accumulatedFees(), _fee(_d1) + _fee(_d2));
  }

  function test_FeeAccrual_GivenADonationDirectlyToTheVault() external {
    uint256 _a = 100 * ONE;
    uint256 _donation = 40 * ONE;
    _deposit(alice, _a);

    // a third party donates aUSDC directly
    aUSDC.mint(address(vault), _donation);

    // It treats the donation as yield (fee taken, remainder to holders)
    assertEq(vault.claimableFees(), _fee(_donation));
    assertEq(vault.totalAssets(), _a + _donation - _fee(_donation));
  }

  function test_FeeAccrual_GivenAFuzzedSequenceOfActions(uint256 _d1, uint256 _y1, uint256 _w, uint256 _y2) external {
    _d1 = bound(_d1, ONE, 1e12);
    _y1 = bound(_y1, 0, 1e12);
    _y2 = bound(_y2, 0, 1e12);

    _deposit(alice, _d1);
    _accrueYield(_y1);

    uint256 _maxW = vault.maxWithdraw(alice);
    _w = bound(_w, 0, _maxW);
    if (_w > 0) {
      vm.prank(alice);
      vault.withdraw(_w, alice, alice);
    }
    _accrueYield(_y2);

    // It never lets total redeemable plus accumulatedFees exceed the aUSDC balance
    assertLe(vault.totalAssets() + vault.claimableFees(), aUSDC.balanceOf(address(vault)));
  }

  /*///////////////////////////////////////////////////////////////
                          inflationAttack
  ///////////////////////////////////////////////////////////////*/

  function test_InflationAttack_GivenAOneWeiSeedAndLargeDonation() external {
    _deposit(alice, 1); // attacker seeds 1 unit
    aUSDC.mint(address(vault), 1e18); // attacker donates large amount

    // It still mints non-zero shares to a normal second depositor (virtual shares protect)
    uint256 _bobShares = _deposit(bob, 100 * ONE);
    assertGt(_bobShares, 0);

    vm.prank(bob);
    uint256 _out = vault.redeem(_bobShares, bob, bob);
    assertGt(_out, 0); // bob recovers value, not stolen
  }

  /*///////////////////////////////////////////////////////////////
                          noLeakRoundTrip
  ///////////////////////////////////////////////////////////////*/

  function test_NoLeakRoundTrip_GivenADepositThenImmediateRedeemWithNoYield() external {
    uint256 _amount = 100 * ONE;
    uint256 _shares = _deposit(alice, _amount);

    vm.prank(alice);
    uint256 _out = vault.redeem(_shares, alice, alice);

    // It returns approximately N aUSDC and zeroes total supply
    assertApproxEqAbs(_out, _amount, 2);
    assertEq(vault.totalSupply(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          lossHandling
  ///////////////////////////////////////////////////////////////*/

  function test_LossHandling_GivenBalanceDrops_HoldersBearItNoFee() external {
    _deposit(alice, 100 * ONE);
    // simulate an Aave markdown: the vault's aUSDC balance falls 20%
    deal(address(aUSDC), address(vault), 80 * ONE);

    // It accrues no fee on a drop and reflects the loss in net assets
    assertEq(vault.claimableFees(), 0);
    assertEq(vault.totalAssets(), 80 * ONE);

    // It still lets the holder exit, bearing the loss pro-rata, with no revert
    uint256 _shares = vault.balanceOf(alice);
    vm.prank(alice);
    uint256 _out = vault.redeem(_shares, alice, alice);
    assertApproxEqAbs(_out, 80 * ONE, 2);
    assertEq(vault.accumulatedFees(), 0);
  }

  function test_LossHandling_GivenRecoveryBelowLastCheckpoint_AccruesNoFee() external {
    _deposit(alice, 100 * ONE); // lastCheckpointBalance = 100
    deal(address(aUSDC), address(vault), 80 * ONE); // loss
    deal(address(aUSDC), address(vault), 95 * ONE); // partial recovery, still below 100

    // It charges no fee on recovery below the last checkpoint (gains measured from the checkpoint)
    assertEq(vault.claimableFees(), 0);
    assertEq(vault.totalAssets(), 95 * ONE);
  }

  /*///////////////////////////////////////////////////////////////
                          extra coverage
  ///////////////////////////////////////////////////////////////*/

  function test_MaxMint_GivenNotPaused() external view {
    assertEq(vault.maxMint(alice), type(uint256).max);
  }

  function test_MaxMint_GivenPaused() external {
    // It returns zero while paused
    vm.prank(admin);
    vault.pause();
    assertEq(vault.maxMint(alice), 0);
  }

  function test_Mint_GivenYieldHasAccrued() external {
    _deposit(alice, 100 * ONE);
    _accrueYield(20 * ONE);

    uint256 _shares = 10 * ONE * OFFSET;
    uint256 _assets = vault.previewMint(_shares);
    aUSDC.mint(bob, _assets);
    vm.startPrank(bob);
    aUSDC.approve(address(vault), _assets);
    vault.mint(_shares, bob);
    vm.stopPrank();

    // It checkpoints the fee on the prior yield and mints exactly shares
    assertEq(vault.accumulatedFees(), _fee(20 * ONE));
    assertEq(vault.balanceOf(bob), _shares);
  }

  function test_Redeem_WhenRedeemingOnBehalfWithoutAllowance() external {
    uint256 _shares = _deposit(alice, 100 * ONE);
    // It should revert with ERC20InsufficientAllowance
    vm.prank(bob);
    vm.expectRevert();
    vault.redeem(_shares, bob, alice);
  }
}
