import type { Address, Hex } from "../internal.js";

// NOTE (core-sdk split): the original packages/sdk/src/types/SwapQuoteProvider.ts also defined
// `LiFiSwapQuoteProviderConfig`/`LiFiSwapQuoteProviderDependencies` — construction config for the
// concrete (EVM/LiFi-only) `LiFiSwapQuoteProvider` class, which stays in evm-sdk. Dropped here;
// the sdk original stays as reference until evm-sdk's own copy is made.

/**
 * Parameters for requesting a swap quote from an external DEX aggregator, generic over the
 * chain's address type `TAddress`.
 */
export interface SwapQuoteRequest<TAddress = Address> {
    /** Source chain ID. */
    fromChainId: number;
    /** Destination chain ID (same as source for same-chain swaps). */
    toChainId: number;
    /** Input token address. */
    fromToken: TAddress;
    /** Output token address. */
    toToken: TAddress;
    /** Address initiating the swap (used for approval checks). */
    fromAddress: TAddress;
    /** Recipient address for swap output. Defaults to fromAddress if omitted. */
    toAddress?: TAddress;
    /** Fallback address for cross-chain bridge failure refunds. Defaults to fromAddress if omitted. */
    fallbackAddress?: TAddress;
    /** Amount in token units (wei). */
    amount: string;
    /** Whether `amount` specifies input ("from") or output ("to") tokens. */
    amountType: "from" | "to";
    /** Slippage tolerance (0-1 range, e.g. 0.005 = 0.5%). If omitted, defaults to 0.5% same-chain / 3% cross-chain. */
    slippage?: number;
    /**
     * LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`). Some
     * tools embed a short transaction deadline in their calldata that can expire
     * before this protocol's proof generation (30-60s) plus relayer round-trip
     * completes, causing an on-chain `ExpiredTransaction()` revert regardless of
     * quote freshness. Use this to steer away from tools known to do that.
     */
    denyExchanges?: string[];
}

/**
 * Result of a swap quote containing the calldata needed for on-chain execution, generic over the
 * chain's address type `TAddress`.
 */
export interface SwapQuoteResult<TAddress = Address> {
    /** Input amount in token units (wei). */
    fromAmount: string;
    /** Expected output amount in token units (wei). */
    toAmount: string;
    /** Minimum output amount accounting for slippage (wei). */
    toAmountMin: string;
    /** Input amount in USD (informational). */
    fromAmountUSD?: string;
    /** Output amount in USD (informational). */
    toAmountUSD?: string;
    /** Address to approve tokens to before executing the swap. */
    approvalAddress: TAddress;
    /** Encoded swap calldata for on-chain execution. */
    transactionData: Hex;
    /** Contract address the swap transaction targets. */
    transactionTo: TAddress;
    /** Estimated execution duration in seconds. */
    estimatedDuration: number;
    /** Bridge/DEX tool used for this swap (e.g. "stargateV2"). Pass to `getSwapStatus` for cross-chain lookups. */
    tool?: string;
    /** Input token address LiFi actually routed (echo — for caller cross-checks). */
    fromTokenAddress: TAddress;
    /** Output token address LiFi actually routed (echo — for caller cross-checks). */
    toTokenAddress: TAddress;
    /** Source chain ID LiFi actually routed (echo — for caller cross-checks). */
    fromChainId: number;
    /** Destination chain ID LiFi actually routed (echo — for caller cross-checks). */
    toChainId: number;
    /**
     * Input token symbol as the provider routed it. Optional: a provider that
     * cannot report it makes any same-asset check fall through to "not proven".
     */
    fromTokenSymbol?: string;
    /** Output token symbol as the provider routed it (see {@link fromTokenSymbol}). */
    toTokenSymbol?: string;
    /** Input token decimals as the provider routed it. */
    fromTokenDecimals?: number;
    /** Output token decimals as the provider routed it. */
    toTokenDecimals?: number;
}

/**
 * Parameters for requesting a swap-and-deposit quote (contract calls variant), generic over the
 * chain's address type `TAddress`.
 * The aggregator swaps input tokens then calls the pool's deposit function atomically.
 */
export interface SwapAndDepositQuoteRequest<TAddress = Address> {
    /** Source chain ID. */
    fromChainId: number;
    /** Destination chain ID (same as source for same-chain). */
    toChainId: number;
    /** Input token address (token user holds). */
    fromToken: TAddress;
    /** Deposit token address (token accepted by pool). */
    toToken: TAddress;
    /** Address initiating the swap. */
    fromAddress: TAddress;
    /** Fixed deposit amount in deposit-token units (wei string). Used as LiFi's toAmount target
     * unless netFromAmount is also set, in which case it is only the contractCalls amount. */
    depositAmount: string;
    /**
     * When set, switches the LiFi outer request from toAmount (destination-token target) to
     * fromAmount (source-token budget). LiFi takes exactly this many source tokens, bridges
     * and swaps them, passes depositAmount of the output to the deposit contractCall, and
     * routes any surplus to fallbackAddress. Required for cross-asset swaps (e.g. USDC→USDT)
     * where the toAmount quote inflates the required source input above the available budget.
     */
    netFromAmount?: string;
    /** ABI-encoded deposit calldata to execute after swap. */
    depositCalldata: Hex;
    /** Pool entrypoint contract address (target of the deposit call). */
    poolAddress: TAddress;
    /** Gas limit for the deposit contract call. Defaults to "300000". */
    depositGasLimit?: string;
    /**
     * Destination-chain address for LiFi to send funds to if the destination
     * contract call fails, or (per LiFi's executor behavior) any leftover
     * left unconsumed by a successful call. Passed to LiFi as `toFallbackAddress`.
     * Omitting this leaves LiFi's own default in place — for a contract-calls
     * quote there is no protocol-owned recipient otherwise, so destination-chain
     * leftover has no deterministic destination.
     */
    fallbackAddress?: TAddress;
    /** Slippage tolerance (0-1 range, e.g. 0.005 = 0.5%). If omitted, defaults to 0.5% same-chain / 3% cross-chain. */
    slippage?: number;
    /**
     * LiFi tool/exchange names to exclude from routing (e.g. `["fly"]`). Some
     * tools embed a short transaction deadline in their calldata that can expire
     * before this protocol's proof generation (30-60s) plus relayer round-trip
     * completes, causing an on-chain `ExpiredTransaction()` revert regardless of
     * quote freshness. Use this to steer away from tools known to do that.
     */
    denyExchanges?: string[];
}

/**
 * Result of a swap-and-deposit quote, generic over the chain's address type `TAddress`.
 */
export interface SwapAndDepositQuoteResult<TAddress = Address> {
    /** Input amount in token units (wei). */
    fromAmount: string;
    /** Deposit amount in token units (wei). */
    toAmount: string;
    /**
     * LiFi's guaranteed delivery for the whole route (`estimate.toAmountMin`), in output-token
     * units. Absent when LiFi did not report it.
     */
    toAmountMin?: string;
    /**
     * The `fromAmount` LiFi encoded for OUR destination contract call (the `custom` step of
     * `includedSteps`), in output-token units. LiFi ignores `contractCalls[].fromAmount` and
     * encodes the route's guaranteed delivery instead (measured 2026-09-23/24): this is what
     * the Executor sends as `msg.value` for a native-coin call, and the approval amount for
     * an ERC-20 call. Absent when the quote carries no such step.
     */
    destinationCallAmount?: string;
    /** Input amount in USD (informational). */
    fromAmountUSD?: string;
    /** Output amount in USD (informational). */
    toAmountUSD?: string;
    /** Address to approve input tokens to before executing. */
    approvalAddress: TAddress;
    /** Encoded transaction calldata for on-chain execution. */
    transactionData: Hex;
    /** Contract address the transaction targets (LiFi router). */
    transactionTo: TAddress;
    /** ETH value to send with the transaction (hex-encoded). */
    transactionValue: Hex;
    /** Estimated execution duration in seconds. */
    estimatedDuration: number;
    /** Bridge/DEX tool used for this route (e.g. "stargateV2"), for diagnostics. */
    tool?: string;
    /** Input token address LiFi actually routed (echo — for caller cross-checks). */
    fromTokenAddress: TAddress;
    /** Deposit token address LiFi actually routed (echo — for caller cross-checks). */
    toTokenAddress: TAddress;
    /** Source chain ID LiFi actually routed (echo — for caller cross-checks). */
    fromChainId: number;
    /** Destination chain ID LiFi actually routed (echo — for caller cross-checks). */
    toChainId: number;
}
