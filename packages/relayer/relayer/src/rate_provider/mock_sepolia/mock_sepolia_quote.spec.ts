import { BadRequestException } from "@nestjs/common";
import { queryRate } from "./mock_sepolia_quote";
import { TokenDescription, RateProvider } from "../rate_types";
import { ChainType } from "../../config/enums";

const ONE_TO_ONE = 10n ** 18n;

function token(ticker: string, chainId: number, decimals = 18): TokenDescription {
    return {
        address: "0x0000000000000000000000000000000000000001",
        ticker,
        quoter: RateProvider.MOCK,
        decimals,
        chainType: ChainType.EVM,
        chainId,
    };
}

async function rate(inputTicker: string, outputTicker: string, chainId: number): Promise<bigint> {
    const quote = await queryRate(token(inputTicker, chainId), token(outputTicker, chainId), ChainType.EVM, chainId, "");
    expect(quote.den).toBe(1n);
    expect(quote.source).toBe(RateProvider.MOCK);
    return quote.num;
}

describe("mock_sepolia queryRate", () => {
    it("prices ETH -> stablecoin on sepolia at 2100 USD", async () => {
        expect(await rate("ETH", "USDC", 11155111)).toBe(2100n * 10n ** 18n);
    });

    it("prices stablecoin -> ETH on sepolia at 1/2100", async () => {
        expect(await rate("USDC", "ETH", 11155111)).toBe(10n ** 18n / 2100n);
    });

    it("prices ETH pairs on mainnet at 2100 USD", async () => {
        expect(await rate("ETH", "USDT", 1)).toBe(2100n * 10n ** 18n);
        expect(await rate("DAI", "WETH", 1)).toBe(10n ** 18n / 2100n);
    });

    it("prices cBTC -> stablecoin on citrea at 63800 USD", async () => {
        expect(await rate("cBTC", "USDC", 4114)).toBe(63800n * 10n ** 18n);
    });

    it("prices stablecoin -> cBTC on citrea at 1/63800", async () => {
        expect(await rate("USDC", "cBTC", 4114)).toBe(10n ** 18n / 63800n);
    });

    it("prices a same-ticker pair 1:1 regardless of chain price", async () => {
        expect(await rate("cBTC", "cBTC", 4114)).toBe(ONE_TO_ONE);
        expect(await rate("ETH", "ETH", 1)).toBe(ONE_TO_ONE);
    });

    it("prices stablecoin -> stablecoin 1:1", async () => {
        expect(await rate("USDC", "USDT", 11155111)).toBe(ONE_TO_ONE);
    });

    it("throws BadRequestException for a chain with no mocked prices", async () => {
        await expect(queryRate(token("ETH", 137), token("USDC", 137), ChainType.EVM, 137, "")).rejects.toThrow(
            BadRequestException
        );
    });
});
