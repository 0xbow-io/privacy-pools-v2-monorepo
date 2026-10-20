// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {Pausable} from '@openzeppelin/contracts/utils/Pausable.sol';

import {Test} from 'forge-std/Test.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';
import {MockRewardsController} from 'test/helpers/MockRewardsController.sol';

/// @title UnitPPYieldTokenAdmin
/// @notice Unit tests for the ppUSDC admin surface: fees (setFeeBps), ownership (2-step transfer,
/// renounce disabled), rewards (claimRewards/setRewardsController), and token rescue. See
/// test/unit/PPYieldToken.tree.
contract UnitPPYieldTokenAdmin is Test {
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
                          setFeeBps
  ///////////////////////////////////////////////////////////////*/

  function test_SetFeeBps_WhenCallerIsNotAdmin() external {
    // It should revert with OwnableUnauthorizedAccount
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.setFeeBps(500);
  }

  function test_SetFeeBps_WhenNewFeeExceedsMax() external {
    // It should revert with PPYieldToken_FeeTooHigh
    uint256 _tooHigh = MAX_FEE + 1;
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_FeeTooHigh.selector);
    vault.setFeeBps(_tooHigh);
  }

  function test_SetFeeBps_WhenValid() external {
    // It updates feeBps and emits FeeUpdated
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit IPPYieldToken.FeeUpdated(FEE, 2000);
    vault.setFeeBps(2000);
    assertEq(vault.feeBps(), 2000);
  }

  function test_SetFeeBps_ChargesAccruedYieldAtOldRateThenSwitches() external {
    uint256 _a = 100 * ONE;
    uint256 _d1 = 20 * ONE;
    _deposit(alice, _a);
    _accrueYield(_d1); // 20 yield under the old 10% fee

    vm.prank(admin);
    vault.setFeeBps(2000); // -> 20%; must checkpoint the 20 at 10% first

    // It charged pre-change yield at the OLD rate and reset the baseline
    assertEq(vault.accumulatedFees(), (_d1 * FEE) / BPS);
    assertEq(vault.lastCheckpointBalance(), _a + _d1);

    // It charges new yield at the new rate
    uint256 _d2 = 30 * ONE;
    _accrueYield(_d2);
    assertEq(vault.claimableFees(), (_d1 * FEE) / BPS + (_d2 * 2000) / BPS);
  }

  /*///////////////////////////////////////////////////////////////
                          claimFees (recipient overload)
  ///////////////////////////////////////////////////////////////*/

  function test_ClaimFees_WhenGivenAnExplicitRecipient() external {
    uint256 _delta = 20 * ONE;
    _deposit(alice, 100 * ONE);
    _accrueYield(_delta);

    address _treasury = makeAddr('treasury');
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit IPPYieldToken.FeesClaimed(_treasury, _fee(_delta));
    uint256 _claimed = vault.claimFees(_treasury);

    // It sweeps to the passed recipient, not the admin
    assertEq(_claimed, _fee(_delta));
    assertEq(aUSDC.balanceOf(_treasury), _fee(_delta));
    assertEq(aUSDC.balanceOf(admin), 0);
  }

  function test_ClaimFees_WhenRecipientIsZero() external {
    _deposit(alice, 100 * ONE);
    _accrueYield(20 * ONE);
    // It should revert with PPYieldToken_ZeroAddress
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroAddress.selector);
    vault.claimFees(address(0));
  }

  /*///////////////////////////////////////////////////////////////
                          fee accounting
  ///////////////////////////////////////////////////////////////*/

  // _pendingFees must charge exactly floor(feeBps * delta / MAX_BPS). A remainder-bearing delta that
  // is also at least the checkpoint balance pins the exact floored fee, distinguishing it from any
  // rounding variant (ceil, floor-of-delta, round-nearest) and from a modulo or sub-MAX_BPS
  // miscalculation. With a 10% fee, _a = 1000 and delta = 9999 the exact fee is 999, while ceil is
  // 1000, floor-of-delta is 0 and round-nearest is 1000, so only the correct formula passes.
  function test_PendingFees_RemainderBearingDeltaChargesExactFloorFee() external {
    uint256 _a = 1000; // checkpoint balance after the first deposit
    uint256 _delta = 9999; // >= _a, %10 == 9, < MAX_BPS: pins the exact floored fee
    _deposit(alice, _a);
    _accrueYield(_delta);

    // It charges exactly feeBps * delta / MAX_BPS, floored - not ceil, floor-of-delta, nearest or `%`
    uint256 _exact = (_delta * FEE) / BPS; // 999
    assertEq(_exact, 999, 'precondition: exact fee should be 999');
    assertEq(vault.claimableFees(), _exact, 'pending fee must equal floor(feeBps * delta / MAX_BPS)');
  }

  // The one-wei fee boundary: a delta of 10 under a 10% fee yields exactly 1 wei of fee, and that
  // single wei must still be transferred to the recipient rather than stranded.
  function test_ClaimFees_TransfersAOneWeiFee() external {
    uint256 _a = 100 * ONE;
    uint256 _delta = 10; // 10 * 1000 / 10000 == 1 wei of fee
    _deposit(alice, _a);
    _accrueYield(_delta);

    assertEq(vault.claimableFees(), 1, 'precondition: claimable fee should be exactly 1 wei');

    address _treasury = makeAddr('treasury');
    vm.prank(admin);
    uint256 _claimed = vault.claimFees(_treasury);

    // It actually transfers the single wei to the recipient
    assertEq(_claimed, 1, 'claimed should be 1 wei');
    assertEq(aUSDC.balanceOf(_treasury), 1, 'the 1 wei fee must reach the recipient');
  }

  // The constructor fee bound is inclusive: a fee of exactly MAX_FEE_BPS must be accepted, while one
  // above it must revert. (The MAX_FEE_BPS + 1 reject is also covered in PPYieldToken.t.sol.)
  function test_Constructor_AcceptsFeeEqualToMax() external {
    // It deploys successfully with the initial fee at exactly MAX_FEE_BPS
    PPYieldToken _atMax = new PPYieldToken(IERC20(address(aUSDC)), MAX_FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    assertEq(_atMax.feeBps(), MAX_FEE, 'feeBps should equal MAX_FEE_BPS');

    // It still rejects one above the bound
    uint256 _tooHigh = MAX_FEE + 1;
    vm.expectRevert(IPPYieldToken.PPYieldToken_FeeTooHigh.selector);
    new PPYieldToken(IERC20(address(aUSDC)), _tooHigh, admin, 'Privacy Pool USDC', 'ppUSDC');
  }

  // The zero-claim no-transfer guarantee and the post-claim resync. After a balance drop the
  // claimable fee is zero, yet lastCheckpointBalance is still stale (above the live balance). A zero
  // claim must (a) move no assets, so no zero-value transfer fires, and (b) still resync
  // lastCheckpointBalance to the live balance even though nothing was claimed. Both are observed: no
  // transfer call fires, and the next yield interval accrues from the post-claim (lower) basis.
  function test_ClaimFees_ZeroClaimMovesNothingAndResyncsBasis() external {
    uint256 _a = 100 * ONE;
    _deposit(alice, _a); // lastCheckpointBalance == 100e6
    deal(address(aUSDC), address(vault), 80 * ONE); // Aave markdown: live balance falls below the checkpoint

    assertEq(vault.claimableFees(), 0, 'precondition: a drop accrues no fee');

    address _treasury = makeAddr('treasury');
    // It moves no assets on a zero claim (the guard must short-circuit the transfer entirely)
    vm.expectCall(address(aUSDC), abi.encodeCall(IERC20.transfer, (_treasury, 0)), 0);
    vm.prank(admin);
    uint256 _claimed = vault.claimFees(_treasury);

    assertEq(_claimed, 0, 'a zero claim returns zero');
    assertEq(aUSDC.balanceOf(_treasury), 0, 'recipient balance must be unchanged');
    // It resyncs lastCheckpointBalance to the live balance even on a zero claim
    assertEq(vault.lastCheckpointBalance(), 80 * ONE, 'lastCheckpointBalance must resync to the live balance');

    // It therefore measures the next interval from the resynced basis: a recovery to 110e6 is a
    // 30e6 gain (fee 3e6), not a 10e6 gain off the stale 100e6 basis (fee 1e6).
    _accrueYield(30 * ONE); // live balance 80e6 -> 110e6
    assertEq(vault.claimableFees(), (30 * ONE * FEE) / BPS, 'next-interval fee must use the resynced basis');
  }

  /*///////////////////////////////////////////////////////////////
                          admin transfer (2-step)
  ///////////////////////////////////////////////////////////////*/

  function test_Admin_ReturnsOwner() external view {
    assertEq(vault.admin(), vault.owner());
  }

  function test_TransferAdmin_WhenCallerIsNotAdmin() external {
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.transferOwnership(bob);
  }

  function test_TransferAdmin_IsTwoStep() external {
    // step 1: admin proposes; the role does not change until accepted
    vm.prank(admin);
    vault.transferOwnership(bob);
    assertEq(vault.admin(), admin);
    assertEq(vault.pendingOwner(), bob);

    // a non-pending address cannot accept
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.acceptOwnership();

    // step 2: the pending owner accepts and becomes the admin
    vm.prank(bob);
    vault.acceptOwnership();
    assertEq(vault.admin(), bob);

    // the new admin holds the powers; the old admin no longer does
    vm.prank(admin);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, admin));
    vault.setFeeBps(0);
    vm.prank(bob);
    vault.setFeeBps(0);
    assertEq(vault.feeBps(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          setRewardsController
  ///////////////////////////////////////////////////////////////*/

  function test_SetRewardsController_WhenCallerIsNotAdmin() external {
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.setRewardsController(address(1));
  }

  function test_SetRewardsController_WhenValid() external {
    address _controller = makeAddr('controller');
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit IPPYieldToken.RewardsControllerUpdated(address(0), _controller);
    vault.setRewardsController(_controller);
    assertEq(vault.rewardsController(), _controller);
  }

  /*///////////////////////////////////////////////////////////////
                          claimRewards
  ///////////////////////////////////////////////////////////////*/

  function test_ClaimRewards_WhenCallerIsNotAdmin() external {
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.claimRewards(new address[](0), alice);
  }

  function test_ClaimRewards_WhenControllerNotSet() external {
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_RewardsControllerNotSet.selector);
    vault.claimRewards(new address[](0), admin);
  }

  function test_ClaimRewards_ForwardsToControllerAndSendsRewardToRecipient() external {
    // configure a mock controller holding a reward token
    MockRewardsController _controller = new MockRewardsController();
    MockERC20 _reward = new MockERC20('Reward', 'RWD', 18);
    _reward.mint(address(_controller), 7e18);
    _controller.setReward(_reward, 7e18);

    vm.prank(admin);
    vault.setRewardsController(address(_controller));

    address[] memory _assets = new address[](1);
    _assets[0] = address(aUSDC);
    address _treasury = makeAddr('treasury');

    vm.prank(admin);
    (address[] memory _list, uint256[] memory _amts) = vault.claimRewards(_assets, _treasury);

    // It forwards to the controller, which sends the reward to the recipient (not user funds)
    assertEq(_reward.balanceOf(_treasury), 7e18);
    assertEq(_controller.lastTo(), _treasury);
    assertEq(_list[0], address(_reward));
    assertEq(_amts[0], 7e18);
    // It never touched the vault's aUSDC
    assertEq(aUSDC.balanceOf(address(vault)), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          rescueToken
  ///////////////////////////////////////////////////////////////*/

  function test_RescueToken_WhenCallerIsNotAdmin() external {
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.rescueToken(IERC20(address(aUSDC)), alice, 1);
  }

  function test_RescueToken_WhenTokenIsTheAsset() external {
    // It should revert with PPYieldToken_CannotRescueAsset (backing can never be swept)
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_CannotRescueAsset.selector);
    vault.rescueToken(IERC20(address(aUSDC)), admin, 1);
  }

  function test_RescueToken_WhenRecipientIsZero() external {
    MockERC20 _stray = new MockERC20('Stray', 'STR', 18);
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroAddress.selector);
    vault.rescueToken(IERC20(address(_stray)), address(0), 1);
  }

  function test_RescueToken_WhenValid() external {
    // a stray (airdropped) token lands in the vault
    MockERC20 _stray = new MockERC20('Stray', 'STR', 18);
    _stray.mint(address(vault), 100e18);

    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit IPPYieldToken.TokenRescued(address(_stray), admin, 100e18);
    vault.rescueToken(IERC20(address(_stray)), admin, 100e18);

    assertEq(_stray.balanceOf(admin), 100e18);
    assertEq(_stray.balanceOf(address(vault)), 0);
  }

  function test_RescueToken_CanRescueStrayShares() external {
    // a user accidentally sends ppUSDC to the vault itself
    uint256 _shares = _deposit(alice, 100 * ONE);
    vm.prank(alice);
    vault.transfer(address(vault), _shares);
    assertEq(vault.balanceOf(address(vault)), _shares);

    // the admin can rescue the stray shares (token == address(this), != asset)
    vm.prank(admin);
    vault.rescueToken(IERC20(address(vault)), alice, _shares);
    assertEq(vault.balanceOf(alice), _shares);
    assertEq(vault.balanceOf(address(vault)), 0);
  }

  function test_SetFeeBps_GivenNoYield_IsANoOpCheckpoint() external {
    _deposit(alice, 100 * ONE); // no yield accrued
    vm.prank(admin);
    vault.setFeeBps(500);
    // It changes the fee without accruing anything (delta == 0)
    assertEq(vault.feeBps(), 500);
    assertEq(vault.accumulatedFees(), 0);
    assertEq(vault.lastCheckpointBalance(), 100 * ONE);
  }

  function test_SetRewardsController_OverwriteEmitsOldAndNew() external {
    address _first = makeAddr('first');
    address _second = makeAddr('second');
    vm.prank(admin);
    vault.setRewardsController(_first);
    // It emits the previous controller as _old when overwriting
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit IPPYieldToken.RewardsControllerUpdated(_first, _second);
    vault.setRewardsController(_second);
    assertEq(vault.rewardsController(), _second);
  }

  /*///////////////////////////////////////////////////////////////
                          renounceOwnership (disabled)
  ///////////////////////////////////////////////////////////////*/

  function test_RenounceOwnership_RevertsForAdmin() external {
    // It should revert with PPYieldToken_RenounceDisabled (admin is transferable, never droppable)
    vm.prank(admin);
    vm.expectRevert(IPPYieldToken.PPYieldToken_RenounceDisabled.selector);
    vault.renounceOwnership();
  }

  function test_RenounceOwnership_RevertsForNonAdmin() external {
    // onlyOwner rejects a non-admin before the disabled-revert
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.renounceOwnership();
  }

  /*///////////////////////////////////////////////////////////////
                          pause / unpause
  ///////////////////////////////////////////////////////////////*/

  function test_Pause_WhenCallerIsNotAdmin() external {
    // It should revert with OwnableUnauthorizedAccount
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.pause();
  }

  function test_Unpause_WhenCallerIsNotAdmin() external {
    // It should revert with OwnableUnauthorizedAccount
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
    vault.unpause();
  }

  function test_Pause_BlocksDepositAndMint() external {
    // It sets paused to true and emits Paused
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit Pausable.Paused(admin);
    vault.pause();
    assertTrue(vault.paused());
    // It sets maxDeposit and maxMint to zero (the ERC-4626 cap the entrypoints enforce)
    assertEq(vault.maxDeposit(alice), 0);
    assertEq(vault.maxMint(alice), 0);

    // It blocks deposit (maxDeposit==0 -> ERC4626ExceededMaxDeposit)
    vm.prank(alice);
    vm.expectRevert();
    vault.deposit(1 * ONE, alice);

    // It blocks mint (maxMint==0 -> ERC4626ExceededMaxMint)
    vm.prank(alice);
    vm.expectRevert();
    vault.mint(1 * ONE * OFFSET, alice);
  }

  function test_Pause_StillAllowsExitAndClaim() external {
    // a holder with a position and accrued yield
    _deposit(alice, 100 * ONE);
    _accrueYield(20 * ONE);

    vm.prank(admin);
    vault.pause();

    // It still allows withdraw
    vm.prank(alice);
    vault.withdraw(10 * ONE, alice, alice);

    // It still allows redeem (burn the rest). Read balance BEFORE the prank so the inline call
    // does not consume it.
    uint256 _rest = vault.balanceOf(alice);
    vm.prank(alice);
    vault.redeem(_rest, alice, alice);
    assertEq(vault.balanceOf(alice), 0);

    // It still allows claimFees
    vm.prank(admin);
    uint256 _claimed = vault.claimFees(admin);
    assertGt(_claimed, 0);
  }

  function test_Pause_WhenAlreadyPaused() external {
    vm.prank(admin);
    vault.pause();
    // It should revert with EnforcedPause
    vm.prank(admin);
    vm.expectRevert(Pausable.EnforcedPause.selector);
    vault.pause();
  }

  function test_Unpause_WhenNotPaused() external {
    // It should revert with ExpectedPause
    vm.prank(admin);
    vm.expectRevert(Pausable.ExpectedPause.selector);
    vault.unpause();
  }

  function test_Unpause_AfterPauseAllowsDepositsAgain() external {
    vm.prank(admin);
    vault.pause();

    // It sets paused to false and emits Unpaused
    vm.prank(admin);
    vm.expectEmit(address(vault));
    emit Pausable.Unpaused(admin);
    vault.unpause();
    assertFalse(vault.paused());

    // It allows deposits again
    uint256 _shares = _deposit(alice, 100 * ONE);
    assertGt(_shares, 0);
  }

  function test_Unpause_RestoresMaxDepositAndMint() external {
    vm.prank(admin);
    vault.pause();
    vm.prank(admin);
    vault.unpause();
    // It restores maxDeposit/maxMint to unbounded after unpause
    assertEq(vault.maxDeposit(alice), type(uint256).max);
    assertEq(vault.maxMint(alice), type(uint256).max);
  }

  function test_Pause_ZeroAmountDepositStillRevertsZeroShares() external {
    // While paused, a 0-amount deposit slips past the maxDeposit==0 check (0 <= 0) and is caught by
    // the dust revert - confirming the INTL-10 ordering (no unreachable EnforcedPause backstop).
    vm.prank(admin);
    vault.pause();
    vm.prank(alice);
    vm.expectRevert(IPPYieldToken.PPYieldToken_ZeroShares.selector);
    vault.deposit(0, alice);
  }
}
