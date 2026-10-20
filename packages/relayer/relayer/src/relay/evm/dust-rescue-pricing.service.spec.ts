import { Test, TestingModule } from "@nestjs/testing";
import type { Hex } from "viem";
import { DustRescuePricingService } from "./dust-rescue-pricing.service";
import { RelayerConfig } from "../../config/relayer-config";
import { RateProvider } from "../../rate_provider/rate_types";
import type { Quote } from "../../rate_provider/rate_types";

const curveQueryRateForPair = jest.fn();
jest.mock("../../rate_provider/curve/curve_quote_obtention", () => ({
    queryRateForPair: (...args: unknown[]) => curveQueryRateForPair(...args),
}));

const cowswapQueryRateForPair = jest.fn();
jest.mock("../../rate_provider/cowswap/quote_obtention", () => ({
    queryRateForPair: (...args: unknown[]) => cowswapQueryRateForPair(...args),
}));

const NATIVE_ASSET_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Hex;
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Hex;
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Hex;
const OP_USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Hex;
// Synthetic placeholder — deliberately NOT Base's real reference stablecoin (USDC), so
// this exercises the real queryRateForPair path rather than the same-as-stablecoin
// trivial-$1 shortcut.
const SOME_OTHER_BASE_ASSET = "0x0000000000000000000000000000000000000042" as Hex;

function fakeAsset(
    overrides: Partial<{ address: Hex; ticker: string; quoter: RateProvider; decimals: number }> = {},
) {
    return {
        address: NATIVE_ASSET_ADDRESS,
        ticker: "ETH",
        quoter: RateProvider.CURVE,
        decimals: 18,
        chainType: "evm" as never,
        chainId: 1,
        ...overrides,
    };
}

function fakeQuote(overrides: Partial<Quote> = {}): Quote {
    return {
        source: RateProvider.CURVE,
        num: 2_500n * 10n ** 18n,
        den: 1n,
        token_in: fakeAsset(),
        token_out: fakeAsset({ address: MAINNET_USDC, ticker: "USDC", decimals: 6 }),
        chainType: "evm" as never,
        chainId: 1,
        ...overrides,
    };
}

// `asset` plus any `others` are exposed as `supported_assets` on a raw config object —
// production code now wraps this itself via `new EvmChainConfigWrapper(c)`
// (relayerConfig.chain(...).config(...) returns the raw config, not a wrapper), and the
// real wrapper's own `asset()` lookup (find-or-throw) is what a test now exercises.
async function buildService(
    asset: ReturnType<typeof fakeAsset>,
    others: ReturnType<typeof fakeAsset>[] = [],
): Promise<DustRescuePricingService> {
    const relayerConfig = {
        chain: () => ({
            config: () => ({
                supported_assets: [asset, ...others],
                rpc_url: "https://rpc.example",
            }),
        }),
    };

    const module: TestingModule = await Test.createTestingModule({
        providers: [DustRescuePricingService, { provide: RelayerConfig, useValue: relayerConfig }],
    }).compile();

    return module.get<DustRescuePricingService>(DustRescuePricingService);
}

describe("DustRescuePricingService", () => {
    beforeEach(() => {
        curveQueryRateForPair.mockReset();
        cowswapQueryRateForPair.mockReset();
    });

    it("substitutes the chain's wrapped-native address when pricing native-asset dust", async () => {
        curveQueryRateForPair.mockResolvedValue(fakeQuote());
        const service = await buildService(fakeAsset({ quoter: RateProvider.CURVE }));

        const rate = await service.priceForRescue(1, NATIVE_ASSET_ADDRESS);

        expect(curveQueryRateForPair).toHaveBeenCalledTimes(1);
        const [dustToken] = curveQueryRateForPair.mock.calls[0];
        expect(dustToken.address).toBe(MAINNET_WETH);
        // Metadata stays the real native asset's — only the address passed to the
        // provider changes.
        expect(dustToken.ticker).toBe("ETH");
        expect(dustToken.decimals).toBe(18);
        expect(rate.source).toBe("Curve");
        expect(rate.tokenDecimals).toBe(18);
    });

    it("prices Native-quoter native dust through the reference stablecoin's configured quoter", async () => {
        cowswapQueryRateForPair.mockResolvedValue(fakeQuote({ source: RateProvider.COWSWAP }));
        const service = await buildService(fakeAsset({ quoter: RateProvider.NATIVE }), [
            fakeAsset({ address: MAINNET_USDC, ticker: "USDC", quoter: RateProvider.COWSWAP, decimals: 6 }),
        ]);

        const rate = await service.priceForRescue(1, NATIVE_ASSET_ADDRESS);

        expect(curveQueryRateForPair).not.toHaveBeenCalled();
        expect(cowswapQueryRateForPair).toHaveBeenCalledTimes(1);
        const [dustToken, stablecoinToken] = cowswapQueryRateForPair.mock.calls[0];
        expect(dustToken.address).toBe(MAINNET_WETH);
        expect(dustToken.quoter).toBe(RateProvider.COWSWAP);
        expect(stablecoinToken.quoter).toBe(RateProvider.COWSWAP);
        expect(rate.source).toBe("Cowswap");
    });

    it("throws for Native-quoter dust when the reference stablecoin isn't a configured asset", async () => {
        const service = await buildService(fakeAsset({ quoter: RateProvider.NATIVE }), [
            fakeAsset({ address: SOME_OTHER_BASE_ASSET, ticker: "USDT", quoter: RateProvider.COWSWAP, decimals: 6 }),
        ]);

        await expect(service.priceForRescue(1, NATIVE_ASSET_ADDRESS)).rejects.toThrow(
            /reference stablecoin .* is not in its supported_assets/,
        );
        expect(curveQueryRateForPair).not.toHaveBeenCalled();
        expect(cowswapQueryRateForPair).not.toHaveBeenCalled();
    });

    it("throws without querying any provider when the chain has no wrapped-native address configured", async () => {
        const service = await buildService(fakeAsset({ quoter: RateProvider.CURVE }));

        await expect(service.priceForRescue(8453, NATIVE_ASSET_ADDRESS)).rejects.toThrow(
            /No wrapped-native address configured for chainId=8453/,
        );
        expect(curveQueryRateForPair).not.toHaveBeenCalled();
        expect(cowswapQueryRateForPair).not.toHaveBeenCalled();
    });

    it("returns a trivial $1 rate for chain 10 when the dust asset is Optimism's reference stablecoin (USDC)", async () => {
        // Optimism's assets are Uniswap-quoted, which isn't wired for USD pricing — but a
        // USDC-output reshield never needs a quoter: the dust asset IS
        // REFERENCE_STABLECOIN_BY_CHAIN_ID[10], so priceForRescue short-circuits to $1.
        const service = await buildService(
            fakeAsset({ address: OP_USDC, ticker: "USDC", quoter: RateProvider.UNISWAP, decimals: 6 }),
        );

        const rate = await service.priceForRescue(10, OP_USDC);

        expect(curveQueryRateForPair).not.toHaveBeenCalled();
        expect(cowswapQueryRateForPair).not.toHaveBeenCalled();
        expect(rate.tokenDecimals).toBe(6);
        expect(BigInt(rate.microUsdPerWholeTokenX1e18)).toBe(1_000_000n * 10n ** 18n);
    });

    it("prices a non-native ERC-20 dust asset unchanged (no substitution)", async () => {
        cowswapQueryRateForPair.mockResolvedValue(
            fakeQuote({
                source: RateProvider.COWSWAP,
                token_in: fakeAsset({ address: SOME_OTHER_BASE_ASSET, ticker: "USDT", quoter: RateProvider.COWSWAP, decimals: 6 }),
            }),
        );
        const service = await buildService(
            fakeAsset({ address: SOME_OTHER_BASE_ASSET, ticker: "USDT", quoter: RateProvider.COWSWAP, decimals: 6 }),
        );

        // SOME_OTHER_BASE_ASSET here stands in for an arbitrary non-native, non-stablecoin-match ERC-20
        // (chainId 8453's real reference stablecoin differs, so this doesn't hit the
        // trivial-$1 shortcut).
        await service.priceForRescue(8453, SOME_OTHER_BASE_ASSET);

        expect(cowswapQueryRateForPair).toHaveBeenCalledTimes(1);
        const [dustToken] = cowswapQueryRateForPair.mock.calls[0];
        expect(dustToken.address).toBe(SOME_OTHER_BASE_ASSET);
    });
});
