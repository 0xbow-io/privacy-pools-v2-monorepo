// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

import {Test} from 'forge-std/Test.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title PPYieldTokenHandler
/// @notice Bounded random-action driver for the ppUSDC invariant suite. Each action keeps inputs in
/// valid ranges and records ghost state for the before/after properties (rate monotonicity,
/// claim-preserves-rate) and the cumulative-yield/fee bound.
contract PPYieldTokenHandler is Test {
  uint256 internal constant MAX_FEE_BPS = 2000; // mirrors the contract's cap (20%)

  PPYieldToken internal immutable VAULT;
  MockERC20 internal immutable A_USDC;
  MockERC20 internal immutable STRAY; // a non-asset token, for the rescueToken action
  address internal immutable ADMIN;

  address[3] internal actors;

  uint256 public cumulativeYield; // total simulated Aave yield minted to the vault
  uint256 public cumulativeClaimed; // total fees swept to the recipient
  uint256 internal lastRate; // last meaningful exchange rate (0 == "no baseline")
  bool public rateDecreased; // set if the rate ever fell (beyond rounding) while supply > 0
  bool public adminMovedRate; // set if an admin action (claim or setFeeBps) moved the rate

  constructor(PPYieldToken _vault, MockERC20 _aUSDC, address _admin) {
    VAULT = _vault;
    A_USDC = _aUSDC;
    ADMIN = _admin;
    STRAY = new MockERC20('Stray', 'STR', 18);
    actors = [makeAddr('actor0'), makeAddr('actor1'), makeAddr('actor2')];
  }

  function _actor(uint256 _seed) internal view returns (address) {
    return actors[_seed % actors.length];
  }

  /// @dev Record the post-action rate and flag any decrease while shares exist. When supply is zero
  /// the per-share rate is ill-defined (leftover fee dust with no shares), so reset the baseline.
  function _afterAction() internal {
    if (VAULT.totalSupply() == 0) {
      lastRate = 0;
      return;
    }
    uint256 _rate = VAULT.exchangeRate();
    if (lastRate != 0 && _rate + 2 < lastRate) rateDecreased = true;
    lastRate = _rate;
  }

  function deposit(uint256 _actorSeed, uint256 _amount) external {
    if (VAULT.paused()) return; // deposits are closed while paused
    address _actor = _actor(_actorSeed);
    _amount = bound(_amount, 1, 1e15);
    if (VAULT.previewDeposit(_amount) == 0) return;
    A_USDC.mint(_actor, _amount);
    vm.startPrank(_actor);
    A_USDC.approve(address(VAULT), _amount);
    VAULT.deposit(_amount, _actor);
    vm.stopPrank();
    _afterAction();
  }

  function mintShares(uint256 _actorSeed, uint256 _shares) external {
    if (VAULT.paused()) return; // mints are closed while paused
    address _actor = _actor(_actorSeed);
    _shares = bound(_shares, 1, 1e21);
    uint256 _assets = VAULT.previewMint(_shares);
    if (_assets == 0) return;
    A_USDC.mint(_actor, _assets);
    vm.startPrank(_actor);
    A_USDC.approve(address(VAULT), _assets);
    VAULT.mint(_shares, _actor);
    vm.stopPrank();
    _afterAction();
  }

  function withdraw(uint256 _actorSeed, uint256 _amount) external {
    address _actor = _actor(_actorSeed);
    uint256 _maxW = VAULT.maxWithdraw(_actor);
    if (_maxW == 0) return;
    _amount = bound(_amount, 1, _maxW);
    vm.prank(_actor);
    VAULT.withdraw(_amount, _actor, _actor);
    _afterAction();
  }

  function redeem(uint256 _actorSeed, uint256 _shares) external {
    address _actor = _actor(_actorSeed);
    uint256 _bal = VAULT.balanceOf(_actor);
    if (_bal == 0) return;
    _shares = bound(_shares, 1, _bal);
    if (VAULT.previewRedeem(_shares) == 0) return;
    vm.prank(_actor);
    VAULT.redeem(_shares, _actor, _actor);
    _afterAction();
  }

  function transferShares(uint256 _fromSeed, uint256 _toSeed, uint256 _amount) external {
    address _from = _actor(_fromSeed);
    address _to = _actor(_toSeed);
    uint256 _bal = VAULT.balanceOf(_from);
    if (_bal == 0) return;
    _amount = bound(_amount, 1, _bal);
    vm.prank(_from);
    VAULT.transfer(_to, _amount);
    _afterAction();
  }

  function accrueYield(uint256 _amount) external {
    _amount = bound(_amount, 0, 1e14);
    if (_amount != 0) {
      A_USDC.mint(address(VAULT), _amount);
      cumulativeYield += _amount;
    }
    _afterAction();
  }

  function claimFees() external {
    bool _supplyPositive = VAULT.totalSupply() > 0;
    uint256 _before = _supplyPositive ? VAULT.exchangeRate() : 0;
    vm.prank(ADMIN);
    cumulativeClaimed += VAULT.claimFees();
    if (_supplyPositive && VAULT.totalSupply() > 0) {
      uint256 _after = VAULT.exchangeRate();
      if (_after > _before + 2 || _before > _after + 2) adminMovedRate = true;
    }
    _afterAction();
  }

  function rescueStray(uint256 _seed) external {
    // a stray (non-asset) token lands in the vault and the admin rescues it - must never
    // affect the aUSDC backing or the rate (asserted by the invariants after this action)
    uint256 _amt = bound(_seed, 1, 1e24);
    STRAY.mint(address(VAULT), _amt);
    vm.prank(ADMIN);
    VAULT.rescueToken(IERC20(address(STRAY)), ADMIN, _amt);
    _afterAction();
  }

  function togglePause(uint256) external {
    // interleave pause/unpause with the other actions; withdraw/redeem/claimFees keep running while
    // paused, so the solvency/backing invariants assert holders can always exit under a pause.
    // Read paused() BEFORE the prank so the inline call does not consume it.
    bool _paused = VAULT.paused();
    vm.prank(ADMIN);
    if (_paused) VAULT.unpause();
    else VAULT.pause();
    _afterAction();
  }

  function setFeeBps(uint256 _seed) external {
    // fuzz fee changes within the cap, interleaved with the other actions
    bool _supplyPositive = VAULT.totalSupply() > 0;
    uint256 _before = _supplyPositive ? VAULT.exchangeRate() : 0;
    vm.prank(ADMIN);
    VAULT.setFeeBps(bound(_seed, 0, MAX_FEE_BPS));
    // a fee change checkpoints at the old rate and must not move the exchange rate
    if (_supplyPositive && VAULT.totalSupply() > 0) {
      uint256 _after = VAULT.exchangeRate();
      if (_after > _before + 2 || _before > _after + 2) adminMovedRate = true;
    }
    _afterAction();
  }
}

/// @title InvariantPPYieldToken
/// @notice Stateful invariants for the ppUSDC wrapper. See test/invariant/PPYieldToken.tree.
contract InvariantPPYieldToken is Test {
  uint256 internal constant FEE = 1000; // initial fee at deploy
  uint256 internal constant MAX_FEE_BPS = 2000; // cap the fee can be raised to (via setFeeBps fuzz)
  uint256 internal constant BPS = 10_000;

  MockERC20 internal aUSDC;
  PPYieldToken internal vault;
  PPYieldTokenHandler internal handler;

  address internal admin = makeAddr('admin');

  function setUp() public {
    aUSDC = new MockERC20('Aave USDC', 'aUSDC', 6);
    vault = new PPYieldToken(IERC20(address(aUSDC)), FEE, admin, 'Privacy Pool USDC', 'ppUSDC');
    handler = new PPYieldTokenHandler(vault, aUSDC, admin);
    targetContract(address(handler));
  }

  /// @notice Everything owed (net assets + claimable fee) is covered by the aUSDC the vault holds
  function invariant_Solvency() public view {
    assertLe(vault.totalAssets() + vault.claimableFees(), aUSDC.balanceOf(address(vault)));
  }

  /// @notice Outstanding shares are never worth more than the net assets backing them
  function invariant_SharesFullyBacked() public view {
    assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalAssets());
  }

  /// @notice Cumulative protocol fees never exceed MAX_FEE_BPS of cumulative yield (holds even as
  /// the handler fuzzes the fee within the cap, since every interval is charged at <= MAX_FEE_BPS)
  function invariant_FeeBound() public view {
    uint256 _totalFees = vault.claimableFees() + handler.cumulativeClaimed();
    assertLe(_totalFees, (handler.cumulativeYield() * MAX_FEE_BPS) / BPS + 1);
  }

  /// @notice The checkpoint balance never exceeds the live balance (only yield grows it between actions)
  function invariant_CheckpointNeverExceedsBalance() public view {
    assertLe(vault.lastCheckpointBalance(), aUSDC.balanceOf(address(vault)));
  }

  /// @notice The exchange rate never decreases while shares exist (no loss in the mock)
  function invariant_RateMonotonic() public view {
    assertFalse(handler.rateDecreased());
  }

  /// @notice Admin actions (claimFees, setFeeBps) never move the exchange rate
  function invariant_AdminActionsPreserveRate() public view {
    assertFalse(handler.adminMovedRate());
  }
}
