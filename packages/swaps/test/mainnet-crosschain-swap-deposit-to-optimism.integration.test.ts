/**
 * CROSS-CHAIN swap-and-deposit entry flow: the wallet holds USDC on Arbitrum,
 * LiFi bridges + swaps it to USDT and deposits the USDT into the OPTIMISM
 * privacy pool via the Entrypoint (contractCalls quote executed by LiFi's
 * destination executor). First integration exercise of the session-level
 * cross-chain path (`sourceChain` builder config): the approval and the LiFi
 * transaction are signed by the source-chain wallet; the SDK validates LiFi's
 * contracts against the ARBITRUM RelaySwaps allowlist; the source receipt is
 * returned immediately and the TEST polls LiFi status for destination delivery
 * (the SDK deliberately does not poll — caller's choice).
 *
 * No pool withdrawal happens anywhere in this suite and no relayer is involved.
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
import { arbitrum, optimism } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

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
// Input: USDC on Arbitrum (source chain). Deposit: USDT on Optimism (pool chain).
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const USDT = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Address;

// --- Config ---
const OP_CHAIN_ID = 10;
const OP_RPC = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";
const ARB_CHAIN_ID = 42161;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
// Source-chain RelaySwaps — its approvedRouters vets the LiFi contracts the wallet
// will approve and call on Arbitrum.
const ARB_RELAY_SWAPS = getContract(42161, "RelaySwaps");
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// POSTMAN_ROLE wallet — registerLabel() on the live ASPRegistry reverts otherwise.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
// Deposit NOTE value (the vetting fee is added on top by the SDK when sizing the swap).
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDT
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-swap-deposit-notes",
);
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
  "Cross-Chain Swap-and-Deposit — Arbitrum USDC -> LiFi bridge+swap -> Optimism USDT deposit",
  () => {
    let publicClient: ReturnType<typeof createPublicClient>;
    let arbPublicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let arbWalletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;

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

      // Source-chain clients: the input USDC and both transactions live on Arbitrum.
      arbPublicClient = createPublicClient({
        chain: arbitrum,
        transport: http(ARB_RPC),
      });
      arbWalletClient = createWalletClient({
        account,
        chain: arbitrum,
        transport: http(ARB_RPC),
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
        // Cross-chain source attachment: the SDK signs/sends on Arbitrum and vets
        // LiFi's contracts against the ARBITRUM RelaySwaps allowlist.
        sourceChain: {
          chainId: ARB_CHAIN_ID,
          rpcUrl: ARB_RPC,
          walletInteractor: {
            type: "viem",
            walletClient: arbWalletClient as any,
          },
          relaySwapsAddress: ARB_RELAY_SWAPS as Address,
        },
      })
        .withAspDataProvider(localASP)
        .withSwapAndDepositQuoteProvider(
          (lifiProvider = new LiFiSwapQuoteProvider({})),
        )
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

    it("full flow: keystore -> swap+bridge USDC(Arb)->USDT(OP) + deposit (no withdrawal)", async () => {
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
      const walletArbUsdcBefore = (await arbPublicClient.readContract({
        address: ARB_USDC,
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
      console.log(
        "Wallet USDC (Arbitrum) before:",
        formatUnits(walletArbUsdcBefore, 6),
      );
      console.log(
        "Vault USDT (Optimism) before: ",
        formatUnits(vaultUsdtBefore, 6),
      );

      // === 3. Prepare: destination deposit proof + cross-chain LiFi contractCalls
      // quote. The SDK pads the swap output by the destination vetting fee and
      // validates LiFi's transactionTo/approvalAddress against the ARBITRUM
      // RelaySwaps allowlist (UnallowedLiFiAddress if LiFi serves a contract we
      // have not approved there — fix with approveRouter from the OPS admin). ===
      const depositValue = `0x${BigInt(DEPOSIT_AMOUNT).toString(16)}` as Hex;
      console.log(
        "\nPreparing cross-chain swap-and-deposit for",
        formatUnits(BigInt(DEPOSIT_AMOUNT), 6),
        "USDT note on Optimism...",
      );

      const prepared = await session.prepareSwapAndDeposit({
        fromChainId: ARB_CHAIN_ID,
        inputToken: ARB_USDC,
        depositToken: USDT,
        depositAmount: depositValue,
      });

      console.log(
        "Estimated USDC in (Arbitrum):",
        formatUnits(BigInt(prepared.estimatedInputAmount), 6),
      );
      console.log("LiFi transactionTo:", prepared.transactionTo);
      console.log("LiFi approvalAddress:", prepared.approvalAddress);
      console.log("Note commitment:", prepared.pendingNote.commitment);

      expect(BigInt(prepared.estimatedInputAmount)).toBeGreaterThan(0n);
      expect(prepared.fromChainId).toBe(ARB_CHAIN_ID);

      // === 4. Persist the note secrets BEFORE sending: cross-chain, the SDK
      // deliberately does not persist (no destination commitment exists yet at
      // source-receipt time), so the caller owns the secrets on disk while the
      // bridge is in flight. ===
      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
        JSON.stringify(prepared.pendingNote, null, 2),
      );
      console.log("Pending note persisted to disk");

      // === 5. Execute: approval + LiFi tx signed by the ARBITRUM wallet. The
      // receipt is the SOURCE-chain receipt — delivery on Optimism follows. ===
      const receipt = await session.executeSwapAndDeposit(prepared);
      expect(receipt.status).toBe(true);
      console.log("Source (Arbitrum) swap tx:", receipt.txHash);

      // === 6. Poll LiFi status for destination delivery (test-side by design —
      // the SDK returns at the source receipt). ===
      const maxWaitMs = 600_000;
      const pollIntervalMs = 15_000;
      const pollStart = Date.now();
      let destinationTxHash: string | undefined;
      while (Date.now() - pollStart < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash: receipt.txHash as Hex,
          fromChainId: ARB_CHAIN_ID,
          toChainId: OP_CHAIN_ID,
        });
        console.log(
          `LiFi status: ${status.status}${status.substatus ? ` (${status.substatus})` : ""}`,
        );
        if (status.status === "DONE" && status.receiving?.txHash) {
          destinationTxHash = status.receiving.txHash;
          break;
        }
        if (status.status === "FAILED") {
          throw new Error(
            `LiFi transfer failed: ${status.substatusMessage ?? status.substatus ?? "unknown"}`,
          );
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      if (!destinationTxHash) {
        throw new Error(
          `No destination tx after ${maxWaitMs / 1000}s of polling`,
        );
      }
      console.log("Destination (Optimism) deposit tx:", destinationTxHash);

      // === 7. Recovery snapshot with the DESTINATION deposit tx (saved before
      // ASP registration — the deposit is irreversible on-chain already) ===
      const depositTx = await publicClient.getTransaction({
        hash: destinationTxHash as `0x${string}`,
      });
      await saveRecoverySnapshot({
        publicClient: publicClient as any,
        chainId: OP_CHAIN_ID,
        depositTxHash: destinationTxHash as Hex,
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

      // === 8. Register label in ASP tree so the note is spendable later ===
      const label = prepared.pendingNote.label as Hash;
      console.log("\nRegistering label in local ASP tree:", label);
      await localASP.registerLabel(label);

      const serialized = localASP.serialize();
      state.aspLeaves = serialized.leaves;
      persistence.save(state);
      console.log("ASP root updated on-chain:", await localASP.getRoot());

      // === 9. Balance assertions ===
      const walletArbUsdcAfter = (await arbPublicClient.readContract({
        address: ARB_USDC,
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
      console.log(
        "Wallet USDC (Arbitrum) after:",
        formatUnits(walletArbUsdcAfter, 6),
      );
      console.log(
        "Vault USDT (Optimism) after: ",
        formatUnits(vaultUsdtAfter, 6),
      );

      // The Arbitrum wallet paid the swap input; the Optimism vault holds exactly
      // the note value more USDT (vetting fee goes to the Entrypoint's fee
      // accounting, not the vault).
      expect(walletArbUsdcBefore - walletArbUsdcAfter).toBeGreaterThan(0n);
      expect(vaultUsdtAfter - vaultUsdtBefore).toBe(BigInt(DEPOSIT_AMOUNT));
    }, 1_200_000);
  },
);
