import { Injectable, Logger } from "@nestjs/common";
import type { Hex } from "viem";
import { RelayerConfig } from "../../config/relayer-config";
import { EvmChainConfigWrapper } from "../../config/evm/evm-chain-config";
import { ChainType } from "../../config/enums";
import { RateProvider } from "../../rate_provider/rate_types";
import type { TokenDescription } from "../../rate_provider/rate_types";
import { queryRateForPair as curveQueryRateForPair } from "../../rate_provider/curve/curve_quote_obtention";
import { queryRateForPair as cowswapQueryRateForPair } from "../../rate_provider/cowswap/quote_obtention";
import { REFERENCE_STABLECOIN_BY_CHAIN_ID } from "../../rate_provider/reference_stablecoin";
import { microUsdPerWholeTokenX1e18 } from "../../rate_provider/usd_pricing";
import { NATIVE_ASSET_ADDRESS } from "../../config/evm/evm.types";

/**
 * Wrapped-native address per chain, used ONLY to price a native-asset dust rescue (see
 * the `tokenId === NATIVE_ASSET_ADDRESS` branch in `priceForRescue` below) — neither
 * Curve nor CowSwap can quote the raw native-asset sentinel directly: Curve's on-chain
 * oracle has no pool trading the sentinel address (always reverts/zero-rates, see
 * curve_quote_obtention.ts's "known gaps"), and CowSwap's orderbook API rejects it
 * outright (`InvalidNativeSellToken` — verified live against
 * https://api.cow.fi/mainnet/api/v1/quote). Deliberately local to this one call site
 * rather than added to `queryRateForPair` itself, which is intentionally built to never
 * silently substitute a caller's token (see its own doc comment, and the legacy
 * `queryRate` wrapper it was split off from) — every other caller must keep getting
 * exactly the token it asked for. Same verified addresses as
 * curve_quote_obtention.ts's `CURVE_CONFIG_BY_CHAIN_ID` / cowswap/quote_obtention.ts's
 * `ANCHOR_TOKEN_BY_CHAIN_ID` (not imported from either — both are provider-internal and
 * this substitution applies regardless of which provider ends up quoting).
 */
const WRAPPED_NATIVE_BY_CHAIN_ID: Partial<Record<number, Hex>> = {
    1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH, Mainnet
};

/** Structural mirror of dust-rescue-service's `DustAssetUsdRate` (job.types.ts) — same
 * boundary-cast pattern already used for `StealthRecipientIdentifier` (see
 * dust-rescue-orchestrator.service.ts) rather than a cross-package import. */
export interface DustAssetUsdRate {
    source: "Curve" | "Cowswap";
    microUsdPerWholeTokenX1e18: Hex;
    tokenDecimals: number;
}

/**
 * Prices a cross-chain-reshield dust asset against a reference USD stablecoin, once, at
 * Leg-1 registration time — see dust_collection_service_detailed_design.org §4b. Uses
 * `RelayerConfig` directly (not the request-scoped `EvmConfigService`) because the asset
 * being priced lives on the *destination* chain, not this request's own source chain —
 * the same request-scope-bypassing pattern the now-deleted
 * `DustRescueOrchestratorService.attemptRescue()` already used for the same reason.
 *
 * Deliberately does not go through Nest's `DiscoveryService`/DI-registered
 * `RateProviderService` instances: those are pinned to the verified WETH anchor by
 * design (see the `queryRate` curried wrappers in curve_quote_obtention.ts /
 * cowswap/quote_obtention.ts) and must stay that way for the existing native-gas-cost
 * conversion path. This calls the generalized `queryRateForPair` functions directly —
 * there are only two providers wired for USD pricing, so a plain switch on `quoter`
 * is simpler than registering new DI tokens for a single, narrow call site.
 */
@Injectable()
export class DustRescuePricingService {
    private readonly logger = new Logger(DustRescuePricingService.name);

    constructor(private readonly relayerConfig: RelayerConfig) {}

    // See the `Native` branch in priceForRescue: the reference stablecoin's own configured
    // quoter is the provider that gets to price native dust against it.
    private stablecoinQuoter(
        chainConfig: { asset(address: string): { quoter: RateProvider } },
        stablecoinAddress: Hex,
        nativeTicker: string,
        destinationChainId: number,
    ): RateProvider {
        let stablecoinConfig: { quoter: RateProvider };
        try {
            stablecoinConfig = chainConfig.asset(stablecoinAddress);
        } catch {
            throw new Error(
                `Dust asset ${nativeTicker} on chainId=${destinationChainId} is native (quoter "${RateProvider.NATIVE}") ` +
                    `and the chain's reference stablecoin ${stablecoinAddress} is not in its supported_assets — ` +
                    `no provider to USD-price it with.`,
            );
        }
        return stablecoinConfig.quoter;
    }

    async priceForRescue(destinationChainId: number, tokenId: Hex): Promise<DustAssetUsdRate> {
        const chainConfig = new EvmChainConfigWrapper(this.relayerConfig.chain(ChainType.EVM).config(destinationChainId));
        const assetConfig = chainConfig.asset(tokenId);
        const stablecoin = REFERENCE_STABLECOIN_BY_CHAIN_ID[destinationChainId];
        if (!stablecoin) {
            throw new Error(
                `No reference stablecoin configured for chainId=${destinationChainId} — cannot USD-price dust rescue assets on this chain.`,
            );
        }

        // Native-asset dust (e.g. ETH from a reshield-crosschain-to-native-ETH deposit):
        // price the chain's wrapped-native token instead — see WRAPPED_NATIVE_BY_CHAIN_ID's
        // doc comment for why neither provider can quote the raw sentinel address. Only the
        // address passed to the rate provider changes; ticker/decimals (and the `tokenId`
        // this method returns pricing for) stay the real native asset's.
        let priceableAddress: Hex = tokenId;
        if (tokenId.toLowerCase() === NATIVE_ASSET_ADDRESS) {
            const wrappedNative = WRAPPED_NATIVE_BY_CHAIN_ID[destinationChainId];
            if (!wrappedNative) {
                throw new Error(
                    `No wrapped-native address configured for chainId=${destinationChainId} — cannot ` +
                        `USD-price native-asset dust rescue on this chain.`,
                );
            }
            priceableAddress = wrappedNative;
        }

        // Native-treated assets (sentinel / WETH) carry the inert `Native` quoter — they
        // never reach a provider on the fee path, so their config names none. For USD
        // pricing we still need one: borrow the reference stablecoin's configured quoter
        // on the destination chain, since that provider must be able to price the
        // stablecoin leg of this exact pair anyway.
        const pricingQuoter =
            assetConfig.quoter === RateProvider.NATIVE
                ? this.stablecoinQuoter(chainConfig, stablecoin.address, assetConfig.ticker, destinationChainId)
                : assetConfig.quoter;
        const dustToken: TokenDescription = {
            address: priceableAddress,
            ticker: assetConfig.ticker,
            quoter: pricingQuoter,
            decimals: assetConfig.decimals,
            chainType: ChainType.EVM,
            chainId: destinationChainId,
        };
        const stablecoinToken: TokenDescription = {
            address: stablecoin.address,
            ticker: stablecoin.ticker,
            quoter: pricingQuoter,
            decimals: stablecoin.decimals,
            chainType: ChainType.EVM,
            chainId: destinationChainId,
        };

        // The dust asset IS the reference stablecoin (e.g. USDC→USDC on Base): rate is
        // trivially $1. Skip the external API call — a same-token query would fail or
        // be undefined behavior on both Curve and CowSwap.
        if (tokenId.toLowerCase() === stablecoin.address.toLowerCase()) {
            const rateX1e18 = 1_000_000n * 10n ** 18n; // 1 USD = 1e6 microUSD, scaled × 1e18
            this.logger.log(
                `Dust asset ${assetConfig.ticker} on chainId=${destinationChainId} is the reference stablecoin — rate trivially $1`,
            );
            return {
                source: "Cowswap",
                microUsdPerWholeTokenX1e18: `0x${rateX1e18.toString(16)}` as Hex,
                tokenDecimals: assetConfig.decimals,
            };
        }

        const queryRateForPair =
            pricingQuoter === RateProvider.CURVE
                ? curveQueryRateForPair
                : pricingQuoter === RateProvider.COWSWAP
                    ? cowswapQueryRateForPair
                    : undefined;
        if (!queryRateForPair) {
            throw new Error(
                `Dust asset ${assetConfig.ticker} on chainId=${destinationChainId} is configured with quoter ` +
                    `${pricingQuoter}, which isn't wired for USD pricing (only Curve and CowSwap are).`,
            );
        }

        const quote = await queryRateForPair(
            dustToken,
            stablecoinToken,
            ChainType.EVM,
            destinationChainId,
            chainConfig.rpcUrl(),
        );

        const rate = microUsdPerWholeTokenX1e18(quote);
        this.logger.log(
            `Priced dust asset ${assetConfig.ticker} on chainId=${destinationChainId} via ${quote.source} against ${stablecoin.ticker}`,
        );

        return {
            source: quote.source === RateProvider.CURVE ? "Curve" : "Cowswap",
            microUsdPerWholeTokenX1e18: `0x${rate.toString(16)}` as Hex,
            tokenDecimals: assetConfig.decimals,
        };
    }
}
