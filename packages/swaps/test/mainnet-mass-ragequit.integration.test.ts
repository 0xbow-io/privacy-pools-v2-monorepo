import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum } from "viem/chains";
import { resolve } from "path";
import { existsSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  NoteStatus,
  ViemRPCInteractor,
  APP_IDENTIFIER,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  Hash,
  Hex,
  PoolSession,
} from "@privacy-pools-v2/evm-sdk";

import type { ILogger } from "@privacy-pools-v2/evm-sdk";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

import {
  POOL_ADDRESS,
  ENTRYPOINT_ADDRESS,
  KEYSTORE_ADDRESS,
  ASP_REGISTRY_ADDRESS,
  DEPLOYMENT_BLOCK,
  RELAY_SWAPS_ADDRESS,
} from "./contract.config.js";

// --- Config ---
const ARB_CHAIN_ID = 42161;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(__dirname, "../.mainnet-test-notes");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const POOL_COMMITMENTS_ABI = parseAbi([
  "function commitments(uint256 _commitmentHash) view returns (uint256 _createdAt)",
]);

const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;

function buildSecretDerivationPayload(signerAddress: Address) {
  const addressHash = keccak256(signerAddress as `0x${string}`);
  return {
    domain: {
      name: "Standardized Secret Derivation",
      version: "1",
      verifyingContract:
        "0x0000000000000000000000000000000000000000" as `0x${string}`,
      salt: keccak256(toHex(APP_IDENTIFIER)),
    },
    types: {
      SecretDerivation: [
        { name: "purpose", type: "string" },
        { name: "addressHash", type: "bytes32" },
      ],
    },
    primaryType: "SecretDerivation" as const,
    message: {
      purpose:
        "This signature is used to deterministically derive application-specific secrets from your master seed. It is not a transaction and will not cost any gas.",
      addressHash,
    },
  };
}

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

describe.skipIf(!PRIVATE_KEY || !hasCircuits)(
  "Mass Ragequit (Arb Mainnet)",
  () => {
    let publicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let session: PoolSession;
    let localASP: LocalASPTreeService;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);

      publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(ARB_RPC),
      });

      walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(ARB_RPC),
      });

      const persistence = new TestStatePersistence();
      const savedState = persistence.load();

      // Derive protocol keys
      let protocolKeys: MainnetTestState["protocolKeys"];

      if (savedState?.protocolKeys) {
        protocolKeys = savedState.protocolKeys;
      } else {
        const cryptoService = new CryptoService();
        const payload = buildSecretDerivationPayload(
          account.address as Address,
        );
        const signature = await walletClient.signTypedData({
          ...payload,
          account,
        });
        const addressHash = keccak256(account.address as `0x${string}`);

        const km = KeystoreManager.fromSignature(
          {
            signature: signature as Hex,
            signerAddress: account.address as Address,
            revocableKeyIndex: "0x0" as Hex,
            addressHash: addressHash as Hex,
          },
          { cryptoService },
        );

        const viewingKeyPair = km.getViewingKeyPair();
        protocolKeys = {
          privateNullifyingKey: km.getPrivateNullifyingKey(),
          privateRevocableKey: km.getPrivateRevocableKey(),
          revocableKeyIndex: km.getRevocableKeyIndex(),
          viewingPrivateKey: viewingKeyPair.privateKey,
          viewingPublicKey: viewingKeyPair.publicKey,
        };
      }

      // Local ASP tree
      localASP = await LocalASPTreeService.create(
        {
          aspRegistryAddress: ASP_REGISTRY_ADDRESS,
          walletClient: walletClient as any,
          publicClient: publicClient as any,
        },
        savedState?.aspLeaves && savedState.aspLeaves.length > 0
          ? savedState.aspLeaves
          : undefined,
      );

      // Build PoolSession
      session = await PoolSessionBuilder.fromConfig({
        chainId: ARB_CHAIN_ID,
        rpcUrl: ARB_RPC,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: POOL_ADDRESS as Address,
          entrypointAddress: ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: RELAY_SWAPS_ADDRESS as Address,
        },
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, ARB_CHAIN_ID, {
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          poolAddress: POOL_ADDRESS as Address,
        }),
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [
          {
            url: "http://localhost:3000",
            name: "dummy",
            chainId: ARB_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: account.address as Address,
            processorAddress: account.address as Address,
          },
        ],
        persistentStorage: {
          type: "file",
          dirPath: NOTE_STORAGE_DIR,
        },
        walletInteractor: {
          type: "viem",
          walletClient: walletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
      })
        .withAspDataProvider(localASP)
        // Paid RPC: giant getLogs chunks instead of the default 10k-block crawl.
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: publicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create();

      console.log("PoolSession created for ragequit");
    }, 120_000);

    afterAll(() => {
      saveSessionLeafCache(
        LEAF_CACHE_DIR,
        ARB_CHAIN_ID,
        {
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          poolAddress: POOL_ADDRESS as Address,
        },
        session,
      );
    });

    it("discover notes and ragequit all ACTIVE + PENDING", async () => {
      // Discover all notes from chain
      console.log("Discovering notes from deployment block...");
      await session.discoverNotes({ fromBlock: DEPLOYMENT_BLOCK as Hex });

      const accountExport = await session.exportAccount();
      const allNotes = accountExport.notes;
      console.log(`Found ${allNotes.length} total notes`);

      // Filter ragequitable notes (ACTIVE or PENDING — ragequit works on both).
      // Zero-value change/dust notes are excluded: the pool reverts on ragequitting
      // nothing, and each attempt costs a full proof generation.
      const ragequitable = allNotes.filter(
        (n) =>
          (n.status === NoteStatus.ACTIVE || n.status === NoteStatus.PENDING) &&
          BigInt(n.value) > 0n,
      );

      console.log(`${ragequitable.length} notes eligible for ragequit:`);
      for (const note of ragequitable) {
        console.log(
          `  - ${note.commitment} | ${note.status} | value: ${note.value} | token: ${note.tokenId}`,
        );
      }

      if (ragequitable.length === 0) {
        console.log(
          "No notes to ragequit — nothing deposited or all already exited",
        );
        return;
      }

      // Check USDC balance before
      const balanceBefore = await publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address as `0x${string}`],
      });
      console.log(
        `\nUSDC balance before: ${formatUnits(balanceBefore as bigint, 6)}`,
      );

      // Ragequit each note sequentially
      let successCount = 0;
      let staleCount = 0;
      for (const note of ragequitable) {
        // Pre-flight: the pool must know this commitment, or ragequit reverts
        // with PoolVault_CommitmentNotFound. Notes from older SDK versions can
        // decrypt fine but recompute to a commitment that was never stored
        // (note-format drift) — skip those quietly instead of burning a proof.
        const createdAt = (await publicClient.readContract({
          address: POOL_ADDRESS as `0x${string}`,
          abi: POOL_COMMITMENTS_ABI,
          functionName: "commitments",
          args: [BigInt(note.commitment)],
        })) as bigint;
        if (createdAt === 0n) {
          staleCount++;
          console.log(
            `\nSkipping ${note.commitment} — commitment unknown on-chain (stale/pre-drift note format)`,
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
        } catch (error) {
          console.error(
            `  ✗ Failed:`,
            error instanceof Error ? error.message : error,
          );
        }
      }

      // Check USDC balance after
      const balanceAfter = await publicClient.readContract({
        address: USDC as `0x${string}`,
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
        `\n=== Ragequit complete: ${successCount}/${ragequitable.length} notes exited (${staleCount} stale skipped) ===`,
      );

      // At least one exit when any real (non-stale) note was attempted; a run
      // where every eligible note is stale is a clean no-op, not a failure.
      if (ragequitable.length - staleCount > 0) {
        expect(successCount).toBeGreaterThan(0);
      }
    }, 5_400_000); // 90 min timeout — full-range note discovery + proof gen per note
  },
);
