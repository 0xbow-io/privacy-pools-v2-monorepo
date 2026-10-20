// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.32;

import {MockERC20} from "./MockERC20.sol";

interface IERC20Like {
    function transferFrom(address _from, address _to, uint256 _amount) external returns (bool);
}

/// @title MockRouter
/// @notice Stands in for the real LiFi Diamond in the evm-sdk e2e suite
///   (packages/evm-sdk/e2e/) — LiFi has no solver/liquidity on local or test chains, so a real
///   swap cannot execute against a local anvil fork. This mock implements the shapes the e2e
///   suite's fake quote providers target, plus `swapETHAndCall` (added for
///   wallet-app's ppv2-poc dev playground — the e2e suite's own swap-and-deposit fake quote
///   provider only exercises the ERC20-input direction), plus a same-signature stand-in for the
///   real Diamond's CalldataVerificationFacet.extractGenericSwapParameters, which
///   EvmSwapChainAdapter.extractEmbeddedRecipient() calls directly on `transactionTo` for the
///   same-chain withdraw-and-swap path.
/// @dev No simulated price anywhere — callers size amounts themselves (1:1 mock rate in the e2e
///   suite's fake quote providers). `swapETHToERC20`/`extractGenericSwapParameters` are used by
///   the withdraw-and-swap direction (native ETH in, MockERC20 out); `swapAndCall` by the
///   swap-and-deposit direction (MockERC20 in, native ETH forwarded into an embedded
///   Entrypoint.deposit call).
contract MockRouter {
    address public constant NATIVE_ASSET = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Withdraw-and-swap direction: accepts native ETH input, mints `_outputToken`
    ///   directly to `_recipient` — like LiFi with an explicit receiver. Paying the recipient
    ///   directly (not `msg.sender`, i.e. not RelaySwaps) is load-bearing:
    ///   RelaySwaps.execute()'s minOutputAmount guard measures the recipient's own balance delta.
    /// @param _outputToken The MockERC20 to mint.
    /// @param _recipient Receives `msg.value` of `_outputToken` (1:1 mock rate).
    function swapETHToERC20(address _outputToken, address _recipient) external payable {
        MockERC20(_outputToken).mint(_recipient, msg.value);
    }

    /// @notice Swap-and-deposit direction: pulls `_amount` of `_inputToken` from the caller (the
    ///   depositor, who approved this router beforehand), then forwards `_callValue` of this
    ///   router's own pre-funded native ETH balance into an embedded call —
    ///   `_dstCallTarget.call{value: _callValue}(_dstCallData)` — the real Entrypoint.deposit()
    ///   calldata. Simulates "the swap converted your ERC20 into native ETH" using a pre-funded
    ///   reserve instead of a real swap; the caller must fund this contract with at least
    ///   `_callValue` wei beforehand (see network.ts's `fundAddress(mockRouterAddress)`).
    /// @param _inputToken The MockERC20 being swapped from.
    /// @param _amount Amount of `_inputToken` to pull from the caller.
    /// @param _dstCallTarget The embedded call's target (the real Entrypoint).
    /// @param _callValue Native wei to forward with the embedded call.
    /// @param _dstCallData The embedded call's data (the real Entrypoint.deposit() calldata).
    function swapAndCall(
        address _inputToken,
        uint256 _amount,
        address _dstCallTarget,
        uint256 _callValue,
        bytes calldata _dstCallData
    ) external payable {
        IERC20Like(_inputToken).transferFrom(msg.sender, address(this), _amount);
        (bool _ok,) = _dstCallTarget.call{value: _callValue}(_dstCallData);
        require(_ok, "MockRouter: embedded call failed");
    }

    /// @notice Swap-and-deposit direction, ETH input (mirror image of `swapAndCall`, which is
    ///   ERC20 input, ETH forwarded): receives native ETH via `msg.value`, mints `msg.value` of
    ///   `_outputToken` to itself (1:1 mock rate, same mechanic as `swapETHToERC20`) to simulate
    ///   "the swap converted your ETH into `_outputToken`", approves `_dstCallTarget` to pull
    ///   that amount, then forwards the embedded call with no value —
    ///   `_dstCallTarget.call(_dstCallData)` — the real Entrypoint.deposit() calldata for an
    ///   ERC20 deposit token (which pulls `msg.value` of `_outputToken` from `msg.sender`, i.e.
    ///   this router, via `safeTransferFrom`).
    /// @param _outputToken The MockERC20 to mint and approve for the embedded call to pull.
    /// @param _dstCallTarget The embedded call's target (the real Entrypoint).
    /// @param _dstCallData The embedded call's data (the real Entrypoint.deposit() calldata).
    function swapETHAndCall(address _outputToken, address _dstCallTarget, bytes calldata _dstCallData)
        external
        payable
    {
        MockERC20(_outputToken).mint(address(this), msg.value);
        MockERC20(_outputToken).approve(_dstCallTarget, msg.value);
        (bool _ok,) = _dstCallTarget.call(_dstCallData);
        require(_ok, "MockRouter: embedded call failed");
    }

    /// @notice Cross-chain swap-and-deposit direction, ERC20 in / ERC20 out (the ERC20 sibling of
    ///   `swapAndCall`, which can only fund a NATIVE deposit): pulls `_amount` of `_inputToken`
    ///   from the caller, mints `_outputAmount` of `_outputToken` to itself (1:1 mock rate),
    ///   approves `_dstCallTarget` for it, then forwards the embedded call —
    ///   `_dstCallTarget.call(_dstCallData)` — the real Entrypoint.deposit() calldata for an ERC20
    ///   deposit token (which pulls the amount from `msg.sender`, i.e. this router). A plain
    ///   native-coin destination deposit can never land through the real aggregator (LiFi sends
    ///   its own guaranteed delivery as msg.value), so ERC20-out is the only shape worth mocking
    ///   for the cross-chain reshield path.
    /// @param _inputToken The MockERC20 being swapped from.
    /// @param _amount Amount of `_inputToken` to pull from the caller.
    /// @param _outputToken The MockERC20 to mint and approve for the embedded call to pull.
    /// @param _outputAmount Amount of `_outputToken` to mint and approve.
    /// @param _dstCallTarget The embedded call's target (the real Entrypoint).
    /// @param _dstCallData The embedded call's data (the real Entrypoint.deposit() calldata).
    function swapERC20AndCall(
        address _inputToken,
        uint256 _amount,
        address _outputToken,
        uint256 _outputAmount,
        address _dstCallTarget,
        bytes calldata _dstCallData
    ) external payable {
        IERC20Like(_inputToken).transferFrom(msg.sender, address(this), _amount);
        MockERC20(_outputToken).mint(address(this), _outputAmount);
        MockERC20(_outputToken).approve(_dstCallTarget, _outputAmount);
        (bool _ok,) = _dstCallTarget.call(_dstCallData);
        require(_ok, "MockRouter: embedded call failed");
    }

    /// @notice Same-chain ERC20-to-ERC20 direction: pulls `_amount` of `_inputToken` from the
    ///   caller, mints `_amount` of `_outputToken` directly to `_recipient` (1:1 mock rate) — the
    ///   yield-unwrap withdraw-and-swap fake quote provider targets this (unwrapped underlying
    ///   in, plain ERC20 out). Paying the recipient directly is load-bearing for the same reason
    ///   as `swapETHToERC20` above.
    /// @param _inputToken The MockERC20 being swapped from.
    /// @param _outputToken The MockERC20 to mint.
    /// @param _amount Amount of `_inputToken` to pull from the caller, and of `_outputToken` to mint.
    /// @param _recipient Receives `_amount` of `_outputToken`.
    function swapERC20ToERC20(address _inputToken, address _outputToken, uint256 _amount, address _recipient)
        external
    {
        IERC20Like(_inputToken).transferFrom(msg.sender, address(this), _amount);
        MockERC20(_outputToken).mint(_recipient, _amount);
    }

    /// @notice Withdraw-and-swap direction, ERC20 in / ETH out (mirror image of
    ///   `swapETHToERC20`): pulls `_amount` of `_inputToken` from the caller, sends `_amount`
    ///   wei of native ETH directly to `_recipient` (1:1 mock rate) from this router's own
    ///   pre-funded reserve (same reserve `swapAndCall` forwards from — fund this contract with
    ///   enough native ETH for whichever mock-swap direction a test exercises). Paying the
    ///   recipient directly (not `msg.sender`) is load-bearing for the same reason as
    ///   `swapETHToERC20`/`swapERC20ToERC20` above; unlike the RelaySwaps-internal
    ///   `gasSwapToSender` (which always pays `msg.sender`, i.e. RelaySwaps itself, for its
    ///   narrower B2 gas-top-up mechanic), this pays an arbitrary recipient.
    /// @param _inputToken The MockERC20 being swapped from.
    /// @param _amount Amount of `_inputToken` to pull from the caller, and of native ETH to send.
    /// @param _recipient Receives `_amount` wei of native ETH.
    function swapERC20ToETH(address _inputToken, uint256 _amount, address _recipient) external {
        IERC20Like(_inputToken).transferFrom(msg.sender, address(this), _amount);
        (bool _ok,) = _recipient.call{value: _amount}("");
        require(_ok, "MockRouter: ETH payout failed");
    }

    /// @notice B2 gas-swap leg: pulls `_pull` of `_inputToken` from the caller (RelaySwaps) and
    ///   sends `_ethOut` wei back to it from this router's own pre-funded native reserve —
    ///   simulates "swap a slice of ERC20 input into native ETH" in-contract, the mechanic
    ///   RelaySwaps' B2 path uses to self-fund a bridge's native fee.
    /// @param _inputToken The MockERC20 being swapped from.
    /// @param _pull Amount of `_inputToken` to pull from the caller.
    /// @param _ethOut Native wei to send back to the caller.
    function gasSwapToSender(address _inputToken, uint256 _pull, uint256 _ethOut) external {
        IERC20Like(_inputToken).transferFrom(msg.sender, address(this), _pull);
        (bool _ok,) = msg.sender.call{value: _ethOut}("");
        require(_ok, "MockRouter: gas-swap refund failed");
    }

    /// @notice Same selector/ABI shape as the real LiFi Diamond's
    ///   CalldataVerificationFacet.extractGenericSwapParameters — decodes THIS contract's own
    ///   `swapETHToERC20`/`swapERC20ToERC20`/`swapERC20ToETH` calldata (the shapes the
    ///   withdraw-and-swap fake quote provider targets) and re-expresses it in the real facet's
    ///   5-slot tuple, receiver at index 2 (the only index
    ///   EvmSwapChainAdapter.extractEmbeddedRecipient() reads). Branches on the leading 4-byte
    ///   selector since the three shapes decode differently (`swapETHToERC20`'s `(address,
    ///   address)` is the fallback branch, having no selector-specific check of its own).
    ///   `amount`/`receivingAmount` are unused by that check and returned as 0 — a `pure`
    ///   function has no access to the original call's msg.value to report them meaningfully
    ///   anyway.
    /// @param _data The full swap transaction calldata (4-byte selector + ABI-encoded params).
    function extractGenericSwapParameters(bytes calldata _data)
        external
        pure
        returns (address _sendingAssetId, uint256 _amount, address _receiver, address _receivingAssetId, uint256 _receivingAmount)
    {
        bytes4 _selector = bytes4(_data[:4]);
        if (_selector == this.swapERC20ToERC20.selector) {
            (address _erc20Input, address _erc20Output,, address _erc20Recipient) =
                abi.decode(_data[4:], (address, address, uint256, address));
            return (_erc20Input, 0, _erc20Recipient, _erc20Output, 0);
        }
        if (_selector == this.swapERC20ToETH.selector) {
            (address _erc20Input,, address _ethRecipient) = abi.decode(_data[4:], (address, uint256, address));
            return (_erc20Input, 0, _ethRecipient, NATIVE_ASSET, 0);
        }
        (address _outputToken, address _recipient) = abi.decode(_data[4:], (address, address));
        return (NATIVE_ASSET, 0, _recipient, _outputToken, 0);
    }

    receive() external payable {}
}
