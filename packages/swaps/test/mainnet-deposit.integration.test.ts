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
import { saveRecoverySnapshot } from "./helpers/recovery-snapshot.js";
import type { ProtocolKeys } from "./helpers/recovery-snapshot.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  APP_IDENTIFIER,
  NoteStatus,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  Hex,
  PoolSession,
  ILogger,
} from "@privacy-pools-v2/evm-sdk";

import {
  POOL_ADDRESS,
  ENTRYPOINT_ADDRESS,
  KEYSTORE_ADDRESS,
  ASP_REGISTRY_ADDRESS,
  DEPLOYMENT_BLOCK,
  RELAY_SWAPS_ADDRESS,
} from "./contract.config.js";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";

// --- Tokens ---
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;

// --- Config ---
const ARB_CHAIN_ID = 42161;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Separate from PRIVATE_KEY on purpose: the depositor (PRIVATE_KEY) owns the note and
// must match the session's ownerAddress, but registering the label needs POSTMAN_ROLE
// on the live ASPRegistry — a different wallet. Reusing one key for both breaks either
// the deposit (wrong owner) or the registration (Permissioned_NotAuthorized).
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDC
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(__dirname, "../.mainnet-deposit-notes");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

// --- EIP-712 typed data for secret derivation ---
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

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

/**
 * Minimal SDK-only deposit into the pool — no relayer, no swap, no external ASP
 * service (a local ASP tree stands in to approve the label so the note reaches
 * ACTIVE). Isolates the plain `deposit` path (approve → deposit proof →
 * Entrypoint.deposit) so a failure here rules the deposit machinery in/out
 * independently of the reshield swap+deposit embedding.
 */
describe.skipIf(!PRIVATE_KEY || !ASP_POSTMAN_PRIVATE_KEY || !hasCircuits)(
  "SDK Deposit (Arb Mainnet) — plain USDC deposit into pool",
  () => {
    let publicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;
    let session: PoolSession;
    let protocolKeys: ProtocolKeys;
    let localASP: LocalASPTreeService;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      const postmanAccount = privateKeyToAccount(
        ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`,
      );

      publicClient = createPublicClient({
        chain: arbitrum,
        transport: http(ARB_RPC),
      });
      walletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(ARB_RPC),
      });
      postmanWalletClient = createWalletClient({
        account: postmanAccount,
        chain: arbitrum,
        transport: http(ARB_RPC),
      });

      // --- Derive protocol keys from an EIP-712 signature ---
      const cryptoService = new CryptoService();
      const payload = buildSecretDerivationPayload(account.address as Address);
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

      // --- Local ASP tree: registers the deposit label on-chain so the note
      // can be observed reaching ACTIVE (no relayer needed for a plain deposit).
      // Signed by the postman wallet, not the depositor — POSTMAN_ROLE lives there. ---
      localASP = await LocalASPTreeService.create({
        aspRegistryAddress: ASP_REGISTRY_ADDRESS as Hex,
        walletClient: postmanWalletClient as any,
        publicClient: publicClient as any,
      });

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
            name: "unused",
            chainId: ARB_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: account.address as Address,
            processorAddress: account.address as Address,
          },
        ],
        persistentStorage: { type: "file", dirPath: NOTE_STORAGE_DIR },
        walletInteractor: { type: "viem", walletClient: walletClient as any },
        logger: consoleLogger,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
      })
        .withAspDataProvider(localASP)
        .create();

      console.log("PoolSession created");
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

    it("deposit USDC and observe the note become ACTIVE on-chain", async () => {
      const depositValue = `0x${BigInt(DEPOSIT_AMOUNT).toString(16)}` as Hex;

      const poolBefore = (await publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as `0x${string}`],
      })) as bigint;
      console.log("Pool USDC before:", formatUnits(poolBefore, 6));

      // === 1. Prepare deposit (builds proof + approval tx) ===
      console.log(
        "\nPreparing deposit of",
        formatUnits(BigInt(DEPOSIT_AMOUNT), 6),
        "USDC...",
      );
      const depositResult = await session.prepareDeposit({
        tokenId: USDC,
        value: depositValue,
      });
      const commitment = depositResult.pendingNote.commitment;
      console.log("Deposit proof ready. Commitment:", commitment);
      console.log(
        "Note value:",
        formatUnits(BigInt(depositResult.pendingNote.value), 6),
      );
      expect(BigInt(depositResult.pendingNote.value)).toBe(
        BigInt(DEPOSIT_AMOUNT),
      );
      expect(depositResult.depositTx.to.toLowerCase()).toBe(
        ENTRYPOINT_ADDRESS.toLowerCase(),
      );

      // === 2. Execute (approve if needed, then Entrypoint.deposit) ===
      const depositReceipt = await session.executeDeposit(depositResult);
      console.log(
        "Deposit tx:",
        depositReceipt.txHash,
        "status:",
        depositReceipt.status,
      );
      expect(depositReceipt.status).toBe(true);

      // === 3. Recovery snapshot — all data needed for ragequit without re-scanning.
      // Saved before ASP registration deliberately: the deposit is already
      // irreversible on-chain at this point, but registerLabel can still revert
      // (e.g. an authorization gap), and a snapshot saved after such a revert
      // would never be written, losing recovery data for real, spent funds.
      const depositTx = await publicClient.getTransaction({
        hash: depositReceipt.txHash as `0x${string}`,
      });
      await saveRecoverySnapshot({
        publicClient: publicClient as any,
        chainId: ARB_CHAIN_ID,
        depositTxHash: depositReceipt.txHash as Hex,
        depositBlock: depositTx.blockNumber!,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
        ownerAddress: account.address as Address,
        contracts: {
          pool: POOL_ADDRESS as Address,
          entrypoint: ENTRYPOINT_ADDRESS as Address,
          keystore: KEYSTORE_ADDRESS as Address,
          aspRegistry: ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys,
        note: depositResult.pendingNote,
        storageDir: NOTE_STORAGE_DIR,
      });

      // === 4. Register the label in the local ASP tree so the note is approved ===
      await localASP.registerLabel(depositResult.pendingNote.label as Hex);
      console.log(
        "Label registered in ASP tree, root:",
        await localASP.getRoot(),
      );

      // === 5. On-chain proof: pool USDC balance grew by the deposit amount ===
      const poolAfter = (await publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as `0x${string}`],
      })) as bigint;
      console.log("Pool USDC after:", formatUnits(poolAfter, 6));
      expect(poolAfter - poolBefore).toBe(BigInt(DEPOSIT_AMOUNT));

      // === 6. SDK-side proof: sync notes, the deposited note is ACTIVE ===
      // discoverNotes() only returns newly-found notes; this note was already
      // added to the NoteManager by prepareDeposit(), so it's skipped as a
      // duplicate here — its status still gets synced to ACTIVE as a side
      // effect. exportAccount() reads the current state instead of relying
      // on discoverNotes()'s return value.
      const fromBlock =
        `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
      await session.discoverNotes({ fromBlock });

      const accountExport = await session.exportAccount();
      const note = accountExport.notes.find(
        (n) => n.commitment.toLowerCase() === commitment.toLowerCase(),
      );
      expect(note, "deposited note should be discovered").toBeDefined();
      expect(note!.status).toBe(NoteStatus.ACTIVE);
      expect(note!.tokenId.toLowerCase()).toBe(USDC.toLowerCase());
      expect(BigInt(note!.value)).toBe(BigInt(DEPOSIT_AMOUNT));

      console.log("\n=== SDK DEPOSIT PASS ===");
    }, 300_000);
  },
);
