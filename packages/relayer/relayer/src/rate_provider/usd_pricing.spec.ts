import { microUsdPerWholeTokenX1e18 } from "./usd_pricing";
import { RateProvider } from "./rate_types";
import type { Quote, TokenDescription } from "./rate_types";
import { ChainType } from "../config/enums";

const DUST: TokenDescription = {
    address: "0x0000000000000000000000000000000000000aaa",
    ticker: "DUST",
    quoter: RateProvider.CURVE,
    decimals: 18,
    chainType: ChainType.EVM,
    chainId: 42161,
};
const USDC: TokenDescription = {
    address: "0x0000000000000000000000000000000000000bbb",
    ticker: "USDC",
    quoter: RateProvider.CURVE,
    decimals: 6,
    chainType: ChainType.EVM,
    chainId: 42161,
};

function curveQuote(aggregatedRate: bigint): Quote {
    return {
        source: RateProvider.CURVE,
        num: aggregatedRate,
        den: 1n,
        token_in: DUST,
        token_out: USDC,
        chainType: ChainType.EVM,
        chainId: 42161,
    };
}

// Mirrors the normalization queryRateForPair applies in cowswap/quote_obtention.ts:
// num = buyAmount * 10^inputDecimals * 1e18, den = sellAmount * 10^outputDecimals.
function cowswapQuote(buyAmount: bigint, sellAmount: bigint, dustDecimals: number, stablecoinDecimals: number): Quote {
    return {
        source: RateProvider.COWSWAP,
        num: buyAmount * 10n ** BigInt(dustDecimals) * 10n ** 18n,
        den: sellAmount * 10n ** BigInt(stablecoinDecimals),
        token_in: DUST,
        token_out: USDC,
        chainType: ChainType.EVM,
        chainId: 42161,
    };
}

describe("microUsdPerWholeTokenX1e18", () => {
    it("Curve: 1:1 price (18-decimal dust, 6-decimal stablecoin) gives 1e24.", () => {
        // aggregated_rate = 1e18 means "1 whole dust token == 1 whole stablecoin" (decimals-invariant).
        const result = microUsdPerWholeTokenX1e18(curveQuote(10n ** 18n));
        expect(result).toBe(10n ** 24n);
    });

    it("CowSwap: 1:1 price (18-decimal dust, 6-decimal stablecoin) agrees with Curve's 1e24.", () => {
        // Selling 100 whole dust tokens (100 * 10^18) for 100 whole USDC (100 * 10^6) at 1:1.
        const sellAmount = 100n * 10n ** 18n;
        const buyAmount = 100n * 10n ** 6n;
        const result = microUsdPerWholeTokenX1e18(cowswapQuote(buyAmount, sellAmount, 18, 6));
        expect(result).toBe(10n ** 24n);
    });

    it("Curve: a non-1:1 price scales linearly.", () => {
        // 1 whole dust token == 0.5 whole stablecoin -> half of the 1:1 result.
        const result = microUsdPerWholeTokenX1e18(curveQuote(5n * 10n ** 17n));
        expect(result).toBe(5n * 10n ** 23n);
    });

    it("CowSwap: a 6-decimal dust asset (e.g. USDT-like) still normalizes correctly.", () => {
        // 100 whole 6-decimal dust tokens sell for 100 whole 6-decimal USDC at 1:1.
        const sellAmount = 100n * 10n ** 6n;
        const buyAmount = 100n * 10n ** 6n;
        const result = microUsdPerWholeTokenX1e18(cowswapQuote(buyAmount, sellAmount, 6, 6));
        expect(result).toBe(10n ** 24n);
    });

    it("throws for an unsupported provider.", () => {
        const quote: Quote = {
            source: RateProvider.UNISWAP,
            num: 1n,
            den: 1n,
            token_in: DUST,
            token_out: USDC,
            chainType: ChainType.EVM,
            chainId: 42161,
        };
        expect(() => microUsdPerWholeTokenX1e18(quote)).toThrow(/unsupported rate provider/);
    });
});
