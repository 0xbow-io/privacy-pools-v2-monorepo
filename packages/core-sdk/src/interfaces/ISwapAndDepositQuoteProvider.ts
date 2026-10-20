import type {
    Address,
    ISwapProvider,
    SwapAndDepositQuoteRequest,
    SwapAndDepositQuoteResult,
} from "../internal.js";

/**
 * Provides contract-calls swap quotes from an external DEX aggregator, generic over the chain's
 * address type `TAddress`.
 *
 * Unlike {@link ISwapQuoteProvider} which returns a simple swap quote,
 * this provider wraps deposit calldata into the swap so the aggregator
 * executes swap + deposit atomically via `getContractCallsQuote`.
 */
export interface ISwapAndDepositQuoteProvider<TAddress = Address> extends ISwapProvider {
    /**
     * Fetches a swap-and-deposit quote that atomically swaps input tokens
     * and calls the pool's deposit function with the provided calldata.
     *
     * @param params - The swap-and-deposit quote parameters.
     * @returns The quote result with estimated amounts and transaction calldata.
     * @throws {SwapQuoteProviderBaseError}
     */
    getSwapAndDepositQuote(
        params: SwapAndDepositQuoteRequest<TAddress>,
    ): Promise<SwapAndDepositQuoteResult<TAddress>>;
}
