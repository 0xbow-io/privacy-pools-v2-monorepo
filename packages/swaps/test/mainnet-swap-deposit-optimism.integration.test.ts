/**
 * Swap-and-deposit entry flow on Optimism: the wallet holds USDC, LiFi swaps it
 * to USDT and atomically deposits the USDT into the privacy pool via the
 * Entrypoint (contractCalls quote). First integration exercise of
 * `PoolSession.prepareSwapAndDeposit` / `executeSwapAndDeposit` — no pool
 * withdrawal happens anywhere in this suite, and no relayer is involved: both
 * transactions (ERC-20 approval to LiFi's ERC20Proxy, then the swap+deposit)
 * are sent directly from the depositor wallet.
 *
 * Shares its persisted state (.mainnet-relay-swaps-reshield-state.json) with
 * the reshield suite ON PURPOSE: the local ASP tree leaves live there, and the
 * on-chain ASP root is one shared tree — a suite with its own empty leaf state
 * would clobber the root and orphan every other suite's registered labels.
 */
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
import { optimism } from "viem/chains";
import { resolve } from "path";
import { existsSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
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
import { saveRecoverySnapshot } from "./helpers/recovery-snapshot.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

// Contract addresses come from the shared deployments registry (deployments-it-002.json).
import { getContract } from "./helpers/deployment-loader.js";

const POOL_ADDRESS = getContract(10, "PoolVault");
const ENTRYPOINT_ADDRESS = getContract(10, "Entrypoint");
const KEYSTORE_ADDRESS = getContract(10, "Keystore");
const ASP_REGISTRY_ADDRESS = getContract(10, "ASPRegistry");
const RELAY_SWAPS_ADDRESS = getContract(10, "RelaySwaps");
// Optimism stack deploy block (2026-08-16, broadcast/Deploy.s.sol/10/run-latest.json).
const DEPLOYMENT_BLOCK = "0x9473A98"; // 155663000 — safely before the first deploy tx

// --- Tokens ---
const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const USDT = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Address;

// --- Config ---
const OP_CHAIN_ID = 10;
const OP_RPC = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// POSTMAN_ROLE wallet — registerLabel() on the live ASPRegistry reverts otherwise.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
// Deposit NOTE value (the vetting fee is added on top by the SDK when sizing the swap).
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDT
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(__dirname, "../.mainnet-swap-deposit-notes");
// Shared recovery sweep dir — scanned by mainnet-recover-snapshots.integration.test.ts.
const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

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

describe.skipIf(!PRIVATE_KEY || !ASP_POSTMAN_PRIVATE_KEY || !hasCircuits)(
  "Swap-and-Deposit (Optimism Mainnet) — wallet USDC -> LiFi swap -> USDT deposit",
  () => {
    let publicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;

    let session: PoolSession;
    let localASP: LocalASPTreeService;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      const postmanAccount = privateKeyToAccount(
        ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`,
      );

      // Cast: Optimism's op-stack formatters widen the client type beyond the
      // bare `createPublicClient` return type used for the declaration.
      publicClient = createPublicClient({
        chain: optimism,
        transport: http(OP_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;

      walletClient = createWalletClient({
        account,
        chain: optimism,
        transport: http(OP_RPC),
      });

      postmanWalletClient = createWalletClient({
        account: postmanAccount,
        chain: optimism,
        transport: http(OP_RPC),
      });

      // Shared with the reshield suite — see the file docblock for why.
      persistence = new TestStatePersistence(
        resolve(__dirname, "../.mainnet-relay-swaps-reshield-state.json"),
      );
      const savedState = persistence.load();

      // --- Derive or load protocol keys ---
      let protocolKeys: MainnetTestState["protocolKeys"];

      if (savedState?.protocolKeys) {
        protocolKeys = savedState.protocolKeys;
        console.log("Loaded protocol keys from state file");
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
        console.log("Derived fresh protocol keys from signature");
      }

      state = savedState ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);

      // --- Local ASP tree, signed by the postman wallet (POSTMAN_ROLE). ---
      localASP = await LocalASPTreeService.create(
        {
          aspRegistryAddress: ASP_REGISTRY_ADDRESS,
          walletClient: postmanWalletClient as any,
          publicClient: publicClient as any,
        },
        state.aspLeaves.length > 0 ? state.aspLeaves : undefined,
      );
      console.log(
        "Local ASP tree initialized with",
        state.aspLeaves.length,
        "leaves",
      );

      // --- Build PoolSession. The builder requires at least one relayer entry,
      // but this flow never contacts it (both txs are wallet-sent) — placeholder. ---
      const relayerInfo = {
        url: process.env.RELAYER_URL ?? "http://localhost:3000",
        name: "local",
        chainId: OP_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: RELAY_SWAPS_ADDRESS as Address,
      };

      session = await PoolSessionBuilder.fromConfig({
        chainId: OP_CHAIN_ID,
        rpcUrl: OP_RPC,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: POOL_ADDRESS as Address,
          entrypointAddress: ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: RELAY_SWAPS_ADDRESS as Address,
        },
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, OP_CHAIN_ID, {
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          poolAddress: POOL_ADDRESS as Address,
        }),
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
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
        .withSwapAndDepositQuoteProvider(new LiFiSwapQuoteProvider({}))
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

      console.log("PoolSession created successfully");
    }, 120_000);

    afterAll(() => {
      if (!session) return; // beforeAll failed — nothing to persist
      saveSessionLeafCache(
        LEAF_CACHE_DIR,
        OP_CHAIN_ID,
        {
          keystoreAddress: KEYSTORE_ADDRESS as Address,
          poolAddress: POOL_ADDRESS as Address,
        },
        session,
      );
    });

    it("full flow: keystore -> swap USDC->USDT via LiFi + deposit USDT (no withdrawal)", async () => {
      // === 1. Register in keystore (idempotent) ===
      const registered = await session.isKeystoreRegistered();
      if (registered) {
        console.log("Already registered in keystore, skipping");
      } else {
        console.log("Registering in keystore...");
        const receipts = await session.registerKeystore();
        expect(receipts.length).toBeGreaterThan(0);
        expect(receipts.every((r: { status: boolean }) => r.status)).toBe(true);
        state.keystoreRegistered = true;
        persistence.save(state);
        console.log("Keystore registration complete");
      }

      // === 2. Balances before ===
      const walletUsdcBefore = (await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      const vaultUsdtBefore = (await publicClient.readContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as Address],
      })) as bigint;
      console.log("Wallet USDC before:", formatUnits(walletUsdcBefore, 6));
      console.log("Vault USDT before: ", formatUnits(vaultUsdtBefore, 6));

      // === 3. Prepare swap-and-deposit (deposit proof + LiFi contractCalls quote).
      // The SDK pads the swap output by the vetting fee (Entrypoint pulls
      // value + fee), so the note commits to exactly DEPOSIT_AMOUNT. ===
      const depositValue = `0x${BigInt(DEPOSIT_AMOUNT).toString(16)}` as Hex;
      console.log(
        "\nPreparing swap-and-deposit for",
        formatUnits(BigInt(DEPOSIT_AMOUNT), 6),
        "USDT note...",
      );

      const prepared = await session.prepareSwapAndDeposit({
        fromChainId: OP_CHAIN_ID,
        inputToken: USDC,
        depositToken: USDT,
        depositAmount: depositValue,
      });

      console.log(
        "Estimated USDC in:",
        formatUnits(BigInt(prepared.estimatedInputAmount), 6),
      );
      console.log("LiFi transactionTo:", prepared.transactionTo);
      console.log("LiFi approvalAddress:", prepared.approvalAddress);
      console.log("Note commitment:", prepared.pendingNote.commitment);

      expect(BigInt(prepared.estimatedInputAmount)).toBeGreaterThan(0n);

      // === 4. Execute: approval (if needed) + swap+deposit, both from the wallet ===
      const receipt = await session.executeSwapAndDeposit(prepared);
      expect(receipt.status).toBe(true);
      console.log("Swap-and-deposit tx:", receipt.txHash);

      // === 5. Recovery snapshot (saved before ASP registration — the deposit
      // is irreversible on-chain already; a later failure must not lose it) ===
      const depositTx = await publicClient.getTransaction({
        hash: receipt.txHash as `0x${string}`,
      });
      await saveRecoverySnapshot({
        publicClient: publicClient as any,
        chainId: OP_CHAIN_ID,
        depositTxHash: receipt.txHash as Hex,
        depositBlock: depositTx.blockNumber!,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
        ownerAddress: account.address as Address,
        contracts: {
          pool: POOL_ADDRESS as Address,
          entrypoint: ENTRYPOINT_ADDRESS as Address,
          keystore: KEYSTORE_ADDRESS as Address,
          aspRegistry: ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys: state.protocolKeys,
        note: prepared.pendingNote,
        storageDir: RECOVERY_SNAPSHOT_DIR,
      });
      console.log("Recovery snapshot saved");

      // === 6. Register label in ASP tree so the note is spendable later ===
      const label = prepared.pendingNote.label as Hash;
      console.log("\nRegistering label in local ASP tree:", label);
      await localASP.registerLabel(label);

      const serialized = localASP.serialize();
      state.aspLeaves = serialized.leaves;
      persistence.save(state);
      console.log("ASP root updated on-chain:", await localASP.getRoot());

      // === 7. Balance assertions ===
      const walletUsdcAfter = (await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      })) as bigint;
      const vaultUsdtAfter = (await publicClient.readContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as Address],
      })) as bigint;
      console.log("Wallet USDC after:", formatUnits(walletUsdcAfter, 6));
      console.log("Vault USDT after: ", formatUnits(vaultUsdtAfter, 6));

      // Wallet paid the estimated USDC input (± nothing else; gas is ETH).
      expect(walletUsdcBefore - walletUsdcAfter).toBeGreaterThan(0n);
      // The vault holds exactly the note value more USDT (vetting fee goes to
      // the Entrypoint's fee accounting, not the vault).
      expect(vaultUsdtAfter - vaultUsdtBefore).toBe(BigInt(DEPOSIT_AMOUNT));
    }, 300_000);
  },
);
