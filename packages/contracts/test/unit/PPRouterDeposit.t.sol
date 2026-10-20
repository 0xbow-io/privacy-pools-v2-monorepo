// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouterBase} from 'test/unit/helpers/PPRouterBase.sol';

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPYieldToken} from 'contracts/PPYieldToken.sol';
import {PPYieldTokenZap} from 'contracts/PPYieldTokenZap.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPRouter} from 'interfaces/IPPRouter.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {MockAaveAToken} from 'test/helpers/MockAaveMulti.sol';
import {MockERC20} from 'test/helpers/MockERC20.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/// @notice Coverage for {PPRouter.depositExactShares}: the exact-output wrap+shield math, the
/// `maxUnderlyingIn` slippage bound, the vetting-fee split, dust `skim`, the constructor guards, and
/// the `quote` helper. No Groth16 — the monorepo integration tests cover real proofs. See PPRouterDeposit.tree.
contract UnitPPRouterDeposit is PPRouterBase {
  /// @notice After a rate rise, the router shields exactly the committed value; only USDC floats.
  function test_DepositExactShares_SucceedsAfterRateRise() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    (uint256 _quoteR0,) = router.quote(SHIELD_VALUE);

    _accrueYield(50e6); // lift the rate

    (uint256 _need,) = router.quote(SHIELD_VALUE);
    assertGt(_need, _quoteR0, 'committed value costs more underlying after the rate rise');

    _fundAlice(_need);
    vm.prank(alice);
    uint256 _pulled = router.depositExactShares(_p, _noteData(), bytes(''), _need);

    assertEq(_pulled, _need, 'pulls exactly the quoted underlying');
    assertEq(entrypoint.shielded(address(vault)), SHIELD_VALUE, 'exactly the committed value is shielded');
    assertEq(vault.balanceOf(alice), 0, 'no un-shielded pp-share dust with the payer');
    assertEq(vault.balanceOf(address(router)), 0, 'router holds no pp-shares');
    assertLe(aUSDC.balanceOf(address(router)), 2, 'only wei-level aToken dust remains');
    // The router's forceApprove(ZAP, underlyingIn) is exactly consumed by the zap's supply — no residue.
    assertEq(usdc.allowance(address(router), address(zap)), 0, 'no residual underlying allowance to the zap');
  }

  /// @notice With a non-zero vetting fee the router mints `value + fee`; the entrypoint splits them.
  function test_DepositExactShares_WithVettingFeeSplitsValueAndFee() external {
    _enableAsset(100); // 1%
    uint256 _expectedFee = (SHIELD_VALUE * 100) / 10_000;

    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _accrueYield(50e6);
    (uint256 _need, uint256 _total) = router.quote(SHIELD_VALUE);
    assertEq(_total, SHIELD_VALUE + _expectedFee, 'quote total = value + vetting fee');

    _fundAlice(_need);
    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);

    assertEq(entrypoint.shielded(address(vault)), SHIELD_VALUE, 'pool shields exactly value');
    assertEq(entrypoint.feeCollected(address(vault)), _expectedFee, 'vetting fee retained by entrypoint');
    assertEq(vault.balanceOf(address(router)), 0, 'router minted exactly value + fee');
  }

  /// @notice A proof targeting a different asset than the router's vault is rejected.
  function test_DepositExactShares_RevertsOnAssetMismatch() external {
    address _other = makeAddr('otherAsset');
    ProofLibV2.DepositProof memory _p = _proof(_other, SHIELD_VALUE);
    _fundAlice(type(uint128).max);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_AssetMismatch.selector, _other));
    router.depositExactShares(_p, _noteData(), bytes(''), type(uint256).max);
  }

  /// @notice A zero committed value is rejected.
  function test_DepositExactShares_RevertsOnZeroValue() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), 0);
    vm.prank(alice);
    vm.expectRevert(IPPRouter.PPRouter_ZeroValue.selector);
    router.depositExactShares(_p, _noteData(), bytes(''), type(uint256).max);
  }

  /// @notice The happy path emits `Deposited` with payer, asset, value, underlying pulled, and total.
  function test_DepositExactShares_EmitsDeposited() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _accrueYield(50e6);
    (uint256 _need, uint256 _total) = router.quote(SHIELD_VALUE);
    _fundAlice(_need);

    vm.expectEmit(true, true, true, true, address(router));
    emit IPPRouter.Deposited(alice, address(vault), SHIELD_VALUE, _need, _total);
    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);
  }

  /// @notice If the supply credits less aToken than the exact mint needs (beyond the rounding buffer),
  /// the zap's defensive wrap guard reverts and the prior supply is unwound (the whole tx reverts). The
  /// revert now originates in the zap (`PPYieldTokenZap_InsufficientWrap`) and bubbles up through the router.
  function test_DepositExactShares_RevertsOnInsufficientWrap() external {
    UnderCreditingPool _bad = new UnderCreditingPool(IERC20Metadata(address(usdc)), 3); // > buffer (2)
    MockAaveAToken _badA = _bad.A_TOKEN();
    PPYieldToken _badVault = new PPYieldToken(IERC20(address(_badA)), 0, admin, 'pp', 'pp');
    entrypoint.setAssetConfig(
      address(_badVault),
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: type(uint256).max})
    );
    PPYieldTokenZap _badZap =
      new PPYieldTokenZap(IPPYieldToken(address(_badVault)), IAavePool(address(_bad)), IERC20(address(usdc)));
    PPRouter _r = new PPRouter(
      IPPYieldToken(address(_badVault)),
      IAavePool(address(_bad)),
      IERC20(address(usdc)),
      IEntrypoint(address(entrypoint)),
      ppDust,
      IPPYieldTokenZap(address(_badZap)),
      IPoolVault(address(poolVault)),
      false
    );

    // Seed the vault through the bad pool so it is non-empty.
    usdc.mint(address(this), 100e6);
    usdc.approve(address(_bad), 100e6);
    _bad.supply(address(usdc), 100e6, address(this), 0);
    uint256 _seedA = _badA.balanceOf(address(this));
    _badA.approve(address(_badVault), _seedA);
    _badVault.deposit(_seedA, makeAddr('badHolder'));

    ProofLibV2.DepositProof memory _p = _proof(address(_badVault), SHIELD_VALUE);
    (uint256 _need,) = _r.quote(SHIELD_VALUE);
    usdc.mint(alice, _need);
    vm.startPrank(alice);
    usdc.approve(address(_r), _need);
    // quote = previewMint(total) + buffer(2); the bad pool credits need - shortfall(3), so the zap
    // receives (need - 3) = (aNeeded - 1) < aNeeded = (need - 2) -> InsufficientWrap (raised by the zap).
    vm.expectRevert(
      abi.encodeWithSelector(IPPYieldTokenZap.PPYieldTokenZap_InsufficientWrap.selector, _need - 3, _need - 2)
    );
    _r.depositExactShares(_p, _noteData(), bytes(''), _need);
    vm.stopPrank();
  }

  /// @notice If a (deviating) entrypoint pulls fewer than `value + fee` shares, the defensive
  /// `SharesStranded` guard reverts instead of stranding the payer's pp-shares in the router.
  function test_DepositExactShares_RevertsIfEntrypointUnderpulls() external {
    MockDeviatingEntrypoint _bad = new MockDeviatingEntrypoint(); // pulls only `value`, never the fee
    _bad.setAssetConfig(
      address(vault),
      IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 100, maxRelayFee: type(uint256).max})
    );
    PPRouter _r = new PPRouter(
      IPPYieldToken(address(vault)),
      IAavePool(address(pool)),
      IERC20(address(usdc)),
      IEntrypoint(address(_bad)),
      ppDust,
      IPPYieldTokenZap(address(zap)),
      IPoolVault(address(poolVault)),
      false
    );

    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    (uint256 _need,) = _r.quote(SHIELD_VALUE);
    usdc.mint(alice, _need);
    vm.startPrank(alice);
    usdc.approve(address(_r), _need);
    vm.expectRevert(IPPRouter.PPRouter_SharesStranded.selector);
    _r.depositExactShares(_p, _noteData(), bytes(''), _need);
    vm.stopPrank();
  }

  /// @notice A proof whose `tokenId` signal has dirty bits above 160 is rejected by the canonicalization
  /// check in `ProofLibV2.tokenId` (reached on the router's first line).
  function test_DepositExactShares_RevertsOnNonCanonicalTokenId() external {
    ProofLibV2.DepositProof memory _p;
    uint256 _dirty = uint256(uint160(address(vault))) | (uint256(1) << 200);
    _p.pubSignals[1] = _dirty;
    _p.pubSignals[2] = SHIELD_VALUE;
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirty));
    router.depositExactShares(_p, _noteData(), bytes(''), type(uint256).max);
  }

  /// @notice The bound is the validity window: too tight after drift reverts, and the SAME proof then
  /// deposits once the bound is raised. The note is never invalidated by a rate move.
  function test_SlippageBound_RevertsThenSameProofRetries() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    (uint256 _quoteR0,) = router.quote(SHIELD_VALUE);

    _accrueYield(50e6);
    (uint256 _need,) = router.quote(SHIELD_VALUE);

    _fundAlice(_need);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_SlippageExceeded.selector, _need, _quoteR0));
    router.depositExactShares(_p, _noteData(), bytes(''), _quoteR0);

    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);
    assertEq(entrypoint.shielded(address(vault)), SHIELD_VALUE, 'retry shields exactly the committed value');
  }

  /// @notice `skim` sends accumulated aToken dust to the fixed recipient.
  function test_Skim_SweepsDustToRecipient() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _accrueYield(50e6);
    (uint256 _need,) = router.quote(SHIELD_VALUE);
    _fundAlice(_need);
    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);

    uint256 _dust = aUSDC.balanceOf(address(router));
    router.skim();
    assertEq(aUSDC.balanceOf(address(router)), 0, 'router swept clean');
    assertEq(aUSDC.balanceOf(ppDust), _dust, 'dust delivered to the fixed recipient');
  }

  /// @notice `skim` emits `Skimmed` only on a real sweep, and is a silent no-op when there is no dust.
  function test_Skim_EmitsOnSweepNoOpWhenEmpty() external {
    assertEq(router.skim(), 0, 'no-op skim returns 0 (no dust before any deposit)');

    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _accrueYield(50e6);
    (uint256 _need,) = router.quote(SHIELD_VALUE);
    _fundAlice(_need);
    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);

    uint256 _dust = aUSDC.balanceOf(address(router));
    assertGt(_dust, 0, 'a deposit leaves wei-dust');
    vm.expectEmit(true, true, true, true, address(router));
    emit IPPRouter.Skimmed(ppDust, _dust);
    router.skim();
  }

  /// @notice The constructor rejects a zero address in any position.
  function test_Constructor_RevertsOnZeroAddress() external {
    IPPYieldToken _v = IPPYieldToken(address(vault));
    IAavePool _p = IAavePool(address(pool));
    IERC20 _u = IERC20(address(usdc));
    IPPYieldTokenZap _z = IPPYieldTokenZap(address(zap));
    IPoolVault _pv = IPoolVault(address(poolVault));
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(IPPYieldToken(address(0)), _p, _u, IEntrypoint(address(entrypoint)), ppDust, _z, _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, IAavePool(address(0)), _u, IEntrypoint(address(entrypoint)), ppDust, _z, _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, _p, IERC20(address(0)), IEntrypoint(address(entrypoint)), ppDust, _z, _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, _p, _u, IEntrypoint(address(0)), ppDust, _z, _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, _p, _u, IEntrypoint(address(entrypoint)), address(0), _z, _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, _p, _u, IEntrypoint(address(entrypoint)), ppDust, IPPYieldTokenZap(address(0)), _pv, false);
    vm.expectRevert(IPPRouter.PPRouter_ZeroAddress.selector);
    new PPRouter(_v, _p, _u, IEntrypoint(address(entrypoint)), ppDust, _z, IPoolVault(address(0)), false);
  }

  /// @notice The constructor rejects a zap that wraps a different (vault, underlying) pair than the router.
  function test_Constructor_RevertsOnZapAssetMismatch() external {
    // A zap over a foreign vault: its VAULT() != this router's vault, so construction must revert.
    MockERC20 _dai = new MockERC20('DAI', 'DAI', 18);
    MockAaveAToken _aDai = pool.addReserve(IERC20Metadata(address(_dai)), 'Aave DAI', 'aDAI');
    PPYieldToken _vault2 = new PPYieldToken(IERC20(address(_aDai)), 0, admin, 'Privacy Pool DAI', 'ppDAI');
    PPYieldTokenZap _foreignZap =
      new PPYieldTokenZap(IPPYieldToken(address(_vault2)), IAavePool(address(pool)), IERC20(address(_dai)));

    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_AssetMismatch.selector, address(_vault2)));
    new PPRouter(
      IPPYieldToken(address(vault)),
      IAavePool(address(pool)),
      IERC20(address(usdc)),
      IEntrypoint(address(entrypoint)),
      ppDust,
      IPPYieldTokenZap(address(_foreignZap)),
      IPoolVault(address(poolVault)),
      false
    );
  }

  /// @notice `quote` equals an independently-derived `previewMint(value + fee) + buffer`, and the
  /// executed deposit pulls exactly that (non-tautological).
  function test_Quote_MatchesPreviewMintPlusBuffer() external {
    _accrueYield(50e6);
    uint256 _expected = vault.previewMint(SHIELD_VALUE) + 2; // fee 0 -> total == value; buffer == 2
    (uint256 _need, uint256 _total) = router.quote(SHIELD_VALUE);
    assertEq(_total, SHIELD_VALUE, 'total = value (no vetting fee)');
    assertEq(_need, _expected, 'quote = previewMint(total) + SUPPLY_ROUNDING_BUFFER');

    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    _fundAlice(_need);
    vm.prank(alice);
    uint256 _pulled = router.depositExactShares(_p, _noteData(), bytes(''), _need);
    assertEq(_pulled, _expected, 'executed pull equals the independently-derived amount');
  }

  /// @notice Vetting-fee split is correct at the bps extremes (1 and 2000).
  function test_VettingFee_1bps() external {
    _assertFeeSplit(1, SHIELD_VALUE);
  }

  function test_VettingFee_2000bps() external {
    _assertFeeSplit(2000, SHIELD_VALUE);
  }

  function _assertFeeSplit(uint256 _bps, uint256 _value) internal {
    _enableAsset(_bps);
    uint256 _expectedFee = (_value * _bps) / 10_000;
    ProofLibV2.DepositProof memory _p = _proof(address(vault), _value);
    (uint256 _need, uint256 _total) = router.quote(_value);
    assertEq(_total, _value + _expectedFee, 'total = value + fee');
    _fundAlice(_need);
    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);
    assertEq(entrypoint.shielded(address(vault)), _value, 'shielded value');
    assertEq(entrypoint.feeCollected(address(vault)), _expectedFee, 'retained fee');
  }

  /// @notice The slippage bound is exact to the wei: `need - 1` reverts, `need` succeeds.
  function test_Slippage_OneWeiBoundary() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    (uint256 _need,) = router.quote(SHIELD_VALUE);
    _fundAlice(_need);

    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_SlippageExceeded.selector, _need, _need - 1));
    router.depositExactShares(_p, _noteData(), bytes(''), _need - 1);

    vm.prank(alice);
    router.depositExactShares(_p, _noteData(), bytes(''), _need);
    assertEq(entrypoint.shielded(address(vault)), SHIELD_VALUE, 'exact-bound deposit succeeds');
  }
}

/// @notice An entrypoint that pulls only `value` (never the vetting fee), to exercise the router's
/// defensive `SharesStranded` guard. Does not verify the proof (no Groth16 here).
contract MockDeviatingEntrypoint {
  using ProofLibV2 for ProofLibV2.DepositProof;

  mapping(address _asset => IEntrypoint.AssetConfig _config) internal _configs;

  function setAssetConfig(address _asset, IEntrypoint.AssetConfig calldata _config) external {
    _configs[_asset] = _config;
  }

  function assets(address _asset) external view returns (IEntrypoint.AssetConfig memory _config) {
    _config = _configs[_asset];
  }

  function deposit(
    ProofLibV2.DepositProof calldata _proof,
    IPoolVault.NoteData calldata,
    bytes calldata
  ) external payable {
    // Intentionally under-pulls: takes only `value`, stranding the `fee` shares in the router.
    IERC20(_proof.tokenId()).transferFrom(msg.sender, address(this), _proof.value());
  }
}

/// @notice A pool that under-credits each supply by a fixed shortfall, to exercise the router's
/// defensive `InsufficientWrap` guard. Mints its own aToken so `poolMint`'s onlyPool check passes.
contract UnderCreditingPool {
  MockAaveAToken public immutable A_TOKEN;
  IERC20 public immutable UNDERLYING;
  uint256 public immutable SHORTFALL;

  constructor(IERC20Metadata _underlying, uint256 _shortfall) {
    A_TOKEN = new MockAaveAToken('Aave USDC', 'aUSDC', _underlying.decimals(), address(_underlying));
    UNDERLYING = IERC20(address(_underlying));
    SHORTFALL = _shortfall;
  }

  function supply(address, uint256 _amount, address _onBehalfOf, uint16) external {
    UNDERLYING.transferFrom(msg.sender, address(this), _amount);
    A_TOKEN.poolMint(_onBehalfOf, _amount - SHORTFALL);
  }
}
