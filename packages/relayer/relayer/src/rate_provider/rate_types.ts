import { Address } from "viem";
import { ChainType } from "../config/enums";

export enum RateProvider {
    // Marker for assets that never reach a rate provider: the chain's native asset
    // (sentinel address) and WETH, which both convert 1:1 into native gas cost
    // (EvmQuoteService.isNativeToken). No provider is registered under this name;
    // RateProviderBootValidator requires it on exactly those assets and rejects it on
    // any other, so a config can't silently pin a real quoter to an asset that ignores it.
    NATIVE = "Native",
    // Marker for ERC-4626 share tokens (ppUSDC over USDC) that no market prices. The
    // asset entry names its `underlying`; EvmQuoteService quotes that underlying through
    // ITS quoter and scales by the wrapper's live `previewRedeem` rate. No provider is
    // registered under this name; RateProviderBootValidator checks the wiring at boot.
    UNDERLYING = "Underlying",
    UNISWAP = "Uniswap",
    COWSWAP = "Cowswap",
    CURVE = "Curve",
    TEST = "Test",
    MOCK = "Mock",
}

export interface TokenDescription {
    address: Address;
    ticker: string;
    fee_bps?: bigint;
    quoter: RateProvider;
    decimals: number;
    chainType: ChainType;
    chainId: number;
}

export interface Quote {
    source: RateProvider;
    num: bigint;
    den: bigint;
    token_in: TokenDescription;
    token_out: TokenDescription;
    chainType: ChainType;
    chainId: number;
}

// A single (chainType, chainId) a rate provider declares it can price against.
// `assetId` is deliberately a wildcard ("*") for now — per-asset allowlisting already
// lives in relayer.config.json's supported_assets[]; this only gates chain support.
export interface KnownCurrency {
    chainType: ChainType;
    chainId: number;
    assetId: string;
}

// Declarative description a rate provider ships (its own rate_provider_description.json)
// listing which chains it actually supports — checked at boot and defensively per request.
export interface RateProviderDescription {
    provider: RateProvider;
    known_currencies: KnownCurrency[];
}

export type RateGetterFunction = (
    input_token: TokenDescription,
    output_token: TokenDescription,
    chainType: ChainType,
    chainId: number,
    rpc_url: string,
) => Promise<Quote>;
