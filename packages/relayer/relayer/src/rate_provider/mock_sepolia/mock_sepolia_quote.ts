import { TokenDescription, Quote, RateProvider, RateGetterFunction } from "../rate_types";
import { ChainType } from "../../config/enums";
import { BadRequestException } from "@nestjs/common";

const STABLECOINS = ["USDT", "USDC", "DAI"];

// Mocked USD price of each chain's native asset, for chains where a real rate
// provider isn't available. Sepolia/mainnet price ETH; Citrea prices cBTC; BSC
// prices BNB. Chains not listed here are not mocked and fail loudly instead of
// mis-pricing.
const NATIVE_PRICE_USD: Record<number, bigint> = {
    1: 2100n,
    11155111: 2100n,
    4114: 63800n,
    5115: 63800n,
    42161: 2100n,
    8453: 2100n,
    56: 800n,
    10: 2100n,
};

function isStablecoin(ticker: string): boolean {
    return STABLECOINS.includes(ticker.toUpperCase());
}

// Tickers this mock treats as a chain's native asset (or its wrapped form).
function isNative(ticker: string): boolean {
    const t = ticker.toUpperCase();
    return t === "ETH" || t === "WETH" || t === "CBTC" || t === "BNB" || t === "WBNB";
}

function getMockedRate(input_token: TokenDescription, output_token: TokenDescription, nativePriceUsd: bigint): bigint {
    // 18-decimal rate convention to match Curve's format.
    const NATIVE_USD_RATE = nativePriceUsd * 10n ** 18n;
    const USD_NATIVE_RATE = 10n ** 18n / nativePriceUsd;
    const ONE_TO_ONE = 10n ** 18n;

    if (input_token.ticker.toUpperCase() === output_token.ticker.toUpperCase()) {
        return ONE_TO_ONE;
    }
    if (isNative(input_token.ticker) && isStablecoin(output_token.ticker)) {
        return NATIVE_USD_RATE;
    }
    if (isStablecoin(input_token.ticker) && isNative(output_token.ticker)) {
        return USD_NATIVE_RATE;
    }
    return ONE_TO_ONE; // TODO this could break WBTC or other fluctuating tokens
}

export const queryRate: RateGetterFunction = async function (
    input_token: TokenDescription,
    output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    _rpc_url: string,
): Promise<Quote> {
    const nativePriceUsd = NATIVE_PRICE_USD[chainId];
    if (nativePriceUsd === undefined) {
        throw new BadRequestException(`Mock rate provider has no mocked prices for chainId ${chainId}`);
    }

    return {
        source: RateProvider.MOCK,
        num: getMockedRate(input_token, output_token, nativePriceUsd),
        den: 1n,
        token_in: input_token,
        token_out: output_token,
        chainType,
        chainId,
    };
};
