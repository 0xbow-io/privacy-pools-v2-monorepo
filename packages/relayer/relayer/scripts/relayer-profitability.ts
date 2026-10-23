/**
 * Relayer profitability report — read-only. CLI wrapper around the core dissection logic in
 * `src/report/relayer-profitability.lib.ts` (shared with `EvmReportService`, which runs the same
 * computation on demand via the Telegram `/current_profit_margins` command). See that file's
 * header for the full method description (how txs are found, which events count as revenue, how
 * prices are valued).
 *
 * Usage (from packages/relayer/relayer):
 *   RPC_URL_EVM_1=… RPC_URL_EVM_56=… npx tsx scripts/relayer-profitability.ts \
 *     [--config ../../swaps/.relayer-prod-config.json] [--signer 0x9e2f…] [--count 10] \
 *     [--chains 1,56] [--fee-receiver 0x…,0x…] [--json out.json] [--include-ops] [--max-scan 200]
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { formatUnits, getAddress } from "viem";
import {
    computeChainProfitability,
    type ProfitabilityChainConfig,
    type ProfitabilityChainReport,
} from "../src/report/relayer-profitability.lib";

function arg(name: string, fallback?: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : fallback;
}
const CONFIG_PATH = resolve(arg("config", resolve(__dirname, "../../../swaps/.relayer-prod-config.json"))!);
const SIGNER = getAddress(arg("signer", "0x9e2f1B234953F46c6091636290E9035618EA3C07")!);
const COUNT = Number(arg("count", "10"));
const CHAINS_ARG = arg("chains");
const EXTRA_FEE_RECEIVERS = (arg("fee-receiver") ?? "")
    .split(",")
    .filter(Boolean)
    .map((a) => getAddress(a));
const JSON_OUT = arg("json");
const INCLUDE_OPS_IN_COUNT = process.argv.includes("--include-ops");
const MAX_SCAN = Number(arg("max-scan", "200"));

interface FileAssetCfg { address: string; ticker: string; decimals: number; quoter?: string; underlying?: string }
interface FileChainCfg {
    id: number;
    name: string;
    rpc_url: string;
    relay_contract: string;
    pool_vault_contract: string;
    relay_swaps_contract?: string;
    fee_receiver_address?: string;
    allowed_processors?: string[];
    native_currency: { symbol: string; decimals: number };
    supported_assets: FileAssetCfg[];
}
const fileConfig = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { chains: { evm: FileChainCfg[] } };
const selectedChains = fileConfig.chains.evm.filter((c) => !CHAINS_ARG || CHAINS_ARG.split(",").map(Number).includes(c.id));

function toLibConfig(c: FileChainCfg): ProfitabilityChainConfig {
    const envRpcUrl = process.env[`RPC_URL_EVM_${c.id}`];
    return {
        id: c.id,
        name: c.name,
        rpcUrl: envRpcUrl ?? c.rpc_url,
        relayContract: c.relay_contract,
        poolVaultContract: c.pool_vault_contract,
        relaySwapsContract: c.relay_swaps_contract,
        feeReceiverAddress: process.env[`FEE_RECEIVER_ADDRESS_EVM_${c.id}`] ?? c.fee_receiver_address,
        allowedProcessors: c.allowed_processors,
        nativeCurrency: c.native_currency,
        supportedAssets: c.supported_assets.map((a) => ({ address: a.address, ticker: a.ticker, decimals: a.decimals, underlying: a.underlying })),
    };
}

// Every chain in the file is in scope for cross-chain native-price-feed lookups (e.g. cBTC's feed
// is read on mainnet), even when `--chains` narrows which ones get a full dissection.
const byChainId = new Map(fileConfig.chains.evm.map((c) => [c.id, toLibConfig(c)]));

const usd = (n: number) => (Number.isNaN(n) ? "   n/a" : `${n < 0 ? "-" : " "}$${Math.abs(n).toFixed(4)}`);

function printChain(chain: ProfitabilityChainConfig, report: ProfitabilityChainReport): void {
    console.log(
        `== ${report.chainName} (${report.chainId}) — signer nonce ${report.nonce}, balance ` +
            `${formatUnits(report.balanceNative, chain.nativeCurrency.decimals)} ${report.nativeSymbol} (@ $${report.nativePriceUsd.toFixed(2)})`,
    );
    if (report.nonce === 0) {
        console.log("   no transactions\n");
        return;
    }

    for (const r of report.rows) {
        const rev = r.revenue.map((x) => `${x.amount} ${x.ticker} (${usd(x.usd).trim()}, ${x.source})`).join("; ") || "—";
        const leak = r.feeElsewhere.length ? `  !! fee paid to ${r.feeElsewhere.map((f) => `${f.to} ${f.amount} ${f.ticker}`).join("; ")}` : "";
        console.log(
            `   #${r.nonce} ${r.time} ${r.status === "reverted" ? "REVERTED " : ""}${r.kind}\n` +
                `      gas ${r.gasUsed} → ${formatUnits(r.gasCostNative, chain.nativeCurrency.decimals)} ${report.nativeSymbol}` +
                `${r.valueSentNative > 0n ? ` + sent ${formatUnits(r.valueSentNative, chain.nativeCurrency.decimals)}` : ""}` +
                ` | cost ${usd(r.costUsd)} | earned ${usd(r.revenueUsd)} [${rev}] | net ${usd(r.netUsd)}${leak}\n` +
                `      ${r.hash}`,
        );
    }
    if (report.opsCount) console.log(`   (ops txs, not relays: ${report.opsCount}, gas+value ${usd(report.opsCostUsd)} — excluded from the relay NET below)`);
    console.log(
        `   -- ${report.chainName}: ${report.relayCount} relays, cost ${usd(report.costUsd)}, earned ${usd(report.revenueUsd)}, NET ${usd(report.netUsd)}` +
            `${report.revertedCount ? ` | ${report.revertedCount} reverted (${usd(report.revertedCostUsd)} burnt)` : ""}` +
            `${report.leakedUsd ? ` | fees paid to non-relayer addresses: ${usd(report.leakedUsd)}` : ""}\n`,
    );
}

(async () => {
    console.log(`Relayer profitability — signer ${SIGNER}, last ${COUNT} txs per chain, config ${CONFIG_PATH}`);
    console.log(`Prices are current (Chainlink / $1 stables / previewRedeem), not at tx time.\n`);

    const reports: { chain: ProfitabilityChainConfig; report: ProfitabilityChainReport }[] = [];
    for (const fileChain of selectedChains) {
        const chain = byChainId.get(fileChain.id)!;
        const report = await computeChainProfitability(chain, byChainId, SIGNER, {
            count: COUNT,
            maxScan: MAX_SCAN,
            includeOps: INCLUDE_OPS_IN_COUNT,
            extraFeeReceivers: EXTRA_FEE_RECEIVERS,
        });
        printChain(chain, report);
        reports.push({ chain, report });
    }

    const totalRelays = reports.reduce((s, { report }) => s + report.relayCount, 0);
    const totalCost = reports.reduce((s, { report }) => s + report.costUsd, 0);
    const totalRevenue = reports.reduce((s, { report }) => s + report.revenueUsd, 0);
    const totalOpsCost = reports.reduce((s, { report }) => s + report.opsCostUsd, 0);
    const totalOps = reports.reduce((s, { report }) => s + report.opsCount, 0);
    console.log(
        `== TOTAL relays: ${totalRelays}, cost ${usd(totalCost)}, earned ${usd(totalRevenue)}, NET ${usd(totalRevenue - totalCost)} ` +
            `(${totalRelays ? usd((totalRevenue - totalCost) / totalRelays).trim() : "—"} per relay)`,
    );
    console.log(`   ops txs listed separately: ${totalOps}, cost ${usd(totalOpsCost)}`);

    if (JSON_OUT) {
        const all = reports.flatMap(({ report }) => report.rows.map((r) => ({ ...r, chainId: report.chainId, chain: report.chainName })));
        writeFileSync(JSON_OUT, JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        console.log(`JSON written to ${JSON_OUT}`);
    }
})().catch((e) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
});
