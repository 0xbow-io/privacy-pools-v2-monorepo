import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { createPublicClient, http, parseAbi } from "viem";
import { RelayerConfig } from "../../config/relayer-config";
import { EvmChainConfigWrapper } from "../../config/evm/evm-chain-config";
import { ChainType } from "../../config/enums";
import { FATLoggerService } from "../../logger/fat.logger.provider";
import { RELAY_SWAP_ROUTING_TYPEHASH } from "./swap_routing_abi";

const RELAY_SWAPS_ROUTING_TYPEHASH_ABI = parseAbi([
    "function ROUTING_TYPEHASH() pure returns (bytes32)",
]);

const BOOT_RPC_TIMEOUT_MS = Number(process.env.ROUTING_LAYOUT_BOOT_RPC_TIMEOUT_MS ?? 20_000);

/**
 * Fails boot (loud) if any configured chain's RelaySwaps contract decodes a different
 * SwapRouting shape than this relayer's own encoder (`relaySwapRoutingParams` in
 * `swap_routing_abi.ts`) was built for. RC-32: SwapRouting is never part of any external
 * function's ABI (execute() decodes it from opaque bytes), so five of six live RelaySwaps
 * deployments were found still on an older SwapRouting layout with nothing to notice —
 * every relay-swap and reshield against one panics mid-decode only after the relayer has
 * already simulated and signed it. Reading `ROUTING_TYPEHASH()` at boot moves that failure
 * to relayer startup: an operator misconfigured to point at a stale RelaySwaps address
 * finds out immediately, not from a wave of per-request failures.
 *
 * A RelaySwaps redeploy after boot is not observed until the relayer restarts — the same
 * operational model as YieldZapRegistry's allowlist read.
 */
@Injectable()
export class RoutingLayoutBootValidator implements OnApplicationBootstrap {
    constructor(
        private readonly relayerConfig: RelayerConfig,
        private readonly logger: FATLoggerService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        const evmChains = this.relayerConfig.chain(ChainType.EVM).allConfigs().map((c) => new EvmChainConfigWrapper(c));

        for (const chain of evmChains) {
            const relaySwaps = chain.relaySwapsContractAddress();
            if (!relaySwaps) continue; // no RelaySwaps configured on this chain -- nothing to check

            const onChainTypehash = await this.readOnChainTypehash(chain.id, chain.rpcUrl(), relaySwaps);

            if (onChainTypehash.toLowerCase() !== RELAY_SWAP_ROUTING_TYPEHASH.toLowerCase()) {
                throw new Error(
                    `RoutingLayoutBootValidator: RelaySwaps at ${relaySwaps} on chainId ${chain.id} reports ` +
                        `ROUTING_TYPEHASH ${onChainTypehash}, but this relayer encodes SwapRouting for ` +
                        `${RELAY_SWAP_ROUTING_TYPEHASH} (RC-32) — relaying a swap or reshield against this ` +
                        `deployment would panic mid-decode after being signed. Confirm the configured ` +
                        `relay_swaps_contract is the current deployment for this chain.`
                );
            }
            this.logger.info(
                `RoutingLayoutBootValidator: chainId ${chain.id} RelaySwaps ${relaySwaps} routing layout OK`
            );
        }
    }

    private async readOnChainTypehash(
        chainId: number,
        rpcUrl: string,
        relaySwaps: string
    ): Promise<string> {
        const client = createPublicClient({
            transport: http(rpcUrl, { timeout: BOOT_RPC_TIMEOUT_MS }),
        });

        try {
            return await client.readContract({
                address: relaySwaps as `0x${string}`,
                abi: RELAY_SWAPS_ROUTING_TYPEHASH_ABI,
                functionName: "ROUTING_TYPEHASH",
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            this.logger.turbo(
                `RoutingLayoutBootValidator: could not read RelaySwaps.ROUTING_TYPEHASH() on chainId ` +
                    `${chainId} (${relaySwaps}) — relayer cannot safely serve swaps/reshields on this ` +
                    `chain until this RPC answers`,
                { dedupKey: `relayer.routingLayoutBootValidator.${chainId}`, detail }
            );
            throw new Error(`RoutingLayoutBootValidator boot read failed for chainId ${chainId}: ${detail}`);
        }
    }
}
