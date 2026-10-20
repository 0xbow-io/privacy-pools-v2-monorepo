import { Injectable } from "@nestjs/common";
import { RelayerConfig } from "../config/relayer-config";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { ChainType } from "../config/enums";
import type { EvmAddress, EvmChainId } from "../config/evm/evm.types";
import type { IAssetConfig, IChainConfig, IChainContracts, IFullConfig } from "../relayer.types";
import type { BPS, Wei } from "../quote/evm/unit.types";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { version as relayerVersion } from "../../package.json";
import { YieldDiscoveryService } from "./yield-discovery.service";
import { ChainedDetailsService } from "./details.interface";

@Injectable()
export class EvmDetailsService implements ChainedDetailsService<ChainType.EVM> {
    constructor(
        private readonly logger: FATLoggerService,
        private readonly relayerConfig: RelayerConfig,
        private readonly yieldDiscovery: YieldDiscoveryService
    ) {
        this.logger.setContext(EvmDetailsService.name);
    }

    async assetDetails(chainId: EvmChainId, asset: EvmAddress): Promise<IAssetConfig> {
        this.logger.info("Fetching asset details", { chainId, asset });

        const chain = new EvmChainConfigWrapper(this.relayerConfig.chain(ChainType.EVM).config(chainId));
        const assetConfig = chain.asset(asset);

        return this.mapAsset(assetConfig, chain.flatFeeAmount());
    }

    async chainDetails(chainId: EvmChainId): Promise<IChainConfig> {
        this.logger.info("Fetching chain details", { chainId });

        const chain = new EvmChainConfigWrapper(this.relayerConfig.chain(ChainType.EVM).config(chainId));
        const contracts = this.mapContracts(
            chain.entrypointContractAddress(),
            chain.poolVaultContractAddress(),
            chain.relayContractAddress(),
            chain.relaySwapsContractAddress()
        );

        return {
            id: chain.id,
            name: chain.name,
            type: ChainType.EVM,
            contracts,
            swapsSupported: contracts.relaySwaps !== undefined,
            destinationCallsSupported: chain.destinationCallsSupported(),
            assets: chain.allAssets.map((a) => this.mapAsset(a, chain.flatFeeAmount())),
            // Discovery (minr #30): everything a client used to hand-copy into RelayerInfo /
            // PoolSessionConfig — the signer, every alternate processor, and the yield wrappers
            // (router = the processor to bind for a yield-share note).
            relayerAddress: chain.signerAddress(),
            processors: chain.allowedProcessors(),
            yield: this.yieldDiscovery.wrappersFor(Number(chain.id)),
            // The same ceiling quoteSwap / relaySwap enforce (env override included), so a
            // client can size or refuse before proving.
            maxSwapValueWei: chain.maxSwapValueWei(),
        };
    }

    async allDetails(): Promise<IFullConfig> {
        this.logger.info("Fetching all available chains");

        const config = this.relayerConfig.fullConfig();
        // One code path per chain (chainDetails) so the full listing can never drift from the
        // per-chain one — it used to rebuild the shape from the raw config here.
        //
        // Chainless GET /details is intentionally EVM-only: DETAILS_SERVICE's factory only ever
        // falls back to EvmDetailsService when no chainType is in the route (details.module.ts),
        // so this service has no business reporting on other chains' config — skip them rather
        // than crash (a real risk now that Stellar is a genuinely configured chain type, not just
        // a reserved enum slot). Use GET /details/stellar/:chainId for Stellar chain details.
        const chains = await Promise.all(
            (config.chains[ChainType.EVM] ?? []).map((c) => this.chainDetails(c.id as EvmChainId))
        );
        return { version: relayerVersion, chains };
    }

    private mapContracts(
        entrypoint: EvmAddress,
        poolVault: EvmAddress,
        relay: EvmAddress,
        relaySwaps: EvmAddress | undefined
    ): IChainContracts {
        // Zero-address config placeholders mean "no RelaySwaps on this chain" — advertise
        // the field as absent rather than echoing 0x0 for clients to accidentally target.
        const isUnset = !relaySwaps || /^0x0{40}$/i.test(relaySwaps);
        return {
            entrypoint,
            poolVault,
            relay,
            ...(isUnset ? {} : { relaySwaps }),
        };
    }

    private mapAsset(asset: { address: EvmAddress; ticker: string; fee_bps?: BPS }, flatFee: Wei): IAssetConfig {
        return {
            address: asset.address,
            ticker: asset.ticker,
            fixedFeeAmount: flatFee,
            ...(asset.fee_bps && { feeBPS: asset.fee_bps }),
        };
    }
}
