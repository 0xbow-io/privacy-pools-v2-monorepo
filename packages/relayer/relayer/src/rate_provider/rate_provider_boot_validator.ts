import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { DiscoveryService } from "@nestjs/core";
import { RelayerConfig } from "../config/relayer-config";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { ChainType } from "../config/enums";
import { RateProviderService } from "./rate_provider.service";
import { NATIVE_ASSET_ADDRESS } from "../config/evm/evm.types";
import { RateProvider } from "./rate_types";

// Mirrors EvmQuoteService.isNativeToken — native assets never reach a rate provider
// (evm.quote.service.ts short-circuits them before discoverRateProvider). Their
// `quoter` must therefore be the inert `Native` marker: anything else is a config that
// *claims* a real provider prices the asset when nothing ever will.
function isNativeAsset(asset: { address: string; ticker: string }): boolean {
    return asset.address.toLowerCase() === NATIVE_ASSET_ADDRESS || asset.ticker.toLowerCase() === "weth";
}

// Fails app startup if any configured asset names a quoter that either doesn't exist or
// doesn't declare support for that asset's chain — the primary gate for the whole
// chain-scoping mechanism. Given this, RateProviderService's own per-request check
// (rate_provider.service.ts) should be unreachable in practice; it stays as
// defense-in-depth for anything constructed outside the static config.
//
// The `Native` marker is enforced in both directions: native-treated assets must carry
// it, and no other asset may (there is no provider registered under that name, so a
// non-native asset marked `Native` would fail at its first quote instead of at boot).
@Injectable()
export class RateProviderBootValidator implements OnApplicationBootstrap {
    constructor(
        private readonly relayerConfig: RelayerConfig,
        private readonly discoveryService: DiscoveryService
    ) {}

    onApplicationBootstrap(): void {
        const providers = this.discoveryService.getProviders();
        const evmChains = this.relayerConfig.chain(ChainType.EVM).allConfigs().map((c) => new EvmChainConfigWrapper(c));

        for (const chain of evmChains) {
            for (const asset of chain.allAssets) {
                if (isNativeAsset(asset)) {
                    if (asset.underlying !== undefined) {
                        throw new Error(
                            `Native-treated asset ${asset.ticker} on chainId ${chain.id} sets \`underlying\` — ` +
                            `\`underlying\` is only meaningful with quoter "${RateProvider.UNDERLYING}"`
                        );
                    }
                    if (asset.quoter !== RateProvider.NATIVE) {
                        throw new Error(
                            `Native-treated asset ${asset.ticker} on chainId ${chain.id} must use quoter ` +
                            `"${RateProvider.NATIVE}" (got "${asset.quoter}"): native assets and WETH never ` +
                            `reach a rate provider, so any other quoter is a misleading no-op`
                        );
                    }
                    continue;
                }
                if (asset.quoter === RateProvider.NATIVE) {
                    throw new Error(
                        `Asset ${asset.ticker} (${asset.address}) on chainId ${chain.id} is not the native ` +
                        `asset sentinel or WETH, so it cannot use quoter "${RateProvider.NATIVE}" — pick a real ` +
                        `rate provider`
                    );
                }

                // ERC-4626 share tokens: no provider is looked up for the share itself; the
                // wiring to the underlying is what gets validated (see EvmQuoteService.quoteViaUnderlying).
                if (asset.quoter === RateProvider.UNDERLYING) {
                    const underlyingAddress = asset.underlying;
                    if (underlyingAddress === undefined) {
                        throw new Error(
                            `Asset ${asset.ticker} on chainId ${chain.id} uses quoter "${RateProvider.UNDERLYING}" ` +
                            `but has no \`underlying\` address`
                        );
                    }
                    const underlying = chain.allAssets.find(
                        (candidate) => candidate.address.toLowerCase() === underlyingAddress.toLowerCase()
                    );
                    if (!underlying) {
                        throw new Error(
                            `Asset ${asset.ticker} on chainId ${chain.id}: underlying ${asset.underlying} is not in ` +
                            `this chain's supported_assets`
                        );
                    }
                    // The zap a share is swapped through is derived on-chain at boot from
                    // RelaySwaps.approvedZapList() (see YieldZapRegistry) — a `zap` here is an
                    // optional cross-check, no longer required. YieldZapRegistry fails boot if a
                    // relay_swaps chain's Underlying asset has no allowlisted zap, or if this
                    // `zap` disagrees with the on-chain one.
                    // A Native-treated underlying (WETH, or the native sentinel) is fine: it prices 1:1 to
                    // gas, so the share prices as previewRedeem(1 share) worth of native — that is
                    // ppETH (native-mode PPRouter over WETH). Only a chained share stays out.
                    if (underlying.quoter === RateProvider.UNDERLYING) {
                        throw new Error(
                            `Asset ${asset.ticker} on chainId ${chain.id}: underlying ${underlying.ticker} is itself a ` +
                            `"${RateProvider.UNDERLYING}" share — chained wrappers are not supported`
                        );
                    }
                    continue;
                }
                if (asset.underlying !== undefined) {
                    throw new Error(
                        `Asset ${asset.ticker} on chainId ${chain.id} sets \`underlying\` but its quoter is ` +
                        `"${asset.quoter}" — \`underlying\` is only meaningful with quoter "${RateProvider.UNDERLYING}"`
                    );
                }
                if (asset.zap !== undefined) {
                    throw new Error(
                        `Asset ${asset.ticker} on chainId ${chain.id} sets \`zap\` but its quoter is ` +
                        `"${asset.quoter}" — \`zap\` is only meaningful with quoter "${RateProvider.UNDERLYING}"`
                    );
                }

                const matched = providers.find((prov) => prov.token === asset.quoter);
                const instance: RateProviderService | undefined = matched?.instance;

                if (!instance) {
                    throw new Error(
                        `No rate provider registered for quoter "${asset.quoter}" ` +
                        `(asset ${asset.ticker} on chainId ${chain.id})`
                    );
                }

                const description = instance.getDescription();
                const supported = description.known_currencies.some(
                    (currency) => currency.chainType === ChainType.EVM && currency.chainId === chain.id
                );

                if (!supported) {
                    throw new Error(
                        `Rate provider ${description.provider} does not support chainId=${chain.id} ` +
                        `(configured for asset ${asset.ticker} via quoter "${asset.quoter}")`
                    );
                }
            }
        }
    }
}
