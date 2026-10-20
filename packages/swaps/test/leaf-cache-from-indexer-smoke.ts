/**
 * §11.5 live smoke test (envio_hyper_index.org): cross-checks
 * `fetchKeystoreLeafCacheSeed` (test/helpers/leaf-cache-from-indexer.ts)
 * against an independent, from-scratch RPC scan of the same real Sepolia
 * keystore contract — not a comparison against the SDK's own
 * `KeystoreInteractor` (which isn't exported publicly from
 * @privacy-pools-v2/evm-sdk anyway), so this doesn't just prove
 * self-consistency with the thing being validated.
 *
 * Not wired into `pnpm test` — one-off verification script.
 * Run from packages/swaps with GQL_KEY set:
 *   GQL_KEY=... npx tsx test/leaf-cache-from-indexer-smoke.ts
 */
import { createPublicClient, http, type Log } from "viem";
import { sepolia } from "viem/chains";

import type { Address, Hash, LeafCacheSeed } from "@privacy-pools-v2/evm-sdk";

import {
  fetchKeystoreLeafCacheSeed,
  fetchStateLeafCacheSeed,
} from "./helpers/leaf-cache-from-indexer.js";

const CHAIN_ID = 11155111;
const KEYSTORE_ADDRESS =
  "0x6d264aCb9C3A7A3105c29470AfE2F5F1EC203C73" as Address;
// Canonical Sepolia poolAddress from packages/sdk/src/constant/deployments.ts —
// NOT docs/deployments.local.json's poolVault, which is the unrelated local
// anvil-fork deployment (see the fromBlock comment below for why that
// distinction already bit this script once).
const POOL_VAULT_ADDRESS =
  "0x09b94d3127019298757A6ceeB7911922085f7C01" as Address;
const RPC_URL =
  process.env.SEPOLIA_RPC_URL ??
  process.env.RPC_URL_11155111 ??
  "https://ethereum-sepolia-rpc.publicnode.com";
const GETLOGS_WINDOW = 10_000n;

async function withRetries<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastError;
}

const KEYSTORE_EVENTS_ABI = [
  {
    type: "event",
    name: "LeafInserted",
    inputs: [
      { name: "_newLeaf", type: "uint256", indexed: false },
      { name: "_root", type: "uint256", indexed: false },
      { name: "_leafIndex", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "LeafUpdated",
    inputs: [
      { name: "_newLeaf", type: "uint256", indexed: false },
      { name: "_root", type: "uint256", indexed: false },
      { name: "_leafIndex", type: "uint256", indexed: false },
    ],
  },
] as const;

const POOL_VAULT_LEAVES_INSERTED_ABI = [
  {
    type: "event",
    name: "LeavesInserted",
    inputs: [
      { name: "_newLeaves", type: "uint256[]", indexed: false },
      { name: "_root", type: "uint256", indexed: false },
      { name: "_startIndex", type: "uint256", indexed: false },
    ],
  },
] as const;

function bigintToHex(value: bigint): Hash {
  return `0x${value.toString(16).padStart(64, "0")}` as Hash;
}

async function getLogsChunked(
  client: ReturnType<typeof createPublicClient>,
  address: Address,
  events: readonly unknown[],
  fromBlock: bigint,
): Promise<Log[]> {
  const currentBlock = await client.getBlockNumber();
  const logs: Log[] = [];
  let cursor = fromBlock;
  while (cursor <= currentBlock) {
    const toBlock =
      cursor + GETLOGS_WINDOW > currentBlock
        ? currentBlock
        : cursor + GETLOGS_WINDOW;
    const batch = await withRetries(() =>
      client.getLogs({
        address,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        events: events as any,
        fromBlock: cursor,
        toBlock,
      }),
    );
    logs.push(...batch);
    cursor = toBlock + 1n;
  }
  return logs;
}

async function scanKeystoreFromRpc(): Promise<{
  toBlock: bigint;
  leaves: Hash[];
}> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL),
  });
  const currentBlock = await client.getBlockNumber();

  // A safe lower bound below this contract's true earliest LeafInserted
  // (block 10994877, per the indexer's own leafIndex=0 row) — NOT
  // docs/deployments.local.json's minFromBlock, which is a different,
  // unrelated local anvil-fork deployment and does not apply to this real
  // Sepolia contract (first attempt used that value and silently missed
  // every event before it, which is exactly the kind of gap this smoke
  // test exists to catch).
  const logs = await getLogsChunked(
    client,
    KEYSTORE_ADDRESS,
    KEYSTORE_EVENTS_ABI,
    10900000n,
  );

  // viem returns logs already ordered by (blockNumber, logIndex) ascending within one getLogs call,
  // and our windows are scanned in increasing order, so `logs` is globally ordered correctly.
  const leaves: Hash[] = [];
  for (const log of logs) {
    const decoded = log as unknown as {
      eventName: string;
      args: { _leafIndex: bigint; _newLeaf: bigint };
    };
    if (decoded.eventName !== "LeafInserted") continue;
    leaves[Number(decoded.args._leafIndex)] = bigintToHex(
      decoded.args._newLeaf,
    );
  }
  for (const log of logs) {
    const decoded = log as unknown as {
      eventName: string;
      args: { _leafIndex: bigint; _newLeaf: bigint };
    };
    if (decoded.eventName !== "LeafUpdated") continue;
    leaves[Number(decoded.args._leafIndex)] = bigintToHex(
      decoded.args._newLeaf,
    );
  }

  return { toBlock: currentBlock, leaves };
}

async function scanPoolVaultFromRpc(): Promise<{
  toBlock: bigint;
  leaves: Hash[];
}> {
  const client = createPublicClient({
    chain: sepolia,
    transport: http(RPC_URL),
  });
  const currentBlock = await client.getBlockNumber();

  // Same earliest-block reasoning as scanKeystoreFromRpc — the pool vault
  // and keystore deploy together, so the same safe lower bound applies.
  const logs = await getLogsChunked(
    client,
    POOL_VAULT_ADDRESS,
    POOL_VAULT_LEAVES_INSERTED_ABI,
    10900000n,
  );

  const leaves: Hash[] = [];
  for (const log of logs) {
    const decoded = log as unknown as {
      args: { _startIndex: bigint; _newLeaves: readonly bigint[] };
    };
    const startIndex = Number(decoded.args._startIndex);
    decoded.args._newLeaves.forEach((newLeaf, offset) => {
      leaves[startIndex + offset] = bigintToHex(newLeaf);
    });
  }

  return { toBlock: currentBlock, leaves };
}

function compare(
  label: string,
  fromIndexer: LeafCacheSeed,
  fromRpc: { toBlock: bigint; leaves: Hash[] },
): boolean {
  const comparableLength = fromIndexer.leaves.length;
  const rpcPrefix = fromRpc.leaves.slice(0, comparableLength);

  let mismatches = 0;
  for (let i = 0; i < comparableLength; i++) {
    if (rpcPrefix[i] !== fromIndexer.leaves[i]) {
      mismatches++;
      console.error(
        `  [${label}] MISMATCH at index ${i}: indexer=${fromIndexer.leaves[i]} rpc=${rpcPrefix[i]}`,
      );
    }
  }

  const ok = mismatches === 0 && rpcPrefix.length === comparableLength;
  console.log(
    ok
      ? `  [${label}] PASS — all ${comparableLength} leaves match an independent RPC scan.`
      : `  [${label}] FAIL — ${mismatches} mismatch(es) out of ${comparableLength} leaves.`,
  );
  return ok;
}

async function main() {
  const apiKey = process.env.GQL_KEY;
  if (!apiKey) {
    console.error("Set GQL_KEY (see ~/.../research_hyperindex/.env)");
    process.exit(1);
  }
  const indexerConfig = {
    endpoint: "https://indexer.hyperindex.xyz/cf03704/v1/graphql",
    apiKey,
  };

  console.log("=== Keystore ===");
  console.log("Fetching seed from indexer (cf03704)...");
  const keystoreFromIndexer = await fetchKeystoreLeafCacheSeed(
    indexerConfig,
    CHAIN_ID,
    KEYSTORE_ADDRESS,
  );
  console.log(
    `  indexer: toBlock=${keystoreFromIndexer.toBlock}, ${keystoreFromIndexer.leaves.length} leaves`,
  );
  console.log(
    "Scanning the same contract directly via RPC (independent path)...",
  );
  const keystoreFromRpc = await scanKeystoreFromRpc();
  console.log(
    `  rpc scan: toBlock=${keystoreFromRpc.toBlock}, ${keystoreFromRpc.leaves.length} leaves`,
  );
  const keystoreOk = compare("keystore", keystoreFromIndexer, keystoreFromRpc);

  console.log("\n=== PoolVault (state tree) ===");
  console.log("Fetching seed from indexer (cf03704)...");
  const poolFromIndexer = await fetchStateLeafCacheSeed(
    indexerConfig,
    CHAIN_ID,
    POOL_VAULT_ADDRESS,
  );
  console.log(
    `  indexer: toBlock=${poolFromIndexer.toBlock}, ${poolFromIndexer.leaves.length} leaves`,
  );
  console.log(
    "Scanning the same contract directly via RPC (independent path)...",
  );
  const poolFromRpc = await scanPoolVaultFromRpc();
  console.log(
    `  rpc scan: toBlock=${poolFromRpc.toBlock}, ${poolFromRpc.leaves.length} leaves`,
  );
  const poolOk = compare("pool-vault", poolFromIndexer, poolFromRpc);

  if (!keystoreOk || !poolOk) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
