import { Injectable, Scope } from "@nestjs/common";
import { createPublicClient, formatUnits, http, type Address, type PublicClient } from "viem";
import { ChainType } from "../../config/enums";
import { EvmChainConfigWrapper } from "../../config/evm/evm-chain-config";
import { EvmConfigService } from "../../config/evm/evm-config.service";
import { RelayerConfig } from "../../config/relayer-config";
import { computeChainProfitability, type ProfitabilityChainConfig, type ProfitabilityChainReport } from "../relayer-profitability.lib";
import type { IReportService, NativeBalanceReport, ProfitMarginReport, ReportOptions } from "../report.interface";

const DEFAULT_PROFIT_MARGIN_COUNT = 10;
const RPC_TIMEOUT_MS = 30_000;
const RPC_RETRY_COUNT = 2;

// Public clients cached per chainId — read-only, deliberately separate from EVMChainService's own
// cache: a bug in report code must never touch the hot relay/broadcast path's state.
const publicClientCache = new Map<string, PublicClient>();
function clientFor(rpcUrl: string, chainId: number): PublicClient {
    // Keyed by chain AND endpoint: keying by chain alone would keep serving a stale URL after a config change.
    const key = `${chainId}:${rpcUrl}`;
    const cached = publicClientCache.get(key);
    if (cached) return cached;
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT }) });
    publicClientCache.set(key, client);
    return client;
}

function toLibConfig(chainId: number, wrapper: EvmChainConfigWrapper): ProfitabilityChainConfig {
    return {
        id: chainId,
        name: wrapper.name,
        rpcUrl: wrapper.rpcUrl(),
        relayContract: wrapper.relayContractAddress(),
        poolVaultContract: wrapper.poolVaultContractAddress(),
        relaySwapsContract: wrapper.relaySwapsContractAddress(),
        feeReceiverAddress: wrapper.feeReceiverAddress(),
        allowedProcessors: wrapper.allowedProcessors(),
        nativeCurrency: wrapper.nativeCurrency(),
        supportedAssets: wrapper.allAssets.map((a) => ({ address: a.address, ticker: a.ticker, decimals: a.decimals, underlying: a.underlying })),
    };
}

/** Read-only EVM reports: no signer key is ever used, only the signer's public address. */
@Injectable({ scope: Scope.REQUEST })
export class EvmReportService implements IReportService {
    constructor(
        private readonly config: EvmConfigService,
        private readonly relayerConfig: RelayerConfig
    ) {}

    async nativeAssetBalance(): Promise<NativeBalanceReport> {
        const wrapper = this.config.chainConfig();
        const client = clientFor(wrapper.rpcUrl(), this.config.chainId());
        const balance = await client.getBalance({ address: wrapper.signerAddress() });
        const native = wrapper.nativeCurrency();
        return {
            chainId: this.config.chainId(),
            chainName: wrapper.name,
            amount: formatUnits(balance, native.decimals),
            symbol: native.symbol,
        };
    }

    async profitMargin(_opts: ReportOptions = {}): Promise<ProfitMarginReport> {
        const wrapper = this.config.chainConfig();
        const chain = toLibConfig(this.config.chainId(), wrapper);
        const byChainId = this.allChainsById();
        const signer = wrapper.signerAddress() as Address;
        const report = await computeChainProfitability(chain, byChainId, signer, { count: DEFAULT_PROFIT_MARGIN_COUNT });
        return {
            chainId: chain.id,
            chainName: chain.name,
            summary: formatSummary(chain, report),
        };
    }

    /**
     * Every configured EVM chain, not just this one — a chain's native-price feed can live on a
     * different chain (e.g. cBTC's is read on mainnet), so computeChainProfitability needs the full
     * set to resolve those cross-chain lookups.
     */
    private allChainsById(): Map<number, ProfitabilityChainConfig> {
        const configs = this.relayerConfig.chain(ChainType.EVM).allConfigs();
        return new Map(configs.map((raw) => [raw.id, toLibConfig(raw.id, new EvmChainConfigWrapper(raw))]));
    }
}

const usd = (n: number) => (Number.isNaN(n) ? "n/a" : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`);

function formatSummary(chain: ProfitabilityChainConfig, report: ProfitabilityChainReport): string {
    const lines = [
        `${report.chainName} (${report.chainId}): ${report.relayCount} relays, cost ${usd(report.costUsd)}, earned ${usd(report.revenueUsd)}, NET ${usd(report.netUsd)}`,
    ];
    if (report.revertedCount) lines.push(`  ${report.revertedCount} reverted (${usd(report.revertedCostUsd)} burnt)`);
    if (report.leakedUsd) lines.push(`  fees paid to non-relayer addresses: ${usd(report.leakedUsd)}`);
    lines.push(`  signer balance: ${formatUnits(report.balanceNative, chain.nativeCurrency.decimals)} ${report.nativeSymbol}`);
    return lines.join("\n");
}
