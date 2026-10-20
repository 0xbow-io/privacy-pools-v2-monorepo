// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {ReentrancyGuardTransient} from '@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol';

import {Test} from 'forge-std/Test.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title UnitPPYieldTokenReentrancy
/// @notice Reentrancy and CEI-ordering unit tests for the ppUSDC wrapper. The production asset is a
/// trusted hookless aToken, so these tests deploy dedicated wrappers over MALICIOUS assets (and a
/// malicious rewards controller / rescuable token) whose hooks re-enter the guarded functions. Each
/// test exercises a `nonReentrant` guard or the claimFees checks-effects-interactions ordering. No
/// sibling .tree: these are defense-in-depth tests, not BTT branches.
contract UnitPPYieldTokenReentrancy is Test {
  uint256 internal constant FEE = 1000; // 10%
  uint256 internal constant BPS = 10_000;
  uint256 internal constant ONE = 1e6; // 1 aUSDC (6 decimals)

  address internal admin = makeAddr('admin');
  address internal alice = makeAddr('alice');

  function _fee(uint256 _delta) internal pure returns (uint256 _feeAmount) {
    _feeAmount = (_delta * FEE) / BPS;
  }

  /// @notice Deploys a wrapper over a malicious 6-decimal asset (aUSDC-shaped) and points the hook
  /// back at it. Returns both so a test can arm the mode and re-entry target.
  function _deployOverMalicious() internal returns (ReentrantAsset _asset, PPYieldToken _vault) {
    _asset = new ReentrantAsset();
    _vault = new PPYieldToken(IERC20(address(_asset)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    _asset.setVault(address(_vault));
  }

  /// @notice Mints malicious asset to `_who`, approves the vault, and deposits, all hooks disarmed.
  function _depositClean(
    ReentrantAsset _asset,
    PPYieldToken _vault,
    address _who,
    uint256 _assets
  ) internal returns (uint256 _shares) {
    _asset.mint(_who, _assets);
    vm.startPrank(_who);
    _asset.approve(address(_vault), _assets);
    _shares = _vault.deposit(_assets, _who);
    vm.stopPrank();
  }

  /*///////////////////////////////////////////////////////////////
                          _deposit
  ///////////////////////////////////////////////////////////////*/

  // `_deposit` is `nonReentrant`. `super._deposit` calls `safeTransferFrom(asset, caller, vault,
  // assets)`, firing the malicious asset's transferFrom hook, which re-enters `deposit`. The re-entry
  // trips the guard and reverts ReentrancyGuardReentrantCall, which bubbles up through
  // safeTransferFrom and reverts the outer deposit.
  function test_Deposit_ReentryRevertsReentrancyGuard() external {
    (ReentrantAsset _asset, PPYieldToken _vault) = _deployOverMalicious();
    _asset.arm(ReentrantAsset.Mode.ReenterDeposit);

    uint256 _amount = 100 * ONE;
    _asset.mint(alice, _amount);
    vm.startPrank(alice);
    _asset.approve(address(_vault), _amount);
    // It reverts ReentrancyGuardReentrantCall (the transferFrom hook re-enters the guarded deposit)
    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _vault.deposit(_amount, alice);
    vm.stopPrank();
  }

  /*///////////////////////////////////////////////////////////////
                          _withdraw
  ///////////////////////////////////////////////////////////////*/

  // `_withdraw` is `nonReentrant`. The malicious asset holds its own share position and is the
  // withdrawer/receiver, so `super._withdraw`'s payout `safeTransfer` fires its transfer hook, which
  // re-enters `withdraw(1, asset, asset)`. The re-entrant call passes the maxWithdraw check (the asset
  // owns shares) and reaches `_withdraw`, where the guard trips. The guard is `_withdraw`'s only
  // modifier, so no ownership is needed.
  function test_Withdraw_ReentryRevertsReentrancyGuard() external {
    (ReentrantAsset _asset, PPYieldToken _vault) = _deployOverMalicious();
    _depositClean(_asset, _vault, address(_asset), 100 * ONE); // the asset holds a share position

    _asset.arm(ReentrantAsset.Mode.ReenterWithdraw);

    vm.prank(address(_asset));
    // It reverts ReentrancyGuardReentrantCall (the payout transfer hook re-enters the guarded withdraw)
    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _vault.withdraw(10 * ONE, address(_asset), address(_asset));
  }

  /*///////////////////////////////////////////////////////////////
                          claimFees
  ///////////////////////////////////////////////////////////////*/

  // claimFees is `onlyOwner nonReentrant` (onlyOwner runs first), so the re-entrant caller must be
  // the owner to reach the guard. The
  // malicious asset is therefore deployed AS the owner; the owner-pranked claimFees pays the fee,
  // firing the asset's transfer hook, which re-enters claimFees as the owner and reaches the guard.
  // Yield is accrued first so `_claimed` is non-zero and the payout transfer actually fires.
  function test_ClaimFees_ReentryRevertsReentrancyGuard() external {
    ReentrantAsset _asset = new ReentrantAsset();
    // owner == the malicious asset, so its re-entrant claimFees passes onlyOwner and hits nonReentrant
    PPYieldToken _vault = new PPYieldToken(IERC20(address(_asset)), FEE, address(_asset), 'Privacy Pool USDC', 'ppUSDC');
    _asset.setVault(address(_vault));
    _depositClean(_asset, _vault, alice, 100 * ONE);
    _asset.mint(address(_vault), 20 * ONE); // accrue yield -> non-zero claimable fee

    _asset.arm(ReentrantAsset.Mode.ReenterClaimFees);

    vm.prank(address(_asset));
    // It reverts ReentrancyGuardReentrantCall (the fee-payout transfer hook re-enters claimFees)
    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _vault.claimFees(address(_asset));
  }

  /*///////////////////////////////////////////////////////////////
                          rescueToken
  ///////////////////////////////////////////////////////////////*/

  // The asset is a normal mock; the RESCUED token is malicious. rescueToken is `onlyOwner
  // nonReentrant`, so the re-entrant caller
  // must be the owner; the malicious rescued token is therefore deployed AS the owner. The
  // owner-pranked rescueToken calls `safeTransfer(token, to, amount)`, firing the rescued token's
  // transfer hook, which re-enters rescueToken as the owner and reaches the guard.
  function test_RescueToken_ReentryRevertsReentrancyGuard() external {
    MockERC20 _asset = new MockERC20('Aave USDC', 'aUSDC', 6);
    ReentrantAsset _stray = new ReentrantAsset();
    // owner == the malicious rescued token, so its re-entrant rescueToken passes onlyOwner
    PPYieldToken _vault = new PPYieldToken(IERC20(address(_asset)), FEE, address(_stray), 'Privacy Pool USDC', 'ppUSDC');
    _stray.setVault(address(_vault));
    _stray.mint(address(_vault), 100e18);
    _stray.arm(ReentrantAsset.Mode.ReenterRescue);

    vm.prank(address(_stray));
    // It reverts ReentrancyGuardReentrantCall (the rescued-token transfer hook re-enters rescueToken)
    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _vault.rescueToken(IERC20(address(_stray)), address(_stray), 100e18);
  }

  /*///////////////////////////////////////////////////////////////
                          claimRewards
  ///////////////////////////////////////////////////////////////*/

  // claimRewards is `onlyOwner nonReentrant`, so the re-entrant caller must be the owner; the
  // malicious controller is therefore
  // both the vault owner AND the rewards controller. The owner-pranked claimRewards forwards to the
  // controller's `claimAllRewards`, which re-enters claimRewards as the owner and reaches the guard.
  function test_ClaimRewards_ReentryRevertsReentrancyGuard() external {
    MockERC20 _asset = new MockERC20('Aave USDC', 'aUSDC', 6);
    ReentrantController _controller = new ReentrantController();
    // owner == the malicious controller, so its re-entrant claimRewards passes onlyOwner
    PPYieldToken _vault =
      new PPYieldToken(IERC20(address(_asset)), FEE, address(_controller), 'Privacy Pool USDC', 'ppUSDC');
    _controller.setVault(address(_vault));

    vm.prank(address(_controller));
    _vault.setRewardsController(address(_controller));

    vm.prank(address(_controller));
    // It reverts ReentrancyGuardReentrantCall (the controller re-enters claimRewards)
    vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
    _vault.claimRewards(new address[](0), address(_controller));
  }

  /*///////////////////////////////////////////////////////////////
                          claimFees CEI
  ///////////////////////////////////////////////////////////////*/

  // claimFees must zero accumulatedFees BEFORE the fee transfer (checks-effects-interactions).
  // claimFees is nonReentrant, so this cannot be exercised by re-entering it. Instead the malicious
  // asset's fee-payout transfer hook STATICCALLs the unguarded view `claimableFees()` mid-transfer
  // and records it. By the time the hook fires the vault's balance has already dropped by the fee
  // (transfer debits the sender first), so `_pendingFees` is zero. With effects applied first,
  // accumulatedFees is already zeroed before the transfer, so claimableFees() observed mid-transfer
  // is 0. If the zeroing happened after the transfer, accumulatedFees would still be set, so the
  // observed value would equal the (non-zero) accrued fee. The test asserts the observed mid-transfer
  // value is zero.
  function test_ClaimFees_ObservesZeroedFeesMidTransfer() external {
    (ReentrantAsset _asset, PPYieldToken _vault) = _deployOverMalicious();
    _depositClean(_asset, _vault, alice, 100 * ONE); // lastCheckpointBalance == 100e6
    _asset.mint(address(_vault), 20 * ONE); // accrue yield; pending fee = 2e6

    // checkpoint the pending fee into accumulatedFees via a tiny extra deposit, so the fee is
    // ACCUMULATED (not pending) and lastCheckpointBalance tracks the live balance at claim time.
    _depositClean(_asset, _vault, alice, ONE);
    assertEq(_vault.accumulatedFees(), _fee(20 * ONE), 'precondition: fee should be accumulated');
    assertEq(
      _vault.lastCheckpointBalance(), _asset.balanceOf(address(_vault)), 'precondition: checkpoint tracks balance'
    );

    _asset.arm(ReentrantAsset.Mode.ObserveClaimableFees);

    vm.prank(admin);
    uint256 _claimed = _vault.claimFees(admin);
    assertEq(_claimed, _fee(20 * ONE), 'precondition: a non-zero fee must be claimed so the transfer fires');

    // It observes accumulatedFees already zeroed mid-transfer (CEI: effects before interactions).
    // Effects-first records 0; zeroing after the transfer would record the still-set accrued fee.
    assertEq(_asset.observedClaimableFees(), 0, 'accumulatedFees must be zeroed before the fee transfer (CEI)');
    assertTrue(_asset.observed(), 'precondition: the transfer hook must have fired and recorded');
  }
}

/// @notice A 6-decimal (aUSDC-shaped) ERC-20 whose transfer / transferFrom hooks either re-enter a
/// guarded function of the wrapper or staticcall an unguarded view mid-transfer. The mode flag picks
/// the behaviour so one mock serves the deposit, withdraw, claimFees, rescue and CEI-observe tests.
/// Disarmed (Mode.None) it behaves like a plain ERC-20 so setup deposits succeed.
contract ReentrantAsset is ERC20 {
  enum Mode {
    None,
    ReenterDeposit,
    ReenterWithdraw,
    ReenterClaimFees,
    ReenterRescue,
    ObserveClaimableFees
  }

  Mode public mode;
  address public vault;
  bool public observed;
  uint256 public observedClaimableFees;

  constructor() ERC20('Reentrant aUSDC', 'raUSDC') {}

  function decimals() public pure override returns (uint8) {
    return 6;
  }

  function mint(address _to, uint256 _amount) external {
    _mint(_to, _amount);
  }

  function setVault(address _vault) external {
    vault = _vault;
  }

  function arm(Mode _mode) external {
    mode = _mode;
  }

  /// @dev Fires on the fee-payout / withdraw-payout / rescue transfer (msg.sender is the vault). The
  /// balance move runs first (super) so an observed `claimableFees()` sees the post-debit balance.
  function transfer(address _to, uint256 _amount) public override returns (bool _ok) {
    _ok = super.transfer(_to, _amount);
    _runHook();
  }

  /// @dev Fires on the deposit pull (`super._deposit` -> safeTransferFrom). The balance move runs
  /// first so the re-entrant deposit sees a consistent state before tripping the guard.
  function transferFrom(address _from, address _to, uint256 _amount) public override returns (bool _ok) {
    _ok = super.transferFrom(_from, _to, _amount);
    _runHook();
  }

  function _runHook() internal {
    Mode _m = mode;
    if (_m == Mode.None) return;
    if (_m == Mode.ReenterDeposit) {
      PPYieldToken(vault).deposit(1, address(this));
    } else if (_m == Mode.ReenterWithdraw) {
      PPYieldToken(vault).withdraw(1, address(this), address(this));
    } else if (_m == Mode.ReenterClaimFees) {
      PPYieldToken(vault).claimFees(address(this));
    } else if (_m == Mode.ReenterRescue) {
      PPYieldToken(vault).rescueToken(IERC20(address(this)), address(this), 1);
    } else if (_m == Mode.ObserveClaimableFees) {
      observedClaimableFees = PPYieldToken(vault).claimableFees();
      observed = true;
    }
  }
}

/// @notice A malicious rewards controller whose `claimAllRewards` re-enters the wrapper's guarded
/// `claimRewards`. Matches the IAaveRewardsController signature the wrapper invokes.
contract ReentrantController {
  address public vault;

  function setVault(address _vault) external {
    vault = _vault;
  }

  function claimAllRewards(
    address[] calldata _assets,
    address _to
  ) external returns (address[] memory _rewardsList, uint256[] memory _claimedAmounts) {
    PPYieldToken(vault).claimRewards(_assets, _to);
    _rewardsList = new address[](0);
    _claimedAmounts = new uint256[](0);
  }
}
