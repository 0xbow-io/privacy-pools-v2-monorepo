// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockPool} from "../src/MockPool.sol";
import {RelaySwaps, IPool, IEntrypoint} from "../src/RelaySwaps.sol";
import {SwapRoutingBuilder} from "./helpers/SwapRoutingBuilder.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ProofLibV2} from 'main_contracts_libs/ProofLibV2.sol';

// Minimal ERC20 (duplicated from RelaySwaps.t.sol to keep this file self-contained)
contract RescueMockERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint8 public decimals = 6;

    function mint(address _to, uint256 _amount) external { balanceOf[_to] += _amount; }

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

// Minimal swap target — consumes the full input and mints output 1:1
contract RescueMockSwapper {
    function swap(address _in, address _out, uint256 _amount, address _recipient) external {
        RescueMockERC20(_in).transferFrom(msg.sender, address(this), _amount);
        RescueMockERC20(_out).mint(_recipient, _amount);
    }

    receive() external payable {}
}

contract RelaySwapsRescueTest is Test {
    address internal constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    MockPool internal pool;
    RelaySwaps internal relaySwaps;
    RescueMockSwapper internal swapper;
    RescueMockERC20 internal usdc;
    RescueMockERC20 internal usdt;

    address internal owner = makeAddr("owner");
    address internal attacker = makeAddr("attacker");
    address internal rescueTarget = makeAddr("rescueTarget");
    address internal recipient = makeAddr("recipient");

    function setUp() public {
        pool = new MockPool();
        swapper = new RescueMockSwapper();
        usdc = new RescueMockERC20();
        usdt = new RescueMockERC20();

        relaySwaps = new RelaySwaps(
            IPool(address(pool)),
            IEntrypoint(address(pool)),
            owner,
            address(swapper)
        );

        pool.setAssetConfig(address(usdc), true, 0, 0, 0, 0);
        pool.setAssetConfig(address(usdt), true, 0, 0, 0, 0);
        pool.setAssetConfig(NATIVE_ASSET, true, 0, 0, 0, 0);
        vm.deal(address(swapper), 100 ether);
    }

    // -------------------------------------------------------------------------
    // rescue() — ETH
    // -------------------------------------------------------------------------

    function test_RescueETH() public {
        uint256 _stranded = 1 ether;
        vm.deal(address(relaySwaps), _stranded);

        vm.expectEmit(true, true, false, true);
        emit RelaySwaps.Rescued(NATIVE_ASSET, rescueTarget, _stranded);

        vm.prank(owner);
        relaySwaps.rescue(NATIVE_ASSET, rescueTarget, _stranded);

        assertEq(rescueTarget.balance, _stranded);
        assertEq(address(relaySwaps).balance, 0);
    }

    // -------------------------------------------------------------------------
    // rescue() — ERC20
    // -------------------------------------------------------------------------

    function test_RescueERC20() public {
        uint256 _stranded = 500_000;
        usdc.mint(address(relaySwaps), _stranded);

        vm.expectEmit(true, true, false, true);
        emit RelaySwaps.Rescued(address(usdc), rescueTarget, _stranded);

        vm.prank(owner);
        relaySwaps.rescue(address(usdc), rescueTarget, _stranded);

        assertEq(usdc.balanceOf(rescueTarget), _stranded);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    // -------------------------------------------------------------------------
    // rescue() — reverts for _to == address(0)
    // -------------------------------------------------------------------------

    function test_RevertWhen_RescueToZeroAddress() public {
        usdc.mint(address(relaySwaps), 1_000);
        vm.prank(owner);
        vm.expectRevert();
        relaySwaps.rescue(address(usdc), address(0), 1_000);
    }

    // -------------------------------------------------------------------------
    // rescue() — reverts for non-owner
    // -------------------------------------------------------------------------

    function test_RevertWhen_RescueCalledByNonOwner() public {
        usdc.mint(address(relaySwaps), 1_000);
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        relaySwaps.rescue(address(usdc), attacker, 1_000);
    }

    // -------------------------------------------------------------------------
    // Pre-existing balance is NOT swept by execute() (delta-only baseline)
    // -------------------------------------------------------------------------

    function test_StrandedBalanceUntouchedByExecuteDeltaSweep() public {
        uint256 _stranded = 500_000;
        uint256 _withdrawal = 1_000_000;

        // Strand USDC before any execute() — this becomes part of _inputBefore snapshot
        usdc.mint(address(relaySwaps), _stranded);
        // Pool funds for the legitimate withdrawal
        usdc.mint(address(pool), _withdrawal);

        bytes memory _swapCalldata =
            abi.encodeCall(RescueMockSwapper.swap, (address(usdc), address(usdt), _withdrawal, recipient));

        vm.prank(makeAddr("relayer"));
        relaySwaps.execute(
            _buildProof(_withdrawal, address(usdc)),
            _buildParams(_buildRouting(_swapCalldata)),
            new IPool.NoteData[](0)
        );

        // Legitimate withdrawal output delivered to recipient
        assertEq(usdt.balanceOf(recipient), _withdrawal);
        // Stranded USDC was NOT swept — delta sweep only moves intra-call arrivals
        assertEq(usdc.balanceOf(address(relaySwaps)), _stranded);
    }

    // -------------------------------------------------------------------------
    // rescue() after execute() drains only the stranded portion
    // -------------------------------------------------------------------------

    function test_RescueAfterExecuteDrainsOnlyStrandedPortion() public {
        uint256 _stranded = 500_000;
        uint256 _withdrawal = 1_000_000;

        usdc.mint(address(relaySwaps), _stranded);
        usdc.mint(address(pool), _withdrawal);

        bytes memory _swapCalldata =
            abi.encodeCall(RescueMockSwapper.swap, (address(usdc), address(usdt), _withdrawal, recipient));

        vm.prank(makeAddr("relayer"));
        relaySwaps.execute(
            _buildProof(_withdrawal, address(usdc)),
            _buildParams(_buildRouting(_swapCalldata)),
            new IPool.NoteData[](0)
        );

        // Stranded USDC is still locked — rescue() is the only exit path
        assertEq(usdc.balanceOf(address(relaySwaps)), _stranded);

        vm.prank(owner);
        relaySwaps.rescue(address(usdc), rescueTarget, _stranded);

        assertEq(usdc.balanceOf(rescueTarget), _stranded);
        assertEq(usdc.balanceOf(address(relaySwaps)), 0);
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _buildProof(uint256 _amount, address _token)
        internal pure returns (ProofLibV2.TransactProof memory _proof)
    {
        _proof.pubSignals = new uint256[][](8);
        for (uint256 _i = 0; _i < 8; _i++) {
            _proof.pubSignals[_i] = new uint256[](1);
        }
        _proof.pubSignals[5][0] = _amount;
        _proof.pubSignals[6][0] = uint256(uint160(_token));
    }

    function _buildRouting(bytes memory _swapCalldata)
        internal view returns (RelaySwaps.SwapRouting memory)
    {
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
        return _routing;
    }

    function _buildParams(RelaySwaps.SwapRouting memory _routing)
        internal view returns (IPool.TransactParams memory _params)
    {
        _params.processor = address(relaySwaps);
        _params.data = abi.encode(_routing);
    }
}
