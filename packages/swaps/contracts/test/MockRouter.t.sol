// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {Test} from "forge-std/Test.sol";
import {MockRouter} from "../src/MockRouter.sol";
import {MockERC20} from "../src/MockERC20.sol";

contract MockRouterTest is Test {
    MockRouter internal _router;
    MockERC20 internal _token;

    function setUp() public {
        _router = new MockRouter();
        _token = new MockERC20("Mock USD", "mUSD", 18);
    }

    function test_ExtractGenericSwapParametersRoundTripsRecipient() public {
        address _recipient = makeAddr("recipient");
        bytes memory _calldataBlob =
            abi.encodeCall(MockRouter.swapETHToERC20, (address(_token), _recipient));

        (address _sendingAssetId, uint256 _amount, address _receiver, address _receivingAssetId, uint256 _receivingAmount) =
            _router.extractGenericSwapParameters(_calldataBlob);

        assertEq(_receiver, _recipient, "receiver (index [2]) must round-trip the swap's recipient");
        assertEq(_receivingAssetId, address(_token), "receivingAssetId must round-trip the output token");
        // Hardcoded rather than calling _router.NATIVE_ASSET() — this exact solc 0.8.32 build
        // hits an internal compiler error on an external getter call to a public constant
        // combined with this file's other test functions (reproduced in isolation; not a
        // logic issue). Same literal as MockRouter.NATIVE_ASSET's own definition.
        assertEq(_sendingAssetId, 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE, "sendingAssetId must be the native sentinel");
        assertEq(_amount, 0);
        assertEq(_receivingAmount, 0);
    }

    function test_SwapETHToERC20MintsOutputToRecipientDirectly() public {
        address _recipient = makeAddr("recipient");
        _router.swapETHToERC20{value: 1 ether}(address(_token), _recipient);
        assertEq(_token.balanceOf(_recipient), 1 ether);
    }

    function test_SwapAndCallPullsInputAndForwardsEmbeddedCall() public {
        address _depositor = makeAddr("depositor");
        _token.mint(_depositor, 100 ether);
        vm.deal(address(_router), 100 ether);
        uint256 _balanceBefore = address(this).balance;

        vm.prank(_depositor);
        _token.approve(address(_router), 100 ether);

        vm.prank(_depositor);
        _router.swapAndCall(address(_token), 100 ether, address(this), 100 ether, "");

        assertEq(_token.balanceOf(address(_router)), 100 ether, "router should have pulled the input token");
        assertEq(
            address(this).balance - _balanceBefore, 100 ether, "embedded call should have forwarded the native value"
        );
    }

    function test_SwapERC20AndCallPullsInputMintsOutputAndApprovesTarget() public {
        address _depositor = makeAddr("depositor");
        MockERC20 _out = new MockERC20("Out", "OUT", 18);
        _token.mint(_depositor, 100 ether);

        vm.prank(_depositor);
        _token.approve(address(_router), 100 ether);

        vm.prank(_depositor);
        _router.swapERC20AndCall(address(_token), 100 ether, address(_out), 40 ether, address(this), "");

        assertEq(_token.balanceOf(address(_router)), 100 ether, "router should have pulled the input token");
        assertEq(_out.balanceOf(address(_router)), 40 ether, "router should hold the minted output");
        assertEq(_out.allowance(address(_router), address(this)), 40 ether, "target should be approved for the output");
    }

    receive() external payable {}
}
