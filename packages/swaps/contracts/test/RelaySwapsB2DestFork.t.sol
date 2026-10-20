// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test, console} from "forge-std/Test.sol";

/// @title RelaySwapsB2DestFork
/// @notice Forked-MAINNET check for the B2 destination leg — the part the OP-fork
///   e2e cannot reach (a LayerZero message never delivers on a fork). Replays the
///   compose message Stargate would deliver: impersonates the LZ endpoint calling
///   `lzCompose` on LiFi's ReceiverStargateV2 with the REAL composeMsg extracted
///   from the captured main-leg calldata (scripts/b2-capture-lifi-fixtures.ts,
///   fixture section `dest`).
///
///   Answers the destination-failure checkpoint neither B2 plan verified:
///   - happy path: the embedded `Entrypoint.deposit` lands a note on the real
///     mainnet Entrypoint/PoolVault with the delivered amount;
///   - short delivery: where the funds actually go when the deposit cannot be
///     afforded (expected: LiFi's receiver catches the failed dest call and sends
///     the raw USDC to the payload receiver — the fallbackAddress path).
///
///   ENV-GATED: skips unless `B2_DEST_FORK_RPC_URL` is set (mainnet RPC). Run:
///
///     cd packages/swaps && npx tsx scripts/b2-capture-lifi-fixtures.ts
///     cd contracts && B2_DEST_FORK_RPC_URL=$RPC_URL_1 \
///       forge test --match-contract RelaySwapsB2DestFork -vvv
contract RelaySwapsB2DestForkTest is Test {
    // LayerZero EndpointV2 — same address on mainnet as everywhere (lz docs).
    // Env-overridable in case of an endpoint migration.
    address internal ENDPOINT;
    // StargatePoolUSDC on mainnet — the `_from` lzCompose would report. LiFi's
    // receiver gates on the endpoint (msg.sender), `_from` is informational.
    address internal STARGATE_POOL;

    address internal constant USDC_MAINNET = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;

    struct DestFixture {
        address receiver; // LiFi ReceiverStargateV2 (sendParams.to)
        bytes composeMsg;
        uint256 amountLD;
        uint256 minAmountLD;
        address payloadReceiver; // failure fallback inside the compose payload
        uint256 depositProofValue;
        uint256 totalDepositCost;
        address entrypoint;
        address poolVault;
        uint32 srcEid;
    }

    DestFixture internal fx;
    bool internal enabled;

    function setUp() public {
        string memory rpc = vm.envOr("B2_DEST_FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            enabled = false;
            return;
        }
        enabled = true;

        ENDPOINT = vm.envOr("LZ_ENDPOINT_MAINNET", 0x1a44076050125825900e736c501f859c50fE728c);
        STARGATE_POOL = vm.envOr(
            "STARGATE_POOL_USDC_MAINNET",
            0xc026395860Db2d07ee33e05fE50ed7bD583189C7
        );

        string memory path = vm.envOr(
            "B2_FIXTURE_PATH",
            string("../test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json")
        );
        string memory json = vm.readFile(path);

        fx.receiver = vm.parseJsonAddress(json, ".dest.receiver");
        fx.composeMsg = vm.parseJsonBytes(json, ".dest.composeMsg");
        fx.amountLD = vm.parseJsonUint(json, ".dest.amountLD");
        fx.minAmountLD = vm.parseJsonUint(json, ".dest.minAmountLD");
        fx.payloadReceiver = vm.parseJsonAddress(json, ".dest.payloadReceiver");
        fx.depositProofValue = vm.parseJsonUint(json, ".dest.depositProofValue");
        fx.totalDepositCost = vm.parseJsonUint(json, ".dest.totalDepositCost");
        fx.entrypoint = vm.parseJsonAddress(json, ".dest.entrypoint");
        fx.poolVault = vm.parseJsonAddress(json, ".dest.poolVault");
        fx.srcEid = uint32(vm.parseJsonUint(json, ".dest.srcEid"));

        // The deposit proof is chain-state-independent (Groth16 verify + permissionless
        // LeanIMT insert), so latest state is fine — no pin needed.
        vm.createSelectFork(rpc);
    }

    /// @notice Full delivery: the destination `Entrypoint.deposit` must land the note.
    function test_B2_DestFork_FullDelivery_DepositLands() public {
        if (!enabled) {
            vm.skip(true, "B2_DEST_FORK_RPC_URL unset - dest fork check skipped");
            return;
        }
        uint256 delivered = fx.amountLD;
        _fundReceiver(delivered);

        uint256 vaultBefore = _usdc(fx.poolVault);
        uint256 entrypointBefore = _usdc(fx.entrypoint);
        uint256 fallbackBefore = _usdc(fx.payloadReceiver);

        _compose(delivered);

        console.log("vault USDC delta      :", _usdc(fx.poolVault) - vaultBefore);
        console.log("entrypoint USDC delta :", _usdc(fx.entrypoint) - entrypointBefore);
        console.log("fallback USDC delta   :", _usdc(fx.payloadReceiver) - fallbackBefore);
        console.log("receiver USDC after   :", _usdc(fx.receiver));

        // Entrypoint pulls totalDepositCost, forwards the note value to the vault and
        // keeps the vetting fee; the executor's leftover goes to the payload receiver.
        assertEq(
            _usdc(fx.poolVault) - vaultBefore,
            fx.depositProofValue,
            "vault did not receive the proven note value"
        );
        assertEq(
            _usdc(fx.entrypoint) - entrypointBefore,
            fx.totalDepositCost - fx.depositProofValue,
            "entrypoint did not keep the vetting fee"
        );
        assertEq(
            _usdc(fx.payloadReceiver) - fallbackBefore,
            delivered - fx.totalDepositCost,
            "leftover did not reach the payload receiver"
        );
        assertEq(_usdc(fx.receiver), 0, "USDC stranded in the LiFi receiver");
    }

    /// @notice Short delivery (below the deposit cost): the deposit cannot be paid —
    ///   assert where the funds actually end up. Expected per LiFi receiver semantics:
    ///   the failed destination call is caught and the raw USDC is sent to the payload
    ///   receiver (the fallbackAddress path) — NOT stranded, NOT reverted.
    function test_B2_DestFork_ShortDelivery_FundsToFallback() public {
        if (!enabled) {
            vm.skip(true, "B2_DEST_FORK_RPC_URL unset - dest fork check skipped");
            return;
        }
        uint256 delivered = fx.totalDepositCost - 1;
        _fundReceiver(delivered);

        uint256 vaultBefore = _usdc(fx.poolVault);
        uint256 fallbackBefore = _usdc(fx.payloadReceiver);

        _compose(delivered);

        console.log("vault USDC delta    :", _usdc(fx.poolVault) - vaultBefore);
        console.log("fallback USDC delta :", _usdc(fx.payloadReceiver) - fallbackBefore);
        console.log("receiver USDC after :", _usdc(fx.receiver));

        assertEq(_usdc(fx.poolVault) - vaultBefore, 0, "vault received funds on a short delivery");
        assertEq(
            _usdc(fx.payloadReceiver) - fallbackBefore,
            delivered,
            "short-delivery funds did not reach the payload receiver"
        );
        assertEq(_usdc(fx.receiver), 0, "USDC stranded in the LiFi receiver");
    }

    /// @notice The receiver must reject a compose from anyone but the LZ endpoint —
    ///   also validates the ENDPOINT address assumption (a wrong endpoint constant
    ///   would make this pass vacuously fail).
    function test_B2_DestFork_RejectsNonEndpointCaller() public {
        if (!enabled) {
            vm.skip(true, "B2_DEST_FORK_RPC_URL unset - dest fork check skipped");
            return;
        }
        _fundReceiver(fx.amountLD);
        bytes memory message = _oftMessage(fx.amountLD);
        vm.expectRevert();
        vm.prank(makeAddr("not-the-endpoint"));
        ILayerZeroComposer(fx.receiver).lzCompose(
            STARGATE_POOL,
            bytes32(uint256(1)),
            message,
            makeAddr("lz-executor"),
            ""
        );
    }

    /// @dev Stargate credits the tokens to the compose receiver BEFORE the endpoint
    ///   calls lzCompose — simulate that credit.
    function _fundReceiver(uint256 amount) internal {
        deal(USDC_MAINNET, fx.receiver, amount);
    }

    function _compose(uint256 deliveredLD) internal {
        bytes memory message = _oftMessage(deliveredLD);
        vm.prank(ENDPOINT);
        ILayerZeroComposer(fx.receiver).lzCompose{gas: 2_000_000}(
            STARGATE_POOL,
            bytes32(uint256(1)), // guid — informational
            message,
            makeAddr("lz-executor"),
            ""
        );
    }

    /// @dev OFTComposeMsgCodec layout: nonce(8) ++ srcEid(4) ++ amountLD(32) ++
    ///   composeFrom(32) ++ composeMsg. The receiver reads amountLD + composeMsg;
    ///   composeFrom (source-side sender) is informational here.
    function _oftMessage(uint256 deliveredLD) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint64(1),
            fx.srcEid,
            deliveredLD,
            bytes32(uint256(uint160(STARGATE_POOL))),
            fx.composeMsg
        );
    }

    function _usdc(address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = USDC_MAINNET.staticcall(
            abi.encodeWithSignature("balanceOf(address)", who)
        );
        require(ok && data.length >= 32, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}

interface ILayerZeroComposer {
    function lzCompose(
        address _from,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;
}
