import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  formatUnits,
  formatEther,
  keccak256,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arbitrum, mainnet } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
  APP_IDENTIFIER,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  Hash,
  Hex,
  PoolSession,
  SwapAndDepositQuoteRequest,
  RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import type { ILogger } from "@privacy-pools-v2/evm-sdk";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import { saveRecoverySnapshot } from "./helpers/recovery-snapshot.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import { getContract } from "./helpers/deployment-loader.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

// --- Contract addresses (from deployments-it-002.json or RELAY_SWAPS_DEPLOYMENTS_PATH) ---
const POOL_ADDRESS = getContract(42161, "PoolVault");
const ENTRYPOINT_ADDRESS = getContract(42161, "Entrypoint");
const KEYSTORE_ADDRESS = getContract(42161, "Keystore");
const ASP_REGISTRY_ADDRESS = getContract(42161, "ASPRegistry");
const RELAY_SWAPS_ADDRESS = getContract(42161, "RelaySwaps");

// --- Tokens ---
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const NATIVE_ETH = "0x0000000000000000000000000000000000000000" as Address;

// --- Config ---
const ARB_CHAIN_ID = 42161;
const ETH_CHAIN_ID = 1;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const ETH_RPC = process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Separate from PRIVATE_KEY on purpose: the depositor owns the note and must
// match the session's ownerAddress, but registering the label needs
// POSTMAN_ROLE on the live ASPRegistry — a different wallet. Same fix as
// mainnet-deposit.integration.test.ts / the other mainnet suites.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const LIFI_API_KEY = process.env.LIFI_API_KEY;
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDC
const DEPLOYMENT_BLOCK = process.env.DEPLOYMENT_BLOCK ?? "0x1C9A7B45"; // 480063557
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-deposit-from-eth-notes",
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
  "Cross-Chain Deposit: Ethereum -> Arbitrum (ETH on mainnet, deposit USDC into Arb pool)",
  () => {
    let arbPublicClient: ReturnType<typeof createPublicClient>;
    let ethPublicClient: ReturnType<typeof createPublicClient>;
    let ethWalletClient: ReturnType<typeof createWalletClient>;
    let arbWalletClient: ReturnType<typeof createWalletClient>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;

    let session: PoolSession;
    let localASP: LocalASPTreeService;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      const postmanAccount = privateKeyToAccount(
        ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`,
      );

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
        chain: arbitrum,
        transport: http(ARB_RPC),
      });

      ethPublicClient = createPublicClient({
        chain: mainnet,
        transport: http(ETH_RPC),
      });

      ethWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(ETH_RPC),
      });

      persistence = new TestStatePersistence(
        resolve(
          __dirname,
          "../.mainnet-crosschain-deposit-from-eth-state.json",
        ),
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
        const signature = await arbWalletClient.signTypedData({
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

      // --- Relayer setup (needed for PoolSessionBuilder even though deposit doesn't relay) ---
      relayerInfo = {
        url: "http://localhost:3000",
        name: "local",
        chainId: ARB_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: RELAY_SWAPS_ADDRESS as Address,
      };

      // --- Build PoolSession (Arbitrum) ---
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
          walletClient: arbWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: DEPLOYMENT_BLOCK as Hex,
      })
        .withAspDataProvider(localASP)
        .create();

      lifiProvider = new LiFiSwapQuoteProvider({
        ...(LIFI_API_KEY ? { apiKey: LIFI_API_KEY } : {}),
      });

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

    it("cross-chain: swap ETH on mainnet -> bridge -> deposit USDC into Arbitrum pool", async () => {
      const depositAmount = BigInt(DEPOSIT_AMOUNT);

      console.log("\n=== Cross-Chain Deposit: Ethereum -> Arbitrum ===");
      console.log("Wallet:", account.address);
      console.log("Pool (Arbitrum):", POOL_ADDRESS);
      console.log("Deposit amount:", formatUnits(depositAmount, 6), "USDC");
      console.log("Input: ETH (mainnet) -> Deposit: USDC (Arbitrum)");

      // --- 1. Check wallet ETH balance on mainnet ---
      const walletEth = await ethPublicClient.getBalance({
        address: account.address,
      });
      console.log("\nMainnet wallet ETH:", formatEther(walletEth));

      // --- 2. Snapshot Arbitrum pool USDC before ---
      const poolUsdcBefore = await arbPublicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as `0x${string}`],
      });
      console.log("Arbitrum pool USDC before:", formatUnits(poolUsdcBefore, 6));

      // --- 3. Generate deposit proof targeting Arbitrum pool (USDC) ---
      console.log("\nGenerating deposit proof...");
      const depositValue = `0x${depositAmount.toString(16)}` as Hex;
      const depositResult = await session.prepareDeposit({
        tokenId: USDC,
        value: depositValue,
      });
      console.log(
        "Proof generated. Commitment:",
        depositResult.pendingNote.commitment,
      );

      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `crosschain-deposit-${Date.now()}.json`),
        JSON.stringify(depositResult.pendingNote, null, 2),
      );
      persistence.save(state);

      // --- 4. Get cross-chain LiFi contractCalls quote (ETH mainnet -> ARB USDC + deposit) ---
      const VETTING_FEE_BPS = 100n; // 1% — from Entrypoint.assets(USDC).vettingFeeBPS
      const vettingFee = (depositAmount * VETTING_FEE_BPS) / 10000n;
      const totalDepositCost = depositAmount + vettingFee;
      console.log("Note value:", formatUnits(depositAmount, 6), "USDC");
      console.log("Vetting fee (1%):", formatUnits(vettingFee, 6));
      console.log(
        "Total deposit cost:",
        formatUnits(totalDepositCost, 6),
        "USDC",
      );

      console.log(
        "\nGetting cross-chain LiFi quote (ETH -> USDC + deposit)...",
      );
      // denyExchanges excludes "fly": its calldata embeds a transaction deadline
      // shorter than this protocol's proof generation (30-60s) plus bridge/relay
      // round-trip, so it reliably reverts on-chain with ExpiredTransaction()
      // regardless of quote freshness — confirmed by direct reproduction.
      const quoteRequest: SwapAndDepositQuoteRequest = {
        fromChainId: ETH_CHAIN_ID,
        toChainId: ARB_CHAIN_ID,
        fromToken: NATIVE_ETH,
        toToken: USDC,
        fromAddress: account.address as Address,
        depositAmount: totalDepositCost.toString(),
        depositCalldata: depositResult.depositTx.data,
        poolAddress: depositResult.depositTx.to,
        depositGasLimit: "800000",
        denyExchanges: ["fly"],
      };

      const quote = await lifiProvider.getSwapAndDepositQuote(quoteRequest);

      console.log(
        "LiFi fromAmount:",
        formatEther(BigInt(quote.fromAmount)),
        "ETH",
      );
      console.log(
        "LiFi toAmount:",
        formatUnits(BigInt(quote.toAmount), 6),
        "USDC (ARB)",
      );
      console.log("Approval address:", quote.approvalAddress);
      console.log("Transaction to:", quote.transactionTo);
      console.log(
        "Transaction value:",
        formatEther(BigInt(quote.transactionValue)),
      );
      if (quote.estimatedDuration) {
        console.log("Estimated duration:", quote.estimatedDuration, "seconds");
      }

      expect(quote.fromAmount).toBeTruthy();
      expect(quote.transactionData).toBeTruthy();
      expect(quote.transactionTo).toBeTruthy();

      const txValue = BigInt(quote.transactionValue);
      expect(walletEth).toBeGreaterThan(txValue);

      // --- 5. Submit cross-chain swap+deposit on mainnet (ETH native, no approval needed) ---
      console.log(
        "\nSubmitting cross-chain swap+deposit on Ethereum mainnet...",
      );
      const txHash = await ethWalletClient.sendTransaction({
        chain: mainnet,
        account,
        to: quote.transactionTo as `0x${string}`,
        data: quote.transactionData as `0x${string}`,
        value: txValue,
      });
      console.log("Mainnet tx submitted:", txHash);

      const receipt = await ethPublicClient.waitForTransactionReceipt({
        hash: txHash,
      });
      console.log("Mainnet tx confirmed in block:", receipt.blockNumber);
      console.log("Mainnet tx status:", receipt.status);
      expect(receipt.status).toBe("success");

      // --- 6. Wait for bridge via LiFi status (gives us the Arbitrum tx hash
      // directly, needed below for the recovery snapshot — balance polling
      // alone can't tell us which tx/block the deposit landed in) ---
      console.log("\nWaiting for bridge to Arbitrum (polling LiFi status)...");
      const maxWaitMs = 600_000; // 10 minutes
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let destinationTxHash: Hex | undefined;

      while (Date.now() - start < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash,
          fromChainId: ETH_CHAIN_ID,
          toChainId: ARB_CHAIN_ID,
        });

        if (status.status === "DONE" && status.receiving?.txHash) {
          destinationTxHash = status.receiving.txHash;
          console.log("Bridge complete! Arbitrum tx:", destinationTxHash);
          break;
        }

        if (status.status === "FAILED") {
          throw new Error(
            `LiFi bridge reported FAILED: ${status.substatusMessage ?? status.substatus ?? "no detail"}`,
          );
        }

        const elapsed = Math.round((Date.now() - start) / 1000);
        console.log(
          `  Polling... ${elapsed}s elapsed, status: ${status.status}`,
        );
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      if (!destinationTxHash) {
        throw new Error(
          `Bridge did not complete within ${maxWaitMs / 1000}s (last status: unknown)`,
        );
      }

      const poolUsdcAfter = await arbPublicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [POOL_ADDRESS as `0x${string}`],
      });
      console.log("Arbitrum pool USDC after:", formatUnits(poolUsdcAfter, 6));
      expect(poolUsdcAfter).toBeGreaterThan(poolUsdcBefore);

      // --- 7. Recovery snapshot — all data needed for ragequit without
      // re-scanning. Saved before ASP registration deliberately: the deposit
      // is already irreversible on-chain at this point, but registerLabel
      // below can still fail, and a snapshot saved after such a failure
      // would never be written, losing recovery data for real, spent funds.
      // Shared with mainnet-recover-snapshots.integration.test.ts via
      // RECOVERY_SNAPSHOT_DIR. Left UNRECOVERED here on purpose: unlike the
      // withdraw-flavored suites, this test doesn't spend the note — it
      // stays a live deposit for mainnet-recover-snapshots (or a later
      // withdraw test) to pick up. ---
      const destinationTx = await arbPublicClient.getTransaction({
        hash: destinationTxHash,
      });
      await saveRecoverySnapshot({
        publicClient: arbPublicClient as any,
        chainId: ARB_CHAIN_ID,
        depositTxHash: destinationTxHash,
        depositBlock: destinationTx.blockNumber,
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

      // --- 8. Register label in ASP tree so the note reaches ACTIVE and is
      // actually spendable afterward — every other deposit-flavored suite
      // does this; a bridged deposit left PENDING forever would be
      // functionally useless beyond ragequit recovery. ---
      const label = depositResult.pendingNote.label as Hash;
      console.log("\nRegistering label in local ASP tree:", label);
      await localASP.registerLabel(label);

      const serialized = localASP.serialize();
      state.aspLeaves = serialized.leaves;
      persistence.save(state);

      const aspRoot = await localASP.getRoot();
      console.log("ASP tree root updated on-chain:", aspRoot);
      console.log("Total ASP leaves:", serialized.leaves.length);

      // --- 9. Sync notes to promote PENDING -> ACTIVE ---
      console.log("\nSyncing notes from deposit block...");
      const fromBlock =
        `0x${(destinationTx.blockNumber - 1n).toString(16)}` as Hex;
      await session.discoverNotes({ fromBlock });
      console.log("Notes synced");

      console.log("\n=== Cross-Chain Deposit from Ethereum PASS ===");
    }, 720_000); // 12 min timeout for bridge
  },
);
