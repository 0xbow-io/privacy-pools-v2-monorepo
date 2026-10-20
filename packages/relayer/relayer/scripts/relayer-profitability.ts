/**
 * Relayer profitability report — read-only.
 *
 * For the last N transactions sent by a relayer signer on each chain, dissects what the relayer
 * SPENT (gas, L1 data fee, native value it forwarded) and what it EARNED (the relay fee it was
 * paid, plus any other tokens that landed on the signer / fee receiver in that tx), values both
 * in USD and prints per-tx and per-chain net.
 *
 * Transactions are found by NONCE, not by events: the script binary-searches the block where the
 * signer's nonce ticks over, so reverted relays (no events, pure gas loss) are included.
 *
 * Usage (from packages/relayer/relayer):
 *   RPC_URL_EVM_1=… RPC_URL_EVM_56=… npx tsx scripts/relayer-profitability.ts \
 *     [--config ../../swaps/.relayer-prod-config.json] [--signer 0x9e2f…] [--count 10] \
 *     [--chains 1,56] [--fee-receiver 0x…,0x…] [--json out.json] [--include-ops] [--max-scan 200]
 *
 * `--count` counts RELAYS (withdraw / transfer / swap / yield-router txs). Ops txs the signer also
 * sends (self-sends that fill or cancel nonces, plain payouts, approvals) are listed and totalled
 * separately so they do not distort relay profitability; `--include-ops` counts them too.
 *
 * Revenue sources recognised per tx:
 *   - PrivacyPoolRelay `Relayed` / `RelayedBatch`  → `_fee` of `_asset` to `_feeRecipient`   (withdrawals)
 *   - RelaySwaps `Executed`                         → `feeAmount` of `inputToken` to `feeRecipient` (swaps, reshields)
 *   - PoolVault `Transacted` with caller == signer and the tx sent straight to the pool
 *                                                   → `withdrawnValue` of `asset` to the signer (transfers)
 *   - any other ERC-20 `Transfer` into the signer / fee receivers → "other in" (dust, refunds)
 * Fees are only counted as revenue when their recipient is the signer or a `--fee-receiver`;
 * a fee paid anywhere else is reported as "fee to <addr>" and NOT counted (that is a leak).
 *
 * Prices are CURRENT (Chainlink native/USD; stablecoins = $1; yield shares valued via
 * `previewRedeem` into their underlying). Good for "are we losing money", not for accounting.
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
    createPublicClient,
    decodeEventLog,
    formatUnits,
    getAddress,
    http,
    parseAbi,
    type Address,
    type Hex,
    type Log,
    type PublicClient,
} from "viem";

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
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
// Count only relays (withdraw / transfer / swap / yield-router txs) toward --count; ops txs
// (self-sends, plain payouts, approvals) are still listed, but under their own heading.
const INCLUDE_OPS_IN_COUNT = process.argv.includes("--include-ops");
const MAX_SCAN = Number(arg("max-scan", "200"));

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------
interface AssetCfg { address: string; ticker: string; decimals: number; quoter?: string; underlying?: string }
interface ChainCfg {
    id: number;
    name: string;
    rpc_url: string;
    relay_contract: string;
    pool_vault_contract: string;
    relay_swaps_contract?: string;
    fee_receiver_address?: string;
    allowed_processors?: string[];
    native_currency: { symbol: string; decimals: number };
    supported_assets: AssetCfg[];
}
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as { chains: { evm: ChainCfg[] } };
const chains = config.chains.evm.filter((c) => !CHAINS_ARG || CHAINS_ARG.split(",").map(Number).includes(c.id));

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const STABLES = new Set(["USDC", "USDT", "FDUSD", "USDC.E", "USDT.E", "CTUSD", "DAI"]);
const PLACEHOLDER_FEE_RECEIVER = "0x0000000000000000000000000000000000000001";

// ---------------------------------------------------------------------------------------------
// ABIs
// ---------------------------------------------------------------------------------------------
const EVENTS = parseAbi([
    "event Relayed(address indexed _asset, address indexed _recipient, uint256 _recipientAmount, address indexed _feeRecipient, uint256 _fee, uint256 _gasFunding)",
    "event RelayedBatch(address indexed _asset, address indexed _recipient, uint256 _recipientAmount, address indexed _feeRecipient, uint256 _fee, uint256 _gasFunding, uint256 _count)",
    "event Executed(address indexed inputToken, address indexed outputToken, uint256 inputAmount, address feeRecipient, uint256 feeAmount)",
    "event Transacted(uint256[] outputCommitments, uint256[] nullifierHashes, address indexed asset, uint256 withdrawnValue, address indexed caller)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const CHAINLINK = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);
const ERC4626 = parseAbi(["function previewRedeem(uint256) view returns (uint256)"]);
const ERC20_META = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

// Chainlink feeds used for the native coin of each chain (read on the chain named in `on`).
const NATIVE_FEEDS: Record<number, { on: number; feed: Address }> = {
    1: { on: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" }, // ETH/USD
    10: { on: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
    8453: { on: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
    42161: { on: 1, feed: "0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419" },
    56: { on: 56, feed: "0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE" }, // BNB/USD
    4114: { on: 1, feed: "0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c" }, // BTC/USD for cBTC
};
const WRAPPED_NATIVE = new Set([
    "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // WETH mainnet
    "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", // WBNB
    "0x4200000000000000000000000000000000000006", // WETH OP/Base
]);

// ---------------------------------------------------------------------------------------------
// Clients / helpers
// ---------------------------------------------------------------------------------------------
const clients = new Map<number, PublicClient>();
function client(chainId: number): PublicClient {
    const existing = clients.get(chainId);
    if (existing) return existing;
    const cfg = config.chains.evm.find((c) => c.id === chainId);
    const url = process.env[`RPC_URL_EVM_${chainId}`] ?? cfg?.rpc_url;
    if (!url) throw new Error(`No RPC for chain ${chainId}: set RPC_URL_EVM_${chainId}`);
    const c = createPublicClient({ transport: http(url, { timeout: 60_000, retryCount: 3 }) }) as PublicClient;
    clients.set(chainId, c);
    return c;
}

const nativePriceCache = new Map<number, number>();
async function nativeUsd(chainId: number): Promise<number> {
    if (nativePriceCache.has(chainId)) return nativePriceCache.get(chainId)!;
    const f = NATIVE_FEEDS[chainId];
    if (!f) throw new Error(`No native price feed for chain ${chainId}`);
    const c = client(f.on);
    const [, answer] = await c.readContract({ address: f.feed, abi: CHAINLINK, functionName: "latestRoundData" });
    const dec = await c.readContract({ address: f.feed, abi: CHAINLINK, functionName: "decimals" });
    const px = Number(answer) / 10 ** Number(dec);
    nativePriceCache.set(chainId, px);
    return px;
}

interface TokenInfo { ticker: string; decimals: number }
const tokenInfoCache = new Map<string, TokenInfo>();
async function tokenInfo(chain: ChainCfg, token: string): Promise<TokenInfo> {
    const key = `${chain.id}:${token.toLowerCase()}`;
    if (tokenInfoCache.has(key)) return tokenInfoCache.get(key)!;
    let info: TokenInfo;
    if (token.toLowerCase() === NATIVE || token.toLowerCase() === "0x0000000000000000000000000000000000000000") {
        info = { ticker: chain.native_currency.symbol, decimals: chain.native_currency.decimals };
    } else {
        const cfg = chain.supported_assets.find((a) => a.address.toLowerCase() === token.toLowerCase());
        if (cfg) info = { ticker: cfg.ticker, decimals: cfg.decimals };
        else {
            const c = client(chain.id);
            const [decimals, ticker] = await Promise.all([
                c.readContract({ address: token as Address, abi: ERC20_META, functionName: "decimals" }).catch(() => 18),
                c.readContract({ address: token as Address, abi: ERC20_META, functionName: "symbol" }).catch(() => token.slice(0, 8)),
            ]);
            info = { ticker: String(ticker), decimals: Number(decimals) };
        }
    }
    tokenInfoCache.set(key, info);
    return info;
}

/** USD value of `amount` raw units of `token` on `chain`, at current prices. */
async function usdValue(chain: ChainCfg, token: string, amount: bigint): Promise<number> {
    if (amount === 0n) return 0;
    const t = token.toLowerCase();
    if (t === NATIVE || t === "0x0000000000000000000000000000000000000000" || WRAPPED_NATIVE.has(t)) {
        return (Number(amount) / 10 ** chain.native_currency.decimals) * (await nativeUsd(chain.id));
    }
    const cfg = chain.supported_assets.find((a) => a.address.toLowerCase() === t);
    if (cfg?.underlying) {
        // Yield share: redeem into the underlying, then value that.
        const underlyingAmount = await client(chain.id).readContract({
            address: cfg.address as Address,
            abi: ERC4626,
            functionName: "previewRedeem",
            args: [amount],
        });
        return usdValue(chain, cfg.underlying, underlyingAmount);
    }
    const info = await tokenInfo(chain, token);
    if (STABLES.has(info.ticker.toUpperCase())) return Number(amount) / 10 ** info.decimals;
    return NaN; // unknown token: shown, not valued
}

/** Block in which the signer's nonce went from `nonce` to `nonce + 1` (i.e. tx #nonce was mined). */
async function blockOfNonce(c: PublicClient, signer: Address, nonce: number, hi: bigint): Promise<bigint> {
    let lo = 0n;
    // Invariant: nonceAt(hi) > nonce, nonceAt(lo) <= nonce.
    while (hi - lo > 1n) {
        const mid = (lo + hi) / 2n;
        const n = await c.getTransactionCount({ address: signer, blockNumber: mid });
        if (n > nonce) hi = mid;
        else lo = mid;
    }
    return hi;
}

// ---------------------------------------------------------------------------------------------
// Per-tx dissection
// ---------------------------------------------------------------------------------------------
interface Row {
    chainId: number;
    chain: string;
    nonce: number;
    hash: Hex;
    block: bigint;
    time: string;
    kind: string;
    isRelay: boolean;
    status: "success" | "reverted";
    gasUsed: bigint;
    gasCostNative: bigint;
    valueSentNative: bigint;
    costUsd: number;
    revenue: { token: string; ticker: string; amount: string; usd: number; source: string }[];
    feeElsewhere: { to: string; ticker: string; amount: string; usd: number }[];
    revenueUsd: number;
    netUsd: number;
}

function kindOf(chain: ChainCfg, to: string | null, input: Hex): { kind: string; isRelay: boolean } {
    const t = (to ?? "").toLowerCase();
    const sel = input.slice(0, 10);
    if (t === chain.relay_contract.toLowerCase()) return { kind: `withdraw (${sel})`, isRelay: true };
    if (chain.relay_swaps_contract && t === chain.relay_swaps_contract.toLowerCase()) return { kind: `swap/reshield (${sel})`, isRelay: true };
    if (t === chain.pool_vault_contract.toLowerCase()) return { kind: `transfer (${sel})`, isRelay: true };
    if ((chain.allowed_processors ?? []).some((p) => p.toLowerCase() === t)) return { kind: `yield withdraw via PPRouter ${to!.slice(0, 10)} (${sel})`, isRelay: true };
    if (!to) return { kind: "ops: contract creation", isRelay: false };
    if (t === SIGNER.toLowerCase()) return { kind: `ops: self-send (nonce filler/cancel)`, isRelay: false };
    if (input === "0x") return { kind: `ops: plain native transfer → ${to}`, isRelay: false };
    return { kind: `ops: call → ${to.slice(0, 10)} (${sel})`, isRelay: false };
}

async function dissect(chain: ChainCfg, nonce: number, hash: Hex, feeReceivers: Set<string>): Promise<Row> {
    const c = client(chain.id);
    const [tx, raw] = await Promise.all([
        c.getTransaction({ hash }),
        c.request({ method: "eth_getTransactionReceipt", params: [hash] }) as Promise<Record<string, unknown>>,
    ]);
    const receipt = await c.getTransactionReceipt({ hash });
    const block = await c.getBlock({ blockNumber: receipt.blockNumber });
    const l1Fee = raw.l1Fee ? BigInt(raw.l1Fee as string) : 0n;
    const gasCostNative = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
    const valueSentNative = tx.value;
    const nativePx = await nativeUsd(chain.id);
    const costUsd = (Number(gasCostNative + valueSentNative) / 10 ** chain.native_currency.decimals) * nativePx;

    const revenue: Row["revenue"] = [];
    const feeElsewhere: Row["feeElsewhere"] = [];
    const counted = new Set<string>(); // token:amount keys already attributed to a fee event

    const add = async (token: string, amount: bigint, to: string, source: string) => {
        const info = await tokenInfo(chain, token);
        const usd = await usdValue(chain, token, amount);
        const entry = { token, ticker: info.ticker, amount: formatUnits(amount, info.decimals), usd };
        if (feeReceivers.has(to.toLowerCase())) revenue.push({ ...entry, source });
        else feeElsewhere.push({ to, ticker: info.ticker, amount: entry.amount, usd });
        counted.add(`${token.toLowerCase()}:${amount}:${to.toLowerCase()}`);
    };

    if (receipt.status === "success") {
        const sentToPool = (tx.to ?? "").toLowerCase() === chain.pool_vault_contract.toLowerCase();
        for (const log of receipt.logs as Log[]) {
            let ev: ReturnType<typeof decodeEventLog<typeof EVENTS>>;
            try {
                ev = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics });
            } catch {
                continue;
            }
            const a = ev.args as Record<string, unknown>;
            if (ev.eventName === "Relayed" || ev.eventName === "RelayedBatch") {
                await add(a._asset as string, a._fee as bigint, a._feeRecipient as string, ev.eventName);
            } else if (ev.eventName === "Executed") {
                await add(a.inputToken as string, a.feeAmount as bigint, a.feeRecipient as string, "RelaySwaps.Executed");
            } else if (ev.eventName === "Transacted" && sentToPool && (a.caller as string).toLowerCase() === SIGNER.toLowerCase() && (a.withdrawnValue as bigint) > 0n) {
                await add(a.asset as string, a.withdrawnValue as bigint, SIGNER, "transfer fee (Transacted)");
            }
        }
        // Anything else that landed on the signer / fee receivers (dust sweeps, refunds).
        for (const log of receipt.logs as Log[]) {
            let ev: ReturnType<typeof decodeEventLog<typeof EVENTS>>;
            try {
                ev = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics });
            } catch {
                continue;
            }
            if (ev.eventName !== "Transfer") continue;
            const a = ev.args as { from: string; to: string; value: bigint };
            if (!feeReceivers.has(a.to.toLowerCase())) continue;
            const key = `${log.address.toLowerCase()}:${a.value}:${a.to.toLowerCase()}`;
            if (counted.has(key)) continue;
            const info = await tokenInfo(chain, log.address);
            revenue.push({ token: log.address, ticker: info.ticker, amount: formatUnits(a.value, info.decimals), usd: await usdValue(chain, log.address, a.value), source: "other ERC-20 in" });
        }
    }

    const revenueUsd = revenue.reduce((s, r) => s + (Number.isNaN(r.usd) ? 0 : r.usd), 0);
    return {
        chainId: chain.id,
        chain: chain.name,
        nonce,
        hash,
        block: receipt.blockNumber,
        time: new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " "),
        ...kindOf(chain, tx.to, tx.input),
        status: receipt.status,
        gasUsed: receipt.gasUsed,
        gasCostNative,
        valueSentNative,
        costUsd,
        revenue,
        feeElsewhere,
        revenueUsd,
        netUsd: revenueUsd - costUsd,
    };
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------
const usd = (n: number) => (Number.isNaN(n) ? "   n/a" : `${n < 0 ? "-" : " "}$${Math.abs(n).toFixed(4)}`);

(async () => {
    console.log(`Relayer profitability — signer ${SIGNER}, last ${COUNT} txs per chain, config ${CONFIG_PATH}`);
    console.log(`Prices are current (Chainlink / $1 stables / previewRedeem), not at tx time.\n`);
    const all: Row[] = [];
    for (const chain of chains) {
        const c = client(chain.id);
        const feeReceivers = new Set<string>([SIGNER.toLowerCase(), ...EXTRA_FEE_RECEIVERS.map((a) => a.toLowerCase())]);
        const envFeeReceiver = process.env[`FEE_RECEIVER_ADDRESS_EVM_${chain.id}`];
        if (envFeeReceiver) feeReceivers.add(envFeeReceiver.toLowerCase());
        else if (chain.fee_receiver_address && chain.fee_receiver_address.toLowerCase() !== PLACEHOLDER_FEE_RECEIVER)
            feeReceivers.add(chain.fee_receiver_address.toLowerCase());

        const latest = await c.getBlockNumber();
        const nonce = await c.getTransactionCount({ address: SIGNER, blockTag: "latest" });
        const [nativePx, balance] = await Promise.all([nativeUsd(chain.id), c.getBalance({ address: SIGNER })]);
        console.log(`== ${chain.name} (${chain.id}) — signer nonce ${nonce}, balance ${formatUnits(balance, chain.native_currency.decimals)} ${chain.native_currency.symbol} (@ $${nativePx.toFixed(2)})`);
        if (nonce === 0) {
            console.log("   no transactions\n");
            continue;
        }

        const rows: Row[] = [];
        let hi = latest + 1n;
        let relays = 0;
        for (let n = nonce - 1; n >= Math.max(0, nonce - MAX_SCAN) && (INCLUDE_OPS_IN_COUNT ? rows.length : relays) < COUNT; n--) {
            const blk = await blockOfNonce(c, SIGNER, n, hi);
            hi = blk;
            const b = await c.getBlock({ blockNumber: blk, includeTransactions: true });
            const tx = b.transactions.find((t) => typeof t !== "string" && t.from.toLowerCase() === SIGNER.toLowerCase() && t.nonce === n);
            if (!tx || typeof tx === "string") {
                console.log(`   nonce ${n}: tx not found in block ${blk} (skipped)`);
                continue;
            }
            const row = await dissect(chain, n, tx.hash, feeReceivers);
            rows.push(row);
            if (row.isRelay) relays++;
        }

        for (const r of rows.reverse()) {
            const rev = r.revenue.map((x) => `${x.amount} ${x.ticker} (${usd(x.usd).trim()}, ${x.source})`).join("; ") || "—";
            const leak = r.feeElsewhere.length ? `  !! fee paid to ${r.feeElsewhere.map((f) => `${f.to} ${f.amount} ${f.ticker}`).join("; ")}` : "";
            console.log(
                `   #${r.nonce} ${r.time} ${r.status === "reverted" ? "REVERTED " : ""}${r.kind}\n` +
                    `      gas ${r.gasUsed} → ${formatUnits(r.gasCostNative, chain.native_currency.decimals)} ${chain.native_currency.symbol}` +
                    `${r.valueSentNative > 0n ? ` + sent ${formatUnits(r.valueSentNative, chain.native_currency.decimals)}` : ""}` +
                    ` | cost ${usd(r.costUsd)} | earned ${usd(r.revenueUsd)} [${rev}] | net ${usd(r.netUsd)}${leak}\n` +
                    `      ${r.hash}`,
            );
        }
        const relayRows = rows.filter((r) => r.isRelay);
        const opsRows = rows.filter((r) => !r.isRelay);
        const cost = relayRows.reduce((s, r) => s + r.costUsd, 0);
        const rev = relayRows.reduce((s, r) => s + r.revenueUsd, 0);
        const reverted = relayRows.filter((r) => r.status === "reverted");
        const leaked = relayRows.flatMap((r) => r.feeElsewhere).reduce((s, f) => s + (Number.isNaN(f.usd) ? 0 : f.usd), 0);
        const opsCost = opsRows.reduce((s, r) => s + r.costUsd, 0);
        if (opsRows.length) console.log(`   (ops txs, not relays: ${opsRows.length}, gas+value ${usd(opsCost)} — excluded from the relay NET below)`);
        console.log(
            `   -- ${chain.name}: ${relayRows.length} relays, cost ${usd(cost)}, earned ${usd(rev)}, NET ${usd(rev - cost)}` +
                `${reverted.length ? ` | ${reverted.length} reverted (${usd(reverted.reduce((s, r) => s + r.costUsd, 0))} burnt)` : ""}` +
                `${leaked ? ` | fees paid to non-relayer addresses: ${usd(leaked)}` : ""}\n`,
        );
        all.push(...rows);
    }

    const relaysAll = all.filter((r) => r.isRelay);
    const cost = relaysAll.reduce((s, r) => s + r.costUsd, 0);
    const rev = relaysAll.reduce((s, r) => s + r.revenueUsd, 0);
    console.log(`== TOTAL relays: ${relaysAll.length}, cost ${usd(cost)}, earned ${usd(rev)}, NET ${usd(rev - cost)} (${relaysAll.length ? usd((rev - cost) / relaysAll.length).trim() : "—"} per relay)`);
    console.log(`   ops txs listed separately: ${all.length - relaysAll.length}, cost ${usd(all.filter((r) => !r.isRelay).reduce((s, r) => s + r.costUsd, 0))}`);
    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify(all, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
        console.log(`JSON written to ${JSON_OUT}`);
    }
})().catch((e) => {
    console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
    process.exit(1);
});
