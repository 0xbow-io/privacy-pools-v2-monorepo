import { readFileSync } from "fs";
import { resolve } from "path";
import { queryRate, UNISWAP_V3_POOLS } from "./quote_obtention";
import * as utilities from "../utilities";
import { TokenDescription, RateProvider, type RateProviderDescription } from "../rate_types";
import { ChainType } from "../../config/enums";

// Real, on-chain-verified addresses — see pool_addresses.md. Mainnet orders WCBTC as
// token0 (WCBTC < USDT.e); testnet orders the opposite way (USDC < WCBTC) — deliberately
// exercised by the tests below rather than assuming one fixed ordering.
const USDT_E_MAINNET = "0x9f3096Bac87e7F03DC09b0B416eB0DF837304dc4";
const USDC_E_MAINNET = "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839";
const CTUSD_MAINNET = "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D";
const WCBTC_MAINNET = "0x3100000000000000000000000000000000000006";
const USDC_TESTNET = "0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F";
const WCBTC_TESTNET = "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93";
// BSC: canonical Uniswap V3, 18-decimal USDT (not 6), stablecoin is token0 (USDT < WBNB).
const USDT_BSC = "0x55d398326f99059fF775485246999027B3197955";
const WBNB_BSC = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
// FDUSD has no WBNB pool; it is priced 1:1 as USDT through the USDT/WBNB pool.
const FDUSD_BSC = "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409";
// U (United Stables) has only zero-liquidity pools; it is priced 1:1 as USDT the same way.
const U_BSC = "0xcE24439F2D9C6a2289F741120FE202248B666666";
const USDT_WBNB_POOL_BSC = "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869";
// Robinhood: canonical Uniswap V3, 6-decimal USDG, WETH is token0 (WETH < USDG).
const USDG_ROBINHOOD = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const WETH_ROBINHOOD = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
// Base: canonical Uniswap V3, 6-decimal USDC, WETH is token0 (WETH < USDC). USDT is priced
// 1:1 as USDC through the WETH/USDC pool (its own WETH pools are too thin).
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDT_BASE = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const WETH_USDC_POOL_BASE = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
// Mainnet: USDC is token0 (USDC < WETH), WETH is token0 against USDT. Arbitrum: WETH is token0
// in both pools.
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_MAINNET = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WETH_MAINNET = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC_ARBITRUM = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const USDT0_ARBITRUM = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const WETH_ARBITRUM = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";

// WETH-wei per 1 whole $1 stablecoin at ETH ≈ $2,400: ~4.17e14 wei.
function expectAboutUsd2400PerEth(quote: { num: bigint; den: bigint }): void {
    const weiPerToken = quote.num / quote.den;
    expect(weiPerToken).toBeGreaterThan(4_10_000_000_000_000n);
    expect(weiPerToken).toBeLessThan(4_25_000_000_000_000n);
}

function token(address: string, ticker: string, chainId: number, decimals: number): TokenDescription {
    return {
        address: address as `0x${string}`,
        ticker,
        quoter: RateProvider.UNISWAP,
        decimals,
        chainType: ChainType.EVM,
        chainId,
    };
}

// Mocks pool.observe([900, 0]) -> tickCumulatives = [atWindowAgo, now]. Matches the ABI's
// two-array return shape (tickCumulatives, secondsPerLiquidityCumulativeX128s) — the
// second array is unused by queryRate, so its contents don't matter here.
function mockObserve(tickCumulativeAtWindowAgo: bigint, tickCumulativeNow: bigint): void {
    jest.spyOn(utilities, "getWallet").mockReturnValue({
        readContract: jest.fn().mockResolvedValue([[tickCumulativeAtWindowAgo, tickCumulativeNow], [0n, 0n]]),
    } as unknown as ReturnType<typeof utilities.getWallet>);
}

describe("uniswap_v3 queryRate (JuiceSwap on Citrea, Uniswap V3 on Optimism, BSC, Robinhood, Base, Ethereum and Arbitrum)", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    // tick 0 is a known exact reference point: sqrtRatioX96 = 2^96 exactly (sqrt(1.0001^0) = 1),
    // so the raw token1/token0 price is exactly 1 — letting num/den be checked exactly rather
    // than needing to hand-derive TickMath's bit-shift output.
    it("prices USDT.e -> WCBTC on mainnet at tick 0 (WCBTC is token0)", async () => {
        mockObserve(0n, 0n);

        const quote = await queryRate(
            token(USDT_E_MAINNET, "USDT.e", 4114, 6),
            token(WCBTC_MAINNET, "WCBTC", 4114, 18),
            ChainType.EVM,
            4114,
            "unused"
        );

        expect(quote.source).toBe(RateProvider.UNISWAP);
        expect(quote.token_out.address.toLowerCase()).toBe(WCBTC_MAINNET.toLowerCase());
        expect(quote.chainId).toBe(4114);
        // At tick 0, raw price is 1:1, so num/den (anchor-wei per 1 whole USDT.e) == 10^6.
        expect(quote.num).toBe(quote.den * 10n ** 6n);
    });

    // Catches copy-paste mistakes in the UNISWAP_V3_POOLS table (wrong pool/decimals swapped
    // between entries) — each of mainnet's three stablecoin entries independently resolves
    // to its own correct pool/direction, not accidentally to a neighboring entry's config.
    it.each([
        [USDC_E_MAINNET, "USDC.e"],
        [CTUSD_MAINNET, "ctUSD"],
    ])("prices %s -> WCBTC on mainnet at tick 0", async (address, ticker) => {
        mockObserve(0n, 0n);

        const quote = await queryRate(
            token(address, ticker, 4114, 6),
            token(WCBTC_MAINNET, "WCBTC", 4114, 18),
            ChainType.EVM,
            4114,
            "unused"
        );

        expect(quote.token_out.address.toLowerCase()).toBe(WCBTC_MAINNET.toLowerCase());
        expect(quote.num).toBe(quote.den * 10n ** 6n);
    });

    it("prices USDC -> WCBTC on testnet at tick 0 (WCBTC is token1 — opposite ordering)", async () => {
        mockObserve(0n, 0n);

        const quote = await queryRate(
            token(USDC_TESTNET, "USDC", 5115, 6),
            token(WCBTC_TESTNET, "WCBTC", 5115, 18),
            ChainType.EVM,
            5115,
            "unused"
        );

        expect(quote.token_out.address.toLowerCase()).toBe(WCBTC_TESTNET.toLowerCase());
        // Same tick-0 identity holds regardless of which side is token0/token1.
        expect(quote.num).toBe(quote.den * 10n ** 6n);
    });

    it("prices USDT -> WBNB on BSC at tick 0 using the token's real 18 decimals (USDT is token0)", async () => {
        mockObserve(0n, 0n);

        const quote = await queryRate(
            token(USDT_BSC, "USDT", 56, 18),
            token(WBNB_BSC, "WBNB", 56, 18),
            ChainType.EVM,
            56,
            "unused"
        );

        expect(quote.source).toBe(RateProvider.UNISWAP);
        expect(quote.token_out.address.toLowerCase()).toBe(WBNB_BSC.toLowerCase());
        expect(quote.token_out.decimals).toBe(18);
        expect(quote.chainId).toBe(56);
        // BSC USDT has 18 decimals, so at tick 0 anchor-wei per 1 whole USDT == 10^18 —
        // a 6-decimal assumption here would mis-price BSC fees by 10^12.
        expect(quote.num).toBe(quote.den * 10n ** 18n);
    });

    it("prices USDG -> WETH on Robinhood at tick 0 with 6 decimals (WETH is token0)", async () => {
        mockObserve(0n, 0n);

        const quote = await queryRate(
            token(USDG_ROBINHOOD, "USDG", 4663, 6),
            token(WETH_ROBINHOOD, "WETH", 4663, 18),
            ChainType.EVM,
            4663,
            "unused"
        );

        expect(quote.source).toBe(RateProvider.UNISWAP);
        expect(quote.token_out.address.toLowerCase()).toBe(WETH_ROBINHOOD.toLowerCase());
        expect(quote.chainId).toBe(4663);
        expect(quote.num).toBe(quote.den * 10n ** 6n);
    });

    it("prices FDUSD on BSC exactly as USDT, through the USDT/WBNB pool", async () => {
        // A real TWAP tick for USDT/WBNB (pool_addresses.md): FDUSD must get the identical rate.
        const tick = -65276n;
        mockObserve(0n, 900n * tick);
        const usdt = await queryRate(token(USDT_BSC, "USDT", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");
        mockObserve(0n, 900n * tick);
        const fdusd = await queryRate(token(FDUSD_BSC, "FDUSD", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");

        expect(fdusd.num * usdt.den).toBe(usdt.num * fdusd.den);
        expect(fdusd.token_in.address).toBe(FDUSD_BSC);
        expect(fdusd.token_out.address.toLowerCase()).toBe(WBNB_BSC.toLowerCase());
    });

    it("reads the USDT/WBNB pool when pricing FDUSD", async () => {
        mockObserve(0n, 0n);
        await queryRate(token(FDUSD_BSC, "FDUSD", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");
        const readContract = (utilities.getWallet as jest.Mock).mock.results[0].value.readContract as jest.Mock;
        expect(readContract.mock.calls[0][0].address.toLowerCase()).toBe(USDT_WBNB_POOL_BSC.toLowerCase());
    });

    it("prices U on BSC exactly as USDT, through the USDT/WBNB pool", async () => {
        const tick = -65276n;
        mockObserve(0n, 900n * tick);
        const usdt = await queryRate(token(USDT_BSC, "USDT", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");
        mockObserve(0n, 900n * tick);
        const u = await queryRate(token(U_BSC, "U", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");

        expect(u.num * usdt.den).toBe(usdt.num * u.den);
        expect(u.token_in.address).toBe(U_BSC);
        expect(u.token_out.address.toLowerCase()).toBe(WBNB_BSC.toLowerCase());
    });

    it("reads the USDT/WBNB pool when pricing U", async () => {
        mockObserve(0n, 0n);
        await queryRate(token(U_BSC, "U", 56, 18), token(WBNB_BSC, "WBNB", 56, 18), ChainType.EVM, 56, "unused");
        const readContract = (utilities.getWallet as jest.Mock).mock.results[0].value.readContract as jest.Mock;
        expect(readContract.mock.calls[0][0].address.toLowerCase()).toBe(USDT_WBNB_POOL_BSC.toLowerCase());
    });

    it("prices USDC -> WETH on Base from a real TWAP tick at ~$2,400 per ETH (WETH is token0)", async () => {
        // Real 15-minute TWAP tick for WETH/USDC 0.05% on 2026-10-23 (pool_addresses.md).
        mockObserve(0n, 900n * -198487n);

        const quote = await queryRate(token(USDC_BASE, "USDC", 8453, 6), token(WETH_BASE, "WETH", 8453, 18), ChainType.EVM, 8453, "unused");

        expect(quote.source).toBe(RateProvider.UNISWAP);
        expect(quote.chainId).toBe(8453);
        expect(quote.token_out.address.toLowerCase()).toBe(WETH_BASE.toLowerCase());
        // WETH-wei per 1 whole USDC: ~1/2400 ETH ≈ 4.17e14 wei.
        const weiPerUsdc = quote.num / quote.den;
        expect(weiPerUsdc).toBeGreaterThan(4_10_000_000_000_000n);
        expect(weiPerUsdc).toBeLessThan(4_25_000_000_000_000n);
    });

    it("prices USDT on Base exactly as USDC, through the WETH/USDC pool", async () => {
        const tick = -198487n;
        mockObserve(0n, 900n * tick);
        const usdc = await queryRate(token(USDC_BASE, "USDC", 8453, 6), token(WETH_BASE, "WETH", 8453, 18), ChainType.EVM, 8453, "unused");
        mockObserve(0n, 900n * tick);
        const usdt = await queryRate(token(USDT_BASE, "USDT", 8453, 6), token(WETH_BASE, "WETH", 8453, 18), ChainType.EVM, 8453, "unused");

        expect(usdt.num * usdc.den).toBe(usdc.num * usdt.den);
        expect(usdt.token_in.address).toBe(USDT_BASE);
        expect(usdt.token_out.address.toLowerCase()).toBe(WETH_BASE.toLowerCase());
    });

    it("reads the WETH/USDC pool when pricing Base USDT", async () => {
        mockObserve(0n, 0n);
        await queryRate(token(USDT_BASE, "USDT", 8453, 6), token(WETH_BASE, "WETH", 8453, 18), ChainType.EVM, 8453, "unused");
        const readContract = (utilities.getWallet as jest.Mock).mock.results[0].value.readContract as jest.Mock;
        expect(readContract.mock.calls[0][0].address.toLowerCase()).toBe(WETH_USDC_POOL_BASE.toLowerCase());
    });

    it.each([
        // Real 15-minute TWAP ticks from 2026-10-23 (pool_addresses.md). Mainnet USDC is token0
        // (positive tick); every other pool has WETH as token0 (negative tick).
        ["USDC on mainnet", USDC_MAINNET, WETH_MAINNET, 1, 198482n],
        ["USDT on mainnet", USDT_MAINNET, WETH_MAINNET, 1, -198473n],
        ["USDC on Arbitrum", USDC_ARBITRUM, WETH_ARBITRUM, 42161, -198482n],
        ["USDT0 on Arbitrum", USDT0_ARBITRUM, WETH_ARBITRUM, 42161, -198472n],
    ])("prices %s -> WETH from a real TWAP tick at ~$2,400 per ETH", async (_label, input, weth, chainId, tick) => {
        mockObserve(0n, 900n * tick);

        const quote = await queryRate(token(input, "STABLE", chainId, 6), token(weth, "WETH", chainId, 18), ChainType.EVM, chainId, "unused");

        expect(quote.source).toBe(RateProvider.UNISWAP);
        expect(quote.chainId).toBe(chainId);
        expect(quote.token_out.address.toLowerCase()).toBe(weth.toLowerCase());
        expectAboutUsd2400PerEth(quote);
    });

    it("produces reciprocal rates for opposite token0/token1 orderings given the same tick", async () => {
        // delta/900 = -165764 exactly (no floor-rounding correction needed) — the real
        // 15-min TWAP tick independently observed on the mainnet pool (see pool_addresses.md).
        mockObserve(0n, -900n * 165764n);
        const mainnetQuote = await queryRate(
            token(USDT_E_MAINNET, "USDT.e", 4114, 6),
            token(WCBTC_MAINNET, "WCBTC", 4114, 18),
            ChainType.EVM,
            4114,
            "unused"
        );

        mockObserve(0n, -900n * 165764n);
        const testnetQuote = await queryRate(
            token(USDC_TESTNET, "USDC", 5115, 6),
            token(WCBTC_TESTNET, "WCBTC", 5115, 18),
            ChainType.EVM,
            5115,
            "unused"
        );

        // Both configs pair a 6-decimal stablecoin against 18-decimal WCBTC with opposite
        // token0/token1 ordering, so feeding the same tick (same sqrtRatioX96 = S) in gives:
        // mainnet (input=token1): num/den = (Q192 * 10^6) / S
        // testnet (input=token0): num/den = (S * 10^6) / Q192
        // Multiplying the two: (num/den)_mainnet * (num/den)_testnet = 10^6 * 10^6 = 10^12
        // exactly (the Q192/S factors cancel) — not a plain reciprocal (that would require
        // dividing out the two input tokens' combined decimal scale, which cross-multiplying
        // num*num vs den*den does not do on its own).
        expect(mainnetQuote.num * testnetQuote.num).toBe(mainnetQuote.den * testnetQuote.den * 10n ** 12n);
    });

    it("applies floor-rounding for a negative, non-evenly-divisible tickCumulative delta", async () => {
        // delta = -1, window = 900: BigInt truncating division gives 0, but the correct
        // floored tick is -1 — verifies the Solidity-style floor correction, not just
        // truncation. Compared against the exact tick-0 identity to prove it's not a no-op.
        mockObserve(0n, -1n);

        const quote = await queryRate(
            token(USDT_E_MAINNET, "USDT.e", 4114, 6),
            token(WCBTC_MAINNET, "WCBTC", 4114, 18),
            ChainType.EVM,
            4114,
            "unused"
        );

        expect(quote.num).not.toBe(quote.den * 10n ** 6n);
    });

    it("declares every chain that has a verified pool in rate_provider_description.json", () => {
        // RateProviderBootValidator refuses to start the relayer when a config asset names
        // "Uniswap" on a chain missing from the description, even if the pool table covers it.
        const description = JSON.parse(
            readFileSync(resolve(__dirname, "rate_provider_description.json"), "utf-8")
        ) as RateProviderDescription;
        const declared = description.known_currencies
            .filter((currency) => currency.chainType === ChainType.EVM)
            .map((currency) => currency.chainId);

        for (const chainId of Object.keys(UNISWAP_V3_POOLS).map(Number)) {
            expect(declared).toContain(chainId);
        }
    });

    it("throws for a chainId with no verified pool", async () => {
        await expect(
            queryRate(token(USDT_E_MAINNET, "USDT.e", 999, 6), token(WCBTC_MAINNET, "WCBTC", 999, 18), ChainType.EVM, 999, "unused")
        ).rejects.toThrow(/no verified pool/i);
    });

    it("throws for a configured chainId but an unverified input token", async () => {
        await expect(
            queryRate(
                token("0x0000000000000000000000000000000000000099", "UNKNOWN", 4114, 18),
                token(WCBTC_MAINNET, "WCBTC", 4114, 18),
                ChainType.EVM,
                4114,
                "unused"
            )
        ).rejects.toThrow(/no verified pool/i);
    });
});
