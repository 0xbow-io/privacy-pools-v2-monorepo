/**
 * Fake LiFi quote providers for the evm-sdk e2e suite — LiFi has no solver/liquidity on local or
 * test chains, so a real swap cannot execute against the local anvil-Sepolia fork
 * `network.ts` deploys to. These target the self-deployed `MockRouter` (standing in for the LiFi
 * Diamond) instead, mirroring exactly what `PoolSessionWithdrawAndSwap`/`PoolSessionSwapDeposit`
 * consume from a real `LiFiSwapQuoteProvider` — see packages/swaps/contracts/src/MockRouter.sol
 * for the on-chain side these calldata blobs target.
 */
import { encodeFunctionData } from "viem";

import type {
    Address,
    ISwapAndDepositQuoteProvider,
    ISwapQuoteProvider,
    SwapAndDepositQuoteRequest,
    SwapAndDepositQuoteResult,
    SwapQuoteRequest,
    SwapQuoteResult,
    SwapStatusRequest,
    SwapStatusResult,
} from "../src/internal.js";
import { NATIVE_ASSET_ADDRESS } from "../src/internal.js";
import type { EvmE2ENetwork } from "./network.js";

export const MOCK_ROUTER_ABI = [
    {
        name: "swapETHToERC20",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "_outputToken", type: "address" },
            { name: "_recipient", type: "address" },
        ],
        outputs: [],
    },
    {
        name: "swapERC20ToERC20",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_inputToken", type: "address" },
            { name: "_outputToken", type: "address" },
            { name: "_amount", type: "uint256" },
            { name: "_recipient", type: "address" },
        ],
        outputs: [],
    },
    {
        name: "swapERC20ToETH",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_inputToken", type: "address" },
            { name: "_amount", type: "uint256" },
            { name: "_recipient", type: "address" },
        ],
        outputs: [],
    },
    {
        name: "gasSwapToSender",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [
            { name: "_inputToken", type: "address" },
            { name: "_pull", type: "uint256" },
            { name: "_ethOut", type: "uint256" },
        ],
        outputs: [],
    },
    {
        name: "swapAndCall",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "_inputToken", type: "address" },
            { name: "_amount", type: "uint256" },
            { name: "_dstCallTarget", type: "address" },
            { name: "_callValue", type: "uint256" },
            { name: "_dstCallData", type: "bytes" },
        ],
        outputs: [],
    },
    {
        name: "swapERC20AndCall",
        type: "function",
        stateMutability: "payable",
        inputs: [
            { name: "_inputToken", type: "address" },
            { name: "_amount", type: "uint256" },
            { name: "_outputToken", type: "address" },
            { name: "_outputAmount", type: "uint256" },
            { name: "_dstCallTarget", type: "address" },
            { name: "_dstCallData", type: "bytes" },
        ],
        outputs: [],
    },
] as const;

function isNative(token: Address): boolean {
    return token.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase();
}

/** For withdraw-and-swap: native ETH (or, post-unwrap, a plain ERC20 underlying) withdrawn from
 * the pool → `network.mockErc20Address` delivered directly to the recipient, via
 * `MockRouter.swapETHToERC20`/`swapERC20ToERC20`. Also handles RelaySwaps' "B2" gas-swap leg
 * (ERC20 input → a target amount of native ETH, via `MockRouter.gasSwapToSender`), requested by
 * `PoolSessionReshieldCrosschain.sizeB2GasSwap` with `amountType: "to"` and `toToken` native. */
export function createFakeSwapQuoteProvider(network: EvmE2ENetwork): ISwapQuoteProvider {
    return {
        async getSwapQuote(params: SwapQuoteRequest<Address>): Promise<SwapQuoteResult<Address>> {
            const recipient = params.toAddress ?? params.fromAddress;

            if (params.amountType === "to" && isNative(params.toToken)) {
                // B2 gas-swap leg: `params.amount` is the target native-ETH OUTPUT
                // (`gasSwapTargetOut`); at the 1:1 mock rate that's also the mUSD input pulled
                // from the caller (RelaySwaps). Refunds straight to `msg.sender` (the caller),
                // not `recipient` — RelaySwaps itself is the intended receiver of the gas swap's
                // native output, same reasoning as `swapETHToERC20`'s doc comment in reverse.
                const transactionData = encodeFunctionData({
                    abi: MOCK_ROUTER_ABI,
                    functionName: "gasSwapToSender",
                    args: [params.fromToken, BigInt(params.amount), BigInt(params.amount)],
                });
                return {
                    fromAmount: params.amount,
                    toAmount: params.amount,
                    toAmountMin: params.amount,
                    approvalAddress: network.mockRouterAddress,
                    transactionData,
                    transactionTo: network.mockRouterAddress,
                    estimatedDuration: 1,
                    fromTokenAddress: params.fromToken,
                    toTokenAddress: params.toToken,
                    fromChainId: params.fromChainId,
                    toChainId: params.toChainId,
                };
            }

            const transactionData = isNative(params.fromToken)
                ? encodeFunctionData({
                      abi: MOCK_ROUTER_ABI,
                      functionName: "swapETHToERC20",
                      args: [params.toToken, recipient],
                  })
                : encodeFunctionData({
                      abi: MOCK_ROUTER_ABI,
                      functionName: "swapERC20ToERC20",
                      args: [params.fromToken, params.toToken, BigInt(params.amount), recipient],
                  });
            // 1:1 mock rate, no slippage — arms RelaySwaps' minOutputAmount > 0 guard.
            return {
                fromAmount: params.amount,
                toAmount: params.amount,
                toAmountMin: params.amount,
                approvalAddress: network.mockRouterAddress,
                transactionData,
                transactionTo: network.mockRouterAddress,
                estimatedDuration: 1,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromChainId: params.fromChainId,
                toChainId: params.toChainId,
            };
        },
        async getSwapStatus(_params: SwapStatusRequest): Promise<SwapStatusResult> {
            return { status: "DONE" };
        },
    };
}

/** For a same-chain swap into a native deposit, which the session composes through the swap executor
 * (`network.mockExecutorAddress`): an exact-out quote for `params.amount` wei of native ETH paid to
 * `params.toAddress` (the executor), via `MockRouter.swapERC20ToETH` at the 1:1 mock rate, so the
 * input pulled equals the output. */
export function createFakeExecutorSwapQuoteProvider(network: EvmE2ENetwork): ISwapQuoteProvider {
    return {
        async getSwapQuote(params: SwapQuoteRequest<Address>): Promise<SwapQuoteResult<Address>> {
            if (params.amountType !== "to" || !isNative(params.toToken) || isNative(params.fromToken)) {
                throw new Error("fake executor swap quotes are exact-out ERC20 -> native only");
            }
            const transactionData = encodeFunctionData({
                abi: MOCK_ROUTER_ABI,
                functionName: "swapERC20ToETH",
                args: [params.fromToken, BigInt(params.amount), params.toAddress ?? params.fromAddress],
            });
            return {
                fromAmount: params.amount,
                toAmount: params.amount,
                toAmountMin: params.amount,
                approvalAddress: network.mockRouterAddress,
                transactionData,
                transactionTo: network.mockRouterAddress,
                estimatedDuration: 1,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromChainId: params.fromChainId,
                toChainId: params.toChainId,
            };
        },
        async getSwapStatus(_params: SwapStatusRequest): Promise<SwapStatusResult> {
            return { status: "DONE" };
        },
    };
}

/** For swap-and-deposit: `network.mockErc20Address` swapped into native ETH and forwarded into
 * an embedded `Entrypoint.deposit()` call, via `MockRouter.swapAndCall`. */
export function createFakeSwapAndDepositQuoteProvider(network: EvmE2ENetwork): ISwapAndDepositQuoteProvider {
    return {
        async getSwapAndDepositQuote(
            params: SwapAndDepositQuoteRequest<Address>,
        ): Promise<SwapAndDepositQuoteResult<Address>> {
            const transactionData = encodeFunctionData({
                abi: MOCK_ROUTER_ABI,
                functionName: "swapAndCall",
                args: [
                    params.fromToken,
                    BigInt(params.depositAmount),
                    params.poolAddress,
                    BigInt(params.depositAmount),
                    params.depositCalldata,
                ],
            });
            // 1:1 rate — exact because native ETH's vettingFeeBPS is 0 in the deployed asset
            // config (see DeployE2ELocal.s.sol); changing that BPS later would silently break
            // this shortcut.
            return {
                fromAmount: params.depositAmount,
                toAmount: params.depositAmount,
                approvalAddress: network.mockRouterAddress,
                transactionData,
                transactionTo: network.mockRouterAddress,
                transactionValue: "0x0",
                estimatedDuration: 1,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromChainId: params.fromChainId,
                toChainId: params.toChainId,
            };
        },
        async getSwapStatus(_params: SwapStatusRequest): Promise<SwapStatusResult> {
            return { status: "DONE" };
        },
    };
}

/** Native LayerZero-fee stand-in this fake always reports for the reshield-crosschain main leg
 * below — arbitrary but nonzero, which is RelaySwaps' B2 gas-swap trigger
 * (`PoolSessionReshieldCrosschain`: ERC20 input AND `transactionValue > 0`). Small relative to
 * `network.mockRouterAddress`'s 1000 ETH funding (see the harness global setup). */
const FAKE_B2_TRANSACTION_VALUE = 10_000_000_000_000n; // 0.00001 ETH

/** For RelaySwaps' "B2" cross-chain reshield main leg: `params.fromToken` (an ERC20, e.g. mUSD)
 * swapped/bridged and the destination deposit calldata forwarded, via `MockRouter.swapAndCall` —
 * same mechanic as {@link createFakeSwapAndDepositQuoteProvider}, but ALWAYS reports a nonzero
 * `transactionValue` (a fake native bridge fee) to force `PoolSessionReshieldCrosschain` to size
 * and exercise RelaySwaps' in-contract B2 gas swap. Kept separate from
 * {@link createFakeSwapAndDepositQuoteProvider}, which must never report one. */
export function createFakeReshieldCrosschainQuoteProvider(network: EvmE2ENetwork): ISwapAndDepositQuoteProvider {
    return {
        async getSwapAndDepositQuote(
            params: SwapAndDepositQuoteRequest<Address>,
        ): Promise<SwapAndDepositQuoteResult<Address>> {
            // `netFromAmount`, when set, is the actual source-token budget the contract pulls
            // (see SwapAndDepositQuoteRequest's own doc comment) — required here since
            // PoolSessionReshieldCrosschain always sizes a B2 quote this way, unlike the plain
            // same-chain swap-and-deposit fake above (which only ever sees `depositAmount`).
            const pulled = BigInt(params.netFromAmount ?? params.depositAmount);
            // A native destination deposit cannot land through the real aggregator (LiFi sends its own
            // guaranteed delivery as msg.value), so the SDK refuses it; the ERC-20 shape is the one
            // that works, and is what the mock router funds here.
            const transactionData = isNative(params.toToken)
                ? encodeFunctionData({
                      abi: MOCK_ROUTER_ABI,
                      functionName: "swapAndCall",
                      args: [
                          params.fromToken,
                          pulled,
                          params.poolAddress,
                          BigInt(params.depositAmount),
                          params.depositCalldata,
                      ],
                  })
                : encodeFunctionData({
                      abi: MOCK_ROUTER_ABI,
                      functionName: "swapERC20AndCall",
                      args: [
                          params.fromToken,
                          pulled,
                          params.toToken,
                          BigInt(params.depositAmount),
                          params.poolAddress,
                          params.depositCalldata,
                      ],
                  });
            return {
                fromAmount: pulled.toString(),
                toAmount: params.depositAmount,
                approvalAddress: network.mockRouterAddress,
                transactionData,
                transactionTo: network.mockRouterAddress,
                transactionValue: `0x${FAKE_B2_TRANSACTION_VALUE.toString(16)}`,
                estimatedDuration: 1,
                fromTokenAddress: params.fromToken,
                toTokenAddress: params.toToken,
                fromChainId: params.fromChainId,
                toChainId: params.toChainId,
            };
        },
        async getSwapStatus(_params: SwapStatusRequest): Promise<SwapStatusResult> {
            return { status: "DONE" };
        },
    };
}
