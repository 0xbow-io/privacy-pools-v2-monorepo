/**
 * Relay gas sampler — read-only. Collects the real gas used by every relayed operation on our
 * PoolVaults (prod + testing stacks), classified the way the relayer prices them, to calibrate
 * `src/quote/evm/relay_gas_budget.ts`.
 *
 * Source of truth: every `PoolVault.Transacted` event. Each tx that emitted one is classified by
 * its entry point:
 *   - `RelayedBatch` in the receipt         → withdrawBatch
 *   - `Relayed` in the receipt              → withdraw (yieldWithdraw when sent to a PPRouter);
 *                                            the selector separates relay / relayAndAnnounce / registerAndRelay
 *   - RelaySwaps `Executed` in the receipt  → relaySwap:samechain / :crosschain (LiFiTransferStarted), +unwrap (Unwrapped)
 *   - sent straight to the PoolVault by a relayer signer → shieldedTransfer
 *   - anything else                         → selfTransact / other — reported, not used for budgets
 * Classification is by EVENTS, so no relay / RelaySwaps address lists are needed.
 * and tagged with the note counts the proof spent (nullifiers) and created (commitments), which
 * drive most of the variance.
 *
 * Gas is EXECUTION gas: on Arbitrum the receipt's `gasUsedForL1` is subtracted; OP-stack L1 data
 * fees are not in gasUsed to begin with.
 *
 * Usage (from packages/relayer/relayer):
 *   RPC_URL_EVM_1=… RPC_URL_EVM_56=… RPC_URL_EVM_10=… RPC_URL_EVM_8453=… RPC_URL_EVM_42161=… \
 *     npx tsx scripts/relay-gas-samples.ts [--json samples.json] [--stacks prod,test]
 */
import { writeFileSync } from "fs";
import { createPublicClient, http, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from "viem";

interface Stack {
    name: string;
    group: "prod" | "test";
    chainId: number;
    pool: Address;
    ppRouters: Address[];
    fromBlock: bigint;
    chunk: bigint;
    rpcFallback?: string;
}

// Addresses as of 2026-09-25 (prod: .relayer-prod-config.json; test: deployments-it-003.json /
// .relayer-test-config.json, including every RelaySwaps generation that served the pool).
const STACKS: Stack[] = [
    { name: "prod mainnet", group: "prod", chainId: 1, pool: "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed", ppRouters: ["0xe76E793d776c1e207aD7a7fa7C57d27420d85110", "0x13a0B86BAc3e0c29bD64FEd7bCd2Ee84f371f41c", "0x77613D670BB9fD48A9898D0eac8ebf21B566F960"], fromBlock: 25_884_330n, chunk: 50_000n },
    { name: "prod bsc", group: "prod", chainId: 56, pool: "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed", ppRouters: ["0x9929Ad2Edc2E0B5D59C3f5b2910812D0c8b84E16"], fromBlock: 119_614_738n, chunk: 500_000n },
    { name: "prod citrea", group: "prod", chainId: 4114, pool: "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed", ppRouters: [], fromBlock: 12_987_015n, chunk: 50_000n, rpcFallback: "https://rpc.mainnet.citrea.xyz" },
    { name: "test mainnet", group: "test", chainId: 1, pool: "0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52", ppRouters: [], fromBlock: 25_639_398n, chunk: 50_000n },
    { name: "test optimism", group: "test", chainId: 10, pool: "0x02a1E00294291d0E938eC92A8c2883044524ec4B", ppRouters: [], fromBlock: 155_397_571n, chunk: 2_000_000n },
    { name: "test bsc", group: "test", chainId: 56, pool: "0x968950B99a92d6b96914474a318ac83ed37B3bE6", ppRouters: [], fromBlock: 119_190_727n, chunk: 500_000n },
    { name: "test base", group: "test", chainId: 8453, pool: "0x2B7bC8aF6E60f6A33b82E3098fec2EC81C2b6256", ppRouters: [], fromBlock: 51_737_312n, chunk: 2_000_000n },
    { name: "test arbitrum (it-002)", group: "test", chainId: 42161, pool: "0x38B829a19B178fA5Defa1D379C2859bd3e5B3451", ppRouters: [], fromBlock: 482_544_000n, chunk: 10_000_000n },
];

const ABI = parseAbi([
    "event Transacted(uint256[] outputCommitments, uint256[] nullifierHashes, address indexed asset, uint256 withdrawnValue, address indexed caller)",
]);
const T = {
    relayed: keccak256(toHex("Relayed(address,address,uint256,address,uint256,uint256)")),
    relayedBatch: keccak256(toHex("RelayedBatch(address,address,uint256,address,uint256,uint256,uint256)")),
    executed: keccak256(toHex("Executed(address,address,uint256,address,uint256)")),
    unwrapped: keccak256(toHex("Unwrapped(address,address,uint256,uint256,uint256)")),
    lifiStarted: "0xcba69f43792f9f399347222505213b55af8e0b0b54b893085c2e27ecbe1644f1",
};

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const JSON_OUT = arg("json");
const GROUPS = (arg("stacks") ?? "prod,test").split(",");

interface Sample {
    stack: string;
    group: string;
    chainId: number;
    tx: Hex;
    block: string;
    from: Address;
    to: Address;
    selector: string;
    op: string;
    inputs: number;
    outputs: number;
    transacts: number;
    execGas: number;
    status: string;
}

function clientFor(s: Stack): PublicClient {
    const url = process.env[`RPC_URL_EVM_${s.chainId}`] ?? s.rpcFallback;
    if (!url) throw new Error(`set RPC_URL_EVM_${s.chainId}`);
    return createPublicClient({ transport: http(url, { timeout: 60_000, retryCount: 3 }) }) as PublicClient;
}

async function collect(s: Stack): Promise<Sample[]> {
    const c = clientFor(s);
    const latest = await c.getBlockNumber();
    const txs = new Map<Hex, { inputs: number; outputs: number; transacts: number; caller: string }>();
    for (let f = s.fromBlock; f <= latest; f += s.chunk) {
        const t = f + s.chunk - 1n > latest ? latest : f + s.chunk - 1n;
        const logs = await c.getLogs({ address: s.pool, event: ABI[0], fromBlock: f, toBlock: t });
        for (const l of logs) {
            const a = l.args as { outputCommitments: bigint[]; nullifierHashes: bigint[]; caller: string };
            const prev = txs.get(l.transactionHash) ?? { inputs: 0, outputs: 0, transacts: 0, caller: a.caller };
            prev.inputs += a.nullifierHashes.length;
            prev.outputs += a.outputCommitments.length;
            prev.transacts += 1;
            txs.set(l.transactionHash, prev);
        }
    }
    // Relayer signers = senders of txs that went through the relay contract; reused to recognise
    // relayer-sent direct transfers.
    const out: Sample[] = [];
    const routers = new Set(s.ppRouters.map((x) => x.toLowerCase()));
    const pending: { hash: Hex; meta: { inputs: number; outputs: number; transacts: number; caller: string }; tx: Awaited<ReturnType<PublicClient["getTransaction"]>>; raw: Record<string, string>; topics: Set<string> }[] = [];
    for (const [hash, meta] of txs) {
        const [tx, raw] = await Promise.all([c.getTransaction({ hash }), c.request({ method: "eth_getTransactionReceipt", params: [hash] }) as Promise<Record<string, unknown>>]);
        const topics = new Set(((raw.logs as { topics: string[] }[]) ?? []).map((l) => l.topics[0]));
        pending.push({ hash, meta, tx, raw: raw as Record<string, string>, topics });
    }
    // Relayer signers = senders of relay-contract / RelaySwaps txs; used to recognise the
    // relayer's direct PoolVault.transact calls (shielded transfers) vs user self-transacts.
    const relayerSigners = new Set(pending.filter((p) => p.topics.has(T.relayed) || p.topics.has(T.relayedBatch) || p.topics.has(T.executed)).map((p) => p.tx.from.toLowerCase()));
    for (const p of pending) {
        const to = (p.tx.to ?? "").toLowerCase();
        const sel = p.tx.input.slice(0, 10);
        let op = "other";
        if (p.topics.has(T.relayedBatch)) op = "withdrawBatch";
        else if (p.topics.has(T.relayed)) op = routers.has(to) ? "yieldWithdraw" : "withdraw";
        else if (p.topics.has(T.executed)) op = `relaySwap:${p.topics.has(T.lifiStarted) ? "crosschain" : "samechain"}${p.topics.has(T.unwrapped) ? "+unwrap" : ""}`;
        else if (routers.has(to)) op = "yieldWithdraw";
        else if (to === s.pool.toLowerCase()) op = relayerSigners.has(p.tx.from.toLowerCase()) ? "shieldedTransfer" : "selfTransact";
        const gasUsed = BigInt(p.raw.gasUsed);
        const l1 = p.raw.gasUsedForL1 ? BigInt(p.raw.gasUsedForL1) : 0n;
        out.push({
            stack: s.name,
            group: s.group,
            chainId: s.chainId,
            tx: p.hash,
            block: BigInt(p.raw.blockNumber).toString(),
            from: p.tx.from,
            to: p.tx.to as Address,
            selector: sel,
            op,
            inputs: p.meta.inputs,
            outputs: p.meta.outputs,
            transacts: p.meta.transacts,
            execGas: Number(gasUsed - l1),
            status: p.raw.status === "0x1" ? "success" : "reverted",
        });
    }
    return out;
}

function pct(xs: number[], p: number): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
}
const k = (n: number) => `${Math.round(n / 1000)}k`;

(async () => {
    const all: Sample[] = [];
    for (const s of STACKS.filter((x) => GROUPS.includes(x.group))) {
        try {
            const rows = await collect(s);
            console.log(`${s.name.padEnd(24)} ${rows.length} txs`);
            all.push(...rows);
        } catch (e) {
            console.log(`${s.name.padEnd(24)} FAILED: ${(e as Error).message.split("\n")[0].slice(0, 120)}`);
        }
    }
    const ok = all.filter((r) => r.status === "success");
    const groups = new Map<string, Sample[]>();
    for (const r of ok) {
        const key = `${r.op} | in=${r.inputs} out=${r.outputs}${r.transacts > 1 ? ` x${r.transacts}` : ""} | ${r.selector}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    console.log(`\n${"operation | notes | selector".padEnd(58)} ${"n".padStart(4)} ${"min".padStart(6)} ${"p50".padStart(6)} ${"p90".padStart(6)} ${"max".padStart(6)}  chains`);
    for (const [key, rs] of [...groups].sort()) {
        const g = rs.map((r) => r.execGas);
        console.log(`${key.padEnd(58)} ${String(rs.length).padStart(4)} ${k(Math.min(...g)).padStart(6)} ${k(pct(g, 50)).padStart(6)} ${k(pct(g, 90)).padStart(6)} ${k(Math.max(...g)).padStart(6)}  ${[...new Set(rs.map((r) => r.chainId))].join(",")}`);
    }
    const rev = all.filter((r) => r.status !== "success");
    if (rev.length) console.log(`\n(${rev.length} reverted txs excluded)`);
    if (JSON_OUT) {
        writeFileSync(JSON_OUT, JSON.stringify(all, null, 1));
        console.log(`\nJSON: ${JSON_OUT}`);
    }
})().catch((e) => {
    console.error("FAILED:", e?.message ?? e);
    process.exit(1);
});
