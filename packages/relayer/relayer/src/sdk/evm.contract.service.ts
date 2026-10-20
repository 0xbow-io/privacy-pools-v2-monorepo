import { Address, Hash, Hex } from "viem";
import { EvmRelaySDKPayload, EvmRelaySwapPayload, EvmRelayRegisterSDKPayload, EvmRelayAndAnnounceSDKPayload } from "../relay/evm/types";
import { Injectable, Scope } from "@nestjs/common";
import { Wei, BPS } from "../quote/evm/unit.types";
import { EVMChainService } from "../chain.service/evm.chain.service";
import { EvmConfigService } from "../config/evm/evm-config.service";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { chainKey } from "../config/chain-key";
import { ChainType } from "../config/enums";
import { ENTRYPOINT_ABI } from "./entrypoint.abi";
import { decodeFeeSplit } from "../relay/evm/fee_abi";
import { decodeRelaySwapRouting } from "../relay/evm/swap_routing_abi";

interface EvmWithdrawResponse {
    recipientCommitments?: Hash[];
    amountOut: bigint;
    recipientAddress: Address;
    fee: bigint;
    txHash: Hex;
}

interface EvmTransferResponse {
    // recipientCommitment?: Hash;
    // changeCommitment?: Hash;
    // nullifiers?: Hash[];
    fee: bigint;
    txHash: Hex;
}

interface EvmAssetConfig {
    enabled: boolean;
    vettingFeeBPS: BPS;
    minAmount: Wei;
    maxRelayFee: Wei;
}

// Caches Entrypoint.assets(address) per chain+entrypoint+asset for 60s — the
// config (maxRelayFee et al.) changes only on rare governance action, yet was
// an eth_call on every single quote. Staleness is bounded and safe: the relay
// contract re-reads maxRelayFee on-chain at relay time, so a stale cache can
// at worst produce a commitment the chain rejects (liveness blip, not a fee
// bypass). Module-level because the service is request-scoped (same rationale
// as the gas-price cache in evm.chain.service.ts). Keyed via chainKey(), not a
// bare chainId — an EVM chain and a Stellar (or future Starknet) chain sharing
// a numeric id, with an asset address format that happened to coincide, would
// otherwise silently read/write each other's cached asset config.
const ASSET_CONFIG_TTL_MS = Number(process.env.ASSET_CONFIG_TTL_MS ?? 60_000);
const assetConfigCache = new Map<string, { value: EvmAssetConfig; expiresAt: number }>();

@Injectable({ scope: Scope.REQUEST })
export class EvmContractService {
    constructor(
        private readonly chainService: EVMChainService,
        private readonly configService: EvmConfigService,
        private readonly logger: FATLoggerService
    ) {}

    // functions from PoolSession contract

    async sdkWithdraw(params: EvmRelaySDKPayload, value?: bigint): Promise<EvmWithdrawResponse> {
        try {
            const txHash = await this.chainService.simulateAndWriteRelayWithdrawal(params, value);
            const feeSplit = decodeFeeSplit(params.data);

            return {
                amountOut: params.proof.parsedPubSignals.amountOut,
                recipientAddress: feeSplit.recipient,
                fee: feeSplit.feeAmount,
                txHash,
            };
        } catch (e) {
            this.logger.error("sdkWithdraw failed", e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    async sdkRegisterAndWithdraw(params: EvmRelayRegisterSDKPayload, value?: bigint): Promise<EvmWithdrawResponse> {
        try {
            const txHash = await this.chainService.simulateAndWriteRegisterAndRelay(params, value);
            const feeSplit = decodeFeeSplit(params.data);

            return {
                amountOut: params.proof.parsedPubSignals.amountOut,
                recipientAddress: feeSplit.recipient,
                fee: feeSplit.feeAmount,
                txHash,
            };
        } catch (e) {
            this.logger.error("sdkRegisterAndWithdraw failed", e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    async sdkRelayAndAnnounce(
        params: EvmRelayAndAnnounceSDKPayload,
        value?: bigint
    ): Promise<EvmWithdrawResponse> {
        try {
            const txHash = await this.chainService.simulateAndWriteRelayAndAnnounce(params, value);
            const feeSplit = decodeFeeSplit(params.data);

            return {
                amountOut: params.proof.parsedPubSignals.amountOut,
                recipientAddress: feeSplit.recipient,
                fee: feeSplit.feeAmount,
                txHash,
            };
        } catch (e) {
            this.logger.error("sdkRelayAndAnnounce failed", e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    async sdkRelaySwap(params: EvmRelaySwapPayload): Promise<EvmWithdrawResponse> {
        try {
            const txHash = await this.chainService.simulateAndWriteRelaySwap(params);
            const routing = decodeRelaySwapRouting(params.data);

            return {
                amountOut: params.proof.parsedPubSignals.amountOut,
                recipientAddress: routing.recipient,
                fee: routing.feeAmount,
                txHash,
            };
        } catch (e) {
            this.logger.error("sdkRelaySwap failed", e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    async sdkTransfer(params: EvmRelaySDKPayload): Promise<EvmTransferResponse> {
        try {
            const txHash = await this.chainService.simulateAndWriteRelayTransfer(params);
            const feeSplit = decodeFeeSplit(params.data);

            return {
                fee: feeSplit.feeAmount,
                txHash,
            };
        } catch (e) {
            this.logger.error("sdkTransfer failed", e instanceof Error ? e.message : String(e));
            throw e;
        }
    }

    async ping(): Promise<string> {
        return "pong";
    }

    async getAssetConfig(asset: Address): Promise<EvmAssetConfig> {
        const entryPointAddress = this.configService.entrypointContractAddress();
        const cacheKey = `${chainKey(ChainType.EVM, this.configService.chainId())}:${entryPointAddress}:${asset.toLowerCase()}`;
        const now = Date.now();
        const cached = assetConfigCache.get(cacheKey);
        if (cached && now < cached.expiresAt) return cached.value;

        const result = await this.chainService.readContract({
            address: entryPointAddress,
            abi: ENTRYPOINT_ABI,
            functionName: "assets",
            args: [asset],
        });
        const value: EvmAssetConfig = {
            enabled: true,
            vettingFeeBPS: BPS(BigInt(result.vettingFeeBPS)),
            minAmount: Wei(result.minAmount),
            maxRelayFee: Wei(result.maxRelayFee),
        };
        assetConfigCache.set(cacheKey, { value, expiresAt: now + ASSET_CONFIG_TTL_MS });
        return value;
    }
}
