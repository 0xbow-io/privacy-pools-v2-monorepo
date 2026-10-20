// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouterNativeBase, RejectingRecipient} from 'test/unit/helpers/PPRouterNativeBase.sol';

import {PPRouter} from 'contracts/PPRouter.sol';
import {PPRouterFactory} from 'contracts/PPRouterFactory.sol';

import {IAavePool} from 'interfaces/IAavePool.sol';
import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPRouter} from 'interfaces/IPPRouter.sol';
import {IPPYieldToken} from 'interfaces/IPPYieldToken.sol';
import {IPPYieldTokenZap} from 'interfaces/IPPYieldTokenZap.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @notice Coverage for {PPRouter}'s NATIVE mode: `depositExactSharesNative` (msg.value funding +
/// ceiling + in-tx refund), the native delivery tail of `withdrawToUnderlying`, the WETH-gated
/// `receive()`, the constructor's wrapped-native probe, and `createRouterNative`. The {MockWETH9}
/// unwrap pushes with a 2300-gas `transfer` exactly like canonical WETH9, so the withdrawal tests
/// also prove the router's `receive()` fits the stipend. The parent fixture's ERC-20 router is used
/// for the cross-mode guards. No Groth16 — real proofs are covered by the integration suites. See
/// PPRouterNative.tree.
contract UnitPPRouterNative is PPRouterNativeBase {
  uint256 internal constant WITHDRAW_SHARES = 10e18;

  address internal bob = makeAddr('bob'); // recipient
  address internal carol = makeAddr('carol'); // fee recipient
  address internal relayer = makeAddr('relayer'); // submits the withdrawal

  /*///////////////////////////////////////////////////////////////
                    depositExactSharesNative
  ///////////////////////////////////////////////////////////////*/

  /// @notice After a rate rise the router wraps exactly the quoted value, shields exactly the
  /// committed shares, and refunds the entire overfunding headroom in the same transaction.
  function test_DepositExactSharesNative_SucceedsAndRefundsExcess() external {
    _accrueYieldNative(50e18); // lift the rate so the quote moves off 1:1
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), SHIELD_VALUE);
    (uint256 _need,) = routerEth.quote(SHIELD_VALUE);

    uint256 _headroom = 0.5 ether;
    vm.deal(alice, _need + _headroom);
    vm.prank(alice);
    uint256 _consumed = routerEth.depositExactSharesNative{value: _need + _headroom}(_p, _noteData(), bytes(''));

    assertEq(_consumed, _need, 'consumes exactly the quoted native value');
    assertEq(alice.balance, _headroom, 'the full headroom is refunded in-tx');
    assertEq(entrypoint.shielded(address(vaultEth)), SHIELD_VALUE, 'exactly the committed value is shielded');
    assertEq(vaultEth.balanceOf(alice), 0, 'no un-shielded pp-share dust with the payer');
    assertEq(vaultEth.balanceOf(address(routerEth)), 0, 'router holds no pp-shares');
    assertLe(aWETH.balanceOf(address(routerEth)), 2, 'only wei-level aToken dust remains');
    assertEq(weth.balanceOf(address(routerEth)), 0, 'router holds no WETH');
    assertEq(address(routerEth).balance, 0, 'router holds no native value');
  }

  /// @notice Funding with the exact quote consumes everything and refunds nothing.
  function test_DepositExactSharesNative_ConsumesExactQuoteWithNoRefund() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), SHIELD_VALUE);
    (uint256 _need,) = routerEth.quote(SHIELD_VALUE);

    vm.deal(alice, _need);
    vm.prank(alice);
    uint256 _consumed = routerEth.depositExactSharesNative{value: _need}(_p, _noteData(), bytes(''));

    assertEq(_consumed, _need, 'consumes exactly the quoted native value');
    assertEq(alice.balance, 0, 'nothing left over, nothing refunded');
    assertEq(entrypoint.shielded(address(vaultEth)), SHIELD_VALUE, 'exactly the committed value is shielded');
  }

  /// @notice `msg.value` is the `maxUnderlyingIn` ceiling: underfunding reverts with the same
  /// `SlippageExceeded(required, ceiling)` the ERC-20 path uses.
  function test_DepositExactSharesNative_RevertsWhenMsgValueBelowQuote() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), SHIELD_VALUE);
    (uint256 _need,) = routerEth.quote(SHIELD_VALUE);

    vm.deal(alice, _need - 1);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_SlippageExceeded.selector, _need, _need - 1));
    routerEth.depositExactSharesNative{value: _need - 1}(_p, _noteData(), bytes(''));
  }

  /// @notice The native deposit edge is gated to native-mode routers.
  function test_DepositExactSharesNative_RevertsOnErc20ModeRouter() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE);
    vm.prank(alice);
    vm.expectRevert(IPPRouter.PPRouter_NotNativeMode.selector);
    router.depositExactSharesNative(_p, _noteData(), bytes(''));
  }

  /// @notice A proof targeting a different asset than the router's vault is rejected.
  function test_DepositExactSharesNative_RevertsOnAssetMismatch() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vault), SHIELD_VALUE); // the ERC-20 fixture's asset
    vm.deal(alice, 1 ether);
    vm.prank(alice);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_AssetMismatch.selector, address(vault)));
    routerEth.depositExactSharesNative{value: 1 ether}(_p, _noteData(), bytes(''));
  }

  /// @notice A zero committed value is rejected.
  function test_DepositExactSharesNative_RevertsOnZeroValue() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), 0);
    vm.prank(alice);
    vm.expectRevert(IPPRouter.PPRouter_ZeroValue.selector);
    routerEth.depositExactSharesNative(_p, _noteData(), bytes(''));
  }

  /// @notice The happy path emits the same `Deposited` event as the ERC-20 edge.
  function test_DepositExactSharesNative_EmitsDeposited() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), SHIELD_VALUE);
    (uint256 _need, uint256 _total) = routerEth.quote(SHIELD_VALUE);
    vm.deal(alice, _need);

    vm.expectEmit(true, true, true, true, address(routerEth));
    emit IPPRouter.Deposited(alice, address(vaultEth), SHIELD_VALUE, _need, _total);
    vm.prank(alice);
    routerEth.depositExactSharesNative{value: _need}(_p, _noteData(), bytes(''));
  }

  /*///////////////////////////////////////////////////////////////
                      depositExactShares
  ///////////////////////////////////////////////////////////////*/

  /// @notice The audited ERC-20 edge still works on a native-mode router: a WETH holder deposits
  /// through `depositExactShares` exactly as on any ERC-20 asset — the two edges coexist.
  function test_DepositExactShares_StillAcceptsWethOnNativeRouter() external {
    ProofLibV2.DepositProof memory _p = _proof(address(vaultEth), SHIELD_VALUE);
    (uint256 _need,) = routerEth.quote(SHIELD_VALUE);

    vm.deal(alice, _need);
    vm.startPrank(alice);
    weth.deposit{value: _need}();
    weth.approve(address(routerEth), _need);
    uint256 _pulled = routerEth.depositExactShares(_p, _noteData(), bytes(''), _need);
    vm.stopPrank();

    assertEq(_pulled, _need, 'pulls exactly the quoted WETH');
    assertEq(entrypoint.shielded(address(vaultEth)), SHIELD_VALUE, 'exactly the committed value is shielded');
  }

  /*///////////////////////////////////////////////////////////////
                      withdrawToUnderlying
  ///////////////////////////////////////////////////////////////*/

  /// @notice Native delivery with a fee: the recipient and the fee recipient are paid in NATIVE value
  /// (via the stipend-limited WETH unwrap), the audited event is emitted, and the router keeps no
  /// residual shares, WETH, or native value.
  function test_WithdrawToUnderlying_DeliversNativeWithFee() external {
    uint256 _fee = 1e18;
    _fundPoolVaultNative(WITHDRAW_SHARES);
    uint256 _expectedRecipient = vaultEth.previewRedeem(WITHDRAW_SHARES - _fee);
    uint256 _expectedFee = vaultEth.previewRedeem(_fee);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vaultEth));
    IPoolVault.TransactParams memory _tp = _transactParams(address(routerEth), bob, carol, _fee, 0);

    vm.expectEmit(true, true, true, true, address(routerEth));
    emit IPPRouter.WithdrawnToUnderlying(
      address(vaultEth), address(weth), bob, WITHDRAW_SHARES, _expectedRecipient, carol, _fee, _expectedFee, 0
    );
    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = routerEth.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertEq(bob.balance, _expectedRecipient, 'recipient receives the recipient leg as native value');
    assertEq(carol.balance, _expectedFee, 'fee recipient receives the fee leg as native value');
    assertEq(weth.balanceOf(bob), 0, 'recipient receives no WETH');
    assertEq(_toRecipient, _expectedRecipient, 'return value matches recipient delivery');
    assertEq(_feeOut, _expectedFee, 'return value matches fee delivery');
    assertEq(vaultEth.balanceOf(address(routerEth)), 0, 'router holds no residual pp-shares');
    assertEq(weth.balanceOf(address(routerEth)), 0, 'router holds no residual WETH');
    assertEq(address(routerEth).balance, 0, 'router holds no residual native value');
  }

  /// @notice The submitter's gas funding rides in the SAME transfer as the payout: the recipient's
  /// balance rises by payout + nativeGas in one withdrawal.
  function test_WithdrawToUnderlying_CombinesGasFundingWithPayout() external {
    uint256 _gas = 0.01 ether;
    _fundPoolVaultNative(WITHDRAW_SHARES);
    uint256 _expectedRecipient = vaultEth.previewRedeem(WITHDRAW_SHARES);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vaultEth));
    IPoolVault.TransactParams memory _tp = _transactParams(address(routerEth), bob, carol, 0, _gas);

    vm.deal(relayer, _gas);
    vm.prank(relayer);
    routerEth.withdrawToUnderlying{value: _gas}(_p, _tp, _emptyNotes(), 0);

    assertEq(bob.balance, _expectedRecipient + _gas, 'recipient receives payout plus gas funding');
    assertEq(address(routerEth).balance, 0, 'router holds no residual native value');
  }

  /// @notice The `minUnderlyingOut` floor is enforced on the native delivery.
  function test_WithdrawToUnderlying_RevertsBelowMinUnderlying() external {
    _fundPoolVaultNative(WITHDRAW_SHARES);
    uint256 _expected = vaultEth.previewRedeem(WITHDRAW_SHARES);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vaultEth));
    IPoolVault.TransactParams memory _tp = _transactParams(address(routerEth), bob, carol, 0, 0);

    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_BelowMinUnderlying.selector, _expected, _expected + 1));
    routerEth.withdrawToUnderlying(_p, _tp, _emptyNotes(), _expected + 1);
  }

  /// @notice A recipient that cannot receive native value reverts the whole withdrawal (nothing is
  /// stranded; the proof is not consumed and the owner can re-route and re-prove).
  function test_WithdrawToUnderlying_RevertsWhenRecipientRejectsNative() external {
    _fundPoolVaultNative(WITHDRAW_SHARES);
    address _rejecting = address(new RejectingRecipient());

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vaultEth));
    IPoolVault.TransactParams memory _tp = _transactParams(address(routerEth), _rejecting, carol, 0, 0);

    vm.prank(relayer);
    vm.expectRevert();
    routerEth.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /*///////////////////////////////////////////////////////////////
                          receive
  ///////////////////////////////////////////////////////////////*/

  /// @notice Direct native sends to a native-mode router are rejected (only its WETH may push).
  function test_Receive_RevertsOnDirectSendToNativeRouter() external {
    vm.deal(alice, 1 ether);
    vm.prank(alice);
    (bool _ok,) = address(routerEth).call{value: 1 ether}('');
    assertFalse(_ok, 'direct native send must revert');
    assertEq(address(routerEth).balance, 0, 'nothing stranded on the router');
  }

  /// @notice Direct native sends to an ERC-20-mode router are rejected unconditionally.
  function test_Receive_RevertsOnDirectSendToErc20Router() external {
    vm.deal(alice, 1 ether);
    vm.prank(alice);
    (bool _ok,) = address(router).call{value: 1 ether}('');
    assertFalse(_ok, 'direct native send must revert');
  }

  /*///////////////////////////////////////////////////////////////
                          constructor
  ///////////////////////////////////////////////////////////////*/

  /// @notice Native mode over a plain ERC-20 underlying fails at construction: the zero-value
  /// `deposit()` probe reverts on a token with no WETH9 deposit function.
  function test_Constructor_RevertsOnNativeModeWithPlainErc20Underlying() external {
    vm.expectRevert();
    new PPRouter(
      IPPYieldToken(address(vault)),
      IAavePool(address(pool)),
      IERC20(address(usdc)),
      IEntrypoint(address(entrypoint)),
      ppDust,
      IPPYieldTokenZap(address(zap)),
      IPoolVault(address(poolVault)),
      true
    );
  }

  /*///////////////////////////////////////////////////////////////
                      createRouterNative
  ///////////////////////////////////////////////////////////////*/

  /// @notice The factory's native entrypoint deploys a `NATIVE_MODE = true` router with the same
  /// wiring and registry write as `createRouter` (which stays ERC-20 mode).
  function test_CreateRouterNative_DeploysNativeModeRouter() external {
    PPRouterFactory _f = new PPRouterFactory(
      IAavePool(address(pool)), IEntrypoint(address(entrypoint)), IPoolVault(address(poolVault)), ppDust, address(this)
    );

    PPRouter _rNative = PPRouter(payable(_f.createRouterNative(address(vaultEth), address(zapEth))));
    assertTrue(_rNative.NATIVE_MODE(), 'native factory entrypoint mints a native-mode router');
    assertEq(_f.routerFor(address(vaultEth)), address(_rNative), 'registry records the native router');
    assertEq(address(_rNative.UNDERLYING()), address(weth), 'underlying derived from the aToken');

    PPRouter _rErc20 = PPRouter(payable(_f.createRouter(address(vault), address(zap))));
    assertFalse(_rErc20.NATIVE_MODE(), 'plain factory entrypoint mints an ERC-20-mode router');
  }

  /// @notice `createRouterNative` over a plain ERC-20 underlying fails on the router's constructor probe.
  function test_CreateRouterNative_RevertsOnPlainErc20Underlying() external {
    PPRouterFactory _f = new PPRouterFactory(
      IAavePool(address(pool)), IEntrypoint(address(entrypoint)), IPoolVault(address(poolVault)), ppDust, address(this)
    );
    vm.expectRevert();
    _f.createRouterNative(address(vault), address(zap));
  }
}
