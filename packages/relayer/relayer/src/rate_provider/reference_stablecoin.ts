import type { Address } from "viem";

/**
 * A reference USD-pegged stablecoin per chain, used only by the dust-rescue USD-pricing
 * path (dust_collection_service_detailed_design.org §4b) via `queryRateForPair` — the
 * generalized rate getters, not the legacy `queryRate` (which stays pinned to the WETH
 * anchor maps, unaffected by this file). Same independent-verification discipline as
 * `ANCHOR_TOKEN_BY_CHAIN_ID` / `CURVE_CONFIG_BY_CHAIN_ID`'s anchor addresses: these are
 * well-known canonical USDC deployments, but re-verify on-chain (decimals, no proxy
 * surprises) before trusting a new chain's entry for real pricing.
 */
export interface ReferenceStablecoin {
    address: Address;
    ticker: string;
    decimals: number;
}

export const REFERENCE_STABLECOIN_BY_CHAIN_ID: Partial<Record<number, ReferenceStablecoin>> = {
    1: {
        // Native USDC on Mainnet.
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        ticker: "USDC",
        decimals: 6,
    },
    10: {
        // Native USDC on Optimism. Verified on-chain 2026-08-29: symbol "USDC",
        // 6 decimals, deployed (not the bridged USDC.e). Optimism's dust assets are
        // all `Uniswap`-quoted, which isn't wired for USD pricing — this entry is only
        // useful via `priceForRescue`'s same-token short-circuit (dust asset == the
        // reference stablecoin → trivially $1), which covers the USDC-output reshield.
        address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        ticker: "USDC",
        decimals: 6,
    },
    42161: {
        // Native USDC on Arbitrum One.
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        ticker: "USDC",
        decimals: 6,
    },
    8453: {
        // Native USDC on Base.
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        ticker: "USDC",
        decimals: 6,
    },
};
