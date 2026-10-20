import { Injectable } from "@nestjs/common";
import { RelayerConfig } from "../config/relayer-config";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { ChainType } from "../config/enums";
import { StellarChainConfigWrapper } from "../config/stellar/stellar-chain-config";
import type { StellarAddress, StellarAssetConfig } from "../config/types";
import type { IStellarAssetConfig, IStellarChainConfig, IStellarChainContracts, IStellarFullConfig } from "./details.interface";
import { ChainedDetailsService } from "./details.interface";
import { version as relayerVersion } from "../../package.json";

@Injectable()
export class StellarDetailsService implements ChainedDetailsService<ChainType.STELLAR> {
    constructor(
        private readonly logger: FATLoggerService,
        private readonly relayerConfig: RelayerConfig
    ) {
        this.logger.setContext(StellarDetailsService.name);
    }

    async assetDetails(chainId: number, asset: string): Promise<IStellarAssetConfig> {
        this.logger.info("Fetching asset details", { chainId, asset });

        const chain = new StellarChainConfigWrapper(this.relayerConfig.chain(ChainType.STELLAR).config(chainId));
        const assetConfig = chain.asset(asset);

        return this.mapAsset(assetConfig, chain.flatFeeAmount(asset));
    }

    async chainDetails(chainId: number): Promise<IStellarChainConfig> {
        this.logger.info("Fetching chain details", { chainId });

        const chain = new StellarChainConfigWrapper(this.relayerConfig.chain(ChainType.STELLAR).config(chainId));
        const contracts = this.mapContracts(chain);

        return {
            id: chain.id,
            name: chain.name,
            type: ChainType.STELLAR,
            contracts,
            assets: chain.allAssets.map((a) => this.mapAsset(a, chain.flatFeeAmount(a.address))),
            relayerAddress: chain.signerAddress(),
        };
    }

    async allDetails(): Promise<IStellarFullConfig> {
        this.logger.info("Fetching all available Stellar chains");

        const config = this.relayerConfig.fullConfig();
        const stellarChains = config.chains[ChainType.STELLAR] ?? [];
        const chains = await Promise.all(stellarChains.map((c) => this.chainDetails(c.id)));
        return { version: relayerVersion, chains };
    }

    private mapContracts(chain: StellarChainConfigWrapper): IStellarChainContracts {
        return {
            pool: chain.poolContractId(),
            relay: chain.relayContractId(),
            keystore: chain.keystoreContractId(),
            aspRegistry: chain.aspRegistryContractId(),
        };
    }

    private mapAsset(asset: StellarAssetConfig, flatFee: bigint): IStellarAssetConfig {
        return {
            address: asset.address as StellarAddress,
            ticker: asset.ticker,
            fixedFeeAmount: flatFee,
            ...(asset.fee_bps !== undefined && { feeBPS: Number(asset.fee_bps) }),
        };
    }
}
