import type { SwapStatusRequest, SwapStatusResult } from "../internal.js";

/**
 * Base interface for all swap providers.
 *
 * Provides swap transaction status tracking. Any provider that can quote
 * swaps can also track their execution status — the aggregator that routes
 * the swap has the information needed to monitor bridge delivery.
 */
export interface ISwapProvider {
    /**
     * Fetches the current status of a swap transaction from the DEX aggregator.
     *
     * For same-chain swaps, status resolves immediately after the tx is mined.
     * For cross-chain swaps, tracks bridge delivery to the destination chain.
     * Callers should poll at 5–10 second intervals until status is DONE or FAILED.
     *
     * @param params - The status request parameters.
     * @returns The current swap status.
     * @throws {SwapQuoteProviderBaseError}
     */
    getSwapStatus(params: SwapStatusRequest): Promise<SwapStatusResult>;
}
