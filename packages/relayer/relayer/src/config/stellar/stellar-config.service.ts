import { Inject, Injectable, Scope } from "@nestjs/common";
import { StellarChainConfigWrapper } from "./stellar-chain-config";
import { RelayerConfig } from "../relayer-config";
import { ChainType } from "../enums";
import { CHAIN_CONTEXT } from "../../core/chain-context.token";
import type { ChainContext } from "../../core/chain-context.token";

@Injectable({ scope: Scope.REQUEST })
export class StellarConfigService {
    private readonly chain: StellarChainConfigWrapper;
    private readonly context: ChainContext;

    constructor(@Inject(CHAIN_CONTEXT) context: ChainContext, relayerConfig: RelayerConfig) {
        this.context = context;
        this.chain = new StellarChainConfigWrapper(relayerConfig.chain(ChainType.STELLAR).config(context.chainId));
    }

    chainConfig(): StellarChainConfigWrapper {
        return this.chain;
    }

    chainId(): number {
        return this.context.chainId;
    }

    chainType(): ChainType {
        return this.context.chainType;
    }

    networkPassphrase() {
        return this.chain.networkPassphrase();
    }

    rpcUrl() {
        return this.chain.rpcUrl();
    }

    poolContractId() {
        return this.chain.poolContractId();
    }

    relayContractId() {
        return this.chain.relayContractId();
    }

    keystoreContractId() {
        return this.chain.keystoreContractId();
    }

    aspRegistryContractId() {
        return this.chain.aspRegistryContractId();
    }

    signerSecretKey() {
        return this.chain.signerSecretKey();
    }

    feeReceiverAddress() {
        return this.chain.feeReceiverAddress();
    }

    signerAddress() {
        return this.chain.signerAddress();
    }

    asset(address: string) {
        return this.chain.asset(address);
    }

    assetByTicker(ticker: string) {
        return this.chain.assetByTicker(ticker);
    }

    allAssets() {
        return this.chain.allAssets;
    }

    yieldRouterFor(asset: string) {
        return this.chain.yieldRouterFor(asset);
    }

    /** The flat fee for `asset` in its own base units (a yield share's: its underlying's), or the chain default. */
    flatFeeAmount(asset?: string) {
        return this.chain.flatFeeAmount(asset);
    }

    quoteExpirationMs() {
        return this.chain.quoteExpirationMs();
    }
}
