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
  RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import type { ILogger } from "@privacy-pools-v2/evm-sdk";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import {
  saveRecoverySnapshot,
  markAsRecovered,
} from "./helpers/recovery-snapshot.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

// Contract addresses come from the shared smoke-test config — new deployment by
// default, old one with NEW_CONTRACTS=false.
import {
  POOL_ADDRESS,
  ENTRYPOINT_ADDRESS,
  KEYSTORE_ADDRESS,
  ASP_REGISTRY_ADDRESS,
  RELAY_SWAPS_ADDRESS,
  DEPLOYMENT_BLOCK,
} from "./contract.config.js";

// --- Tokens ---
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
// USDT on Optimism — the cross-chain swap output token
const OP_USDT = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58" as Address;

// --- Config ---
const ARB_CHAIN_ID = 42161;
const OP_CHAIN_ID = 10;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const OP_RPC = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Separate from PRIVATE_KEY on purpose: the depositor owns the note and must
// match the session's ownerAddress, but registering the label needs
// POSTMAN_ROLE on the live ASPRegistry — a different wallet. Same fix as
// mainnet-deposit.integration.test.ts / mainnet-real-relay-swaps-withdraw.integration.test.ts.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const RELAYER_BASE_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDC
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-withdraw-to-op-notes",
);
// Shared with the other mainnet suites and scanned by
// mainnet-recover-snapshots.integration.test.ts — deliberately NOT
// NOTE_STORAGE_DIR above, so one recovery sweep covers deposits from every
// mainnet suite instead of needing a copy per suite.
const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");

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

describe.skipIf(!PRIVATE_KEY || !ASP_POSTMAN_PRIVATE_KEY || !hasCircuits)(
  "Cross-Chain RelaySwaps: Arbitrum -> Optimism (withdraw USDC, receive USDT on OP)",
  () => {
    let arbPublicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;
    let opPublicClient: ReturnType<typeof createPublicClient>;
    let account: ReturnType<typeof privateKeyToAccount>;

    let session: PoolSession;
    let localASP: LocalASPTreeService;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      const postmanAccount = privateKeyToAccount(
        ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`,
      );

      arbPublicClient = createPublicClient({
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

      // Cast: optimism's op-stack formatters widen the client type beyond the
      // bare `createPublicClient` return type used for the declaration.
      opPublicClient = createPublicClient({
        chain: optimism,
        transport: http(OP_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;

      persistence = new TestStatePersistence(
        resolve(__dirname, "../.mainnet-crosschain-withdraw-to-op-state.json"),
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

      // --- Local ASP tree. Signed by the postman wallet, not the depositor —
      // POSTMAN_ROLE lives there, and registerLabel() reverts otherwise. ---
      localASP = await LocalASPTreeService.create(
        {
          aspRegistryAddress: ASP_REGISTRY_ADDRESS,
          walletClient: postmanWalletClient as any,
          publicClient: arbPublicClient as any,
        },
        state.aspLeaves.length > 0 ? state.aspLeaves : undefined,
      );
      console.log(
        "Local ASP tree initialized with",
        state.aspLeaves.length,
        "leaves",
      );

      // --- Relayer setup (points to RelaySwaps processor) ---
      relayerInfo = {
        url: RELAYER_BASE_URL,
        name: "local",
        chainId: ARB_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: RELAY_SWAPS_ADDRESS as Address,
      };

      // --- Build PoolSession ---
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
        .withSwapQuoteProvider(new LiFiSwapQuoteProvider({}))
        // Paid RPC: giant getLogs chunks; the default 10k-block crawl takes ~4min
        // over the full deployment range and expires the relayer fee commitment.
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: arbPublicClient as any,
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

    it("full flow: keystore -> deposit USDC -> ASP register -> cross-chain withdraw-and-swap USDC->USDT(OP) via RelaySwaps", async () => {
      // === 1. Register in keystore (idempotent) ===
      const registered = await session.isKeystoreRegistered();
      if (registered) {
        console.log("Already registered in keystore, skipping");
      } else {
        console.log("Registering in keystore...");
        const receipts = await session.registerKeystore();
        expect(receipts.length).toBeGreaterThan(0);
        expect(receipts.every((r) => r.status)).toBe(true);
        state.keystoreRegistered = true;
        persistence.save(state);
        console.log("Keystore registration complete");
      }

      // === 2. Deposit USDC into pool ===
      const depositValue = `0x${BigInt(DEPOSIT_AMOUNT).toString(16)}` as Hex;
      console.log(
        "\nDepositing",
        formatUnits(BigInt(DEPOSIT_AMOUNT), 6),
        "USDC...",
      );

      const depositResult = await session.prepareDeposit({
        tokenId: USDC,
        value: depositValue,
      });

      console.log(
        "Deposit proof generated. Commitment:",
        depositResult.pendingNote.commitment,
      );
      console.log("Label:", depositResult.pendingNote.label);

      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
        JSON.stringify(depositResult.pendingNote, null, 2),
      );
      persistence.save(state);
      console.log("Note secrets persisted to disk");

      const depositReceipt = await session.executeDeposit(depositResult);
      expect(depositReceipt.status).toBe(true);
      console.log("Deposit tx:", depositReceipt.txHash);

      // === 2.5. Recovery snapshot — all data needed for ragequit without
      // re-scanning. Saved before ASP registration deliberately: the deposit
      // is already irreversible on-chain at this point, but registerLabel or
      // the cross-chain relay-swap steps below can still fail, and a
      // snapshot saved after such a failure would never be written, losing
      // recovery data for real, spent funds. Shared with
      // mainnet-recover-snapshots.integration.test.ts via
      // RECOVERY_SNAPSHOT_DIR. Marked recovered below if the withdraw
      // succeeds, since the note is spent (not stuck) at that point. ===
      const depositBlock = await arbPublicClient.getTransaction({
        hash: depositReceipt.txHash as `0x${string}`,
      });
      const snapshotPath = await saveRecoverySnapshot({
        publicClient: arbPublicClient as any,
        chainId: ARB_CHAIN_ID,
        depositTxHash: depositReceipt.txHash as Hex,
        depositBlock: depositBlock.blockNumber,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
        ownerAddress: account.address as Address,
        contracts: {
          pool: POOL_ADDRESS as Address,
          entrypoint: ENTRYPOINT_ADDRESS as Address,
          keystore: KEYSTORE_ADDRESS as Address,
          aspRegistry: ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys: state.protocolKeys,
        note: depositResult.pendingNote,
        storageDir: RECOVERY_SNAPSHOT_DIR,
      });

      // === 3. Register label in ASP tree ===
      const label = depositResult.pendingNote.label as Hash;
      console.log("\nRegistering label in local ASP tree:", label);

      await localASP.registerLabel(label);

      const serialized = localASP.serialize();
      state.aspLeaves = serialized.leaves;
      persistence.save(state);

      const aspRoot = await localASP.getRoot();
      console.log("ASP tree root updated on-chain:", aspRoot);
      console.log("Total ASP leaves:", serialized.leaves.length);

      // === 3.5. Sync notes to promote PENDING -> ACTIVE ===
      console.log("\nSyncing notes from deposit block...");
      const fromBlock =
        `0x${(depositBlock.blockNumber - 1n).toString(16)}` as Hex;
      await session.discoverNotes({ fromBlock });
      console.log("Notes synced");

      // === 4. Cross-chain withdraw-and-swap: USDC (Arb) -> USDT (OP) via RelaySwaps ===
      const withdrawAmount = BigInt(DEPOSIT_AMOUNT);
      console.log("\n=== CROSS-CHAIN WITHDRAW-AND-SWAP ===");
      console.log(
        "Withdraw",
        formatUnits(withdrawAmount, 6),
        "USDC from Arbitrum pool",
      );
      console.log("Output: USDT on Optimism to", account.address);

      // Snapshot recipient USDT on Optimism before
      const recipientUsdtBefore = await opPublicClient.readContract({
        address: OP_USDT as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log(
        "Recipient USDT on Optimism before:",
        formatUnits(recipientUsdtBefore, 6),
      );

      // Step 1: Prepare the cross-chain swap quote via the SDK session.
      //   prepareSwapQuote handles: prelim fee quote, cross-chain LiFi quote
      //   (toAddress = recipient on OP), calldata hashing, and the committed
      //   relayer quote with the zero-address routing recipient sentinel.
      console.log("\nPreparing cross-chain swap quote via SDK...");
      // denyExchanges excludes "fly": its calldata embeds a transaction deadline
      // shorter than this protocol's proof generation (30-60s) plus relayer
      // round-trip, so it reliably reverts on-chain with ExpiredTransaction()
      // regardless of quote freshness — confirmed by direct reproduction.
      const prepared = await session.prepareSwapQuote({
        relayerInfo,
        amount: `0x${withdrawAmount.toString(16)}` as Hex,
        tokenId: USDC,
        outputToken: OP_USDT as Address,
        recipientAddress: account.address as Address,
        fallbackAddress: account.address as Address,
        toChainId: OP_CHAIN_ID,
        denyExchanges: ["fly"],
      });

      console.log(
        "Committed fee:",
        formatUnits(BigInt(prepared.feeAmount), 6),
        "USDC",
      );
      console.log("Estimated output (OP USDT):", prepared.estimatedOutput);
      console.log(
        "Destination minOutput (LiFi):",
        prepared.destinationMinOutputAmount,
      );
      // On-chain minOutput must be 0 for cross-chain — enforcement happens on the
      // destination chain via the proof-bound LiFi calldata.
      expect(prepared.minOutputAmount).toBe("0x0");

      const committedFee = BigInt(prepared.feeAmount);
      const amountSent = BigInt(
        prepared.selectedQuote.quote.feeCommitment.amountSent,
      );
      const netAmount = amountSent - committedFee;
      const netAmountHex = `0x${netAmount.toString(16)}` as Hex;
      console.log("Net amount (excl fee):", formatUnits(netAmount, 6), "USDC");

      // Step 2: Execute cross-chain withdraw-and-swap via RelaySwaps
      console.log("\nGenerating transact proof (this takes 30-60s)...");
      const proofStart = Date.now();
      const txReceipt = await session.relayWithdrawAndSwap({
        inputCommitments: [depositResult.pendingNote.commitment as Hash],
        amount: netAmountHex,
        tokenId: USDC,
        recipientAddress: account.address as Address,
        fallbackAddress: account.address as Address,
        outputToken: OP_USDT as Address,
        minOutputAmount: prepared.minOutputAmount,
        swapCalldata: prepared.swapCalldata,
        toChainId: prepared.toChainId, // = OP_CHAIN_ID, echoed by prepareSwapQuote
        selectedQuote: prepared.selectedQuote,
      });

      console.log(
        `Proof + relay completed in ${((Date.now() - proofStart) / 1000).toFixed(1)}s`,
      );
      console.log("Arbitrum RelaySwaps tx:", txReceipt.txHash);
      console.log("Status:", txReceipt.status);
      expect(txReceipt.status).toBe(true);

      // Close out the recovery snapshot from step 2.5 — the input note is
      // now spent (pulled via POOL.transact() inside the withdraw-and-swap
      // tx), not stuck, so there's nothing left for
      // mainnet-recover-snapshots to do for it.
      markAsRecovered(snapshotPath);
      console.log(
        "Recovery snapshot marked as recovered (note spent by cross-chain withdraw-and-swap).",
      );

      // Verify RelaySwaps contract holds no leftover tokens
      const contractUsdc = await arbPublicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RELAY_SWAPS_ADDRESS as `0x${string}`],
      });
      expect(contractUsdc).toBe(0n);
      console.log("RelaySwaps USDC remaining:", formatUnits(contractUsdc, 6));

      // === 5. Wait for bridge + verify USDT arrived on Optimism ===
      console.log(
        "\nWaiting for bridge to Optimism (polling recipient USDT balance)...",
      );
      const maxWaitMs = 600_000; // 10 minutes
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let recipientUsdtAfter = recipientUsdtBefore;

      while (Date.now() - start < maxWaitMs) {
        recipientUsdtAfter = await opPublicClient.readContract({
          address: OP_USDT as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [account.address],
        });

        if (recipientUsdtAfter > recipientUsdtBefore) {
          console.log("Bridge complete! Recipient USDT on Optimism increased.");
          break;
        }

        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(
          `  Polling... ${elapsed}s elapsed, USDT: ${formatUnits(recipientUsdtAfter, 6)}`,
        );
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      console.log(
        "Recipient USDT on Optimism after:",
        formatUnits(recipientUsdtAfter, 6),
      );
      const received = recipientUsdtAfter - recipientUsdtBefore;
      console.log("USDT received:", formatUnits(received, 6));
      expect(recipientUsdtAfter).toBeGreaterThan(recipientUsdtBefore);

      console.log("\n=== Cross-Chain RelaySwaps Withdraw-to-Optimism PASS ===");
    }, 1_200_000); // 20 min timeout for proof + bridge
  },
);
