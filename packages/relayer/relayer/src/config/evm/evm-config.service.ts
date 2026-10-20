import { Inject, Injectable, Scope } from "@nestjs/common";
import { EvmChainConfigWrapper } from "./evm-chain-config";
import { RelayerConfig } from "../relayer-config";
import { ChainType } from "../enums";
import { CHAIN_CONTEXT } from "../../core/chain-context.token";
import type { ChainContext } from "../../core/chain-context.token";

export type RelayOp = "transfer" | "withdrawal";

@Injectable({ scope: Scope.REQUEST })
export class EvmConfigService {
    private readonly chain: EvmChainConfigWrapper;
    private readonly context: ChainContext;

    constructor(@Inject(CHAIN_CONTEXT) context: ChainContext, relayerConfig: RelayerConfig) {
        this.context = context;
        this.chain = new EvmChainConfigWrapper(relayerConfig.chain(ChainType.EVM).config(context.chainId));
    }

    chainConfig(): EvmChainConfigWrapper {
        return this.chain;
    }

    chainId(): number {
        return this.context.chainId;
    }

    chainType(): ChainType {
        return this.context.chainType;
    }

    isFeeReceiverSameAsSigner() {
        return this.chain.isFeeReceiverSameAsSigner();
    }

    signerPrivateKey() {
        return this.chain.signerPrivateKey();
    }

    signerAddress() {
        return this.chain.signerAddress();
    }

    /**
     * Default processor address the relayer binds into transactParams for the given
     * operation. Clients must bind this same address into their proof context.
     * Transfers call PoolVault.transact directly, so the processor is the
     * relayer signer; withdrawals route through the relay contract.
     */
    processorAddress(op: RelayOp) {
        return op === "transfer" ? this.chain.signerAddress() : this.chain.relayContractAddress();
    }

    entrypointContractAddress() {
        return this.chain.entrypointContractAddress();
    }

    relayContractAddress() {
        return this.chain.relayContractAddress();
    }

    poolVaultContractAddress() {
        return this.chain.poolVaultContractAddress();
    }

    allowedProcessors() {
        return this.chain.allowedProcessors();
    }

    isAllowedProcessor(address: string) {
        return this.chain.isAllowedProcessor(address);
    }

    relaySwapsContractAddress() {
        return this.chain.relaySwapsContractAddress();
    }

    feeReceiverAddress() {
        return this.chain.feeReceiverAddress();
    }

    asset(address: string) {
        return this.chain.asset(address);
    }

    rpcUrl() {
        return this.chain.rpcUrl();
    }

    assetByTicker(ticker: string) {
        return this.chain.assetByTicker(ticker);
    }

    allAssets() {
        return this.chain.allAssets;
    }

    nativeCurrency() {
        return this.chain.nativeCurrency();
    }

    flatFeeAmount() {
        return this.chain.flatFeeAmount();
    }

    maxSwapValueWei() {
        return this.chain.maxSwapValueWei();
    }

    relayGasCapMultiplier() {
        return this.chain.relayGasCapMultiplier();
    }

    quoteExpirationMs() {
        return this.chain.quoteExpirationMs();
    }
}
