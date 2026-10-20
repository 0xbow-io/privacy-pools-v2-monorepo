/**
 * Recovery test for Base PoolVault notes left stranded by prior runs of
 * mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue.integration.test.ts.
 *
 * Those runs wrote `base-pending-*.json` files (the "layer 1" cheap fallback from
 * integration_test_standards.org §two-layer-protection), but crashed before they
 * could call saveRecoverySnapshot() ("layer 2"). The notes landed on-chain (the
 * relay-swaps tx and LiFi bridge completed) but no recovery snapshot exists in
 * .mainnet-deposit-notes/, so the ordinary test-2 sweep never sees them.
 *
 * This test bypasses snapshots entirely: it rebuilds a Base PoolSession from the
 * saved protocolKeys (state file), scans the Base pool from the deployment block,
 * and ragequits every discovered ACTIVE/PENDING note. Protocol keys come from the
 * state file — no wallet signature required. Ragequit TXs are sent by PRIVATE_KEY
 * (same wallet that owns the notes: 0xa60748...).
 *
 * Run with: ./run_a_test.sh <N>   (whichever index this is in run_a_test.sh)
 * Prereqs : PRIVATE_KEY, ARB_RPC_URL (for key derivation check), BASE_RPC_URL,
 *           circuit artifacts at packages/circuits/build/ragequit.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { resolve } from "path";
import { existsSync, readFileSync } from "fs";

import {
  PoolSessionBuilder,
  NoteStatus,
  ViemRPCInteractor,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  Hash,
  Hex,
  PoolSession,
} from "@privacy-pools-v2/evm-sdk";
import type { ILogger } from "@privacy-pools-v2/evm-sdk";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import { getContract } from "./helpers/deployment-loader.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

// --- Contract addresses (Base, from deployments) ---
const BASE_POOL_ADDRESS = getContract(8453, "PoolVault");
const BASE_ENTRYPOINT_ADDRESS = getContract(8453, "Entrypoint");
const BASE_KEYSTORE_ADDRESS = getContract(8453, "Keystore");
const BASE_ASP_REGISTRY_ADDRESS = getContract(8453, "ASPRegistry");
const BASE_RELAY_SWAPS_ADDRESS = getContract(8453, "RelaySwaps");

// --- Token ---
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

// --- Config ---
const BASE_CHAIN_ID = 8453;
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const BASE_DEPLOYMENT_BLOCK = (process.env.BASE_DEPLOYMENT_BLOCK ??
  "0x2F904AE") as Hex; // 49,874,094

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");

// State file written by the dust-rescue integration test — contains the
// protocolKeys that were used to create the stranded notes.
const STATE_FILE_PATH = resolve(
  __dirname,
  "../.mainnet-crosschain-reshield-dust-rescue-state.json",
);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
const POOL_COMMITMENTS_ABI = parseAbi([
  "function commitments(uint256 _commitmentHash) view returns (uint256 _createdAt)",
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

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "ragequit"));
const hasStateFile = existsSync(STATE_FILE_PATH);

describe.skipIf(!PRIVATE_KEY || !hasCircuits || !hasStateFile)(
  "Recover stranded Base PoolVault notes (cross-chain reshield runs)",
  () => {
    let basePublicClient: ReturnType<typeof createPublicClient>;
    let baseWalletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let session: PoolSession;
    let localASP: LocalASPTreeService;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);

      basePublicClient = createPublicClient({
        chain: base,
        transport: http(BASE_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;
      baseWalletClient = createWalletClient({
        account,
        chain: base,
        transport: http(BASE_RPC),
      });

      const stateFile = JSON.parse(readFileSync(STATE_FILE_PATH, "utf8"));
      const protocolKeys = stateFile.protocolKeys as {
        privateNullifyingKey: Hex;
        privateRevocableKey: Hex;
        revocableKeyIndex: Hex;
        viewingPrivateKey: Hex;
        viewingPublicKey: Hex;
      };

      console.log(
        "Loaded protocolKeys from state file. Owner address:",
        account.address,
      );

      // ASP for Base — ragequit is permissionless w.r.t. the ASP (see
      // integration_test_standards.org §postman-exception): getLabelStatus()
      // unconditionally returns "approved"; no registerLabel() call is made.
      localASP = await LocalASPTreeService.create({
        aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS,
        walletClient: baseWalletClient as any,
        publicClient: basePublicClient as any,
      });

      session = await PoolSessionBuilder.fromConfig({
        chainId: BASE_CHAIN_ID,
        rpcUrl: BASE_RPC,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: BASE_POOL_ADDRESS as Address,
          entrypointAddress: BASE_ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: BASE_RELAY_SWAPS_ADDRESS as Address,
        },
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, BASE_CHAIN_ID, {
          keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
          poolAddress: BASE_POOL_ADDRESS as Address,
        }),
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [
          {
            url: "http://localhost:3000",
            name: "unused",
            chainId: BASE_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: account.address as Address,
            processorAddress: account.address as Address,
          },
        ],
        persistentStorage: { type: "memory" },
        walletInteractor: {
          type: "viem",
          walletClient: baseWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: BASE_DEPLOYMENT_BLOCK,
      })
        .withAspDataProvider(localASP)
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: basePublicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(BASE_DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create();

      console.log("Base PoolSession ready for recovery scan");
    }, 120_000);

    afterAll(() => {
      saveSessionLeafCache(
        LEAF_CACHE_DIR,
        BASE_CHAIN_ID,
        {
          keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
          poolAddress: BASE_POOL_ADDRESS as Address,
        },
        session,
      );
    });

    it("scan Base pool from deployment block, ragequit all ACTIVE/PENDING notes", async () => {
      console.log(
        `\nScanning Base pool from block ${BASE_DEPLOYMENT_BLOCK} for stranded notes...`,
      );
      await session.discoverNotes({ fromBlock: BASE_DEPLOYMENT_BLOCK });

      const accountExport = await session.exportAccount();
      const allNotes = accountExport.notes;
      console.log(`Found ${allNotes.length} total note(s) on Base`);

      const ragequitable = allNotes.filter(
        (n) =>
          (n.status === NoteStatus.ACTIVE || n.status === NoteStatus.PENDING) &&
          BigInt(n.value) > 0n,
      );

      console.log(`${ragequitable.length} note(s) eligible for ragequit:`);
      for (const note of ragequitable) {
        console.log(
          `  - ${note.commitment} | ${note.status} | ${formatUnits(BigInt(note.value), 6)} USDC`,
        );
      }

      if (ragequitable.length === 0) {
        console.log(
          "No ragequitable notes found — pool may already be empty or notes were not yet mined.",
        );
        return;
      }

      const balanceBefore = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address as `0x${string}`],
      });
      console.log(
        `\nUSDC balance before: ${formatUnits(balanceBefore as bigint, 6)}`,
      );

      let successCount = 0;
      let staleCount = 0;
      for (const note of ragequitable) {
        const createdAt = (await basePublicClient.readContract({
          address: BASE_POOL_ADDRESS as `0x${string}`,
          abi: POOL_COMMITMENTS_ABI,
          functionName: "commitments",
          args: [BigInt(note.commitment)],
        })) as bigint;
        if (createdAt === 0n) {
          staleCount++;
          console.log(
            `\nSkipping ${note.commitment} — not found on-chain (note did not land or commitment format mismatch)`,
          );
          continue;
        }

        try {
          console.log(`\nRagequitting ${note.commitment}...`);
          const receipt = await session.rageQuit({
            commitment: note.commitment as Hash,
          });
          console.log(`  ✓ tx: ${receipt.txHash} | status: ${receipt.status}`);
          expect(receipt.status).toBe(true);
          successCount++;
        } catch (err) {
          console.error(
            `  ✗ Failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      const balanceAfter = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address as `0x${string}`],
      });
      console.log(
        `\nUSDC balance after: ${formatUnits(balanceAfter as bigint, 6)}`,
      );
      console.log(
        `Recovered: ${formatUnits((balanceAfter as bigint) - (balanceBefore as bigint), 6)} USDC`,
      );
      console.log(
        `\n=== Recovery complete: ${successCount}/${ragequitable.length} note(s) ragequitted (${staleCount} skipped) ===`,
      );

      if (ragequitable.length - staleCount > 0) {
        expect(successCount).toBeGreaterThan(0);
      }
    }, 5_400_000); // 90 min — full-range scan + proof gen per note
  },
);
