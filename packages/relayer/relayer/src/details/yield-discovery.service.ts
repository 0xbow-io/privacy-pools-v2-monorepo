import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { createPublicClient, http, parseAbi, getAddress } from "viem";
import { RelayerConfig } from "../config/relayer-config";
import { EvmChainConfigWrapper } from "../config/evm/evm-chain-config";
import { ChainType } from "../config/enums";
import { FATLoggerService } from "../logger/fat.logger.provider";
import { EvmAddress } from "../config/evm/evm.types";
import { RateProvider } from "../rate_provider/rate_types";
import type { IYieldWrapper } from "../relayer.types";

// Read-only surface of a PPRouter (minr #30 / relayer-yield-discovery.md §2.2). The pinned
// write ABI in sdk/pprouter.abi.ts stays untouched; these are the immutables every router exposes.
const PP_ROUTER_VIEWS_ABI = parseAbi([
    "function VAULT() view returns (address)",
    "function UNDERLYING() view returns (address)",
    "function ZAP() view returns (address)",
]);
const ERC20_META_ABI = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

const BOOT_RPC_TIMEOUT_MS = Number(process.env.YIELD_DISCOVERY_BOOT_RPC_TIMEOUT_MS ?? 20_000);

/**
 * Publishes, per chain, the yield wrappers a client needs to bind the right processor for a
 * yield-share note: which PPRouter (the `transact` processor for `withdrawToUnderlying`),
 * which share, which underlying, which zap. Derived ON-CHAIN at boot from `allowed_processors`
 * (the routers) — never from hand-copied config — and cross-checked against the configured
 * `Underlying`-quoted assets, so a relayer that would reject or mis-route a yield withdrawal
 * refuses to boot instead (same posture as RateProviderBootValidator / YieldZapRegistry).
 *
 * Why: `RelayerInfo` carries a single caller-supplied `processorAddress`, while the relayer
 * calls the vault from PrivacyPoolRelay, RelaySwaps and each PPRouter. A client that guesses
 * wrong proves against the wrong processor and every relay of that note fails with
 * `PoolVault_ProofContextMismatch` (minr #30, and the 2026-09-01 prod incident). `/details`
 * is the one place a client can ask instead of guessing.
 */
@Injectable()
export class YieldDiscoveryService implements OnApplicationBootstrap {
    /** key: chainId -> wrappers (empty array when the chain has no routers) */
    private readonly wrappers = new Map<number, IYieldWrapper[]>();

    constructor(
        private readonly relayerConfig: RelayerConfig,
        private readonly logger: FATLoggerService
    ) {}

    async onApplicationBootstrap(): Promise<void> {
        for (const raw of this.relayerConfig.chain(ChainType.EVM).allConfigs()) {
            const chain = new EvmChainConfigWrapper(raw);
            this.wrappers.set(Number(chain.id), await this.deriveChain(chain));
        }
    }

    /** Wrappers for `chainId`, `[]` when the chain has no allowlisted routers (or isn't configured). */
    wrappersFor(chainId: number): IYieldWrapper[] {
        return this.wrappers.get(Number(chainId)) ?? [];
    }

    private async deriveChain(chain: EvmChainConfigWrapper): Promise<IYieldWrapper[]> {
        const chainId = Number(chain.id);
        const routers = chain.allowedProcessors();
        const shareAssets = chain.allAssets.filter((asset) => asset.quoter === RateProvider.UNDERLYING);

        if (routers.length === 0) {
            if (shareAssets.length > 0) {
                throw new Error(
                    `YieldDiscovery: chainId ${chainId} configures ${shareAssets.length} "Underlying"-quoted share(s) ` +
                        `(${shareAssets.map((a) => a.ticker).join(", ")}) but no allowed_processors — every yield ` +
                        `withdrawal relay would be rejected`
                );
            }
            return [];
        }

        const client = createPublicClient({ transport: http(chain.rpcUrl(), { timeout: BOOT_RPC_TIMEOUT_MS }) });
        const read = async <T>(address: EvmAddress, abi: typeof PP_ROUTER_VIEWS_ABI | typeof ERC20_META_ABI, fn: string) =>
            (await client.readContract({ address, abi, functionName: fn as never })) as T;

        const result: IYieldWrapper[] = [];
        const coveredShares = new Set<string>();
        for (const rawRouter of routers) {
            const router = getAddress(rawRouter);
            let vault: EvmAddress, underlying: EvmAddress, zap: EvmAddress;
            try {
                [vault, underlying, zap] = (
                    await Promise.all([
                        read<string>(router, PP_ROUTER_VIEWS_ABI, "VAULT"),
                        read<string>(router, PP_ROUTER_VIEWS_ABI, "UNDERLYING"),
                        read<string>(router, PP_ROUTER_VIEWS_ABI, "ZAP"),
                    ])
                ).map((a) => getAddress(a)) as [EvmAddress, EvmAddress, EvmAddress];
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                this.logger.turbo(
                    `YieldDiscovery: could not read PPRouter ${router} on chainId ${chainId} — relayer cannot ` +
                        `publish yield discovery until this RPC answers`,
                    { dedupKey: `relayer.yieldDiscovery.${chainId}`, detail }
                );
                throw new Error(`YieldDiscovery boot read failed for router ${router} on chainId ${chainId}: ${detail}`);
            }

            const share = chain.allAssets.find((a) => a.address.toLowerCase() === vault.toLowerCase());
            if (!share || share.quoter !== RateProvider.UNDERLYING) {
                throw new Error(
                    `YieldDiscovery: PPRouter ${router} on chainId ${chainId} wraps share ${vault}, which is ` +
                        (share ? `configured with quoter "${share.quoter}" instead of "Underlying"` : `not a configured asset`) +
                        ` — the relayer could not quote a withdrawal it is allowlisted to relay`
                );
            }
            if (share.underlying !== undefined && share.underlying.toLowerCase() !== underlying.toLowerCase()) {
                throw new Error(
                    `YieldDiscovery: config underlying ${share.underlying} for ${share.ticker} on chainId ${chainId} ` +
                        `does not match PPRouter ${router}.UNDERLYING() = ${underlying}`
                );
            }
            if (coveredShares.has(vault.toLowerCase())) {
                throw new Error(
                    `YieldDiscovery: two allowed_processors on chainId ${chainId} wrap the same share ${vault} ` +
                        `(${share.ticker}) — a client could not tell which processor to bind`
                );
            }
            coveredShares.add(vault.toLowerCase());

            const [ppDecimals, underlyingDecimals, underlyingSymbol] = await Promise.all([
                read<number>(vault, ERC20_META_ABI, "decimals"),
                read<number>(underlying, ERC20_META_ABI, "decimals"),
                read<string>(underlying, ERC20_META_ABI, "symbol"),
            ]);
            result.push({
                ppToken: vault,
                underlying,
                router,
                zap,
                ppDecimals: Number(ppDecimals),
                underlyingDecimals: Number(underlyingDecimals),
                underlyingSymbol,
            });
        }

        const uncovered = shareAssets.filter((a) => !coveredShares.has(a.address.toLowerCase()));
        if (uncovered.length > 0) {
            throw new Error(
                `YieldDiscovery: "Underlying"-quoted share(s) ${uncovered.map((a) => `${a.ticker} (${a.address})`).join(", ")} ` +
                    `on chainId ${chainId} have no PPRouter in allowed_processors — yield withdrawals of them would be rejected`
            );
        }

        this.logger.info(
            `YieldDiscovery: chainId ${chainId} publishes ${result.length} yield wrapper(s): ` +
                result.map((w) => `${w.underlyingSymbol}->${w.ppToken} via ${w.router}`).join("; ")
        );
        return result;
    }
}
