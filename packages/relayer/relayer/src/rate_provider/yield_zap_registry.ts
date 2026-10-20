import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { RelayerConfig } from "../config/relayer-config";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { ChainType } from "../config/enums";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { EvmAddress } from "../config/evm/evm.types";
import { RateProvider } from "./rate_types";

// Read-only surface the registry needs. `approvedZapList()` is the enumerable form of
// RelaySwaps' owner allowlist; each entry's share is fixed by the zap's own `VAULT()`.
const RELAY_SWAPS_ZAP_LIST_ABI = parseAbi(["function approvedZapList() view returns (address[])"]);
const YIELD_ZAP_ABI = parseAbi([
    "function VAULT() view returns (address)",
    "function UNDERLYING() view returns (address)",
]);

const BOOT_RPC_TIMEOUT_MS = Number(process.env.YIELD_ZAP_BOOT_RPC_TIMEOUT_MS ?? 20_000);

/**
 * Derives, at boot, the share -> zap map every yield swap needs, by reading
 * `RelaySwaps.approvedZapList()` on-chain — the contract allowlist is the single source of
 * truth, not a hand-copied `supported_assets[].zap` field. See
 * `docs/tech-design/future-ideas/relayer-yield-discovery.md`.
 *
 * Fails boot (loud) on any inconsistency for a chain that actually configures an
 * `"Underlying"`-quoted asset: an RPC that will not answer, a configured share with no
 * allowlisted zap, a config `zap` that disagrees with the on-chain one, or a zap whose
 * on-chain `UNDERLYING()` does not match the asset's configured `underlying`. A chain with
 * no yield assets never touches its RPC here. A chain with yield assets but no
 * `relay_swaps_contract` is skipped with a warning: its shares relay as plain withdrawals
 * through the PPRouter, and yield swaps there are refused upstream.
 *
 * A `ZapRemoved` on-chain after boot is not observed until the relayer restarts — the same
 * operational model as the router allowlist.
 */
@Injectable()
export class YieldZapRegistry implements OnApplicationBootstrap {
    /** key: `${chainId}:${shareAddressLowercase}` -> checksummed zap address */
    private readonly zaps = new Map<string, EvmAddress>();

    constructor(
        private readonly relayerConfig: RelayerConfig,
        private readonly logger: FATLoggerService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const evmChains = this.relayerConfig.chain(ChainType.EVM).allConfigs().map((c) => new EvmChainConfigWrapper(c));

        for (const chain of evmChains) {
            const relaySwaps = chain.relaySwapsContractAddress();
            const underlyingAssets = chain.allAssets.filter(
                (asset) => asset.quoter === RateProvider.UNDERLYING
            );
            if (underlyingAssets.length === 0) continue; // no yield swaps on this chain
            if (!relaySwaps) {
                // Shares still relay as plain withdrawals through their PPRouter; only the swap
                // (unwrap) path needs a zap, and quoteSwap/relaySwap already refuse a chain
                // without RelaySwaps.
                this.logger.warn(
                    `YieldZapRegistry: chainId ${chain.id} configures ${underlyingAssets.length} "Underlying"-quoted ` +
                        `asset(s) but has no relay_swaps_contract — yield swaps disabled on this chain, ` +
                        `withdrawals unaffected`
                );
                continue;
            }

            const onChain = await this.readOnChainZaps(chain.id, chain.rpcUrl(), relaySwaps);
            this.reconcile(chain, onChain);
        }
    }

    /**
     * The zap RelaySwaps will redeem `share` through on this chain, or `undefined` if the
     * share is not a boot-derived yield asset. Callers pass this to
     * `RelaySwaps.executeUnwrapped(..., zap)`.
     */
    zapForShare(chainId: number, share: string): EvmAddress | undefined {
        return this.zaps.get(`${chainId}:${share.toLowerCase()}`);
    }

    private async readOnChainZaps(
        chainId: number,
        rpcUrl: string,
        relaySwaps: EvmAddress
    ): Promise<Map<string, { zap: EvmAddress; underlying: EvmAddress }>> {
        const client = createPublicClient({
            transport: http(rpcUrl, { timeout: BOOT_RPC_TIMEOUT_MS }),
        });

        let zapList: readonly string[];
        try {
            zapList = await client.readContract({
                address: relaySwaps,
                abi: RELAY_SWAPS_ZAP_LIST_ABI,
                functionName: "approvedZapList",
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.turbo(
                `YieldZapRegistry: could not read RelaySwaps.approvedZapList() on chainId ${chainId} ` +
                    `(${relaySwaps}) — relayer cannot serve yield swaps until this RPC answers`,
                { dedupKey: `relayer.yieldZapRegistry.${chainId}`, detail }
            );
            throw new Error(
                `YieldZapRegistry boot read failed for chainId ${chainId}: ${detail}`
            );
        }

        const result = new Map<string, { zap: EvmAddress; underlying: EvmAddress }>();
        for (const rawZap of zapList) {
            const zap = getAddress(rawZap);
            const [share, underlying] = await Promise.all([
                client.readContract({ address: zap, abi: YIELD_ZAP_ABI, functionName: "VAULT" }),
                client.readContract({ address: zap, abi: YIELD_ZAP_ABI, functionName: "UNDERLYING" }),
            ]);
            result.set(getAddress(share).toLowerCase(), {
                zap,
                underlying: getAddress(underlying),
            });
        }
        return result;
    }

    private reconcile(
        chain: EvmChainConfigWrapper,
        onChain: Map<string, { zap: EvmAddress; underlying: EvmAddress }>
    ): void {
        const chainId = chain.id;
        const configuredShares = new Set(
            chain.allAssets
                .filter((asset) => asset.quoter === RateProvider.UNDERLYING)
                .map((asset) => asset.address.toLowerCase())
        );

        // An allowlisted zap whose share this relayer does not price is not an error — the
        // RelaySwaps contract may be shared across relayers — but log it so a missing config
        // entry is visible.
        for (const [shareLower, { zap }] of onChain) {
            if (!configuredShares.has(shareLower)) {
                this.logger.warn(
                    `YieldZapRegistry: RelaySwaps on chainId ${chainId} allowlists zap ${zap} for share ` +
                        `${shareLower}, which is not a configured "Underlying" asset — ignoring`
                );
            }
        }

        for (const asset of chain.allAssets) {
            if (asset.quoter !== RateProvider.UNDERLYING) continue;
            const shareLower = asset.address.toLowerCase();
            const entry = onChain.get(shareLower);
            if (!entry) {
                throw new Error(
                    `YieldZapRegistry: "Underlying" asset ${asset.ticker} (${asset.address}) on chainId ` +
                        `${chainId} has no allowlisted zap on RelaySwaps — RelaySwaps.executeUnwrapped cannot ` +
                        `serve it. Run approveZap(zap) for its wrapper.`
                );
            }
            if (asset.zap !== undefined && asset.zap.toLowerCase() !== entry.zap.toLowerCase()) {
                throw new Error(
                    `YieldZapRegistry: config zap ${asset.zap} for ${asset.ticker} on chainId ${chainId} ` +
                        `disagrees with the on-chain allowlisted zap ${entry.zap}`
                );
            }
            if (
                asset.underlying !== undefined &&
                asset.underlying.toLowerCase() !== entry.underlying.toLowerCase()
            ) {
                throw new Error(
                    `YieldZapRegistry: zap ${entry.zap} for ${asset.ticker} on chainId ${chainId} redeems into ` +
                        `${entry.underlying}, but the asset's configured underlying is ${asset.underlying}`
                );
            }
            this.zaps.set(`${chainId}:${shareLower}`, entry.zap);
            this.logger.info(
                `YieldZapRegistry: chainId ${chainId} share ${asset.ticker} -> zap ${entry.zap}`
            );
        }
    }
}
