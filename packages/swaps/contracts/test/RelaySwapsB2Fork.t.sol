// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test, console} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {ProofLibV2} from "main_contracts_libs/ProofLibV2.sol";

/// @title RelaySwapsB2Fork
/// @notice Forked-Optimism check for B2's open question §15.1 — does the real
///   Stargate V2 route (LiFi contractCalls calldata) refund excess source
///   `msg.value` to `msg.sender` (= RelaySwaps), and is that refund inside the
///   same call frame so `_sweepDust` catches it?
///
///   Feeds REAL LiFi calldata (captured by scripts/b2-capture-lifi-fixtures.ts)
///   into a freshly-deployed RelaySwaps on a fork of Optimism: the step-9.5 gas
///   swap (OP-USDC -> native ETH) and the step-10 main leg
///   (`swapTarget.call{value: swapValue}(swapCalldata)` into Stargate). MockPool
///   stands in for PoolVault (skips ZK verification — irrelevant to the value /
///   refund mechanics under test).
///
///   ENV-GATED: skips itself unless `B2_FORK_RPC_URL` is set, so a plain
///   `forge test` (no RPC, CI) is unaffected. Run it with:
///
///     . ../../.env    # RPC_URL_10, etc. (from packages/swaps/)
///     cd packages/swaps && npx tsx scripts/b2-capture-lifi-fixtures.ts
///     cd contracts && B2_FORK_RPC_URL=$RPC_URL_10 \
///       forge test --match-contract RelaySwapsB2Fork -vvvv
///
///   The `-vvvv` call trace is the primary artifact — it shows every ETH
///   transfer, including any Stargate refund back to RelaySwaps.
contract RelaySwapsB2ForkTest is Test {
    // solhint-disable-next-line const-name-snakecase
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    address internal relayer = makeAddr("relayer");
    // Instrumented dust recipient — a plain EOA-like sink with a recording receive().
    DustSink internal dustSink;

    MockPool internal pool;
    RelaySwaps internal relaySwaps;

    struct Fixture {
        address inputToken;
        uint256 withdrawAmount;
        uint256 feeAmount;
        // main leg (pass 3, sized against the reduced net)
        address mainSwapTarget;
        address mainApprovalAddress;
        bytes mainCalldata;
        uint256 mainTransactionValue;
        // gas swap
        address gasSwapTarget;
        address gasSwapApprovalAddress;
        bytes gasSwapCalldata;
        // derived / proof-bound
        uint256 swapValue;
        uint256 gasSwapMaxInput;
        uint256 mainLegNet;
    }

    Fixture internal fx;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("B2_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            enabled = false;
            return;
        }
        enabled = true;

        string memory path = vm.envOr(
            "B2_FIXTURE_PATH",
            string("../test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json")
        );
        string memory json = vm.readFile(path);

        fx.inputToken = vm.parseJsonAddress(json, ".inputToken");
        fx.withdrawAmount = vm.parseJsonUint(json, ".withdrawAmount");
        fx.feeAmount = vm.parseJsonUint(json, ".feeAmount");
        fx.mainSwapTarget = vm.parseJsonAddress(json, ".mainSwap.swapTarget");
        fx.mainApprovalAddress = vm.parseJsonAddress(json, ".mainSwap.approvalAddress");
        fx.mainCalldata = vm.parseJsonBytes(json, ".mainSwap.transactionData");
        fx.mainTransactionValue = vm.parseJsonUint(json, ".mainSwap.transactionValue");
        fx.gasSwapTarget = vm.parseJsonAddress(json, ".gasSwap.swapTarget");
        fx.gasSwapApprovalAddress = vm.parseJsonAddress(json, ".gasSwap.approvalAddress");
        fx.gasSwapCalldata = vm.parseJsonBytes(json, ".gasSwap.transactionData");
        fx.swapValue = vm.parseJsonUint(json, ".derived.swapValue");
        fx.gasSwapMaxInput = vm.parseJsonUint(json, ".derived.gasSwapMaxInput");
        fx.mainLegNet = vm.parseJsonUint(json, ".derived.mainLegNet");

        uint256 forkBlock = vm.parseJsonUint(json, ".sourceForkBlock");
        vm.createSelectFork(rpc, forkBlock);

        dustSink = new DustSink();

        pool = new MockPool();
        pool.setAssetConfig(fx.inputToken, true, 0, 0, 0, 0);

        // RelaySwaps MUST live at the fixture's `executor` address: the captured
        // calldata pins it as the gas-swap ETH receiver and the Stargate refund
        // address (LiFi binds both to the quote's fromAddress). Deploying anywhere
        // else silently misdirects the gas-swap output -> RelaySwaps_GasSwapInsufficient.
        address executor = vm.parseJsonAddress(json, ".executor");
        deployCodeTo(
            "RelaySwaps.sol:RelaySwaps",
            abi.encode(IPool(address(pool)), IEntrypoint(address(pool)), address(this), fx.mainSwapTarget),
            executor
        );
        relaySwaps = RelaySwaps(payable(executor));
        _approveIfDistinct(fx.mainApprovalAddress);
        _approveIfDistinct(fx.gasSwapTarget);
        _approveIfDistinct(fx.gasSwapApprovalAddress);

        // Fund the pool with the withdrawal so MockPool.transact can forward it.
        deal(fx.inputToken, address(pool), fx.withdrawAmount, true);
    }

    function test_B2_Fork_StargateRefundSweptToDustRecipient() public {
        if (!enabled) {
            vm.skip(true, "B2_FORK_RPC_URL unset - forked B2 check skipped");
            return;
        }

        RelaySwaps.SwapRouting memory r = SwapRoutingBuilder.defaultRouting();
        r.swapTarget = fx.mainSwapTarget;
        r.approvalAddress = fx.mainApprovalAddress;
        r.outputToken = fx.inputToken;
        r.recipient = address(0);
        r.feeRecipient = fx.feeAmount > 0 ? makeAddr("feeRecipient") : address(0);
        r.fallbackAddress = address(0);
        r.dustRecipient = address(dustSink);
        r.feeAmount = fx.feeAmount;
        r.minOutputAmount = 0;
        r.nativeGas = 0;
        r.swapValue = fx.swapValue;
        r.gasSwapMaxInput = fx.gasSwapMaxInput;
        r.gasSwapCalldata = fx.gasSwapCalldata;
        r.swapCalldata = fx.mainCalldata;

        IPool.TransactParams memory params;
        params.processor = address(relaySwaps);
        params.data = abi.encode(r);

        ProofLibV2.TransactProof memory proof = _proof(fx.withdrawAmount, fx.inputToken);

        uint256 dustBefore = address(dustSink).balance;

        vm.recordLogs();
        vm.prank(relayer);
        relaySwaps.execute(proof, params, new IPool.NoteData[](0));

        uint256 dustDelta = address(dustSink).balance - dustBefore;

        // --- §15.1 answer, part 2: nothing stranded in RelaySwaps -------------
        // If a Stargate refund arrived in-frame, _sweepDust (delta-only ETH sweep)
        // forwarded it; if it arrived after the frame, this balance would be > 0.
        assertEq(address(relaySwaps).balance, 0, "ETH stranded in RelaySwaps after execute");
        assertEq(
            _erc20BalanceOf(fx.inputToken, address(relaySwaps)),
            0,
            "input-token dust stranded in RelaySwaps"
        );

        // --- §15.1 answer, part 1: is there a refund at all? -----------------
        // dustDelta = gas-swap overshoot (gasSwapOut - swapValue) + Stargate refund.
        // The gas swap was sized to yield ~swapValue * 1.05 out (5% headroom), so
        // an overshoot near 5% of swapValue is expected with NO refund. A dustDelta
        // materially above that implies Stargate refunded excess msg.value to
        // msg.sender (RelaySwaps) inside the call frame — which validates §10's
        // "generous swapValue + refundAddress" mitigation.
        uint256 expectedOvershootCeil = fx.swapValue / 10; // ~10% — generous ceiling on pure gas-swap headroom
        console.log("swapValue (forwarded)      :", fx.swapValue);
        console.log("re-quoted LZ fee           :", fx.mainTransactionValue);
        console.log("dustRecipient ETH delta    :", dustDelta);
        console.log("gas-swap overshoot ceiling :", expectedOvershootCeil);
        if (dustDelta > expectedOvershootCeil) {
            console.log(">>> Stargate refunds excess msg.value to msg.sender IN-FRAME (refund ~=", dustDelta - expectedOvershootCeil, "wei)");
        } else {
            console.log(">>> No detectable in-frame Stargate refund (dustDelta within gas-swap headroom)");
        }

        // Soft floor: the forwarded swapValue must have been >= the actual LZ fee,
        // else the Stargate call would have reverted and we'd never reach here.
        assertGe(fx.swapValue, fx.mainTransactionValue, "swapValue below re-quoted LZ fee");
    }

    function _approveIfDistinct(address router) internal {
        if (router == address(0) || router == fx.mainSwapTarget) return;
        // approveRouter is onlyUpgraderRole; setUp deployed with upgraderRole = address(this).
        try relaySwaps.approveRouter(router) {} catch {}
    }

    function _proof(uint256 amountOut, address tokenIdOut)
        internal
        pure
        returns (ProofLibV2.TransactProof memory p)
    {
        p.pubSignals = new uint256[][](8);
        for (uint256 i = 0; i < 8; i++) {
            p.pubSignals[i] = new uint256[](1);
        }
        p.pubSignals[5][0] = amountOut;
        p.pubSignals[6][0] = uint256(uint160(tokenIdOut));
    }

    function _erc20BalanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(
            abi.encodeWithSignature("balanceOf(address)", who)
        );
        require(ok && data.length >= 32, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}

/// @notice Records every ETH receipt so the test can total gas-swap overshoot +
///   any Stargate refund landing at `dustRecipient`.
contract DustSink {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}
