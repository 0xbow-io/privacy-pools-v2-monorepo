import type { Address } from "viem";
import { TickMath } from "@uniswap/v3-sdk";
import { TokenDescription, Quote, RateProvider, RateGetterFunction } from "../rate_types";
import { ChainType } from "../../config/enums";
import { UNISWAP_V3_POOL_ABI } from "./abi";
import { getWallet } from "../utilities";

// 15-minute TWAP. Independently verified reachable via observe() on both pools below
// (see pool_addresses.md) and matches the pools' instantaneous spot tick at verification
// time — long enough to resist single-block manipulation, short enough that these young,
// low-cardinality pools still have observation history covering it.
const TWAP_WINDOW_SECONDS = 900n;

interface UniswapV3PoolConfig {
    poolAddress: Address;
    inputToken: { address: Address; ticker: string; decimals: number };
    anchor: { address: Address; ticker: string; decimals: number };
    /**
     * Peg: price `inputToken` 1:1 as this token, using THIS token's pool (`poolAddress` is
     * then a pricedAs/anchor pool, not an inputToken/anchor pool). For a stablecoin with no
     * direct anchor pool of its own (BSC FDUSD has no Uniswap V3 pool against WBNB), priced
     * as a same-currency stablecoin that has one. A depeg of `inputToken` is not detected:
     * the relayer is paid in `inputToken`, so a depeg under-prices its fee by the depeg size.
     */
    pricedAs?: { address: Address; ticker: string; decimals: number };
}

// One entry per (chainId, input token) Uniswap V3 pool (JuiceSwap on Citrea, canonical Uniswap V3
// on Optimism, BSC and Robinhood) actually verified on-chain --
// real bytecode, nonzero liquidity, and a working 15-minute TWAP. See pool_addresses.md
// for the full verification (addresses, liquidity, implied price). A pair missing here
// throws explicitly below rather than reusing an unrelated pool for a token it was never
// verified to price.
const UNISWAP_V3_POOLS: Partial<Record<number, UniswapV3PoolConfig[]>> = {
    4114: [
        {
            // wcBTC / USDT.e, 0.3% fee tier. See pool_addresses.md.
            poolAddress: "0xB534E66Da34C0C9AA9f8d4028B43ca89BC9E911d",
            inputToken: { address: "0x9f3096Bac87e7F03DC09b0B416eB0DF837304dc4", ticker: "USDT.e", decimals: 6 },
            anchor: { address: "0x3100000000000000000000000000000000000006", ticker: "WCBTC", decimals: 18 },
        },
        {
            // wcBTC / USDC.e, 0.3% fee tier. See pool_addresses.md.
            poolAddress: "0xD77f369715E227B93D48b09066640F46F0B01b29",
            inputToken: { address: "0xE045e6c36cF77FAA2CfB54466D71A3aEF7bbE839", ticker: "USDC.e", decimals: 6 },
            anchor: { address: "0x3100000000000000000000000000000000000006", ticker: "WCBTC", decimals: 18 },
        },
        {
            // wcBTC / ctUSD, 0.3% fee tier — deepest verified mainnet liquidity of the three. See
            // pool_addresses.md.
            poolAddress: "0xB02e86A9BEfDcd3Bc1628014663F418047eC3884",
            inputToken: { address: "0x8D82c4E3c936C7B5724A382a9c5a4E6Eb7aB6d5D", ticker: "ctUSD", decimals: 6 },
            anchor: { address: "0x3100000000000000000000000000000000000006", ticker: "WCBTC", decimals: 18 },
        },
    ],
    5115: [
        {
            // WCBTC / USDC, 0.3% fee tier — the only pair on testnet pairing WCBTC with a
            // legitimate stablecoin rather than an obvious test/meme token (see pool_addresses.md).
            // Testnet liquidity does not reflect real market prices.
            poolAddress: "0x2763C50cF1176DEfBAfaD602EF3c160BB05210B8",
            inputToken: { address: "0x36c16eaC6B0Ba6c50f494914ff015fCa95B7835F", ticker: "USDC", decimals: 6 },
            anchor: { address: "0x8d0c9d1c17aE5e40ffF9bE350f57840E9E66Cd93", ticker: "WCBTC", decimals: 18 },
        },
    ],
    // Optimism mainnet — canonical Uniswap V3 (not a fork), WETH anchor. Both pools
    // verified on-chain 2026-08-16: nonzero liquidity, working observe([900,0]) TWAP,
    // implied prices agreeing within ~0.1% across the two pools. See pool_addresses.md.
    10: [
        {
            // USDC (native, not USDC.e) / WETH, 0.05% fee tier. See pool_addresses.md.
            poolAddress: "0x1fb3cf6e48F1E7B10213E7b6d87D4c073C7Fdb7b",
            inputToken: { address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", ticker: "USDC", decimals: 6 },
            anchor: { address: "0x4200000000000000000000000000000000000006", ticker: "WETH", decimals: 18 },
        },
        {
            // USDT / WETH, 0.05% fee tier. See pool_addresses.md.
            poolAddress: "0xc858A329Bf053BE78D6239C4A4343B8FbD21472b",
            inputToken: { address: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", ticker: "USDT", decimals: 6 },
            anchor: { address: "0x4200000000000000000000000000000000000006", ticker: "WETH", decimals: 18 },
        },
    ],
    // BNB Smart Chain — canonical Uniswap V3 (factory 0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7),
    // WBNB anchor. Both pools verified on-chain 2026-09-01: nonzero liquidity, working
    // observe([900,0]) TWAP, implied prices agreeing within ~0.1% across the two pools.
    // NOTE: BSC USDT and USDC are 18-decimal tokens (not 6) — decimals below are on-chain
    // `decimals()` values, and the stablecoin is token0 in both pools (address < WBNB).
    // See pool_addresses.md.
    56: [
        {
            // USDT / WBNB, 0.05% fee tier — deepest WBNB/USDT tier on BSC. See pool_addresses.md.
            poolAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
            inputToken: { address: "0x55d398326f99059fF775485246999027B3197955", ticker: "USDT", decimals: 18 },
            anchor: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", ticker: "WBNB", decimals: 18 },
        },
        {
            // USDC / WBNB, 0.01% fee tier — deepest WBNB/USDC tier on BSC. See pool_addresses.md.
            poolAddress: "0x4141325bAc36aFFe9Db165e854982230a14e6d48",
            inputToken: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", ticker: "USDC", decimals: 18 },
            anchor: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", ticker: "WBNB", decimals: 18 },
        },
        {
            // FDUSD, pegged 1:1 to USDT through the USDT / WBNB 0.05% pool. BSC Uniswap V3 has
            // no FDUSD/WBNB pool on any fee tier (checked 2026-09-25), and the prod Entrypoint
            // enables FDUSD, so without this entry FDUSD notes could not be relayed out. See
            // pool_addresses.md.
            poolAddress: "0x6fe9E9de56356F7eDBfcBB29FAB7cd69471a4869",
            inputToken: { address: "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", ticker: "FDUSD", decimals: 18 },
            anchor: { address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", ticker: "WBNB", decimals: 18 },
            pricedAs: { address: "0x55d398326f99059fF775485246999027B3197955", ticker: "USDT", decimals: 18 },
        },
    ],
    // Robinhood Chain — canonical Uniswap V3 (factory 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA),
    // WETH anchor. Verified on-chain 2026-10-14: nonzero liquidity, working observe([900,0])
    // TWAP. WETH is token0 here (WETH < USDG). See pool_addresses.md.
    4663: [
        {
            // WETH / USDG, 0.01% fee tier — deepest USDG tier on Robinhood. See pool_addresses.md.
            poolAddress: "0x52e65B17fB6E5BA00Ed806f37Afcd2DaA50271Ca",
            inputToken: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", ticker: "USDG", decimals: 6 },
            anchor: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", ticker: "WETH", decimals: 18 },
        },
    ],
};

function findPoolConfig(chainId: number, inputTokenAddress: Address): UniswapV3PoolConfig {
    const config = (UNISWAP_V3_POOLS[chainId] ?? []).find(
        (candidate) => candidate.inputToken.address.toLowerCase() === inputTokenAddress.toLowerCase()
    );
    if (!config) {
        throw new Error(
            `Uniswap V3 has no verified pool for token=${inputTokenAddress} on chainId=${chainId} — refusing to ` +
            `guess a pool rather than reuse an unrelated pair.`
        );
    }
    return config;
}

const Q192 = 1n << 192n;

export const queryRate: RateGetterFunction = async function (
    input_token: TokenDescription,
    _output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    rpc_url: string,
): Promise<Quote> {
    const config = findPoolConfig(chainId, input_token.address);

    const wallet = getWallet(rpc_url);
    const [tickCumulatives] = (await wallet.readContract({
        address: config.poolAddress,
        abi: UNISWAP_V3_POOL_ABI,
        functionName: "observe",
        // secondsAgos = [window, 0]: tickCumulatives[0] is `window` seconds ago,
        // tickCumulatives[1] is now.
        args: [[Number(TWAP_WINDOW_SECONDS), 0]],
    })) as readonly [readonly bigint[], readonly bigint[]];

    // Same arithmetic-mean-tick derivation as Uniswap's own OracleLibrary.consult: floor
    // the division (BigInt division truncates toward zero, so correct for negative ticks).
    const tickCumulativesDelta = tickCumulatives[1] - tickCumulatives[0];
    let avgTick = tickCumulativesDelta / TWAP_WINDOW_SECONDS;
    if (tickCumulativesDelta < 0n && tickCumulativesDelta % TWAP_WINDOW_SECONDS !== 0n) {
        avgTick -= 1n;
    }

    const sqrtRatioX96 = BigInt(TickMath.getSqrtRatioAtTick(Number(avgTick)).toString());
    const sqrtRatioX96Squared = sqrtRatioX96 * sqrtRatioX96;
    // The pool prices `pricedAs` when set (a pegged input); its decimals and address fix the
    // scale and the token0/token1 direction. One whole input token == one whole pegged token.
    const pooled = config.pricedAs ?? config.inputToken;
    const inputDecimalsScale = 10n ** BigInt(pooled.decimals);

    // sqrtRatioX96^2 / 2^192 is the raw price of token1 per token0 (Uniswap always orders
    // token0 < token1 by address; that ordering differs between our two verified pools —
    // see pool_addresses.md — so direction is derived from address comparison, not assumed).
    // We want anchor-wei per 1 *whole* input token — kept as an exact num/den fraction
    // (never eagerly divided) so no precision is lost before the caller's own division.
    const inputIsToken0 = pooled.address.toLowerCase() < config.anchor.address.toLowerCase();
    const num = inputIsToken0 ? sqrtRatioX96Squared * inputDecimalsScale : Q192 * inputDecimalsScale;
    const den = inputIsToken0 ? Q192 : sqrtRatioX96Squared;

    const anchorDescription: TokenDescription = {
        address: config.anchor.address,
        ticker: config.anchor.ticker,
        quoter: RateProvider.UNISWAP,
        decimals: config.anchor.decimals,
        chainType,
        chainId,
    };

    return {
        source: RateProvider.UNISWAP,
        num,
        den,
        token_in: input_token,
        token_out: anchorDescription,
        chainType,
        chainId,
    };
};
