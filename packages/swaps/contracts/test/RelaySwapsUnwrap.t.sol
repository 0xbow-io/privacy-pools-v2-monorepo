// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {RelaySwapsTest, MockERC20, MockSwapper} from "./RelaySwaps.t.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';

/// @notice Mock Aave aToken: only the getter approveZap() reads.
contract MockAToken is MockERC20 {
    address public immutable UNDERLYING_ASSET_ADDRESS;
    constructor(address _underlying) MockERC20("Aave USDC", "aUSDC", 6) {
        UNDERLYING_ASSET_ADDRESS = _underlying;
    }
}

/// @notice Mock PPYieldToken share: ERC-20 (18 dp) + the one ERC-4626 view approveZap() reads.
contract MockShare is MockERC20 {
    address public immutable asset;
    constructor(address _aToken) MockERC20("PP USDC", "ppUSDC", 18) {
        asset = _aToken;
    }
}

/// @notice Mock PPYieldTokenZap. Mirrors the real Zap's redeem contract: pulls exactly
///   `_shares` from the caller, sends `_shares * rate / 1e18` underlying to `_receiver`.
///   `rate` is underlying base units per 1e18 shares (1e6 == 1 USDC per share).
contract MockZap {
    address public VAULT;
    address public UNDERLYING;
    address public A_TOKEN;
    uint256 public rate;
    bool public paused;
    error MockZap_Paused();

    constructor(address _vault, address _underlying, address _aToken, uint256 _rate) {
        VAULT = _vault; UNDERLYING = _underlying; A_TOKEN = _aToken; rate = _rate;
    }
    function setRate(uint256 _rate) external { rate = _rate; }
    function setPaused(bool _p) external { paused = _p; }
    function setVault(address _v) external { VAULT = _v; }
    function setUnderlying(address _u) external { UNDERLYING = _u; }
    function setAToken(address _a) external { A_TOKEN = _a; }

    function redeemToUnderlying(uint256 _shares, address _receiver) external virtual returns (uint256 _out) {
        if (paused) revert MockZap_Paused();
        MockERC20(VAULT).transferFrom(msg.sender, address(this), _shares);
        _out = _shares * rate / 1e18;
        MockERC20(UNDERLYING).mint(_receiver, _out);
    }
}

/// @notice Zap that re-enters RelaySwaps.execute() from inside redeem (mirrors ReentrantRouter).
contract ReentrantZap is MockZap {
    address private _target;
    bytes private _calldata;
    bool public reentryAttempted;
    bool public innerBlocked;
    bytes4 public innerSelector;

    constructor(address _vault, address _underlying, address _aToken, uint256 _rate)
        MockZap(_vault, _underlying, _aToken, _rate) {}

    function configure(address target, bytes calldata data) external { _target = target; _calldata = data; }

    function redeemToUnderlying(uint256 _shares, address _receiver) external override returns (uint256 _out) {
        MockERC20(VAULT).transferFrom(msg.sender, address(this), _shares);
        _out = _shares * rate / 1e18;
        MockERC20(UNDERLYING).mint(_receiver, _out);
        reentryAttempted = true;
        (bool ok, bytes memory ret) = _target.call(_calldata);
        if (!ok) {
            innerBlocked = true;
            if (ret.length >= 4) { bytes4 sel; assembly { sel := mload(add(ret, 0x20)) } innerSelector = sel; }
        }
    }
}

/// @dev Inherits the full RelaySwapsTest suite: every legacy test re-runs here against the
///   registry-bearing bytecode, proving the non-registered path is unchanged.
contract RelaySwapsUnwrapTest is RelaySwapsTest {
    MockAToken internal aUsdc;
    MockShare internal ppUsdc;
    MockZap internal zap;

    uint256 internal constant ONE_SHARE = 1e18;
    uint256 internal constant RATE_1 = 1e6;          // 1.000000 USDC per share
    address internal dust = makeAddr("dust");

    function setUp() public override {
        super.setUp();
        aUsdc = new MockAToken(address(usdc));
        ppUsdc = new MockShare(address(aUsdc));
        zap = new MockZap(address(ppUsdc), address(usdc), address(aUsdc), RATE_1);
        pool.setAssetConfig(address(ppUsdc), true, 0, 0, 0, 0);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(zap));
    }

    /*///////////////////////////////////////////////////////////////
                          ALLOWLIST: approveZap / removeZap
    ///////////////////////////////////////////////////////////////*/

    function test_ApproveZap_ListsAfterCrossChecks() public view {
        assertTrue(relaySwaps.approvedZaps(address(zap)));
    }

    function test_ApprovedZapList_ReflectsAddsAndRemoves() public {
        address[] memory _list = relaySwaps.approvedZapList();
        assertEq(_list.length, 1, "setUp approved exactly one zap");
        assertEq(_list[0], address(zap));

        (, MockZap _second) = _freshShare();
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_second));

        _list = relaySwaps.approvedZapList();
        assertEq(_list.length, 2, "second zap listed");
        // Order is not guaranteed — assert set membership, not position.
        bool _sawFirst;
        bool _sawSecond;
        for (uint256 _i; _i < _list.length; ++_i) {
            if (_list[_i] == address(zap)) _sawFirst = true;
            if (_list[_i] == address(_second)) _sawSecond = true;
        }
        assertTrue(_sawFirst && _sawSecond, "both zaps present");

        vm.prank(upgraderRole);
        relaySwaps.removeZap(address(zap));
        _list = relaySwaps.approvedZapList();
        assertEq(_list.length, 1, "first zap removed");
        assertEq(_list[0], address(_second), "only the second remains");
    }

    function test_ApprovedZapList_EmptyOnFreshDeployment() public {
        RelaySwaps _fresh =
            new RelaySwaps(IPool(address(pool)), IEntrypoint(address(pool)), upgraderRole, address(swapper));
        assertEq(_fresh.approvedZapList().length, 0, "no zaps before any approveZap");
    }

    function test_ApproveZap_EmitsEvent() public {
        (MockShare _share, MockZap _zap) = _freshShare();
        vm.expectEmit(true, true, true, true);
        emit RelaySwaps.ZapApproved(address(_zap), address(_share), address(usdc));
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_zap));
    }

    function test_RevertWhen_ApproveZap_NonOwner() public {
        (, MockZap _zap) = _freshShare();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vm.prank(relayer);
        relaySwaps.approveZap(address(_zap));
    }

    function _freshShare() internal returns (MockShare _share, MockZap _zap) {
        _share = new MockShare(address(aUsdc));
        _zap = new MockZap(address(_share), address(usdc), address(aUsdc), RATE_1);
        pool.setAssetConfig(address(_share), true, 0, 0, 0, 0);
    }

    function test_RevertWhen_ApproveZap_ATokenMismatch() public {
        (, MockZap _zap) = _freshShare();
        _zap.setAToken(address(usdt));
        vm.expectRevert(RelaySwaps.RelaySwaps_ZapATokenMismatch.selector);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_zap));
    }

    function test_RevertWhen_ApproveZap_UnderlyingMismatch() public {
        (, MockZap _zap) = _freshShare();
        _zap.setUnderlying(address(usdt)); // aToken says USDC, zap says USDT
        vm.expectRevert(RelaySwaps.RelaySwaps_ZapUnderlyingMismatch.selector);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_zap));
    }

    function test_RevertWhen_ApproveZap_ShareNotEnabledInPool() public {
        (MockShare _share, MockZap _zap) = _freshShare();
        pool.setAssetConfig(address(_share), false, 0, 0, 0, 0);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZapShareNotPoolAsset.selector);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_zap));
    }

    function test_RevertWhen_ApproveZap_NativeUnderlying() public {
        // aToken and zap both agree the underlying is the native sentinel — must still be refused.
        MockAToken _aNative = new MockAToken(NATIVE_ASSET);
        MockShare _share = new MockShare(address(_aNative));
        MockZap _zap = new MockZap(address(_share), NATIVE_ASSET, address(_aNative), RATE_1);
        pool.setAssetConfig(address(_share), true, 0, 0, 0, 0);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZapInvalidUnderlying.selector);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_zap));
    }

    function test_RevertWhen_ApproveZap_ZapIsEOA() public {
        vm.expectRevert(); // staticcall to an EOA returns no data -> decode failure
        vm.prank(upgraderRole);
        relaySwaps.approveZap(makeAddr("eoa"));
    }

    function test_RemoveZap_ThenExecuteUnwrappedReverts() public {
        vm.expectEmit(true, false, false, true);
        emit RelaySwaps.ZapRemoved(address(zap));
        vm.prank(upgraderRole);
        relaySwaps.removeZap(address(zap));
        assertFalse(relaySwaps.approvedZaps(address(zap)));

        uint256 _shares = 10 * ONE_SHARE;
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(0, 10 * RATE_1, 10 * RATE_1));
        vm.expectRevert(RelaySwaps.RelaySwaps_InvalidZap.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
        assertEq(ppUsdc.balanceOf(address(pool)), _shares, "nothing left the pool");
    }

    function test_RevertWhen_RemoveZap_NonOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, relayer));
        vm.prank(relayer);
        relaySwaps.removeZap(address(zap));
    }

    function test_RevertWhen_ExecuteUnwrapped_ZeroZap() public {
        uint256 _shares = 10 * ONE_SHARE;
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(0, 10 * RATE_1, 10 * RATE_1));
        vm.expectRevert(RelaySwaps.RelaySwaps_InvalidZap.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(0));
    }

    function test_RevertWhen_ExecuteUnwrapped_ZapForOtherShare() public {
        // An allowlisted zap for a DIFFERENT share must not be usable against this proof.
        (, MockZap _otherZap) = _freshShare();
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_otherZap));
        uint256 _shares = 10 * ONE_SHARE;
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(0, 10 * RATE_1, 10 * RATE_1));
        vm.expectRevert(RelaySwaps.RelaySwaps_ZapShareMismatch.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(_otherZap));
        assertEq(ppUsdc.balanceOf(address(pool)), _shares);
    }

    function test_PlainExecuteWithShareInput_NoUnwrap_SwapFails() public {
        // Calling execute() on a share note hands raw shares to the swap: the USDC calldata
        // can't pull anything -> revert, never a misroute. The unwrap is an explicit choice.
        uint256 _shares = 10 * ONE_SHARE;
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(0, 10 * RATE_1, 10 * RATE_1));
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);
        assertEq(ppUsdc.balanceOf(address(pool)), _shares);
        assertEq(usdt.balanceOf(recipient), 0);
    }

    /*///////////////////////////////////////////////////////////////
                          EXECUTE: unwrap path
    ///////////////////////////////////////////////////////////////*/

    /// @dev Routing for a share note: LiFi calldata pulls `_pullUnderlying` USDC -> USDT to recipient.
    function _shareRouting(uint256 _feeShares, uint256 _pullUnderlying, uint256 _minOut)
        internal
        view
        returns (RelaySwaps.SwapRouting memory)
    {
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = dust;
        _routing.feeAmount = _feeShares;
        _routing.minOutputAmount = _minOut;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = abi.encodeCall(MockSwapper.swap, (address(usdc), address(usdt), _pullUnderlying, recipient));
        return _routing;
    }

    /// @dev Mints `_shares` into the pool and returns the execute() args for them.
    function _prepShares(uint256 _shares, RelaySwaps.SwapRouting memory _r)
        internal
        returns (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData)
    {
        ppUsdc.mint(address(pool), _shares);
        _proof = _buildTransactProof(_shares, address(ppUsdc));
        _params = _buildTransactParams(address(relaySwaps), _r);
        _noteData = new IPool.NoteData[](0);
    }

    function _executeShares(uint256 _shares, RelaySwaps.SwapRouting memory _r) internal {
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _r);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
    }

    function test_Execute_UnwrapsSharesAndPaysFeeInUnderlying() public {
        uint256 _shares = 100 * ONE_SHARE;
        uint256 _feeShares = 25 * ONE_SHARE / 10;          // 2.5 shares
        uint256 _out = 100 * RATE_1;                        // 100.000000 USDC
        uint256 _feeUnderlying = 25 * RATE_1 / 10;          // 2.500000 USDC
        uint256 _net = _out - _feeUnderlying;

        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(_feeShares, _net, _net));
        vm.expectEmit(true, true, false, true);
        emit RelaySwaps.Unwrapped(address(ppUsdc), address(usdc), _shares, _out, _feeUnderlying);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));

        assertEq(usdt.balanceOf(recipient), _net, "recipient gets swapped net");
        assertEq(usdc.balanceOf(feeRecipient), _feeUnderlying, "fee paid in underlying");
        assertEq(ppUsdc.balanceOf(address(relaySwaps)), 0, "no shares left");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "no underlying left");
        assertEq(ppUsdc.allowance(address(relaySwaps), address(zap)), 0, "zap approval fully consumed");
        assertEq(usdc.allowance(address(relaySwaps), address(swapper)), 0, "swap approval reset");
    }

    function test_Execute_Unwrap_ExecutedEventReportsUnderlying() public {
        uint256 _shares = 10 * ONE_SHARE;
        uint256 _feeShares = ONE_SHARE;
        uint256 _net = 9 * RATE_1;
        (ProofLibV2.TransactProof memory _proof, IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData) =
            _prepShares(_shares, _shareRouting(_feeShares, _net, _net));
        vm.expectEmit(true, true, false, true);
        emit RelaySwaps.Executed(address(usdc), address(usdt), _net, feeRecipient, RATE_1);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
    }

    function test_Execute_Unwrap_RateUp_SurplusSweptToDust() public {
        // Quote was built at 1.0 USDC/share; by execution the wrapper pays 1.1.
        uint256 _shares = 100 * ONE_SHARE;
        uint256 _feeShares = 25 * ONE_SHARE / 10;
        uint256 _quotedNet = 100 * RATE_1 - 25 * RATE_1 / 10;   // 97.5 USDC, what the calldata pulls
        zap.setRate(11 * RATE_1 / 10);
        uint256 _out = 110 * RATE_1;
        uint256 _feeUnderlying = _out * _feeShares / _shares;     // 2.75 USDC
        uint256 _surplus = _out - _feeUnderlying - _quotedNet;     // 9.75 USDC

        _executeShares(_shares, _shareRouting(_feeShares, _quotedNet, _quotedNet));

        assertEq(usdt.balanceOf(recipient), _quotedNet, "recipient still gets the quoted net");
        assertEq(usdc.balanceOf(feeRecipient), _feeUnderlying, "fee scales with realised output");
        assertEq(usdc.balanceOf(dust), _surplus, "surplus goes to the proof-bound dust recipient");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    function test_RevertWhen_Unwrap_RateDown_SwapPullExceedsApproval() public {
        // Rate dropped to 0.9: calldata still pulls 97.5 but only 87.75 is approved -> revert.
        uint256 _shares = 100 * ONE_SHARE;
        uint256 _feeShares = 25 * ONE_SHARE / 10;
        uint256 _quotedNet = 100 * RATE_1 - 25 * RATE_1 / 10;
        zap.setRate(9 * RATE_1 / 10);

        ppUsdc.mint(address(pool), _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(ppUsdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _shareRouting(_feeShares, _quotedNet, _quotedNet));
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));

        assertEq(ppUsdc.balanceOf(address(pool)), _shares, "whole tx reverted: shares never left the pool");
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_Execute_Unwrap_PreExistingUnderlyingNotSwept() public {
        uint256 _preExisting = 50 * RATE_1;
        usdc.mint(address(relaySwaps), _preExisting);
        uint256 _shares = 10 * ONE_SHARE;
        uint256 _net = 9 * RATE_1;

        _executeShares(_shares, _shareRouting(ONE_SHARE, _net, _net));

        assertEq(usdc.balanceOf(address(relaySwaps)), _preExisting, "baseline balance untouched (rescue-only)");
        assertEq(usdc.balanceOf(dust), 0, "nothing swept to dust");
    }

    function test_Execute_Unwrap_ZeroFeeShares() public {
        uint256 _shares = 10 * ONE_SHARE;
        uint256 _out = 10 * RATE_1;
        RelaySwaps.SwapRouting memory _r = _shareRouting(0, _out, _out);
        _r.feeRecipient = address(0);
        _executeShares(_shares, _r);
        assertEq(usdt.balanceOf(recipient), _out);
        assertEq(usdc.balanceOf(feeRecipient), 0);
    }

    function test_Execute_Unwrap_DustFeeRoundsToZero_IsSkippedNotReverted() public {
        // 1 wei of shares at 1e6/1e18 rounds to 0 underlying: waived, not a revert.
        uint256 _shares = 10 * ONE_SHARE;
        uint256 _out = 10 * RATE_1;
        _executeShares(_shares, _shareRouting(1, _out, _out));
        assertEq(usdc.balanceOf(feeRecipient), 0, "zero-underlying fee skipped");
        assertEq(usdt.balanceOf(recipient), _out, "full output still delivered");
    }

    function test_RevertWhen_Unwrap_ZeroFeeRecipientWithFee_StillEnforced() public {
        uint256 _shares = 10 * ONE_SHARE;
        RelaySwaps.SwapRouting memory _r = _shareRouting(1, 10 * RATE_1, 10 * RATE_1);
        _r.feeRecipient = address(0);   // fee committed (1 wei of shares) but no recipient
        ppUsdc.mint(address(pool), _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(ppUsdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroFeeRecipient.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
    }

    function test_RevertWhen_Unwrap_ZeroOutput() public {
        zap.setRate(0);
        uint256 _shares = 10 * ONE_SHARE;
        ppUsdc.mint(address(pool), _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(ppUsdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _shareRouting(0, 1, 1));
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        vm.expectRevert(RelaySwaps.RelaySwaps_UnwrapZeroOutput.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
    }

    /// @dev The real wrapper's pause() does not gate redeem (fork test covers that); this mock
    ///   "pause" stands in for ANY revert on the redeem path (Aave reserve frozen / illiquid,
    ///   wrapper bug) and checks the whole execute() unwinds with the shares still in the pool.
    function test_RevertWhen_Unwrap_RedeemPathReverts() public {
        zap.setPaused(true);
        uint256 _shares = 10 * ONE_SHARE;
        ppUsdc.mint(address(pool), _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(ppUsdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _shareRouting(0, 10 * RATE_1, 10 * RATE_1));
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        vm.expectRevert(MockZap.MockZap_Paused.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
        assertEq(ppUsdc.balanceOf(address(pool)), _shares);
    }

    function test_Unwrap_MaxRelayFeeIsCheckedInShares() public {
        pool.setAssetConfig(address(ppUsdc), true, 0, 0, 2 * ONE_SHARE, 0);   // cap 2 shares
        uint256 _shares = 10 * ONE_SHARE;
        ppUsdc.mint(address(pool), _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(ppUsdc));
        IPool.TransactParams memory _params = _buildTransactParams(
            address(relaySwaps), _shareRouting(25 * ONE_SHARE / 10, 75 * RATE_1 / 10, 75 * RATE_1 / 10)
        );
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        vm.expectRevert(RelaySwaps.RelaySwaps_FeeExceedsMax.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(zap));
    }

    function test_Unwrap_B2GasSwapRunsOnUnderlying() public {
        // Share input, B2 reshield: gas swap and bridge leg both pull USDC (the underlying).
        uint256 _shares = 100 * ONE_SHARE;
        uint256 _feeShares = 2 * ONE_SHARE;
        uint256 _out = 100 * RATE_1;
        uint256 _fee = 2 * RATE_1;
        uint256 _gasIn = 3 * RATE_1;
        uint256 _swapValue = 0.01 ether;
        uint256 _bridgePull = _out - _fee - _gasIn;

        RelaySwaps.SwapRouting memory _r = SwapRoutingBuilder.defaultRouting();
        _r.swapTarget = address(swapper);
        _r.approvalAddress = address(swapper);
        _r.outputToken = address(usdc);
        _r.recipient = address(0);
        _r.feeRecipient = feeRecipient;
        _r.fallbackAddress = address(0);
        _r.dustRecipient = dust;
        _r.feeAmount = _feeShares;
        _r.minOutputAmount = 0;
        _r.nativeGas = 0;
        _r.swapValue = _swapValue;
        _r.gasSwapMaxInput = _gasIn;
        _r.gasSwapCalldata = abi.encodeCall(MockSwapper.gasSwapToSender, (address(usdc), _gasIn, _swapValue));
        _r.swapCalldata = abi.encodeCall(MockSwapper.reshieldBridge, (address(usdc), _bridgePull, 0));
        _executeShares(_shares, _r);

        assertEq(usdc.balanceOf(feeRecipient), _fee);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "gas slice + bridge pull consumed everything");
        assertEq(ppUsdc.balanceOf(address(relaySwaps)), 0);
        assertEq(address(relaySwaps).balance, 0, "swapValue forwarded, no ETH left");
    }

    function test_Unwrap_ReentrancyViaZapIsBlocked() public {
        MockShare _share = new MockShare(address(aUsdc));
        ReentrantZap _rz = new ReentrantZap(address(_share), address(usdc), address(aUsdc), RATE_1);
        pool.setAssetConfig(address(_share), true, 0, 0, 0, 0);
        vm.prank(upgraderRole);
        relaySwaps.approveZap(address(_rz));

        uint256 _shares = 10 * ONE_SHARE;
        uint256 _out = 10 * RATE_1;
        _share.mint(address(pool), 2 * _shares);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_shares, address(_share));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _shareRouting(0, _out, _out));
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        _rz.configure(address(relaySwaps), abi.encodeCall(RelaySwaps.executeUnwrapped, (_proof, _params, _noteData, address(_rz))));

        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof, _params, _noteData, address(_rz));

        assertTrue(_rz.reentryAttempted());
        assertTrue(_rz.innerBlocked(), "inner execute must be rejected");
        assertEq(_rz.innerSelector(), bytes4(keccak256("Reentrancy()")));
        assertEq(usdt.balanceOf(recipient), _out, "outer execute completed exactly once");
        assertEq(_share.balanceOf(address(pool)), _shares, "only one withdrawal happened");
    }

    function test_NonRegisteredToken_UnaffectedByRegistry() public {
        // Plain USDC note through the same instance: byte-identical legacy path.
        uint256 _amount = 1_000_000;
        usdc.mint(address(pool), _amount);
        RelaySwaps.SwapRouting memory _r = _shareRouting(0, _amount, _amount);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_amount, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);
        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);
        assertEq(usdt.balanceOf(recipient), _amount);
    }
}