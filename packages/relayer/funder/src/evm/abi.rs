//! On-chain interfaces the EVM sweep touches; all verified against deployed contracts by the fork
//! tests.

// `sol!` expands the 8-field LiFiGenericSwapCompleted event into an 8-argument constructor.
#![allow(clippy::too_many_arguments)]

use alloy::sol;

sol! {
    #[sol(rpc)]
    interface IERC20 {
        function balanceOf(address owner) external view returns (uint256);
        function allowance(address owner, address spender) external view returns (uint256);
        function approve(address spender, uint256 amount) external returns (bool);
    }

    /// PP yield share: an ERC-4626 vault whose `asset()` is an Aave V3 aToken.
    #[sol(rpc)]
    interface IERC4626 {
        function balanceOf(address owner) external view returns (uint256);
        function asset() external view returns (address);
        function previewRedeem(uint256 shares) external view returns (uint256);
        function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets);
    }

    /// Aave V3 aToken (1:1 with its underlying).
    #[sol(rpc)]
    interface IAToken {
        function balanceOf(address owner) external view returns (uint256);
        function UNDERLYING_ASSET_ADDRESS() external view returns (address);
        function POOL() external view returns (address);
    }

    /// Aave V3 Pool. `amount = type(uint256).max` withdraws the caller's whole aToken balance.
    #[sol(rpc)]
    interface IAavePool {
        function withdraw(address asset, uint256 amount, address to) external returns (uint256);
    }

    /// WETH9 / WBNB.
    #[sol(rpc)]
    interface IWrappedNative {
        function balanceOf(address owner) external view returns (uint256);
        function withdraw(uint256 amount) external;

        /// Emitted when `src` unwraps `wad`: for a router `unwrapWETH9(min, to)`, exactly what `to` got.
        event Withdrawal(address indexed src, uint256 wad);
        /// aeWETH (Arbitrum, Robinhood) emits no `Withdrawal`: its unwrap burns, `Transfer(src, 0x0, wad)`.
        event Transfer(address indexed from, address indexed to, uint256 value);
    }

    /// Uniswap V3 / PancakeSwap V3 QuoterV2. Not `view` (it reverts internally), so only eth_call it.
    #[sol(rpc)]
    interface IQuoterV2 {
        struct QuoteExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint256 amountIn;
            uint24 fee;
            uint160 sqrtPriceLimitX96;
        }

        function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
            external
            returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate);
    }

    /// IV3SwapRouter (Uniswap SwapRouter02 / PancakeSwap SmartRouter): the no-deadline struct.
    #[sol(rpc)]
    interface IV3SwapRouter {
        struct ExactInputSingleParams {
            address tokenIn;
            address tokenOut;
            uint24 fee;
            address recipient;
            uint256 amountIn;
            uint256 amountOutMinimum;
            uint160 sqrtPriceLimitX96;
        }

        function WETH9() external view returns (address);
        function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
        /// Sends the router's whole WETH balance (>= amountMinimum) to `recipient` as native.
        function unwrapWETH9(uint256 amountMinimum, address recipient) external payable;
        /// MulticallExtended: reverts after `deadline`, so a tx stuck in the mempool can't land
        /// hours later at a stale price.
        function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results);
    }

    /// LI.FI Diamond's same-chain swap entrypoints (GenericSwapFacet / GenericSwapFacetV3). Only
    /// decoded, never called by ABI: we sign the API's calldata after checking these fields.
    struct LiFiSwapData {
        address callTo;
        address approveTo;
        address sendingAssetId;
        address receivingAssetId;
        uint256 fromAmount;
        bytes callData;
        bool requiresDeposit;
    }

    /// Emitted by the Diamond after paying `toAmount` of the output to `receiver`.
    interface ILiFiEvents {
        event LiFiGenericSwapCompleted(bytes32 indexed transactionId, string integrator, string referrer, address receiver, address fromAssetId, address toAssetId, uint256 fromAmount, uint256 toAmount);
    }

    interface ILiFiSwap {
        function swapTokensGeneric(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, LiFiSwapData[] _swapData) external payable;
        function swapTokensSingleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, LiFiSwapData _swapData) external;
        function swapTokensMultipleV3ERC20ToNative(bytes32 _transactionId, string _integrator, string _referrer, address _receiver, uint256 _minAmountOut, LiFiSwapData[] _swapData) external;
    }
}
