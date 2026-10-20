// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";
import {RelaySwaps, IPool, IEntrypoint, IYieldZap} from "../src/RelaySwaps.sol";
import {MockERC20, MockSwapper} from "./RelaySwaps.t.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function allowance(address, address) external view returns (uint256);
}
interface IPPYieldTokenMin is IERC20Min {
    function previewRedeem(uint256) external view returns (uint256);
    function asset() external view returns (address);
    function pause() external;
    function owner() external view returns (address);
}
interface IZapMin is IYieldZap {
    function depositUnderlying(uint256 _underlyingAmount, address _receiver) external returns (uint256 _shares);
}

/// @notice Mainnet-fork test of the yield unwrap against the REAL ppUSDC wrapper, its Zap,
///   Aave v3 and the V2 PROD Entrypoint (for maxRelayFee / enablement). The pool side is
///   MockPool (no proof verification) seeded with real shares minted through the Zap; the
///   swap leg is MockSwapper pulling real USDC, so every unwrap-specific line runs against
///   production bytecode.
///
///   ENV-GATED: skips unless `UNWRAP_FORK_RPC_URL` is set. Run with:
///     UNWRAP_FORK_RPC_URL=$RPC_URL_1 forge test --match-contract RelaySwapsUnwrapFork -vv
contract RelaySwapsUnwrapForkTest is Test {
    address internal constant PP_USDC = 0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6;
    address internal constant ZAP = 0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B;
    address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant A_ETH_USDC = 0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c;
    address internal constant ENTRYPOINT = 0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3;

    MockPool internal pool;
    RelaySwaps internal relaySwaps;
    MockSwapper internal swapper;
    MockERC20 internal outToken;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal recipient = makeAddr("recipient");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal dust = makeAddr("dust");

    uint256 internal seededShares;

    function setUp() public {
        string memory _rpc = vm.envOr("UNWRAP_FORK_RPC_URL", string(""));
        vm.skip(bytes(_rpc).length == 0);
        vm.createSelectFork(_rpc);

        pool = new MockPool();
        swapper = new MockSwapper();
        outToken = new MockERC20("Mock Out", "OUT", 6);
        relaySwaps = new RelaySwaps(IPool(address(pool)), IEntrypoint(ENTRYPOINT), owner, address(swapper));
        pool.setAssetConfig(PP_USDC, true, 0, 0, 0, 0);

        // Mint real ppUSDC shares into the mock pool via the real Zap (USDC -> Aave -> wrapper).
        deal(USDC, address(this), 1_000e6);
        IERC20Min(USDC).approve(ZAP, 1_000e6);
        seededShares = IZapMin(ZAP).depositUnderlying(1_000e6, address(pool));
        assertGt(seededShares, 0, "zap minted shares");
        assertEq(IERC20Min(PP_USDC).balanceOf(address(pool)), seededShares);
    }

    function _routing(uint256 _feeShares, uint256 _pull, uint256 _minOut) internal view returns (RelaySwaps.SwapRouting memory) {
        RelaySwaps.SwapRouting memory _r = SwapRoutingBuilder.defaultRouting();
        _r.swapTarget = address(swapper);
        _r.approvalAddress = address(swapper);
        _r.outputToken = address(outToken);
        _r.recipient = recipient;
        _r.feeRecipient = feeRecipient;
        _r.fallbackAddress = address(0);
        _r.dustRecipient = dust;
        _r.feeAmount = _feeShares;
        _r.minOutputAmount = _minOut;
        _r.nativeGas = 0;
        _r.swapValue = 0;
        _r.gasSwapMaxInput = 0;
        _r.gasSwapCalldata = "";
        _r.swapCalldata = abi.encodeCall(MockSwapper.swap, (USDC, address(outToken), _pull, recipient));
        return _r;
    }

    function _proof(uint256 _shares) internal pure returns (ProofLibV2.TransactProof memory _p) {
        _p.pubSignals = new uint256[][](8);
        for (uint256 i = 0; i < 8; i++) _p.pubSignals[i] = new uint256[](1);
        _p.pubSignals[5][0] = _shares;
        _p.pubSignals[6][0] = uint256(uint160(PP_USDC));
    }

    function _register() internal {
        vm.prank(owner);
        relaySwaps.approveZap(ZAP);
    }

    function test_Fork_ApproveZap_AgainstRealContracts() public {
        // Validates every interface assumption: zap.VAULT/A_TOKEN/UNDERLYING, share.asset(),
        // aToken.UNDERLYING_ASSET_ADDRESS(), Entrypoint.assets(share).enabled.
        _register();
        assertTrue(relaySwaps.approvedZaps(ZAP));
        assertEq(IYieldZap(ZAP).VAULT(), PP_USDC);
        assertEq(IYieldZap(ZAP).UNDERLYING(), USDC);
        assertEq(IPPYieldTokenMin(PP_USDC).asset(), A_ETH_USDC);
    }

    function test_Fork_RevertWhen_ApproveZap_NotAZap() public {
        // A contract with none of the zap getters (the mock swapper) must be refused, not listed.
        vm.expectRevert();
        vm.prank(owner);
        relaySwaps.approveZap(address(swapper));
    }

    function test_Fork_Execute_UnwrapsRealShares_FeeMatchesPreviewRedeem() public {
        _register();
        uint256 _shares = seededShares;
        uint256 _feeShares = _shares / 100;                                  // 1%
        uint256 _quotedOut = IPPYieldTokenMin(PP_USDC).previewRedeem(_shares); // same block => exact
        uint256 _quotedFee = IPPYieldTokenMin(PP_USDC).previewRedeem(_feeShares);
        uint256 _net = _quotedOut - _quotedFee;

        uint256 _usdcRelayBefore = IERC20Min(USDC).balanceOf(address(relaySwaps));

        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof(_shares), IPool.TransactParams({processor: address(relaySwaps), data: abi.encode(_routing(_feeShares, _net, _net))}), new IPool.NoteData[](0), ZAP);

        uint256 _feePaid = IERC20Min(USDC).balanceOf(feeRecipient);
        assertApproxEqAbs(_feePaid, _quotedFee, 1, "fee in USDC == previewRedeem(feeShares) +-1 wei");
        assertEq(outToken.balanceOf(recipient), _net, "recipient gets the quoted net");
        assertEq(IERC20Min(PP_USDC).balanceOf(address(relaySwaps)), 0, "no shares stranded");
        assertEq(IERC20Min(USDC).balanceOf(address(relaySwaps)), _usdcRelayBefore, "no underlying stranded");
        assertEq(IERC20Min(PP_USDC).allowance(address(relaySwaps), ZAP), 0, "zap allowance consumed");
        assertEq(IERC20Min(USDC).allowance(address(relaySwaps), address(swapper)), 0, "swap allowance reset");
        assertEq(IERC20Min(PP_USDC).balanceOf(address(pool)), 0, "pool paid out the shares");
    }

    function test_Fork_Execute_RateAccruesAfterQuote_SurplusToDust() public {
        _register();
        uint256 _shares = seededShares;
        uint256 _feeShares = _shares / 100;
        // Quote now...
        uint256 _quotedOut = IPPYieldTokenMin(PP_USDC).previewRedeem(_shares);
        uint256 _quotedFee = IPPYieldTokenMin(PP_USDC).previewRedeem(_feeShares);
        uint256 _net = _quotedOut - _quotedFee;
        // ...execute a month later: Aave's liquidity index has grown, the wrapper pays more.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 216_000);
        uint256 _outLater = IPPYieldTokenMin(PP_USDC).previewRedeem(_shares);
        assertGt(_outLater, _quotedOut, "yield accrued on the fork");

        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof(_shares), IPool.TransactParams({processor: address(relaySwaps), data: abi.encode(_routing(_feeShares, _net, _net))}), new IPool.NoteData[](0), ZAP);

        uint256 _feePaid = IERC20Min(USDC).balanceOf(feeRecipient);
        assertGt(_feePaid, _quotedFee, "fee scales with realised output");
        assertEq(outToken.balanceOf(recipient), _net, "recipient still gets exactly the quoted net");
        uint256 _surplus = IERC20Min(USDC).balanceOf(dust);
        assertGt(_surplus, 0, "surplus swept to the proof-bound dust recipient");
        assertApproxEqAbs(_feePaid + _net + _surplus, _outLater, 2, "everything redeemed is accounted for");
        assertEq(IERC20Min(USDC).balanceOf(address(relaySwaps)), 0);
    }

    function test_Fork_WrapperPaused_StillUnwraps() public {
        // PPYieldToken.pause() gates deposit/mint only (maxDeposit/maxMint -> 0); redeem is
        // never blocked, so a paused wrapper must NOT strand yield notes in a swap.
        _register();
        address _wrapperOwner = IPPYieldTokenMin(PP_USDC).owner();
        vm.prank(_wrapperOwner);
        IPPYieldTokenMin(PP_USDC).pause();

        uint256 _shares = seededShares;
        uint256 _net = IPPYieldTokenMin(PP_USDC).previewRedeem(_shares);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof(_shares), IPool.TransactParams({processor: address(relaySwaps), data: abi.encode(_routing(0, _net, _net))}), new IPool.NoteData[](0), ZAP);
        assertEq(outToken.balanceOf(recipient), _net, "exit path unaffected by pause");
        assertEq(IERC20Min(PP_USDC).balanceOf(address(pool)), 0);
    }

    function test_Fork_MaxRelayFee_FromRealEntrypoint_InShares() public {
        _register();
        uint256 _maxFee = IEntrypoint(ENTRYPOINT).assets(PP_USDC).maxRelayFee;
        assertGt(_maxFee, 0, "prod entrypoint caps ppUSDC relay fee");
        // Use a fee above the cap but below the withdrawal: must be refused BEFORE any unwrap.
        deal(USDC, address(this), 2_000e6);
        IERC20Min(USDC).approve(ZAP, 2_000e6);
        uint256 _more = IZapMin(ZAP).depositUnderlying(2_000e6, address(pool));
        uint256 _shares = seededShares + _more;
        vm.assume(_shares > _maxFee);
        uint256 _feeShares = _maxFee + 1;
        vm.expectRevert(RelaySwaps.RelaySwaps_FeeExceedsMax.selector);
        vm.prank(relayer);
        relaySwaps.executeUnwrapped(_proof(_shares), IPool.TransactParams({processor: address(relaySwaps), data: abi.encode(_routing(_feeShares, 1, 1))}), new IPool.NoteData[](0), ZAP);
    }
}
