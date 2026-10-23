/**
 * Relayer profitability — read-only core, extracted from `scripts/relayer-profitability.ts` so the
 * same dissection logic can be called both by that CLI (for manual/ad-hoc runs) and by
 * `EvmReportService` (for the on-demand `/current_profit_margins` Telegram command). Behavior is
 * unchanged from the original script; only the input shape moved from "parse argv + read a JSON
 * config file" to plain function arguments, and the config shape moved from the script's own
 * `ChainCfg` (one JSON file) to `ProfitabilityChainConfig` (chain-type-agnostic — the caller adapts
 * its own config source, whether that's the JSON file or the live `EvmConfigService`).
 *
 * For the last N transactions sent by a signer on one chain, dissects what was SPENT (gas, L1 data
 * fee, native value forwarded) and what was EARNED (the relay fee, plus any other tokens that landed
 * on the signer / fee receiver), values both in USD, and returns per-tx rows plus chain totals.
 *
 * Transactions are found by NONCE, not by events: `blockOfNonce` binary-searches the block where the
 * signer's nonce ticks over, so reverted relays (no events, pure gas loss) are included.
 *
 * Revenue sources recognised per tx:
 *   - PrivacyPoolRelay `Relayed` / `RelayedBatch`  -> `_fee` of `_asset` to `_feeRecipient`   (withdrawals)
 *   - RelaySwaps `Executed`                         -> `feeAmount` of `inputToken` to `feeRecipient` (swaps, reshields)
 *   - PoolVault `Transacted` with caller == signer and the tx sent straight to the pool
 *                                                   -> `withdrawnValue` of `asset` to the signer (transfers)
 *   - any other ERC-20 `Transfer` into the signer / fee receivers -> "other in" (dust, refunds)
 * Fees are only counted as revenue when their recipient is the signer or a known fee receiver; a fee
 * paid anywhere else is reported as "fee to <addr>" and NOT counted (that is a leak).
 *
 * Prices are CURRENT (Chainlink native/USD; stablecoins = $1; yield shares valued via
 * `previewRedeem` into their underlying). Good for "are we losing money", not for accounting.
 */
import {
    createPublicClient,
    decodeEventLog,
    formatUnits,
    http,
    parseAbi,
    type Address,
    type Hex,
    type Log,
    type PublicClient,
} from "viem";

export interface ProfitabilityAssetConfig {
    address: string;
    ticker: string;
    decimals: number;
    underlying?: string;
}

/** Chain-type-agnostic input — the caller adapts its own config source into this shape. */
export interface ProfitabilityChainConfig {
    id: number;
    name: string;
    rpcUrl: string;
    relayContract: string;
    poolVaultContract: string;
    relaySwapsContract?: string;
    feeReceiverAddress?: string;
    allowedProcessors?: string[];
    nativeCurrency: { symbol: string; decimals: number };
    supportedAssets: ProfitabilityAssetConfig[];
}

export interface ProfitabilityOptions {
    /** How many RELAY txs (withdraw/transfer/swap/yield-router) to dissect. Default 10. */
    count?: number;
    /** Upper bound on how many nonces back to scan looking for `count` relays. Default 200. */
    maxScan?: number;
    /** Count ops txs (self-sends, plain payouts, approvals) toward `count` too. Default false. */
    includeOps?: boolean;
    extraFeeReceivers?: string[];
}

export interface ProfitabilityRow {
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

export interface ProfitabilityChainReport {
    chainId: number;
    chainName: string;
    nativeSymbol: string;
    nonce: number;
    balanceNative: bigint;
    nativePriceUsd: number;
    rows: ProfitabilityRow[];
    relayCount: number;
    costUsd: number;
    revenueUsd: number;
    netUsd: number;
    revertedCount: number;
    revertedCostUsd: number;
    leakedUsd: number;
    opsCount: number;
    opsCostUsd: number;
}

const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const STABLES = new Set(["USDC", "USDT", "FDUSD", "USDC.E", "USDT.E", "CTUSD", "DAI"]);
const PLACEHOLDER_FEE_RECEIVER = "0x0000000000000000000000000000000000000001";
const DEFAULT_COUNT = 10;
const DEFAULT_MAX_SCAN = 200;

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

const clients = new Map<number, PublicClient>();
function client(chain: ProfitabilityChainConfig): PublicClient {
    const existing = clients.get(chain.id);
    if (existing) return existing;
    const c = createPublicClient({ transport: http(chain.rpcUrl, { timeout: 60_000, retryCount: 3 }) }) as PublicClient;
    clients.set(chain.id, c);
    return c;
}

// The relayer process is long-running and imports this module once, so a native price must not
// outlive the report that fetched it: after the TTL it is refetched, and within one report it stays
// consistent across every chain and row. Token metadata (ticker, decimals) is immutable and stays cached.
export const NATIVE_PRICE_TTL_MS = 60_000;
const nativePriceCache = new Map<number, { px: number; fetchedAt: number }>();
export async function nativeUsd(chain: ProfitabilityChainConfig, byChainId: Map<number, ProfitabilityChainConfig>): Promise<number> {
    const cached = nativePriceCache.get(chain.id);
    if (cached !== undefined && Date.now() - cached.fetchedAt < NATIVE_PRICE_TTL_MS) return cached.px;
    const f = NATIVE_FEEDS[chain.id];
    if (!f) throw new Error(`No native price feed for chain ${chain.id}`);
    const feedChain = byChainId.get(f.on) ?? chain;
    const c = client(feedChain);
    const [, answer] = await c.readContract({ address: f.feed, abi: CHAINLINK, functionName: "latestRoundData" });
    const dec = await c.readContract({ address: f.feed, abi: CHAINLINK, functionName: "decimals" });
    const px = Number(answer) / 10 ** Number(dec);
    nativePriceCache.set(chain.id, { px, fetchedAt: Date.now() });
    return px;
}

interface TokenInfo { ticker: string; decimals: number }
const tokenInfoCache = new Map<string, TokenInfo>();
async function tokenInfo(chain: ProfitabilityChainConfig, token: string): Promise<TokenInfo> {
    const key = `${chain.id}:${token.toLowerCase()}`;
    const cachedInfo = tokenInfoCache.get(key);
    if (cachedInfo !== undefined) return cachedInfo;
    let info: TokenInfo;
    if (token.toLowerCase() === NATIVE || token.toLowerCase() === "0x0000000000000000000000000000000000000000") {
        info = { ticker: chain.nativeCurrency.symbol, decimals: chain.nativeCurrency.decimals };
    } else {
        const cfg = chain.supportedAssets.find((a) => a.address.toLowerCase() === token.toLowerCase());
        if (cfg) info = { ticker: cfg.ticker, decimals: cfg.decimals };
        else {
            const c = client(chain);
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
async function usdValue(
    chain: ProfitabilityChainConfig,
    byChainId: Map<number, ProfitabilityChainConfig>,
    token: string,
    amount: bigint,
): Promise<number> {
    if (amount === 0n) return 0;
    const t = token.toLowerCase();
    if (t === NATIVE || t === "0x0000000000000000000000000000000000000000" || WRAPPED_NATIVE.has(t)) {
        return (Number(amount) / 10 ** chain.nativeCurrency.decimals) * (await nativeUsd(chain, byChainId));
    }
    const cfg = chain.supportedAssets.find((a) => a.address.toLowerCase() === t);
    if (cfg?.underlying) {
        // Yield share: redeem into the underlying, then value that.
        const underlyingAmount = await client(chain).readContract({
            address: cfg.address as Address,
            abi: ERC4626,
            functionName: "previewRedeem",
            args: [amount],
        });
        return usdValue(chain, byChainId, cfg.underlying, underlyingAmount);
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

function kindOf(chain: ProfitabilityChainConfig, signer: Address, to: string | null, input: Hex): { kind: string; isRelay: boolean } {
    const t = (to ?? "").toLowerCase();
    const sel = input.slice(0, 10);
    if (t === chain.relayContract.toLowerCase()) return { kind: `withdraw (${sel})`, isRelay: true };
    if (chain.relaySwapsContract && t === chain.relaySwapsContract.toLowerCase()) return { kind: `swap/reshield (${sel})`, isRelay: true };
    if (t === chain.poolVaultContract.toLowerCase()) return { kind: `transfer (${sel})`, isRelay: true };
    if ((chain.allowedProcessors ?? []).some((p) => p.toLowerCase() === t)) return { kind: `yield withdraw via PPRouter ${(to ?? "").slice(0, 10)} (${sel})`, isRelay: true };
    if (!to) return { kind: "ops: contract creation", isRelay: false };
    if (t === signer.toLowerCase()) return { kind: `ops: self-send (nonce filler/cancel)`, isRelay: false };
    if (input === "0x") return { kind: `ops: plain native transfer -> ${to}`, isRelay: false };
    return { kind: `ops: call -> ${to.slice(0, 10)} (${sel})`, isRelay: false };
}

async function dissect(
    chain: ProfitabilityChainConfig,
    byChainId: Map<number, ProfitabilityChainConfig>,
    signer: Address,
    nonce: number,
    hash: Hex,
    feeReceivers: Set<string>,
): Promise<ProfitabilityRow> {
    const c = client(chain);
    const [tx, raw] = await Promise.all([
        c.getTransaction({ hash }),
        c.request({ method: "eth_getTransactionReceipt", params: [hash] }) as Promise<Record<string, unknown>>,
    ]);
    const receipt = await c.getTransactionReceipt({ hash });
    const block = await c.getBlock({ blockNumber: receipt.blockNumber });
    const l1Fee = raw.l1Fee ? BigInt(raw.l1Fee as string) : 0n;
    const gasCostNative = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
    const valueSentNative = tx.value;
    const nativePx = await nativeUsd(chain, byChainId);
    const costUsd = (Number(gasCostNative + valueSentNative) / 10 ** chain.nativeCurrency.decimals) * nativePx;

    const revenue: ProfitabilityRow["revenue"] = [];
    const feeElsewhere: ProfitabilityRow["feeElsewhere"] = [];
    const counted = new Set<string>(); // token:amount:to keys already attributed to a fee event

    const add = async (token: string, amount: bigint, to: string, source: string) => {
        const info = await tokenInfo(chain, token);
        const usd = await usdValue(chain, byChainId, token, amount);
        const entry = { token, ticker: info.ticker, amount: formatUnits(amount, info.decimals), usd };
        if (feeReceivers.has(to.toLowerCase())) revenue.push({ ...entry, source });
        else feeElsewhere.push({ to, ticker: info.ticker, amount: entry.amount, usd });
        counted.add(`${token.toLowerCase()}:${amount}:${to.toLowerCase()}`);
    };

    if (receipt.status === "success") {
        const sentToPool = (tx.to ?? "").toLowerCase() === chain.poolVaultContract.toLowerCase();
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
            } else if (ev.eventName === "Transacted" && sentToPool && (a.caller as string).toLowerCase() === signer.toLowerCase() && (a.withdrawnValue as bigint) > 0n) {
                await add(a.asset as string, a.withdrawnValue as bigint, signer, "transfer fee (Transacted)");
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
            revenue.push({ token: log.address, ticker: info.ticker, amount: formatUnits(a.value, info.decimals), usd: await usdValue(chain, byChainId, log.address, a.value), source: "other ERC-20 in" });
        }
    }

    const revenueUsd = revenue.reduce((s, r) => s + (Number.isNaN(r.usd) ? 0 : r.usd), 0);
    return {
        nonce,
        hash,
        block: receipt.blockNumber,
        time: new Date(Number(block.timestamp) * 1000).toISOString().slice(0, 16).replace("T", " "),
        ...kindOf(chain, signer, tx.to, tx.input),
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

/**
 * Dissects the last `opts.count` relay txs the signer sent on `chain` and returns per-tx rows plus
 * chain totals. `byChainId` supplies every chain in scope (needed so a chain whose Chainlink native
 * feed lives on a different chain, e.g. BTC/USD for cBTC read on mainnet, can resolve that chain too).
 */
export async function computeChainProfitability(
    chain: ProfitabilityChainConfig,
    byChainId: Map<number, ProfitabilityChainConfig>,
    signer: Address,
    opts: ProfitabilityOptions = {},
): Promise<ProfitabilityChainReport> {
    const count = opts.count ?? DEFAULT_COUNT;
    const maxScan = opts.maxScan ?? DEFAULT_MAX_SCAN;
    const includeOps = opts.includeOps ?? false;

    const c = client(chain);
    const feeReceivers = new Set<string>([signer.toLowerCase(), ...(opts.extraFeeReceivers ?? []).map((a) => a.toLowerCase())]);
    if (chain.feeReceiverAddress && chain.feeReceiverAddress.toLowerCase() !== PLACEHOLDER_FEE_RECEIVER) {
        feeReceivers.add(chain.feeReceiverAddress.toLowerCase());
    }

    const latest = await c.getBlockNumber();
    const nonce = await c.getTransactionCount({ address: signer, blockTag: "latest" });
    const [nativePriceUsd, balanceNative] = await Promise.all([nativeUsd(chain, byChainId), c.getBalance({ address: signer })]);

    const rows: ProfitabilityRow[] = [];
    if (nonce > 0) {
        let hi = latest + 1n;
        let relays = 0;
        for (let n = nonce - 1; n >= Math.max(0, nonce - maxScan) && (includeOps ? rows.length : relays) < count; n--) {
            const blk = await blockOfNonce(c, signer, n, hi);
            hi = blk;
            const b = await c.getBlock({ blockNumber: blk, includeTransactions: true });
            const tx = b.transactions.find((t) => typeof t !== "string" && t.from.toLowerCase() === signer.toLowerCase() && t.nonce === n);
            if (!tx || typeof tx === "string") continue;
            const row = await dissect(chain, byChainId, signer, n, tx.hash, feeReceivers);
            rows.push(row);
            if (row.isRelay) relays++;
        }
    }
    rows.reverse();

    const relayRows = rows.filter((r) => r.isRelay);
    const opsRows = rows.filter((r) => !r.isRelay);
    const costUsd = relayRows.reduce((s, r) => s + r.costUsd, 0);
    const revenueUsd = relayRows.reduce((s, r) => s + r.revenueUsd, 0);
    const reverted = relayRows.filter((r) => r.status === "reverted");
    const leakedUsd = relayRows.flatMap((r) => r.feeElsewhere).reduce((s, f) => s + (Number.isNaN(f.usd) ? 0 : f.usd), 0);

    return {
        chainId: chain.id,
        chainName: chain.name,
        nativeSymbol: chain.nativeCurrency.symbol,
        nonce,
        balanceNative,
        nativePriceUsd,
        rows,
        relayCount: relayRows.length,
        costUsd,
        revenueUsd,
        netUsd: revenueUsd - costUsd,
        revertedCount: reverted.length,
        revertedCostUsd: reverted.reduce((s, r) => s + r.costUsd, 0),
        leakedUsd,
        opsCount: opsRows.length,
        opsCostUsd: opsRows.reduce((s, r) => s + r.costUsd, 0),
    };
}
