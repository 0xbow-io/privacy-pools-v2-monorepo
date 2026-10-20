// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from 'forge-std/Test.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';

import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenFactory} from 'contracts/PPYieldTokenFactory.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {MockAaveAToken, MockAaveMultiPool} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

/// @title HandlerYield
/// @notice Self-contained fuzz target for the yield layer (`PPYieldTokenZap` + `PPYieldToken`),
/// exercising the underlying <-> pp-share round trip via the stateless zap over a factory-seeded
/// wrapper. The yield layer is an add-on to the core pool (routed through `PPRouter` on-chain) and is
/// NOT part of `Deploy.s.sol`, so it is stood up here on a minimal 1:1 Aave mock rather than wired
/// into the core-protocol invariant harness. Ghost sums let the paired `InvariantYield` assert
/// value-conservation, C-7 no-griefing, and dead-share-lock properties.
/// @dev Every mutating action is a public `handler_*` entry point so Foundry targets it as a fuzz
/// selector. The mock pool is exactly 1:1 (no interest, no pool-level rounding); all rounding lives in
/// the ERC-4626 share<->asset conversion, so ghost accounting is exact and the invariants are tight.
contract HandlerYield is Test {
  /*///////////////////////////////////////////////////////////////
                            CONSTANTS
  ///////////////////////////////////////////////////////////////*/

  /// @dev Burn address that holds the factory-seeded, permanently-locked dead shares. Kept internal:
  ///      a public `address constant` getter trips a solc 0.8.32 ICE, and the value is a fixed literal
  ///      the invariant contract references directly.
  address internal constant _DEAD = address(0xdEaD);

  /// @dev Underlying decimals (USDC-like) — drives the ERC-4626 offset (18 - 6 = 12).
  uint8 internal constant _UNDERLYING_DECIMALS = 6;

  /// @dev Wrapper yield fee (bps). Never actually accrues here since the mock pays no interest, but a
  ///      non-zero fee exercises the checkpoint path on every deposit/withdraw.
  uint256 internal constant _FEE_BPS = 1000; // 10%

  /// @dev Dead-share seed supplied to the factory at wrapper creation (in underlying units).
  uint256 internal constant _SEED_ASSETS = 1e6; // 1 USDC

  /// @dev Per-action bounds on underlying amounts pulled from actors (1e3 = 0.001 USDC .. 1e12 = 1M USDC).
  uint256 internal constant _MIN_UNDERLYING = 1e3;
  uint256 internal constant _MAX_UNDERLYING = 1e12;

  /*///////////////////////////////////////////////////////////////
                          FIXTURE HANDLES
  ///////////////////////////////////////////////////////////////*/

  MockAaveMultiPool public pool;
  MockERC20 public underlying;
  MockAaveAToken public aToken;
  PPYieldTokenFactory public factory;
  PPYieldToken public vault;
  PPYieldTokenZap public zap;

  /// @dev Fuzz actors that hold shares / receive underlying.
  address[] internal _actors;

  /*///////////////////////////////////////////////////////////////
                          GHOST VARIABLES
  ///////////////////////////////////////////////////////////////*/

  /// @notice Total underlying pulled from actors into the zap across deposits + exact buys.
  uint256 public ghost_underlyingSupplied;

  /// @notice Total aTokens that actually entered the vault as share backing. Equals `ghost_underlyingSupplied`
  ///         for deposits (all supplied aTokens are wrapped) but EXCLUDES the per-buy `_SUPPLY_ROUNDING_BUFFER`
  ///         dust that `buyFixedYieldToken` forwards to the receiver (never reaches the vault). Lets the
  ///         paired invariant tie `totalAssets()` to tracked backing flows independently of the share math.
  uint256 public ghost_vaultBackingIn;

  /// @notice Total underlying withdrawn to receivers via `redeemToUnderlying`.
  uint256 public ghost_underlyingRedeemed;

  /// @notice Total pp-shares ever minted to actors (excludes the factory-seeded dead shares).
  uint256 public ghost_sharesMinted;

  /// @notice Total pp-shares ever redeemed by actors.
  uint256 public ghost_sharesRedeemed;

  /// @notice Total aTokens donated directly to the (stateless) zap to simulate C-7 griefing.
  uint256 public ghost_donatedAToken;

  /// @notice The factory-seeded dead shares, snapshotted at construction (must never change).
  uint256 public deadShares;

  /*///////////////////////////////////////////////////////////////
                          CONSTRUCTOR
  ///////////////////////////////////////////////////////////////*/

  constructor() {
    address _admin = makeAddr('yieldAdmin');
    address _factoryOwner = makeAddr('yieldFactoryOwner');

    pool = new MockAaveMultiPool();
    underlying = new MockERC20('USD Coin', 'USDC', _UNDERLYING_DECIMALS);
    aToken = pool.addReserve(IERC20Metadata(address(underlying)), 'Aave USDC', 'aUSDC');
    factory = new PPYieldTokenFactory(IAavePool(address(pool)), _factoryOwner);

    // Seed the wrapper through the real factory path so the dead-share lock is genuine.
    underlying.mint(_factoryOwner, _SEED_ASSETS);
    vm.startPrank(_factoryOwner);
    underlying.approve(address(factory), _SEED_ASSETS);
    address _wrapper =
      factory.createWrapper(address(aToken), _FEE_BPS, _admin, 'Privacy Pool USDC', 'ppUSDC', _SEED_ASSETS);
    vm.stopPrank();

    vault = PPYieldToken(_wrapper);
    zap = new PPYieldTokenZap(IPPYieldToken(_wrapper), IAavePool(address(pool)), IERC20(address(underlying)));

    deadShares = vault.balanceOf(_DEAD);

    for (uint256 _i; _i < 4; ++_i) {
      _actors.push(makeAddr(string.concat('yieldActor', vm.toString(_i))));
    }
  }

  /*///////////////////////////////////////////////////////////////
                        HANDLER FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  /// @notice Fuzz target: supply underlying and wrap the resulting aTokens into pp-shares for an actor.
  /// @dev underlying -> shares via `PPYieldTokenZap.depositUnderlying`.
  function handler_zapDeposit(uint256 _amountSeed, uint256 _actorSeed) external {
    address _actor = _pickActor(_actorSeed);
    uint256 _amount = bound(_amountSeed, _MIN_UNDERLYING, _MAX_UNDERLYING);

    underlying.mint(_actor, _amount);
    vm.startPrank(_actor);
    underlying.approve(address(zap), _amount);
    uint256 _shares = zap.depositUnderlying(_amount, _actor);
    vm.stopPrank();

    ghost_underlyingSupplied += _amount;
    ghost_vaultBackingIn += _amount; // deposits wrap the full supplied delta; nothing forwarded away
    ghost_sharesMinted += _shares;
  }

  /// @notice Fuzz target: mint an exact pp-share amount to an actor via the buffered exact-in path.
  /// @dev underlying -> exact shares via `PPYieldTokenZap.buyFixedYieldToken`.
  function handler_buyFixedYieldToken(uint256 _sharesSeed, uint256 _actorSeed) external {
    address _actor = _pickActor(_actorSeed);
    // Bound in aToken (asset) units, then convert to a target share count so the buy never rounds to
    // zero and the underlying pulled stays within the same range as deposits.
    uint256 _assets = bound(_sharesSeed, _MIN_UNDERLYING, _MAX_UNDERLYING);
    uint256 _shares = vault.previewDeposit(_assets);
    if (_shares == 0) return;

    uint256 _needed = zap.quoteBuy(_shares);
    // aTokens the vault will actually pull (the wrap backing); the buy over-supplies by
    // `_SUPPLY_ROUNDING_BUFFER` and forwards that dust to the receiver, so it never backs shares.
    uint256 _aNeeded = vault.previewMint(_shares);
    underlying.mint(_actor, _needed);
    vm.startPrank(_actor);
    underlying.approve(address(zap), _needed);
    uint256 _underlyingIn = zap.buyFixedYieldToken(_shares, _actor, _needed);
    vm.stopPrank();

    ghost_underlyingSupplied += _underlyingIn;
    ghost_vaultBackingIn += _aNeeded;
    ghost_sharesMinted += _shares;
  }

  /// @notice Fuzz target: redeem an actor's pp-shares back to underlying via the zap.
  /// @dev shares -> underlying via `PPYieldTokenZap.redeemToUnderlying`. No-ops (returns, no revert)
  ///      when the picked actor holds nothing redeemable, so it never poisons `fail_on_revert`.
  function handler_zapRedeem(uint256 _sharesSeed, uint256 _actorSeed) external {
    address _actor = _pickActor(_actorSeed);
    uint256 _balance = vault.balanceOf(_actor);
    if (_balance == 0) return;

    uint256 _shares = bound(_sharesSeed, 1, _balance);
    // A dust redeem that rounds to zero assets would revert (PPYieldToken_ZeroAssets); skip instead.
    if (vault.previewRedeem(_shares) == 0) return;

    vm.startPrank(_actor);
    IERC20(address(vault)).approve(address(zap), _shares);
    uint256 _out = zap.redeemToUnderlying(_shares, _actor);
    vm.stopPrank();

    ghost_underlyingRedeemed += _out;
    ghost_sharesRedeemed += _shares;
  }

  /// @notice Fuzz target (griefing): donate aTokens straight to the stateless zap.
  /// @dev Stresses the C-7 balance-delta accounting: the zap must strand the donation, never sweep it
  ///      into a caller's shares or a redeemer's payout.
  function handler_donateAToken(uint256 _amountSeed) external {
    uint256 _amount = bound(_amountSeed, 1, _MAX_UNDERLYING);
    // MockAaveAToken is pool-mint only: supply through the pool to this handler, then transfer the
    // minted aTokens to the zap (1:1, so `_amount` underlying == `_amount` aToken).
    underlying.mint(address(this), _amount);
    underlying.approve(address(pool), _amount);
    pool.supply(address(underlying), _amount, address(this), 0);

    // Update ghost accounting before the transfer (test handler; avoids solhint's
    // state-change-after-transfer reentrancy heuristic).
    ghost_donatedAToken += _amount;
    aToken.transfer(address(zap), _amount);
  }

  /*///////////////////////////////////////////////////////////////
                            VIEWS
  ///////////////////////////////////////////////////////////////*/

  function actorsLength() external view returns (uint256 _length) {
    _length = _actors.length;
  }

  function actors(uint256 _i) external view returns (address _actor) {
    _actor = _actors[_i];
  }

  /*///////////////////////////////////////////////////////////////
                        INTERNAL FUNCTIONS
  ///////////////////////////////////////////////////////////////*/

  function _pickActor(uint256 _seed) internal view returns (address _actor) {
    _actor = _actors[_seed % _actors.length];
  }
}
