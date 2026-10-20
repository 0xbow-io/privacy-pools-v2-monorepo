// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {IRelaySwaps} from "../src/IRelaySwaps.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';

/// @notice Minimal ERC20 for testing
contract MockERC20 {
    string public name;
    string public symbol;
    uint8 public decimals;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function mint(address _to, uint256 _amount) external {
        balanceOf[_to] += _amount;
    }

    function approve(address _spender, uint256 _amount) external returns (bool) {
        allowance[msg.sender][_spender] = _amount;
        return true;
    }

    function transfer(address _to, uint256 _amount) external returns (bool) {
        balanceOf[msg.sender] -= _amount;
        balanceOf[_to] += _amount;
        return true;
    }

    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool) {
        allowance[_from][msg.sender] -= _amount;
        balanceOf[_from] -= _amount;
        balanceOf[_to] += _amount;
        return true;
    }
}

/// @notice Mock swap target that sends output directly to recipient (like LiFi with _receiver)
contract MockSwapper {
    /// @dev Pulls ERC20 input, mints ERC20 output directly to _recipient
    function swap(address _inputToken, address _outputToken, uint256 _amount, address _recipient) external {
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _amount);
        MockERC20(_outputToken).mint(_recipient, _amount);
    }

    /// @dev Accepts ETH input, mints ERC20 output directly to _recipient
    function swapETHToERC20(address _outputToken, address _recipient) external payable {
        MockERC20(_outputToken).mint(_recipient, msg.value);
    }

    /// @dev Accepts ETH input, consumes 90%, refunds 10% as ETH dust to caller
    function swapETHToERC20WithRefund(address _outputToken, address _recipient) external payable {
        uint256 _consumed = msg.value * 9 / 10;
        MockERC20(_outputToken).mint(_recipient, _consumed);
        // Refund 10% back to caller as ETH dust
        (bool _ok,) = msg.sender.call{value: msg.value - _consumed}("");
        require(_ok);
    }

    /// @dev Pulls ERC20 input, sends ETH output directly to _recipient
    function swapERC20ToETH(address _inputToken, uint256 _amount, address _recipient) external {
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _amount);
        (bool _ok,) = _recipient.call{value: _amount}("");
        require(_ok);
    }

    /// @dev Pulls ERC20 input, mints ERC20 output to msg.sender (simulates partial fill with dust)
    function swapWithDust(address _inputToken, address _outputToken, uint256 _amount, address _recipient) external {
        // Only consume 90% — leaves 10% as input dust on caller
        uint256 _consumed = _amount * 9 / 10;
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _consumed);
        MockERC20(_outputToken).mint(_recipient, _consumed);
    }

    /// @dev Pulls full ERC20 input, sends 90% output to recipient and returns 10% output dust to
    ///   the caller (RelaySwaps) — simulates a swap that over-delivers output to the processor.
    function swapWithOutputDust(address _inputToken, address _outputToken, uint256 _amount, address _recipient) external {
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _amount);
        uint256 _toRecipient = _amount * 9 / 10;
        MockERC20(_outputToken).mint(_recipient, _toRecipient);
        MockERC20(_outputToken).mint(msg.sender, _amount - _toRecipient); // dust back to RelaySwaps
    }

    /// @dev B2 gas swap: pulls `_pull` ERC20 input from msg.sender (RelaySwaps) and sends
    ///   `_ethOut` wei back to it. `_ethOut` may be < `_pull` to simulate an under-delivering
    ///   gas swap (drives RelaySwaps_GasSwapInsufficient). `_pull` above the bounded approval
    ///   makes the transferFrom underflow-revert (drives the approval-bound test).
    function gasSwapToSender(address _inputToken, uint256 _pull, uint256 _ethOut) external {
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _pull);
        (bool _ok,) = msg.sender.call{value: _ethOut}("");
        require(_ok);
    }

    /// @dev B2 main leg: accepts the native fee as msg.value, pulls `_pull` ERC20 input,
    ///   and optionally refunds `_ethRefund` wei to msg.sender (simulates a Stargate native
    ///   refund landing at RelaySwaps).
    function reshieldBridge(address _inputToken, uint256 _pull, uint256 _ethRefund) external payable {
        MockERC20(_inputToken).transferFrom(msg.sender, address(this), _pull);
        if (_ethRefund > 0) {
            (bool _ok,) = msg.sender.call{value: _ethRefund}("");
            require(_ok);
        }
    }

    receive() external payable {}
}

/// @notice Mock verifier that always returns true
contract MockVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[4] calldata)
        external
        pure
        returns (bool)
    {
        return true;
    }
}

/// @notice Malicious swap router that attempts to re-enter RelaySwaps.execute() during a swap callback.
///   Used to verify the nonReentrant guard blocks the inner call.
contract ReentrantRouter {
    address private _target;
    bytes private _calldata;
    bool private _reentryAttempted;
    bool private _innerBlocked;
    bytes4 private _innerSelector;

    function configure(address target, bytes calldata data) external {
        _target = target;
        _calldata = data;
    }

    function swap(address _in, address _out, uint256 _amount, address _recipient) external {
        MockERC20(_in).transferFrom(msg.sender, address(this), _amount);
        MockERC20(_out).mint(_recipient, _amount);
        // Attempt reentry into RelaySwaps.execute()
        _reentryAttempted = true;
        (bool ok, bytes memory ret) = _target.call(_calldata);
        if (!ok) {
            _innerBlocked = true;
            if (ret.length >= 4) {
                bytes4 sel;
                assembly { sel := mload(add(ret, 0x20)) }
                _innerSelector = sel;
            }
        }
    }

    function reentryAttempted() external view returns (bool) { return _reentryAttempted; }
    function innerBlocked() external view returns (bool) { return _innerBlocked; }
    function innerSelector() external view returns (bytes4) { return _innerSelector; }

    receive() external payable {}
}

contract RelaySwapsTest is Test {
    MockPool internal pool;
    RelaySwaps internal relaySwaps;
    MockSwapper internal swapper;
    MockVerifier internal verifier;
    MockERC20 internal usdc;
    MockERC20 internal usdt;

    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address internal relayer = makeAddr("relayer");
    address internal recipient = makeAddr("recipient");
    address internal feeRecipient = makeAddr("feeRecipient");
    address internal upgraderRole = makeAddr("upgraderRole");

    function setUp() public virtual {
        pool = new MockPool();
        verifier = new MockVerifier();
        usdc = new MockERC20("USD Coin", "USDC", 6);
        usdt = new MockERC20("Tether", "USDT", 6);
        swapper = new MockSwapper();

        relaySwaps = new RelaySwaps(
            IPool(address(pool)),
            IEntrypoint(address(pool)),
            upgraderRole,
            address(swapper)
        );

        pool.setDepositVerifier(address(verifier));
        pool.setAssetConfig(address(usdc), true, 0, 0, 0, 0);
        pool.setAssetConfig(address(usdt), true, 0, 0, 0, 0);
        pool.setAssetConfig(NATIVE_ASSET, true, 0, 0, 0, 0);

        // Fund swapper with ETH for ERC20→ETH swap tests
        vm.deal(address(swapper), 100 ether);
    }

    /*///////////////////////////////////////////////////////////////
                          HAPPY PATH
    ///////////////////////////////////////////////////////////////*/

    function test_Execute() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _withdrawAmount);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
        assertEq(usdt.balanceOf(address(relaySwaps)), 0);
        assertEq(usdc.balanceOf(address(pool)), 0);
    }

    function test_ExecuteWithRelayFee() public {
        uint256 _withdrawAmount = 1_000_000;
        uint256 _feeAmount = 2_500;
        uint256 _netAmount = _withdrawAmount - _feeAmount;

        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _netAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = _feeAmount;
        _routing.minOutputAmount = _netAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _netAmount);
        assertEq(usdc.balanceOf(feeRecipient), _feeAmount);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    function test_ExecuteWithNativeGas() public {
        uint256 _withdrawAmount = 1_000_000;
        uint256 _nativeGas = 0.001 ether;

        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = _nativeGas;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.deal(relayer, _nativeGas);
        vm.prank(relayer);
        relaySwaps.execute{value: _nativeGas}(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _withdrawAmount);
        assertEq(recipient.balance, _nativeGas);
    }

    function test_ExecuteEmitsEvent() public {
        uint256 _withdrawAmount = 1_000_000;
        uint256 _feeAmount = 1_000;

        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount - _feeAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = _feeAmount;
        _routing.minOutputAmount = _withdrawAmount - _feeAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.expectEmit();
        emit RelaySwaps.Executed(
            address(usdc), address(usdt), _withdrawAmount - _feeAmount, feeRecipient, _feeAmount
        );

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    /*///////////////////////////////////////////////////////////////
                        NATIVE ETH TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_ExecuteNativeETHInput() public {
        uint256 _withdrawAmount = 1 ether;
        vm.deal(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapETHToERC20, (address(usdt), recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, NATIVE_ASSET);
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _withdrawAmount);
        assertEq(address(relaySwaps).balance, 0);
    }

    function test_ExecuteNativeETHOutput() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapERC20ToETH, (address(usdc), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = NATIVE_ASSET;
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(recipient.balance, _withdrawAmount);
        assertEq(address(relaySwaps).balance, 0);
    }

    function test_ExecuteNativeETHInputWithFee() public {
        uint256 _withdrawAmount = 1 ether;
        uint256 _feeAmount = 0.01 ether;
        uint256 _netAmount = _withdrawAmount - _feeAmount;

        vm.deal(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapETHToERC20, (address(usdt), recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, NATIVE_ASSET);
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = _feeAmount;
        _routing.minOutputAmount = _netAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _netAmount);
        assertEq(feeRecipient.balance, _feeAmount);
    }

    /*///////////////////////////////////////////////////////////////
      Ownership tests
    ///////////////////////////////////////////////////////////////*/

    function test_ChangingApprovedRouters() public {
        vm.prank(makeAddr("upgraderRole"));
        relaySwaps.approveRouter(makeAddr("pumpkin"));

        bool routers = relaySwaps.approvedRouters(makeAddr("pumpkin"));

        assertEq(routers, true);
    }

    function test_RevertWhen_NonOwnerAddsRouter() public {
        vm.expectRevert();
        relaySwaps.approveRouter(makeAddr("pumpkin"));

        bool routers = relaySwaps.approvedRouters(makeAddr("pumpkin"));

        assertEq(routers, false);
    }

    /// @dev S-3: renounceOwnership() is disabled — the owner cannot renounce and permanently
    ///   freeze the router allowlist (which would leave no way to remove a compromised router).
    function test_RevertWhen_RenounceOwnership() public {
        vm.prank(upgraderRole); // current owner
        vm.expectRevert(RelaySwaps.RelaySwaps_RenounceDisabled.selector);
        relaySwaps.renounceOwnership();

        // Ownership is unchanged
        assertEq(relaySwaps.owner(), upgraderRole);
    }

    /// @dev H3: approvalAddress (which receives the scoped ERC20 approval) must be
    ///   allowlisted too, not just swapTarget. A non-allowlisted approvalAddress reverts.
    function test_RevertWhen_InvalidApprovalAddress() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = makeAddr("unvettedProxy");
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_InvalidApprovalAddress.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    /// @dev H3: a distinct but allowlisted approvalAddress (e.g. LiFi v4's ERC20Proxy,
    ///   separate from the Diamond swapTarget) passes the guard. Native input path so the
    ///   swap completes without needing the approval routed through the mock.
    function test_ExecuteWithDistinctAllowlistedApprovalAddress() public {
        address _erc20Proxy = makeAddr("erc20Proxy");
        vm.prank(upgraderRole);
        relaySwaps.approveRouter(_erc20Proxy);

        uint256 _withdrawAmount = 1 ether;
        vm.deal(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapETHToERC20, (address(usdt), recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, NATIVE_ASSET);
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = _erc20Proxy;
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(recipient), _withdrawAmount);
    }

    /*///////////////////////////////////////////////////////////////
                        DUST SWEEP TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_SweepInputTokenDust() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        // swapWithDust only consumes 90% — leaves 10% as input dust
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapWithDust, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        // Input dust swept to dustRecipient (= recipient)
        uint256 _expectedDust = _withdrawAmount / 10; // 10% not consumed
        assertEq(usdc.balanceOf(recipient), _expectedDust);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    function test_SweepETHDust() public {
        uint256 _withdrawAmount = 1 ether;
        uint256 _expectedDust = _withdrawAmount / 10; // 10% refunded by swapper

        vm.deal(address(pool), _withdrawAmount);

        // swapETHToERC20WithRefund consumes 90%, refunds 10% ETH to caller
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapETHToERC20WithRefund, (address(usdt), recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, NATIVE_ASSET);
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        // ETH refund dust swept to dustRecipient (= recipient) via balance delta
        assertEq(recipient.balance, _expectedDust);
        assertEq(address(relaySwaps).balance, 0);
    }

    /// @dev G3: output-token dust sweep must move ONLY this execution's leftover (the delta),
    ///   never a pre-existing balance from a parallel execution. Pre-fund the contract with BOTH
    ///   input and output tokens, run execute, and assert the pre-existing balances survive while
    ///   only the fresh dust is swept. A full-drain regression would fail this test (the existing
    ///   zero-balance sweep tests would not).
    function test_SweepOutputTokenDust_DeltaOnly_PreservesPreExisting() public {
        uint256 _withdrawAmount = 1_000_000;
        uint256 _preExistingInput = 500_000; // parallel execution's in-flight input
        uint256 _preExistingOutput = 777; // parallel execution's in-flight output
        address _dustSink = makeAddr("dustSink");

        usdc.mint(address(pool), _withdrawAmount);
        // Pre-fund the router as if a parallel execution left balances mid-flight
        usdc.mint(address(relaySwaps), _preExistingInput);
        usdt.mint(address(relaySwaps), _preExistingOutput);

        // swapWithOutputDust pulls full input, sends 90% output to recipient, leaves 10%
        // (100_000) output-token dust on the router.
        bytes memory _swapCalldata =
            abi.encodeCall(MockSwapper.swapWithOutputDust, (address(usdc), address(usdt), _withdrawAmount, recipient));

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        IRelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultIRelaySwapsRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = _dustSink;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        uint256 _expectedOutputDust = _withdrawAmount / 10; // 100_000

        // Only this execution's output dust delta is swept to dustRecipient
        assertEq(usdt.balanceOf(_dustSink), _expectedOutputDust, "output dust delta swept");
        // Swap output delivered to recipient
        assertEq(usdt.balanceOf(recipient), _withdrawAmount - _expectedOutputDust, "swap output to recipient");
        // Pre-existing OUTPUT balance is preserved — NOT drained
        assertEq(usdt.balanceOf(address(relaySwaps)), _preExistingOutput, "pre-existing output preserved");
        // Pre-existing INPUT balance is preserved — this execution's input fully consumed
        assertEq(usdc.balanceOf(address(relaySwaps)), _preExistingInput, "pre-existing input preserved");
        // Nothing wrongly swept to dustSink for the input token
        assertEq(usdc.balanceOf(_dustSink), 0, "no input swept");
    }

    /*///////////////////////////////////////////////////////////////
                        APPROVAL TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_ApprovalResetAfterSwap() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        // Approval reset to 0 after swap
        assertEq(usdc.allowance(address(relaySwaps), address(swapper)), 0);
    }

    /*///////////////////////////////////////////////////////////////
                        REVERT TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ZeroWithdrawal() public {
        bytes memory _swapCalldata = "";
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(0, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroWithdrawal.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_FeeExceedsWithdrawal() public {
        uint256 _withdrawAmount = 1_000_000;
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = _withdrawAmount + 1;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_FeeExceedsWithdrawal.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_FeeExceedsMax() public {
        uint256 _withdrawAmount = 1_000_000;
        uint256 _maxRelayFee = 1_000;
        bytes memory _swapCalldata = "";

        // Set maxRelayFee on asset config
        pool.setAssetConfig(address(usdc), true, 0, 0, _maxRelayFee, 0);

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = feeRecipient;
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = _maxRelayFee + 1;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_FeeExceedsMax.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_NativeGasMismatch() public {
        uint256 _withdrawAmount = 1_000_000;
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0.001 ether;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_NativeGasMismatch.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_SwapFails() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        // Invalid calldata that will fail on swapper
        bytes memory _swapCalldata = hex"deadbeef";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_ZeroFeeRecipientWithFee() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 1_000;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroFeeRecipient.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_InsufficientOutput() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        // MockSwapper.swap delivers 1:1, so _withdrawAmount output
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount + 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_InsufficientOutput.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_InsufficientOutputNativeETH() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        // Swap delivers _withdrawAmount ETH to recipient
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swapERC20ToETH, (address(usdc), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = NATIVE_ASSET;
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount + 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_InsufficientOutput.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_MinOutputWithoutRecipient() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        address _externalTarget = makeAddr("entrypoint");
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, _externalTarget)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = address(0);
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = _externalTarget;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 1;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.expectRevert(RelaySwaps.RelaySwaps_MinOutputWithoutRecipient.selector);
        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    /// @dev F-960: a same-chain swap with recipient != address(0) and minOutputAmount = 0
    ///   disables the balance-delta guard entirely — reject it on-chain.
    function test_RevertWhen_ZeroMinOutputWithRecipient() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata =
            abi.encodeCall(MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient));

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        IRelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultIRelaySwapsRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroMinOutputWithRecipient.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_ExecuteWithZeroRecipient() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        // Swap sends output to some external address (simulating LiFi → Entrypoint deposit
        // or a cross-chain bridge leg) — contract verifies nothing locally.
        address _externalTarget = makeAddr("entrypoint");
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, _externalTarget)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = address(0);
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = _externalTarget;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertEq(usdt.balanceOf(_externalTarget), _withdrawAmount);
    }

    function test_RevertWhen_NativeGasWithoutRecipient() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        address _externalTarget = makeAddr("entrypoint");
        bytes memory _swapCalldata = abi.encodeCall(
            MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, _externalTarget)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = address(0);
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = _externalTarget;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 1 ether;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.deal(relayer, 1 ether);
        vm.expectRevert(RelaySwaps.RelaySwaps_NativeGasWithoutRecipient.selector);
        vm.prank(relayer);
        relaySwaps.execute{value: 1 ether}(_proof, _params, _noteData);
    }

    function test_RevertWhen_ZeroConstructorArgs() public {
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroPool.selector);
        new RelaySwaps(IPool(address(0)), IEntrypoint(address(pool)), upgraderRole, makeAddr("swap"));

        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroEntrypoint.selector);
        new RelaySwaps(IPool(address(pool)), IEntrypoint(address(0)), upgraderRole, makeAddr("swap"));
    }

    /*///////////////////////////////////////////////////////////////
                        RECEIVE TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_ReceiveETHFromPool() public {
        vm.deal(address(pool), 1 ether);
        vm.prank(address(pool));
        (bool _ok,) = address(relaySwaps).call{value: 1 ether}("");
        assertTrue(_ok);
    }

    function test_ReceiveETHFromAnyone() public {
        address _random = makeAddr("random");
        vm.deal(_random, 1 ether);
        vm.prank(_random);
        (bool _ok,) = address(relaySwaps).call{value: 1 ether}("");
        assertTrue(_ok);
    }

    /*///////////////////////////////////////////////////////////////
                    SWAP TARGET VALIDATION TESTS
    ///////////////////////////////////////////////////////////////*/

    function test_RevertWhen_ZeroApprovalAddress() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(0);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroApprovalAddress.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_ZeroDustRecipient() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = address(0);
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroDustRecipient.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_ZeroSwapTarget() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(0);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_ZeroSwapTarget.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_SwapTargetIsSelf() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(relaySwaps);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_InvalidSwapTarget.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_SwapTargetIsPool() public {
        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);
        bytes memory _swapCalldata = "";

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(pool);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_InvalidSwapTarget.selector);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    function test_RevertWhen_CalldataIsTampered() public {
        uint256 _withdrawAmount = 1_000_001;
        uint256 _tamperedAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata = abi.encodeCall(
                                                    MockSwapper.swap, (address(usdc), address(usdt), _withdrawAmount, recipient)
        );

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_tamperedAmount, address(usdc));
        RelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultRouting();
        _routing.swapTarget = address(swapper);
        _routing.approvalAddress = address(swapper);
        _routing.outputToken = address(usdt);
        _routing.recipient = recipient;
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = _withdrawAmount;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);
    }

    /*///////////////////////////////////////////////////////////////
                        REENTRANCY TESTS
    ///////////////////////////////////////////////////////////////*/

    /// @dev G6: execute() is nonReentrant. A malicious (but allowlisted) router that re-enters
    ///   execute() during its swap callback must be blocked by the guard. The router records the
    ///   inner call's outcome; we assert the reentrant call was rejected with solady's
    ///   Reentrancy() selector (0xab143c06) while the outer call still completes.
    function test_ReentrancyGuardBlocksMaliciousRouter() public {
        ReentrantRouter _evil = new ReentrantRouter();

        // Allowlist the malicious router (attack requires it to already be approved)
        vm.prank(upgraderRole);
        relaySwaps.approveRouter(address(_evil));

        uint256 _withdrawAmount = 1_000_000;
        usdc.mint(address(pool), _withdrawAmount);

        bytes memory _swapCalldata =
            abi.encodeCall(ReentrantRouter.swap, (address(usdc), address(usdt), _withdrawAmount, recipient));

        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdrawAmount, address(usdc));
        IRelaySwaps.SwapRouting memory _routing = SwapRoutingBuilder.defaultIRelaySwapsRouting();
        _routing.swapTarget = address(_evil);
        _routing.approvalAddress = address(_evil);
        _routing.outputToken = address(usdt);
        _routing.recipient = address(0);
        _routing.feeRecipient = address(0);
        _routing.fallbackAddress = address(0);
        _routing.dustRecipient = recipient;
        _routing.feeAmount = 0;
        _routing.minOutputAmount = 0;
        _routing.nativeGas = 0;
        _routing.swapValue = 0;
        _routing.gasSwapMaxInput = 0;
        _routing.gasSwapCalldata = "";
        _routing.swapCalldata = _swapCalldata;
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _routing);
        IPool.NoteData[] memory _noteData = new IPool.NoteData[](0);

        // The router replays this exact call to attempt reentry
        _evil.configure(address(relaySwaps), abi.encodeCall(RelaySwaps.execute, (_proof, _params, _noteData)));

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, _noteData);

        assertTrue(_evil.reentryAttempted(), "reentry was attempted");
        assertTrue(_evil.innerBlocked(), "reentrant call was blocked by the guard");
        assertEq(_evil.innerSelector(), bytes4(0xab143c06), "blocked with solady Reentrancy() selector");
    }

    /*///////////////////////////////////////////////////////////////
                          HELPERS
    ///////////////////////////////////////////////////////////////*/

    /*///////////////////////////////////////////////////////////////
                    B2 — SELF-FUNDED BRIDGE msg.value
    ///////////////////////////////////////////////////////////////*/

    /// @dev Builds a reshield (recipient == address(0)) routing whose step-9.5 gas swap
    ///   pulls `_gasIn` USDC and yields `_ethOut` wei, then a main leg that pulls the
    ///   remaining USDC, forwards `_swapValue` as msg.value, and refunds `_ethRefund` wei.
    function _b2Routing(
        uint256 _withdraw,
        uint256 _fee,
        uint256 _swapValue,
        uint256 _gasIn,
        uint256 _gasMaxInput,
        uint256 _gasEthOut,
        uint256 _ethRefund
    ) internal view returns (RelaySwaps.SwapRouting memory _r) {
        _r = SwapRoutingBuilder.defaultRouting();
        _r.swapTarget = address(swapper);
        _r.approvalAddress = address(swapper);
        _r.outputToken = address(usdc);
        _r.recipient = address(0);
        _r.feeRecipient = _fee > 0 ? feeRecipient : address(0);
        _r.fallbackAddress = address(0);
        _r.dustRecipient = relayer;
        _r.feeAmount = _fee;
        _r.minOutputAmount = 0;
        _r.nativeGas = 0;
        _r.swapValue = _swapValue;
        _r.gasSwapMaxInput = _gasMaxInput;
        _r.gasSwapCalldata = abi.encodeCall(
                MockSwapper.gasSwapToSender, (address(usdc), _gasIn, _gasEthOut)
            );
        _r.swapCalldata = abi.encodeCall(
                MockSwapper.reshieldBridge,
                (address(usdc), _withdraw - _fee - _gasIn, _ethRefund)
            );
    }

    function test_B2_GasSwap_HappyPath() public {
        uint256 _withdraw = 1_000_000;
        uint256 _fee = 2_000;
        uint256 _swapValue = 0.001 ether;
        usdc.mint(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r =
            _b2Routing(_withdraw, _fee, _swapValue, 5_000, 6_000, 0.0012 ether, 0);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(usdc.balanceOf(feeRecipient), _fee, "fee paid");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "no input dust");
        assertEq(address(relaySwaps).balance, 0, "no eth left in contract");
        // gas swap yielded 0.0012, main leg consumed 0.001 as msg.value -> 0.0002 overshoot
        assertEq(relayer.balance, 0.0002 ether, "gas-swap overshoot swept to dustRecipient");
    }

    function test_B2_GasSwap_SweepsStargateRefund() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        // gas swap yields exactly swapValue; main leg refunds 0.0003 eth
        RelaySwaps.SwapRouting memory _r =
            _b2Routing(_withdraw, 0, 0.001 ether, 5_000, 6_000, 0.001 ether, 0.0003 ether);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(address(relaySwaps).balance, 0, "refund not stranded in contract");
        assertEq(relayer.balance, 0.0003 ether, "stargate refund swept to dustRecipient");
    }

    function test_B2_RevertWhen_GasSwapInsufficient() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        // gas swap yields 0.0009 < swapValue 0.001
        RelaySwaps.SwapRouting memory _r =
            _b2Routing(_withdraw, 0, 0.001 ether, 5_000, 6_000, 0.0009 ether, 0);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_GasSwapInsufficient.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(address(relaySwaps).balance, 0, "no eth left after revert");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0, "no tokens left after revert");
        assertEq(usdc.balanceOf(address(pool)), _withdraw, "pool funds untouched");
    }

    function test_B2_RevertWhen_GasSwapExceedsMaxInput() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        // gas swap tries to pull 5_000 but the approval is bounded to 4_000
        RelaySwaps.SwapRouting memory _r =
            _b2Routing(_withdraw, 0, 0.001 ether, 5_000, 4_000, 0.0012 ether, 0);
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_SwapFailed.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    function test_B2_RevertWhen_NativeInputWithSwapValue() public {
        uint256 _withdraw = 1 ether;
        vm.deal(address(pool), _withdraw);

        RelaySwaps.SwapRouting memory _r =
            _b2Routing(_withdraw, 0, 0.001 ether, 0, 0, 0, 0);
        _r.outputToken = NATIVE_ASSET;
        _r.swapCalldata = abi.encodeCall(MockSwapper.reshieldBridge, (NATIVE_ASSET, 0, 0));
        _r.gasSwapCalldata = "";
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, NATIVE_ASSET);
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        vm.expectRevert(RelaySwaps.RelaySwaps_GasSwapNativeInput.selector);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));
    }

    function test_B2_SwapValueZero_SkipsGasSwapEntirely() public {
        uint256 _withdraw = 1_000_000;
        usdc.mint(address(pool), _withdraw);

        // swapValue 0, empty gasSwapCalldata: a plain reshield, no ETH anywhere.
        RelaySwaps.SwapRouting memory _r = SwapRoutingBuilder.defaultRouting();
        _r.swapTarget = address(swapper);
        _r.approvalAddress = address(swapper);
        _r.outputToken = address(usdc);
        _r.recipient = address(0);
        _r.feeRecipient = address(0);
        _r.fallbackAddress = address(0);
        _r.dustRecipient = relayer;
        _r.feeAmount = 0;
        _r.minOutputAmount = 0;
        _r.nativeGas = 0;
        _r.swapValue = 0;
        _r.gasSwapMaxInput = 0;
        _r.gasSwapCalldata = "";
        _r.swapCalldata = abi.encodeCall(MockSwapper.reshieldBridge, (address(usdc), _withdraw, 0));
        ProofLibV2.TransactProof memory _proof = _buildTransactProof(_withdraw, address(usdc));
        IPool.TransactParams memory _params = _buildTransactParams(address(relaySwaps), _r);

        vm.prank(relayer);
        relaySwaps.execute(_proof, _params, new IPool.NoteData[](0));

        assertEq(address(relaySwaps).balance, 0);
        assertEq(relayer.balance, 0, "no eth movement on the non-B2 path");
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    function _buildTransactProof(uint256 _amountOut, address _tokenIdOut)
        internal
        pure
        returns (ProofLibV2.TransactProof memory _proof)
    {
        _proof.pubSignals = new uint256[][](8);
        for (uint256 _i = 0; _i < 8; _i++) {
            _proof.pubSignals[_i] = new uint256[](1);
        }
        _proof.pubSignals[5][0] = _amountOut;
        _proof.pubSignals[6][0] = uint256(uint160(_tokenIdOut));
    }

    function _buildTransactParams(address _processor, RelaySwaps.SwapRouting memory _routing)
        internal
        pure
        returns (IPool.TransactParams memory _params)
    {
        _params.processor = _processor;
        _params.data = abi.encode(_routing);
    }

    function _buildTransactParams(address _processor, IRelaySwaps.SwapRouting memory _routing)
        internal
        pure
        returns (IPool.TransactParams memory _params)
    {
        _params.processor = _processor;
        _params.data = abi.encode(_routing);
    }
}
