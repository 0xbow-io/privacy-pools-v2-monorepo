// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

interface IERC20Minimal {
    function approve(address _spender, uint256 _amount) external returns (bool);
    function transfer(address _to, uint256 _amount) external returns (bool);
    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool);
    function balanceOf(address _account) external view returns (uint256);
}

/// @title MockERC20Proxy
/// @notice Stands in for LiFi's ERC20Proxy: the one address a user approves, from which only an
///   authorized caller (the Executor) can pull. Like the real proxy it has no `erc20Proxy()`, so
///   the SDK's executor screening does not mistake it for an Executor.
contract MockERC20Proxy {
    address public immutable owner;
    mapping(address => bool) public authorizedCallers;

    constructor(address _owner) {
        owner = _owner;
    }

    function setAuthorizedCaller(address _caller, bool _authorized) external {
        require(msg.sender == owner, "MockERC20Proxy: not owner");
        authorizedCallers[_caller] = _authorized;
    }

    function transferFrom(address _token, address _from, address _to, uint256 _amount) external {
        require(authorizedCallers[msg.sender], "MockERC20Proxy: unauthorized");
        IERC20Minimal(_token).transferFrom(_from, _to, _amount);
    }
}

/// @title MockLiFiExecutor
/// @notice Stands in for LiFi's Executor (`swapAndExecute`) for the evm-sdk e2e suite's native
///   swap-and-deposit: the SDK composes one Executor transaction that pulls the input token through
///   the ERC20Proxy, swaps it into native ETH (a MockRouter leg paying this contract), then calls
///   `Entrypoint.deposit` with exactly the deposit cost. Like the real Executor, it returns any
///   leftover input token and native ETH to `_receiver`, and answers `erc20Proxy()`, which is how
///   the SDK identifies an Executor on-chain. Only the shape the SDK sends is supported: LiFi's
///   native asset is `address(0)`, and every call's `fromAmount` is what it is sent or approved.
/// @dev Never deployed anywhere but the throwaway local anvil of packages/evm-sdk/e2e.
contract MockLiFiExecutor {
    struct SwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    address public immutable erc20Proxy;

    constructor(address _erc20Proxy) {
        erc20Proxy = _erc20Proxy;
    }

    function swapAndExecute(
        bytes32,
        SwapData[] calldata _swapData,
        address _transferredAssetId,
        address payable _receiver,
        uint256 _amount
    ) external payable {
        if (_transferredAssetId != address(0)) {
            MockERC20Proxy(erc20Proxy).transferFrom(_transferredAssetId, msg.sender, address(this), _amount);
        }

        for (uint256 i = 0; i < _swapData.length; i++) {
            SwapData calldata swap = _swapData[i];
            uint256 value;
            if (swap.sendingAssetId == address(0)) {
                value = swap.fromAmount;
            } else {
                IERC20Minimal(swap.sendingAssetId).approve(swap.approveTo, swap.fromAmount);
            }
            (bool ok, bytes memory result) = swap.callTo.call{value: value}(swap.callData);
            if (!ok) {
                assembly {
                    revert(add(result, 32), mload(result))
                }
            }
        }

        if (_transferredAssetId != address(0)) {
            uint256 leftover = IERC20Minimal(_transferredAssetId).balanceOf(address(this));
            if (leftover > 0) IERC20Minimal(_transferredAssetId).transfer(_receiver, leftover);
        }
        if (address(this).balance > 0) {
            (bool ok,) = _receiver.call{value: address(this).balance}("");
            require(ok, "MockLiFiExecutor: refund failed");
        }
    }

    receive() external payable {}
}
