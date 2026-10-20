import type { Address, ISwapProvider, SwapQuoteRequest, SwapQuoteResult } from "../internal.js";

/**
 * Provides swap quotes from an external DEX aggregator, generic over the chain's address type
 * `TAddress`.
 *
 * The SDK ships a LiFi-backed EVM implementation (evm-sdk's `LiFiSwapQuoteProvider`), but
 * integrators may supply their own by implementing this interface.
 */
export interface ISwapQuoteProvider<TAddress = Address> extends ISwapProvider {
    /**
     * Fetches a swap quote including the calldata needed for on-chain execution.
     *
     * @param params - The swap parameters (tokens, chains, amount).
     * @returns The quote result with estimated amounts and transaction calldata.
     * @throws {SwapQuoteProviderBaseError}
     */
    getSwapQuote(params: SwapQuoteRequest<TAddress>): Promise<SwapQuoteResult<TAddress>>;
}
