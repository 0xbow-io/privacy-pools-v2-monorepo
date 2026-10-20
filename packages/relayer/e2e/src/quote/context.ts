export interface QuoteContext {
    baseUrl: string;
    quoteEndpoint: string;
    /** Needed by negative tests to construct invalid endpoints */
    getQuoteEndpoint: (version: string, chainType: string, chainId: string) => string;
    version: string;
    chainType: string;
    chainId: string;
    /** Common constants */
    ethAddress: string;
    usdcAddress: string;
    usdtAddress: string;
    ethAmount: string;
    stablecoinAmount: string;
    recipient: string;
}
