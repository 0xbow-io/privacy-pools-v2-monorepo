// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {PPRouterBase} from 'test/unit/helpers/PPRouterBase.sol';

import {IEntrypoint} from 'interfaces/IEntrypoint.sol';
import {IPPRouter} from 'interfaces/IPPRouter.sol';
import {IPoolVault} from 'interfaces/IPoolVault.sol';

import {ProofLibV2} from 'libraries/ProofLibV2.sol';

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';

/// @notice Coverage for {PPRouter.withdrawToUnderlying}: the router is the pool's transact processor,
/// so the {MockPPPoolVault} pays it the withdrawn pp-shares, which it unwraps (recipient leg + fee leg)
/// to the underlying via the real {PPYieldTokenZap}. No Groth16 — the public signals are trusted (see
/// {MockPPPoolVault}); real proof verification is covered by the monorepo integration tests. See
/// PPRouterWithdraw.tree.
contract UnitPPRouterWithdraw is PPRouterBase {
  uint256 internal constant WITHDRAW_SHARES = 10e18; // 10 pp-shares to withdraw

  address internal bob = makeAddr('bob'); // recipient
  address internal carol = makeAddr('carol'); // fee recipient
  address internal relayer = makeAddr('relayer'); // submits the tx

  /// @notice Happy path with a fee: recipient and fee recipient each receive their unwrapped underlying,
  /// `WithdrawnToUnderlying` is emitted, and the router holds no residual pp-shares.
  function test_WithdrawToUnderlying_SucceedsWithFee() external {
    uint256 _fee = 1e18;
    uint256 _recipientShares = WITHDRAW_SHARES - _fee;
    _fundPoolVault(WITHDRAW_SHARES);

    uint256 _expectedRecipient = vault.previewRedeem(_recipientShares);
    uint256 _expectedFee = vault.previewRedeem(_fee);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, _fee, 0);

    vm.expectEmit(true, true, true, true, address(router));
    emit IPPRouter.WithdrawnToUnderlying(
      address(vault), address(usdc), bob, WITHDRAW_SHARES, _expectedRecipient, carol, _fee, _expectedFee, 0
    );
    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertApproxEqAbs(usdc.balanceOf(bob), _expectedRecipient, 1, 'recipient receives the recipient leg');
    assertApproxEqAbs(usdc.balanceOf(carol), _expectedFee, 1, 'fee recipient receives the fee leg');
    assertEq(_toRecipient, _expectedRecipient, 'return value matches recipient underlying');
    assertEq(_feeOut, _expectedFee, 'return value matches fee underlying');
    assertEq(vault.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
    // The single forceApprove(ZAP, sharesOut) is exactly consumed by both redeem legs — no dangling allowance.
    assertEq(IERC20(address(vault)).allowance(address(router), address(zap)), 0, 'no residual zap allowance');
  }

  /// @notice A dust fee (nonzero shares that redeem to 0 underlying) is WAIVED to the recipient rather
  /// than reverting the whole withdrawal — the recipient gets the full amount, the fee recipient gets 0.
  function test_WithdrawToUnderlying_WaivesDustFeeInsteadOfReverting() external {
    _fundPoolVault(WITHDRAW_SHARES);
    uint256 _dustFee = 21_000; // 21000 wei of an 18-dp share; previewRedeem rounds to 0 (6-dp) USDC
    assertEq(vault.previewRedeem(_dustFee), 0, 'precondition: the fee really redeems to 0');
    uint256 _expectedFull = vault.previewRedeem(WITHDRAW_SHARES); // recipient gets everything (fee waived)

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, _dustFee, 0);
    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertApproxEqAbs(usdc.balanceOf(bob), _expectedFull, 1, 'recipient gets the full amount (dust fee waived)');
    assertEq(usdc.balanceOf(carol), 0, 'fee recipient gets nothing when the fee is dust');
    assertEq(_feeOut, 0, 'no fee underlying delivered');
    assertEq(_toRecipient, usdc.balanceOf(bob), 'return value matches recipient delivery');
    assertEq(vault.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }

  /// @notice Happy path with no fee: only the recipient leg runs; the fee recipient gets nothing.
  function test_WithdrawToUnderlying_SucceedsNoFee() external {
    _fundPoolVault(WITHDRAW_SHARES);
    uint256 _expectedRecipient = vault.previewRedeem(WITHDRAW_SHARES);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);

    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertApproxEqAbs(usdc.balanceOf(bob), _expectedRecipient, 1, 'recipient receives the whole withdrawal');
    assertEq(usdc.balanceOf(carol), 0, 'fee recipient gets nothing when fee is zero');
    assertEq(_toRecipient, _expectedRecipient, 'all underlying goes to the recipient');
    assertEq(_feeOut, 0, 'no fee underlying');
  }

  /// @notice A zero fee recipient defaults to `msg.sender` (the submitting relayer receives the fee).
  function test_WithdrawToUnderlying_ZeroFeeRecipientDefaultsToSender() external {
    uint256 _fee = 2e18;
    _fundPoolVault(WITHDRAW_SHARES);
    uint256 _expectedFee = vault.previewRedeem(_fee);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, address(0), _fee, 0);

    vm.prank(relayer);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertApproxEqAbs(usdc.balanceOf(relayer), _expectedFee, 1, 'caller (msg.sender) receives the fee');
  }

  /// @notice A zero `amountOut` is rejected.
  function test_WithdrawToUnderlying_RevertsOnZeroWithdrawal() external {
    ProofLibV2.TransactProof memory _p = _transactProof(0, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_ZeroWithdrawal.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A payout routing with a zero-address recipient is rejected (footgun removal, INTL-14).
  function test_WithdrawToUnderlying_RevertsOnZeroRecipient() external {
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), address(0), carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_ZeroRecipient.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A proof whose `tokenIdOut` is not this router's vault is rejected.
  function test_WithdrawToUnderlying_RevertsOnAssetMismatch() external {
    address _other = makeAddr('otherAsset');
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, _other);
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_AssetMismatch.selector, _other));
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A `tokenIdOut` public signal with dirty bits above 160 is rejected by the proof lib's
  /// canonicalization (the address narrowing in `_transactProof` cannot produce this, so build it raw).
  function test_WithdrawToUnderlying_RevertsOnNonCanonicalTokenIdOut() external {
    uint256 _dirty = (uint256(1) << 160) | uint256(uint160(address(vault))); // a bit set above 160
    ProofLibV2.TransactProof memory _p;
    _p.pubSignals = new uint256[][](TRANSACT_PUBSIGNAL_ROWS);
    for (uint256 _i = 0; _i < TRANSACT_PUBSIGNAL_ROWS; ++_i) {
      _p.pubSignals[_i] = new uint256[](1);
    }
    _p.pubSignals[5][0] = WITHDRAW_SHARES;
    _p.pubSignals[6][0] = _dirty;
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(ProofLibV2.ProofLib_TokenIdNotCanonical.selector, _dirty));
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A proof naming a different processor than this router is rejected.
  function test_WithdrawToUnderlying_RevertsOnInvalidProcessor() external {
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(makeAddr('notRouter'), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_InvalidProcessor.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice `msg.value` must equal the declared `nativeGas`, else it reverts.
  function test_WithdrawToUnderlying_RevertsOnNativeGasMismatch() external {
    _fundPoolVault(WITHDRAW_SHARES);
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 1 ether);
    vm.deal(relayer, 1 ether);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_NativeGasMismatch.selector);
    router.withdrawToUnderlying{value: 0.5 ether}(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A fee above the asset's configured `maxRelayFee` is rejected.
  function test_WithdrawToUnderlying_RevertsOnFeeExceedsMax() external {
    // Lower the asset's maxRelayFee below the requested fee.
    entrypoint.setAssetConfig(
      address(vault), IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: 1e18})
    );
    _fundPoolVault(WITHDRAW_SHARES);
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 1e18 + 1, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_FeeExceedsMax.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice `maxRelayFee == 0` means "no cap" (uncapped) per IEntrypoint: a nonzero fee is ACCEPTED and
  /// the withdrawal proceeds (proves the sentinel — a 0 cap does NOT revert with PPRouter_FeeExceedsMax).
  function test_WithdrawToUnderlying_MaxRelayFeeZeroIsUncapped() external {
    // Set the asset's maxRelayFee to 0 (uncapped).
    entrypoint.setAssetConfig(
      address(vault), IEntrypoint.AssetConfig({enabled: true, minAmount: 1, vettingFeeBPS: 0, maxRelayFee: 0})
    );
    uint256 _fee = 1e18;
    uint256 _recipientShares = WITHDRAW_SHARES - _fee;
    _fundPoolVault(WITHDRAW_SHARES);

    uint256 _expectedRecipient = vault.previewRedeem(_recipientShares);
    uint256 _expectedFee = vault.previewRedeem(_fee);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, _fee, 0);

    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    // The withdrawal proceeds and delivers the nonzero fee — no PPRouter_FeeExceedsMax revert under a 0 cap.
    assertApproxEqAbs(usdc.balanceOf(bob), _expectedRecipient, 1, 'recipient receives the recipient leg');
    assertApproxEqAbs(usdc.balanceOf(carol), _expectedFee, 1, 'fee recipient receives the fee leg');
    assertEq(_toRecipient, _expectedRecipient, 'return value matches recipient underlying');
    assertEq(_feeOut, _expectedFee, 'return value matches fee underlying');
  }

  /// @notice A fee greater than the total withdrawn pp-shares is rejected.
  function test_WithdrawToUnderlying_RevertsOnFeeExceedsWithdrawal() external {
    _fundPoolVault(WITHDRAW_SHARES);
    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, WITHDRAW_SHARES + 1, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_FeeExceedsWithdrawal.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice A `minUnderlyingOut` above what the recipient leg yields is rejected (slippage floor).
  function test_WithdrawToUnderlying_RevertsBelowMinUnderlying() external {
    _fundPoolVault(WITHDRAW_SHARES);
    uint256 _expectedRecipient = vault.previewRedeem(WITHDRAW_SHARES);
    uint256 _min = _expectedRecipient + 1;

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(abi.encodeWithSelector(IPPRouter.PPRouter_BelowMinUnderlying.selector, _expectedRecipient, _min));
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), _min);
  }

  /// @notice Edge: the fee consumes the whole withdrawal (recipientShares == 0). The recipient leg is
  /// skipped and the fee recipient receives everything; `minUnderlyingOut == 0` so it succeeds.
  function test_WithdrawToUnderlying_RecipientSharesZeroFeeTakesAll() external {
    _fundPoolVault(WITHDRAW_SHARES);
    uint256 _expectedFee = vault.previewRedeem(WITHDRAW_SHARES);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, WITHDRAW_SHARES, 0);
    vm.prank(relayer);
    (uint256 _toRecipient, uint256 _feeOut) = router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);

    assertEq(usdc.balanceOf(bob), 0, 'recipient leg skipped');
    assertEq(_toRecipient, 0, 'no recipient underlying');
    assertApproxEqAbs(usdc.balanceOf(carol), _expectedFee, 1, 'fee recipient gets the whole withdrawal');
    assertEq(_feeOut, _expectedFee, 'fee return value is the whole withdrawal');
    assertEq(vault.balanceOf(address(router)), 0, 'router holds no residual pp-shares');
  }

  /// @notice Native gas is forwarded to the recipient: with `nativeGas > 0` and a matching `msg.value`,
  /// the recipient's ETH balance increases by exactly `nativeGas`.
  function test_WithdrawToUnderlying_ForwardsNativeGas() external {
    uint256 _gas = 0.3 ether;
    _fundPoolVault(WITHDRAW_SHARES);

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, _gas);

    uint256 _balBefore = bob.balance;
    vm.deal(relayer, _gas);
    vm.prank(relayer);
    router.withdrawToUnderlying{value: _gas}(_p, _tp, _emptyNotes(), 0);

    assertEq(bob.balance - _balBefore, _gas, 'recipient receives the forwarded native gas');
  }

  /// @notice The defensive `SharesNotReceived` guard reverts when the vault pays the wrong amount.
  function test_WithdrawToUnderlying_RevertsIfVaultUnderpays() external {
    _fundPoolVault(WITHDRAW_SHARES);
    poolVault.setPayActualOverride(WITHDRAW_SHARES - 1); // pay one share short

    ProofLibV2.TransactProof memory _p = _transactProof(WITHDRAW_SHARES, address(vault));
    IPoolVault.TransactParams memory _tp = _transactParams(address(router), bob, carol, 0, 0);
    vm.prank(relayer);
    vm.expectRevert(IPPRouter.PPRouter_SharesNotReceived.selector);
    router.withdrawToUnderlying(_p, _tp, _emptyNotes(), 0);
  }

  /// @notice `quoteWithdraw(shares)` equals `VAULT.previewRedeem(shares)`.
  function test_QuoteWithdraw_MatchesPreviewRedeem() external {
    _accrueYield(50e6); // move the rate so the equality is non-trivial
    assertEq(
      router.quoteWithdraw(WITHDRAW_SHARES), vault.previewRedeem(WITHDRAW_SHARES), 'quoteWithdraw = previewRedeem'
    );
  }
}
