// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {MockERC20, MockSwapper} from "./RelaySwaps.t.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';

/// @notice Pool mock that enforces the ZK proof context binding the way the real
///   PoolVault does (PoolVault.sol:147). MockPool deliberately skips this check;
///   this mock exists so the tamper-rejection property of the proof-bound LiFi
///   calldata can be exercised end-to-end through RelaySwaps.execute().
contract ContextBindingPool {
    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    using ProofLibV2 for ProofLibV2.TransactProof;

    error ContextBindingPool_InvalidProcessor();
    error ContextBindingPool_ContextMismatch();

    mapping(address => IEntrypoint.AssetConfig) internal _assets;

    /// @notice Minimal Entrypoint role — only maxRelayFee is read by RelaySwaps
    function setAssetConfig(address _asset, uint256 _maxRelayFee) external {
        _assets[_asset] = IEntrypoint.AssetConfig({
            enabled: true,
            minAmount: 0,
            vettingFeeBPS: 0,
            maxRelayFee: _maxRelayFee
        });
    }

    function assets(address _asset) external view returns (IEntrypoint.AssetConfig memory) {
        return _assets[_asset];
    }

    function transact(
            ProofLibV2.TransactProof calldata _proof,
        IPool.TransactParams calldata _transactParams,
        IPool.NoteData[] calldata _noteData
    ) external {
        require(_transactParams.processor == msg.sender, ContextBindingPool_InvalidProcessor());

        // Mirror of PoolVault.sol:147 — the proof's context public signal commits to
        // the full transact params (processor + ABI-encoded SwapRouting, which embeds
        // the LiFi swapCalldata) and the note data. Any tampering after proof
        // generation changes the hash and fails here.
        require(
            _proof.context()
                == uint256(keccak256(abi.encode(_transactParams, _noteData))) % SNARK_SCALAR_FIELD,
            ContextBindingPool_ContextMismatch()
        );

        uint256 _value = _proof.amountOut();
        address _asset = address(uint160(_proof.tokenIdOut()));
        if (_asset == NATIVE_ASSET) {
            (bool _ok,) = msg.sender.call{value: _value}("");
            require(_ok);
        } else {
            MockERC20(_asset).transfer(msg.sender, _value);
        }
    }

    receive() external payable {}
}

/// @notice Proves the proof-context binding rejects relayer tampering of the
///   proof-bound LiFi calldata (and everything else in the routing blob).
///   RelaySwaps itself never inspects swapCalldata integrity — the pool's context
///   check is the security boundary, so these tests run the full execute() path
///   against a pool that enforces it.
contract RelaySwapsProofBindingTest is Test {
    ContextBindingPool internal pool;
    RelaySwaps internal relaySwaps;
    MockSwapper internal swapper;
    MockSwapper internal otherSwapper;
    MockERC20 internal usdc;
    MockERC20 internal usdt;

    address internal owner = makeAddr("owner");
    address internal relayer = makeAddr("relayer");
    address internal recipient = makeAddr("recipient");
    address internal attacker = makeAddr("attacker");

    uint256 internal constant SNARK_SCALAR_FIELD =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant WITHDRAW_AMOUNT = 1_000_000;

    function setUp() public {
        pool = new ContextBindingPool();
        swapper = new MockSwapper();
        otherSwapper = new MockSwapper();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdt = new MockERC20("Tether", "USDT", 6);

        relaySwaps = new RelaySwaps(
            IPool(address(pool)),
            IEntrypoint(address(pool)),
            owner,
            address(swapper)
        );
        vm.prank(owner);
        relaySwaps.approveRouter(address(otherSwapper));

        pool.setAssetConfig(address(usdc), 0);
        usdc.mint(address(pool), WITHDRAW_AMOUNT);
    }

    /*///////////////////////////////////////////////////////////////
                          HAPPY PATH
    ///////////////////////////////////////////////////////////////*/

    function test_Execute_WithProofBoundCalldata() public {
        (
            ProofLibV2.TransactProof memory _proof,
            IPool.TransactParams memory _params,
            IPool.NoteData[] memory _noteData
        ) = _buildBoundExecution(_swapCalldataTo(recipient), address(swapper));

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), WITHDRAW_AMOUNT);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    /*///////////////////////////////////////////////////////////////
                          TAMPER REJECTION
    ///////////////////////////////////////////////////////////////*/

    function test_RevertWhen_SwapCalldataTampered() public {
        // Proof context is computed over the honest routing (output → recipient) ...
        (
            ProofLibV2.TransactProof memory _proof,
            ,
            IPool.NoteData[] memory _noteData
        ) = _buildBoundExecution(_swapCalldataTo(recipient), address(swapper));

        // ... but the relayer substitutes calldata redirecting the output to itself
        IPool.TransactParams memory _tampered = _buildTransactParams(
            _buildRouting(_swapCalldataTo(attacker), address(swapper))
        );

        vm.prank(relayer);
        vm.expectRevert(ContextBindingPool.ContextBindingPool_ContextMismatch.selector);
        relaySwaps.execute(_proof, _tampered, _noteData);

        assertEq(usdt.balanceOf(attacker), 0);
        assertEq(usdc.balanceOf(address(pool)), WITHDRAW_AMOUNT);
    }

    function test_RevertWhen_SwapTargetTampered() public {
        (
            ProofLibV2.TransactProof memory _proof,
            ,
            IPool.NoteData[] memory _noteData
        ) = _buildBoundExecution(_swapCalldataTo(recipient), address(swapper));

        // Tampered target is ALSO an approved router — proves the context check
        // fires, not the router allowlist.
        IPool.TransactParams memory _tampered = _buildTransactParams(
            _buildRouting(_swapCalldataTo(recipient), address(otherSwapper))
        );

        vm.prank(relayer);
        vm.expectRevert(ContextBindingPool.ContextBindingPool_ContextMismatch.selector);
        relaySwaps.execute(_proof, _tampered, _noteData);
    }

    // RC-10: dustRescue is carried in SwapRouting purely to inherit this same
    // proof-binding — no dedicated on-chain check exists for it, so this test is what
    // actually proves the property: a relayer cannot attach or alter a dustRescue block
    // the note owner didn't prove against.
    function test_RevertWhen_DustRescueTampered() public {
        (
            ProofLibV2.TransactProof memory _proof,
            ,
            IPool.NoteData[] memory _noteData
        ) = _buildBoundExecution(_swapCalldataTo(recipient), address(swapper));

        RelaySwaps.SwapRouting memory _tamperedRouting = _buildRouting(_swapCalldataTo(recipient), address(swapper));
        _tamperedRouting.dustRescue.chainId = 8453;
        _tamperedRouting.dustRescue.tokenId = address(usdt);
        IPool.TransactParams memory _tampered = _buildTransactParams(_tamperedRouting);

        vm.prank(relayer);
        vm.expectRevert(ContextBindingPool.ContextBindingPool_ContextMismatch.selector);
        relaySwaps.execute(_proof, _tampered, _noteData);
    }

    function test_RevertWhen_NoteDataTampered() public {
        (
            ProofLibV2.TransactProof memory _proof,
            IPool.TransactParams memory _params,
        ) = _buildBoundExecution(_swapCalldataTo(recipient), address(swapper));

        // Context commits _noteData too — swapping in different discovery data fails
        IPool.NoteData[] memory _tamperedNotes = new IPool.NoteData[](1);
        _tamperedNotes[0] = IPool.NoteData({hint: bytes32(uint256(1)), data: "0x"});

        vm.prank(relayer);
        vm.expectRevert(ContextBindingPool.ContextBindingPool_ContextMismatch.selector);
        relaySwaps.execute(_proof, _params, _tamperedNotes);
    }

    /*///////////////////////////////////////////////////////////////
                          HELPERS
    ///////////////////////////////////////////////////////////////*/

    function _swapCalldataTo(address _outputRecipient) internal view returns (bytes memory) {
        return abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), WITHDRAW_AMOUNT, _outputRecipient)
        );
    }

    function _buildRouting(bytes memory _swapCalldata, address _swapTarget)
        internal
        view
        returns (RelaySwaps.SwapRouting memory)
    {
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = _swapTarget;
        _routing.approvalAddress = _swapTarget;
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = WITHDRAW_AMOUNT;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        return _routing;
    }

    function _buildTransactParams(RelaySwaps.SwapRouting memory _routing)
        internal
        view
        returns (IPool.TransactParams memory _params)
    {
        _params.processor = address(relaySwaps);
        _params.data = abi.encode(_routing);
    }

    /// @dev Builds proof + params + noteData with the proof context correctly
    ///   committed over (params, noteData) — what the SDK/prover produces.
    function _buildBoundExecution(bytes memory _swapCalldata, address _swapTarget)
        internal
        view
        returns (
            ProofLibV2.TransactProof memory _proof,
            IPool.TransactParams memory _params,
            IPool.NoteData[] memory _noteData
        )
    {
        _params = _buildTransactParams(_buildRouting(_swapCalldata, _swapTarget));
        _noteData = new IPool.NoteData[](0);

        _proof.pubSignals = new uint256[][](8);
        for (uint256 _i = 0; _i < 8; _i++) {
            _proof.pubSignals[_i] = new uint256[](1);
        }
        _proof.pubSignals[5][0] = WITHDRAW_AMOUNT;
        _proof.pubSignals[6][0] = uint256(uint160(address(usdc)));
        _proof.pubSignals[7][0] = _contextFor(_params, _noteData);
    }

    function _contextFor(IPool.TransactParams memory _params, IPool.NoteData[] memory _noteData)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encode(_params, _noteData))) % SNARK_SCALAR_FIELD;
    }
}
