import { describe, it, expect } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, base, bsc, optimism } from "viem/chains";
import { resolve } from "path";
import { existsSync, readdirSync } from "fs";

import {
  PoolSessionBuilder,
  ViemRPCInteractor,
  NoteStatus,
} from "@privacy-pools-v2/evm-sdk";
import type { Address, Hash, Hex, ILogger } from "@privacy-pools-v2/evm-sdk";

import {
  loadRecoverySnapshot,
  markAsRecovered,
  SnapshotRPCInteractor,
  type RecoverySnapshot,
} from "./helpers/recovery-snapshot.js";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import { RELAY_SWAPS_ADDRESS } from "./contract.config.js";

// --- Config ---
const ARB_CHAIN_ID = 42161;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const BSC_RPC = process.env.BSC_RPC_URL ?? "https://bsc-dataseed.binance.org";
const OP_RPC = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(__dirname, "../.mainnet-deposit-notes");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

const consoleLogger: ILogger = {
  level: "debug",
  child(service: string): ILogger {
    return {
      ...consoleLogger,
      debug: (msg: string, obj?: object) =>
        console.log(`[${service}]`, msg, obj ?? ""),
    };
  },
  debug: (msg: string, obj?: object) => console.log("[sdk]", msg, obj ?? ""),
  info: (msg: string, obj?: object) => console.log("[sdk]", msg, obj ?? ""),
  warn: (msg: string, obj?: object) => console.warn("[sdk]", msg, obj ?? ""),
  error: (msg: string, obj?: object) => console.error("[sdk]", msg, obj ?? ""),
  fatal: (msg: string, obj?: object) =>
    console.error("[sdk:fatal]", msg, obj ?? ""),
};

function chainForId(chainId: number) {
  if (chainId === ARB_CHAIN_ID) return arbitrum;
  if (chainId === 8453) return base;
  if (chainId === 56) return bsc;
  if (chainId === 10) return optimism;
  throw new Error(`Unsupported chainId in snapshot: ${chainId}`);
}

function rpcUrlForId(chainId: number): string {
  if (chainId === ARB_CHAIN_ID) return ARB_RPC;
  if (chainId === 8453) return BASE_RPC;
  if (chainId === 56) return BSC_RPC;
  if (chainId === 10) return OP_RPC;
  throw new Error(`No RPC URL configured for chainId ${chainId}`);
}

function loadUnrecoveredSnapshots(): Array<{
  path: string;
  snapshot: RecoverySnapshot;
}> {
  if (!existsSync(NOTE_STORAGE_DIR)) return [];
  return readdirSync(NOTE_STORAGE_DIR)
    .filter((f) => f.startsWith("recovery-") && f.endsWith(".json"))
    .map((f) => ({
      path: resolve(NOTE_STORAGE_DIR, f),
      snapshot: loadRecoverySnapshot(resolve(NOTE_STORAGE_DIR, f)),
    }))
    .filter(({ snapshot }) => snapshot.recoveredAt === undefined);
}

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "ragequit"));
const unrecovered = loadUnrecoveredSnapshots();

describe.skipIf(!PRIVATE_KEY || !hasCircuits)(
  "Recover Snapshots (Ragequit) — Mainnet",
  () => {
    it.skipIf(unrecovered.length === 0)(
      `ragequit ${unrecovered.length} unrecovered deposit snapshot(s)`,
      async () => {
        const account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);

        let totalRecovered = 0;
        // Counts only genuine ragequit attempts (note found + ACTIVE) — not
        // owner mismatches, not-found notes, or notes already spent (see
        // the `discovered.status !== NoteStatus.ACTIVE` skip below). A run
        // where every unrecovered snapshot turns out to already be spent
        // (e.g. left behind before a suite added its own
        // markAsRecovered()-on-success call) is a clean no-op, not a
        // failure — mirrors mainnet-mass-ragequit's stale-note exemption.
        let attempted = 0;

        for (const { path: snapshotPath, snapshot } of unrecovered) {
          console.log(`\n--- Processing snapshot: ${snapshotPath}`);
          console.log(`    commitment: ${snapshot.note.commitment}`);
          console.log(`    chainId:    ${snapshot.chainId}`);
          console.log(`    deposit tx: ${snapshot.depositTxHash}`);
          console.log(`    owner:      ${snapshot.ownerAddress}`);

          // ragequit must be invoked by the note's owner (PoolSessionBuilder
          // enforces this — the signing wallet must match ownerAddress). A
          // wallet mismatch here isn't recoverable by trying harder; skip it
          // so one snapshot belonging to a different wallet doesn't abort
          // every other snapshot in this run.
          if (
            snapshot.ownerAddress.toLowerCase() !==
            account.address.toLowerCase()
          ) {
            console.warn(
              `    SKIP: snapshot owner ${snapshot.ownerAddress} does not match the ` +
                `signing wallet ${account.address} — re-run with that wallet's ` +
                `PRIVATE_KEY to recover it`,
            );
            continue;
          }

          try {
            const rpcUrl = rpcUrlForId(snapshot.chainId);
            const chain = chainForId(snapshot.chainId);

            const publicClient = createPublicClient({
              chain,
              transport: http(rpcUrl),
            });
            const walletClient = createWalletClient({
              account,
              chain,
              transport: http(rpcUrl),
            });

            // Real RPC: large chunks so the delta fetch after the deposit is fast.
            const realRpc = new ViemRPCInteractor(
              {
                publicClient: publicClient as any,
                chunkSize: 2_000_000n,
                minFromBlock: BigInt(snapshot.deploymentBlock),
              },
              { logger: consoleLogger },
            );

            // Snapshot RPC: serves stored leaves for the state tree scan, then
            // appends only the delta from depositBlock+1 onward via the real RPC.
            const snapshotRpc = new SnapshotRPCInteractor(realRpc, snapshot);

            // Ragequit doesn't touch the ASP data provider at all — it bypasses
            // ASP compliance checks by design (see key-architectural-concepts.md
            // §3.6). This local stub only exists to satisfy PoolSessionBuilder's
            // requirement for one; its getLabelStatus() unconditionally reports
            // "approved", so the ACTIVE-only filter below effectively treats
            // every discovered note as ragequit-eligible.
            const localASP = await LocalASPTreeService.create({
              aspRegistryAddress: snapshot.contracts.aspRegistry,
              walletClient: walletClient as any,
              publicClient: publicClient as any,
            });

            const session = await PoolSessionBuilder.fromConfig({
              chainId: snapshot.chainId,
              rpcUrl,
              ownerAddress: snapshot.ownerAddress,
              deployment: {
                poolAddress: snapshot.contracts.pool,
                entrypointAddress: snapshot.contracts.entrypoint,
                keystoreAddress: snapshot.contracts.keystore,
                aspRegistryAddress: snapshot.contracts.aspRegistry,
                // RelaySwaps is not used during ragequit; use the configured one.
                relaySwapsAddress: RELAY_SWAPS_ADDRESS as Address,
              },
              protocolKeys: snapshot.protocolKeys,
              circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
              relayers: [
                {
                  url: "http://localhost:3000",
                  name: "unused",
                  chainId: snapshot.chainId,
                  chainType: "evm",
                  status: "active" as const,
                  address: account.address as Address,
                  processorAddress: account.address as Address,
                },
              ],
              // In-memory: recovery session is ephemeral, notes loaded via discoverNotes.
              persistentStorage: { type: "memory" },
              walletInteractor: {
                type: "viem",
                walletClient: walletClient as any,
              },
              logger: consoleLogger,
              deploymentBlock: snapshot.deploymentBlock,
            })
              .withAspDataProvider(localASP)
              .withRpcInteractor(snapshotRpc)
              .create();

            // Discover the note by scanning only around the deposit block.
            // The SnapshotRPCInteractor intercepts the LeavesInserted scan for
            // this narrow window, making it cheap even on old deployments.
            const depositBlockN = BigInt(snapshot.depositBlock);
            const fromBlock = `0x${(depositBlockN - 1n).toString(16)}` as Hex;
            console.log(`    Discovering note from block ${fromBlock}...`);
            const notes = await session.discoverNotes({ fromBlock });

            const discovered = notes.find(
              (n) =>
                n.commitment.toLowerCase() ===
                snapshot.note.commitment.toLowerCase(),
            );

            if (!discovered) {
              console.warn(
                `    SKIP: note ${snapshot.note.commitment} not found in note discovery scan`,
              );
              continue;
            }

            console.log(`    Note status: ${discovered.status}`);

            if (discovered.status !== NoteStatus.ACTIVE) {
              console.warn(
                `    SKIP: note is not ACTIVE (status: ${discovered.status}); already spent or pending`,
              );
              continue;
            }

            attempted++;

            // Balance snapshot before ragequit
            const tokenId = snapshot.note.tokenId as `0x${string}`;
            const balanceBefore = (await publicClient.readContract({
              address: tokenId,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [account.address as `0x${string}`],
            })) as bigint;
            const decimals = (await publicClient.readContract({
              address: tokenId,
              abi: ERC20_ABI,
              functionName: "decimals",
            })) as number;
            console.log(
              `    Balance before: ${formatUnits(balanceBefore, decimals)} (${decimals} decimals)`,
            );

            console.log(`    Generating ragequit proof...`);
            const receipt = await session.rageQuit({
              commitment: snapshot.note.commitment as Hash,
            });
            console.log(
              `    Ragequit tx: ${receipt.txHash} | status: ${receipt.status}`,
            );
            expect(receipt.status).toBe(true);

            // Balance snapshot after
            const balanceAfter = (await publicClient.readContract({
              address: tokenId,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [account.address as `0x${string}`],
            })) as bigint;
            console.log(
              `    Balance after: ${formatUnits(balanceAfter, decimals)}`,
            );
            console.log(
              `    Recovered: ${formatUnits(balanceAfter - balanceBefore, decimals)}`,
            );

            markAsRecovered(snapshotPath);
            console.log(`    Snapshot marked as recovered.`);
            totalRecovered++;
          } catch (error) {
            // One snapshot's ragequit failing (e.g. a keystore/key-derivation
            // mismatch like the postman-owned stranded notes — see
            // recover-stranded-write-state.ts) must not abort every other
            // snapshot in this run.
            console.error(
              `    SKIP: unexpected error recovering ${snapshot.note.commitment}:`,
              error instanceof Error ? error.message : error,
            );
          }
        }

        console.log(
          `\n=== RECOVERY COMPLETE: ${totalRecovered}/${unrecovered.length} snapshots ragequitted ` +
            `(${attempted} genuinely attempted, ${unrecovered.length - attempted} skipped) ===`,
        );
        // Only require a successful recovery if at least one snapshot was
        // genuinely actionable. If every unrecovered snapshot was skipped
        // (wrong owner, not found, or already spent), there was nothing to
        // recover — that's success, not failure.
        if (attempted > 0) {
          expect(totalRecovered).toBeGreaterThan(0);
        }
      },
      3_600_000, // 1 hour — proof gen can take several minutes per note
    );
  },
);
