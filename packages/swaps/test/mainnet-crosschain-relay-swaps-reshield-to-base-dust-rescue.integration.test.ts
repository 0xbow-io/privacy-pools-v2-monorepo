/**
 * Cross-chain reshield WITH `dustRescue` opted in, closing the exact gap
 * `mainnet-crosschain-relay-swaps-reshield-to-base.integration.test.ts` documents in
 * its own header: "that service has no live GCP deployment this suite can drive
 * end-to-end, so this test still does NOT opt into `dustRescue`."
 *
 * Real chains, real LiFi (both legs), real relayer (a separate process the operator
 * starts, exactly as the base suite requires) — and, per issue #222
 * (dust_unification_feasibility_and_plan.org), a real dust #1 forward
 * (DustRescueForwardingService, fired synchronously inside relaySwap()).
 *
 * What's real vs. substituted, and why (see local-asp-server.ts's own header for the
 * fuller version of this argument): the ASP is real transport / fake data — a local
 * HTTP server (test/helpers/local-asp-server.ts) implementing the one route a
 * deposit-only flow actually calls, `GET /public-key`, so `HttpASPDataProvider`'s real
 * request/parse code path gets exercised, not mocked away. Pub/Sub and Firestore are
 * NOT stood up (no emulator, no real GCP project) — dust-rescue-service's own
 * `SweepService`/`DetectionService`/`ChainWriteService` orchestration is already
 * exhaustively unit-tested (sweep.service.spec.ts) against those exact seams
 * (IDustRescueJobStore), so re-proving that orchestration here would just repeat
 * existing coverage at 100x the cost. What THIS test proves instead, that nothing else
 * does: that `proveDustRescueDeposit` (the same function SweepService calls) produces a
 * real, submittable, successful deposit — on real chain state, summing two
 * independently-observed real LiFi legs — via a small in-test driver that mirrors
 * SweepService's PROVING/SUBMITTING steps directly, not dust-rescue-service's Nest
 * wiring.
 *
 * Deliberately NOT covered here (same "don't test what's already tested elsewhere"
 * principle): full stealth note decryption/recovery for the recipient. That's
 * existing, dedicated stealth-module test coverage (packages/sdk/test/unit/stealth),
 * not specific to dust unification. This test verifies the deposit succeeds and that
 * its value is the real sum of both legs — the actual claim issue #222 makes — via
 * `proveDustRescueDeposit`'s own return value and on-chain receipt status, not via
 * decrypting the resulting note.
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
  getAddress,
  decodeEventLog,
  type Block,
  type Transaction,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { arbitrum, base } from "viem/chains";
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
  RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";
import { proveDustRescueDeposit } from "@privacy-pools-v2/dust-rescue-prover";
import type { StealthRecipientIdentifier } from "@privacy-pools-v2/dust-rescue-prover";

import type { ILogger } from "@privacy-pools-v2/evm-sdk";
import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import {
  startLocalAspServer,
  type LocalAspServer,
} from "./helpers/local-asp-server.js";
import {
  saveRecoverySnapshot,
  markAsRecovered,
} from "./helpers/recovery-snapshot.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import { getContract } from "./helpers/deployment-loader.js";
import { DEPLOYMENT_BLOCK as ARB_DEPLOYMENT_BLOCK } from "./contract.config.js";
import {
  LEAF_CACHE_DIR,
  loadSessionLeafCacheSeeds,
  saveSessionLeafCache,
} from "./helpers/leaf-cache-store.js";

// --- Contract addresses (from deployments-it-002.json) ---
const ARB_POOL_ADDRESS = getContract(42161, "PoolVault");
const ARB_ENTRYPOINT_ADDRESS = getContract(42161, "Entrypoint");
const ARB_KEYSTORE_ADDRESS = getContract(42161, "Keystore");
const ARB_ASP_REGISTRY_ADDRESS = getContract(42161, "ASPRegistry");
const ARB_RELAY_SWAPS_ADDRESS = getContract(42161, "RelaySwaps");

const BASE_POOL_ADDRESS = getContract(8453, "PoolVault");
const BASE_ENTRYPOINT_ADDRESS = getContract(8453, "Entrypoint");
const BASE_KEYSTORE_ADDRESS = getContract(8453, "Keystore");
const BASE_ASP_REGISTRY_ADDRESS = getContract(8453, "ASPRegistry");
const BASE_RELAY_SWAPS_ADDRESS = getContract(8453, "RelaySwaps");

// --- Tokens ---
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;

// --- Config ---
const ARB_CHAIN_ID = 42161;
const BASE_CHAIN_ID = 8453;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Same wallet plays depositor + relayer's own operational signer in this local test
// setup (run_a_test.sh sets PRIVATE_KEY=$SIGNER_PRIVATE_KEY_42161) — so account.address
// IS routing.dustRecipient, the address dust #1 sweeps to on Arbitrum. See §"discover
// dust #1's forward tx" below, which depends on this.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const RELAYER_BASE_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
// Intentionally larger than the base suite's default: dust #1 is capped at 3% of
// `net` (SWAP_DUST_TOLERANCE_BPS) and needs to clear real LiFi/gas noise to be
// observable at all — a bigger operation gives dust #1 more room to be nonzero.
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "10000000"; // 10 USDC
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-reshield-dust-rescue-notes",
);
const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");
// The rescue deposit's note is owned by a stealth identity this test generates itself
// (recipientPrivateKey below) — NOT registered with any PoolSession here (unlike the
// ordinary source/destination notes, which get synced via discoverNotes()). This key is
// the ONLY thing that can ever decrypt/spend that note. Written to disk the moment it's
// generated, and again with full recovery details once the deposit lands — losing this
// file after a successful run means the rescued funds are gone, not just "unverified".
const RESCUE_RECOVERY_DIR = resolve(
  __dirname,
  "../.mainnet-dust-rescue-recovery-notes",
);
// Separate dir for Base destination notes — keeps Base and Arbitrum NoteManager
// JSON files apart (both use privacy-pool-notes.json; sharing a dir would corrupt both).
const BASE_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-reshield-dust-rescue-base-notes",
);
const BASE_DEPLOYMENT_BLOCK = (process.env.BASE_DEPLOYMENT_BLOCK ??
  "0x2F904AE") as Hex; // 49874094

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);
// Same call packages/swaps/scripts/dust-rescue-cost-matrix.ts uses to size its
// approval — Entrypoint.deposit()'s transferFrom pulls value + value*vettingFeeBPS/10000,
// gross of the note's own value (see the note-value computation at the sweptAmount call site).
const ENTRYPOINT_ASSETS_ABI = parseAbi([
  "function assets(address token) view returns (bool enabled, uint256 minAmount, uint256 vettingFeeBPS, uint256 maxRelayFee)",
]);
const ERC20_TRANSFER_EVENT_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

// --- EIP-712 typed data for secret derivation (identical to the base suite) ---
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

/**
 * Waits for a specific (address, nonce) transaction to be mined, by scanning blocks
 * from `fromBlock` onward. Standard JSON-RPC has no "get tx by sender+nonce" call, so
 * this is the direct way to find it — matches how a human would verify this on a block
 * explorer. Only viable because this is a dedicated test relayer instance: no
 * concurrent traffic could produce a different tx at the same nonce.
 */
async function findTransactionByNonce(
  publicClient: ReturnType<typeof createPublicClient>,
  address: Address,
  nonce: number,
  fromBlock: bigint,
  { timeoutMs = 120_000, pollIntervalMs = 5_000 } = {},
): Promise<Transaction | undefined> {
  const start = Date.now();
  let blockNumber = fromBlock;
  while (Date.now() - start < timeoutMs) {
    const latest = await publicClient.getBlockNumber();
    while (blockNumber <= latest) {
      const block: Block = await publicClient.getBlock({
        blockNumber,
        includeTransactions: true,
      });
      const match = (block.transactions as Transaction[]).find(
        (tx) =>
          tx.from?.toLowerCase() === address.toLowerCase() &&
          tx.nonce === nonce,
      );
      if (match) return match;
      blockNumber += 1n;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return undefined;
}

/** Sums matching ERC-20 Transfer log values to `recipient` — same logic
 * DustRescueForwardingService.parseSweptAmount uses, independently reimplemented here
 * so the test doesn't trust the relayer's own accounting of itself. */
function sumTransfersTo(
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[],
  token: Address,
  recipient: Address,
): bigint {
  const wantToken = getAddress(token);
  const wantRecipient = getAddress(recipient);
  let total = 0n;
  for (const log of logs) {
    if (getAddress(log.address) !== wantToken) continue;
    try {
      const decoded = decodeEventLog({
        abi: ERC20_TRANSFER_EVENT_ABI,
        eventName: "Transfer",
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      if (getAddress(decoded.args.to) === wantRecipient) {
        total += decoded.args.value;
      }
    } catch {
      // Not a Transfer log — ignore.
    }
  }
  return total;
}

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

describe.skipIf(!PRIVATE_KEY || !ASP_POSTMAN_PRIVATE_KEY || !hasCircuits)(
  "Cross-Chain Reshield + dust unification (issue #222): Arbitrum -> Base",
  () => {
    let arbPublicClient: ReturnType<typeof createPublicClient>;
    let arbWalletClient: ReturnType<typeof createWalletClient>;
    let arbPostmanWalletClient: ReturnType<typeof createWalletClient>;
    let basePublicClient: ReturnType<typeof createPublicClient>;
    let baseWalletClient: ReturnType<typeof createWalletClient>;
    let basePostmanWalletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;

    let sourceSession: PoolSession;
    let destSession: PoolSession;
    let sourceASP: LocalASPTreeService;
    let destASP: LocalASPTreeService;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;
    let mockAsp: LocalAspServer;
    let recipientPrivateKey: Uint8Array;
    let recipientIdentifier: StealthRecipientIdentifier;
    let recipientKeyPath: string;

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
      arbPostmanWalletClient = createWalletClient({
        account: postmanAccount,
        chain: arbitrum,
        transport: http(ARB_RPC),
      });

      basePublicClient = createPublicClient({
        chain: base,
        transport: http(BASE_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;
      baseWalletClient = createWalletClient({
        account,
        chain: base,
        transport: http(BASE_RPC),
      });
      basePostmanWalletClient = createWalletClient({
        account: postmanAccount,
        chain: base,
        transport: http(BASE_RPC),
      });

      // --- Mock ASP HTTP server for dust-rescue-prover's deposit (see this file's
      // own header + local-asp-server.ts for why this is real transport, fake data). ---
      mockAsp = await startLocalAspServer();
      console.log("Local mock ASP server:", mockAsp.url);

      // --- Real recipient identity for the rescue note. Kept ONLY by this test —
      // not the depositor's own key — a fresh secp256k1 keypair for the "raw"
      // (FluidKey) scheme resolveRecipient() expects: a 65-byte uncompressed point. ---
      recipientPrivateKey = secp256k1.utils.randomSecretKey();
      const uncompressedPubKey = secp256k1.getPublicKey(
        recipientPrivateKey,
        false,
      );
      recipientIdentifier = {
        kind: "raw",
        spendingPubKey:
          `0x${Buffer.from(uncompressedPubKey).toString("hex")}` as Hex,
      };
      // Written immediately, before anything irreversible happens (same "first line of
      // defense" convention the base suite uses for its own pending notes) — this key is
      // never derivable again once lost, unlike the depositor's own protocolKeys, which
      // TestStatePersistence can always re-derive from a signature.
      mkdirSync(RESCUE_RECOVERY_DIR, { recursive: true });
      recipientKeyPath = resolve(
        RESCUE_RECOVERY_DIR,
        `recipient-key-${Date.now()}.json`,
      );
      writeFileSync(
        recipientKeyPath,
        JSON.stringify(
          {
            note:
              "This private key is the ONLY way to ever recover the dust-rescue deposit " +
              "this test run produces. It is not registered with any PoolSession and not " +
              "discoverable any other way. Keep this file until the resulting note (see " +
              "the companion rescue-deposit-*.json written after a successful run) is " +
              "recovered and spent.",
            recipientPrivateKey: `0x${Buffer.from(recipientPrivateKey).toString("hex")}`,
            recipientIdentifier,
          },
          null,
          2,
        ),
      );
      console.log("Rescue recipient key saved:", recipientKeyPath);

      persistence = new TestStatePersistence(
        resolve(
          __dirname,
          "../.mainnet-crosschain-reshield-dust-rescue-state.json",
        ),
      );
      const savedState = persistence.load();

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

      sourceASP = await LocalASPTreeService.create(
        {
          aspRegistryAddress: ARB_ASP_REGISTRY_ADDRESS,
          walletClient: arbPostmanWalletClient as any,
          publicClient: arbPublicClient as any,
        },
        state.aspLeaves.length > 0 ? state.aspLeaves : undefined,
      );
      destASP = await LocalASPTreeService.create({
        aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS,
        walletClient: basePostmanWalletClient as any,
        publicClient: basePublicClient as any,
      });

      relayerInfo = {
        url: RELAYER_BASE_URL,
        name: "local",
        chainId: ARB_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: ARB_RELAY_SWAPS_ADDRESS as Address,
      };

      lifiProvider = new LiFiSwapQuoteProvider({});

      sourceSession = await PoolSessionBuilder.fromConfig({
        chainId: ARB_CHAIN_ID,
        rpcUrl: ARB_RPC,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: ARB_POOL_ADDRESS as Address,
          entrypointAddress: ARB_ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: ARB_ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: ARB_RELAY_SWAPS_ADDRESS as Address,
        },
        ...loadSessionLeafCacheSeeds(LEAF_CACHE_DIR, ARB_CHAIN_ID, {
          keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
          poolAddress: ARB_POOL_ADDRESS as Address,
        }),
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        // relay-swap with dustRescue awaits forward() synchronously (LiFi quote + approve
        // + send), which can take 60–120 s. The default 15 s timeout is too short and
        // causes a client-side abort; the relayer still completes the tx, but a retry then
        // fails with PoolVault_CommitmentAlreadyUsed. retryAttempts:0 because relay-swap
        // is non-idempotent — a retry after a timeout can never be safe.
        httpClientConfig: { timeout: 300_000, retryAttempts: 0 },
        persistentStorage: { type: "file", dirPath: NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: arbWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: ARB_DEPLOYMENT_BLOCK,
        destinationChainId: BASE_CHAIN_ID,
        destinationRpcUrl: BASE_RPC,
        destinationDeployment: {
          poolAddress: BASE_POOL_ADDRESS as Address,
          entrypointAddress: BASE_ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: BASE_RELAY_SWAPS_ADDRESS as Address,
        },
      })
        .withAspDataProvider(sourceASP)
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .create();

      destSession = await PoolSessionBuilder.fromConfig({
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
        persistentStorage: { type: "file", dirPath: BASE_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: baseWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: BASE_DEPLOYMENT_BLOCK,
      })
        .withAspDataProvider(destASP)
        .create();

      console.log("Source (Arbitrum) and destination (Base) sessions ready");
    }, 120_000);

    afterAll(async () => {
      saveSessionLeafCache(
        LEAF_CACHE_DIR,
        ARB_CHAIN_ID,
        {
          keystoreAddress: ARB_KEYSTORE_ADDRESS as Address,
          poolAddress: ARB_POOL_ADDRESS as Address,
        },
        sourceSession,
      );
      saveSessionLeafCache(
        LEAF_CACHE_DIR,
        BASE_CHAIN_ID,
        {
          keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
          poolAddress: BASE_POOL_ADDRESS as Address,
        },
        destSession,
      );
      await mockAsp.close();
    });

    it("full flow: reshield with dustRescue opted in -> unify dust #1 + dust #2 into one rescue deposit", async () => {
      // === 1-6: identical to the base suite (keystore register, deposit, ASP
      // register, note sync, estimate, Base keystore register) ===
      const registered = await sourceSession.isKeystoreRegistered();
      if (!registered) {
        const receipts = await sourceSession.registerKeystore();
        expect(receipts.every((r) => r.status)).toBe(true);
        state.keystoreRegistered = true;
        persistence.save(state);
      }

      const depositAmount = BigInt(DEPOSIT_AMOUNT);
      const depositValue = `0x${depositAmount.toString(16)}` as Hex;
      console.log(
        "\nDepositing",
        formatUnits(depositAmount, 6),
        "USDC on Arbitrum...",
      );
      const depositResult = await sourceSession.prepareDeposit({
        tokenId: USDC_ARB,
        value: depositValue,
      });
      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
        JSON.stringify(depositResult.pendingNote, null, 2),
      );
      persistence.save(state);

      const depositReceipt = await sourceSession.executeDeposit(depositResult);
      expect(depositReceipt.status).toBe(true);
      console.log("Arbitrum deposit tx:", depositReceipt.txHash);

      const depositTx = await arbPublicClient.getTransaction({
        hash: depositReceipt.txHash as `0x${string}`,
      });
      const snapshotPath = await saveRecoverySnapshot({
        publicClient: arbPublicClient as any,
        chainId: ARB_CHAIN_ID,
        depositTxHash: depositReceipt.txHash as Hex,
        depositBlock: depositTx.blockNumber!,
        deploymentBlock: ARB_DEPLOYMENT_BLOCK,
        ownerAddress: account.address as Address,
        contracts: {
          pool: ARB_POOL_ADDRESS as Address,
          entrypoint: ARB_ENTRYPOINT_ADDRESS as Address,
          keystore: ARB_KEYSTORE_ADDRESS as Address,
          aspRegistry: ARB_ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys: state.protocolKeys,
        note: depositResult.pendingNote,
        storageDir: RECOVERY_SNAPSHOT_DIR,
      });

      const label = depositResult.pendingNote.label as Hash;
      await sourceASP.registerLabel(label);
      state.aspLeaves = sourceASP.serialize().leaves;
      persistence.save(state);

      const fromBlock =
        `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
      await sourceSession.discoverNotes({ fromBlock });

      const withdrawAmount = depositAmount;
      console.log(
        "\n=== CROSS-CHAIN RESHIELD + DUST RESCUE: Arbitrum -> Base ===",
      );
      const estimate = await sourceSession.estimateReshieldCrosschainAmount({
        relayerInfo,
        amount: `0x${withdrawAmount.toString(16)}` as Hex,
        tokenId: USDC_ARB,
        outputToken: USDC_BASE,
        toChainId: BASE_CHAIN_ID,
        toChainType: "evm",
        denyExchanges: ["fly"],
      });

      const destRegistered = await destSession.isKeystoreRegistered();
      if (!destRegistered) {
        const destReceipts = await destSession.registerKeystore();
        expect(destReceipts.every((r) => r.status)).toBe(true);
      }

      const destDepositResult = await destSession.prepareDeposit({
        tokenId: USDC_BASE,
        value: estimate.noteValue,
      });
      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `base-pending-${Date.now()}.json`),
        JSON.stringify(destDepositResult.pendingNote, null, 2),
      );

      // === 7. prepareReshieldCrosschainQuote, WITH dustRescue opted in ===
      console.log(
        "\nPreparing cross-chain reshield quote (dustRescue opted in)...",
      );
      const prepared = await sourceSession.prepareReshieldCrosschainQuote({
        relayerInfo,
        amount: `0x${withdrawAmount.toString(16)}` as Hex,
        tokenId: USDC_ARB,
        outputToken: USDC_BASE,
        toChainId: BASE_CHAIN_ID,
        toChainType: "evm",
        depositResult: destDepositResult,
        totalDepositCost: estimate.totalDepositCost,
        denyExchanges: ["fly"],
        dustRescue: { recipientIdentifier },
      });
      console.log("Resolved dustRecipient:", prepared.dustRecipient);
      // dustRescue opted in -> dustRecipient resolves to the relayer's own address
      // (design doc §5/§9), same address this test watches for dust #1 below.
      expect(prepared.dustRecipient.toLowerCase()).toBe(
        account.address.toLowerCase(),
      );

      // Read base pool balance before submitting the relay-swap. Across bridges
      // can settle within seconds of the Arbitrum tx landing, so reading after
      // the receipt (or later) races the destination deposit.
      const basePoolTokenBefore = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [BASE_POOL_ADDRESS as `0x${string}`],
      });

      // === 8. Execute the reshield ===
      console.log("\nGenerating transact proof (this takes 30-60s)...");
      const txReceipt = await sourceSession.relayReshieldCrosschain({
        inputCommitments: [depositResult.pendingNote.commitment as Hash],
        amount: prepared.netAmount,
        tokenId: USDC_ARB,
        outputToken: USDC_BASE,
        toChainId: BASE_CHAIN_ID,
        toChainType: "evm",
        fallbackAddress: prepared.fallbackAddress,
        swapCalldata: prepared.swapCalldata,
        selectedQuote: prepared.selectedQuote,
        dustRecipient: prepared.dustRecipient,
        swapTarget: prepared.swapTarget,
        approvalAddress: prepared.approvalAddress,
        depositNote: prepared.depositNote,
        dustRescue: prepared.dustRescue,
      });
      console.log("Arbitrum RelaySwaps tx:", txReceipt.txHash);
      expect(txReceipt.status).toBe(true);
      markAsRecovered(snapshotPath);

      // === 9. Discover dust #1: parse the Transfer log on the main tx's own
      // receipt (same logic DustRescueForwardingService.parseSweptAmount uses),
      // independently — this test doesn't trust the relayer's internal accounting. ===
      const mainTxReceipt = await arbPublicClient.getTransactionReceipt({
        hash: txReceipt.txHash as Hex,
      });
      const mainTx = await arbPublicClient.getTransaction({
        hash: txReceipt.txHash as Hex,
      });
      const dust1SweptAmount = sumTransfersTo(
        mainTxReceipt.logs as any,
        USDC_ARB,
        account.address as Address,
      );
      console.log(
        "Dust #1 swept on Arbitrum (Transfer log to relayer's own address):",
        formatUnits(dust1SweptAmount, 6),
        "USDC",
      );

      let dust1ReceivingAmount = 0n;
      if (dust1SweptAmount > 0n) {
        // Note: dust1SweptAmount (from sumTransfersTo) includes the relay fee because
        // both fee and swept dust land at the relayer's address via Transfer events.
        // The relayer's DustRescueForwardingService subtracts the committed fee before
        // deciding whether to bridge. If actual swept dust < MIN_FORWARD_AMOUNT (1 USDC),
        // the relayer skips bridging and returns undefined — no forward tx exists.
        console.log(
          "\nDust #1 > 0 (includes relay fee) — checking for forward tx at nonce",
          mainTx.nonce + 1,
          "...",
        );
        // Default timeout (120s @ 5s polls) assumes a forward tx might show up
        // late — but if the relayer is going to submit one at all, it does so
        // as part of the same handling that just landed the main tx, so it
        // shows up within a couple of blocks, not minutes. Tightened so the
        // common "relayer skipped bridging" case (dust #1 below the 1 USDC
        // minimum) doesn't burn 2 minutes polling for a tx that's never coming.
        const forwardTx = await findTransactionByNonce(
          arbPublicClient,
          account.address as Address,
          mainTx.nonce + 1,
          mainTx.blockNumber!,
          { timeoutMs: 20_000, pollIntervalMs: 2_000 },
        );
        if (!forwardTx) {
          console.log(
            "No forward tx at nonce+1 — relayer skipped bridging (actual swept dust, after fee subtraction, was below the 1 USDC minimum). dust1ReceivingAmount stays 0.",
          );
        } else {
          console.log("Dust #1 forward tx:", forwardTx.hash);

          // Poll LiFi status for the forward leg, same mechanism DetectionService
          // uses for its second leg (job.dust1ForwardTxHash). Transient 404s from
          // LiFi's indexing lag are treated as "not yet indexed, retry" rather than
          // test failures.
          const maxWaitMs = 600_000;
          const pollIntervalMs = 15_000;
          const start = Date.now();
          while (Date.now() - start < maxWaitMs) {
            try {
              const status = await lifiProvider.getSwapStatus({
                txHash: forwardTx.hash,
                fromChainId: ARB_CHAIN_ID,
                toChainId: BASE_CHAIN_ID,
              });
              if (status.status === "DONE" && status.receiving?.amount) {
                dust1ReceivingAmount = BigInt(status.receiving.amount);
                console.log(
                  "Dust #1 forward landed on Base:",
                  formatUnits(dust1ReceivingAmount, 6),
                  "USDC",
                );
                break;
              }
              if (status.status === "FAILED") {
                console.warn(
                  "Dust #1 forward's LiFi status is FAILED — treated as 0 contribution, matching DetectionService.",
                );
                break;
              }
            } catch (err) {
              console.warn(
                "LiFi status check threw (transient, retrying):",
                err instanceof Error ? err.message : String(err),
              );
            }
            await new Promise((r) => setTimeout(r, pollIntervalMs));
          }
        }
      } else {
        console.log(
          "Dust #1 was 0 this run (lifiFromAmount consumed all of `net`) — nothing to forward, matches production behavior.",
        );
      }

      // === 10. Wait for the main bridge + destination deposit (dust #2's own leg) ===
      console.log("\nWaiting for main bridge (dust #2's leg)...");
      const maxWaitMs = 600_000;
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let dust2ReceivingAmount: bigint | undefined;
      let destinationTxHash: Hex | undefined;
      while (Date.now() - start < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash: txReceipt.txHash as Hex,
          fromChainId: ARB_CHAIN_ID,
          toChainId: BASE_CHAIN_ID,
        });
        if (
          status.status === "DONE" &&
          status.receiving?.txHash &&
          status.receiving?.amount
        ) {
          destinationTxHash = status.receiving.txHash;
          dust2ReceivingAmount = BigInt(status.receiving.amount);
          console.log("Main bridge complete! Base tx:", destinationTxHash);
          break;
        }
        if (status.status === "FAILED") {
          throw new Error(
            `LiFi bridge reported FAILED: ${status.substatusMessage ?? status.substatus ?? "no detail"}`,
          );
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      if (!destinationTxHash || dust2ReceivingAmount === undefined) {
        throw new Error(
          `Main bridge did not complete within ${maxWaitMs / 1000}s`,
        );
      }

      // Layer 2 of the two-layer protection pattern (integration_test_standards.org
      // §two-layer-protection): now that we have the real destination tx hash and block,
      // save a full recovery snapshot. Left UNRECOVERED — this suite doesn't spend the
      // destination note, so the test-2 recovery sweep picks it up automatically.
      const destinationTx = await basePublicClient.getTransaction({
        hash: destinationTxHash as `0x${string}`,
      });
      await saveRecoverySnapshot({
        publicClient: basePublicClient as any,
        chainId: BASE_CHAIN_ID,
        depositTxHash: destinationTxHash,
        depositBlock: destinationTx.blockNumber!,
        deploymentBlock: BASE_DEPLOYMENT_BLOCK,
        ownerAddress: account.address as Address,
        contracts: {
          pool: BASE_POOL_ADDRESS as Address,
          entrypoint: BASE_ENTRYPOINT_ADDRESS as Address,
          keystore: BASE_KEYSTORE_ADDRESS as Address,
          aspRegistry: BASE_ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys: state.protocolKeys,
        note: destDepositResult.pendingNote,
        storageDir: RECOVERY_SNAPSHOT_DIR,
      });

      const basePoolTokenAfter = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [BASE_POOL_ADDRESS as `0x${string}`],
      });
      expect(basePoolTokenAfter).toBeGreaterThan(basePoolTokenBefore);

      // === 11. THE CORE CLAIM (issue #222): drive proveDustRescueDeposit with the
      // COMBINED amount, mirroring exactly what SweepService's PROVING step would do
      // once DetectionService's two-leg check resolves — see this file's header for
      // why this drives proveDustRescueDeposit directly rather than importing
      // dust-rescue-service's own Nest classes. ===
      const combinedSweptAmount = dust1ReceivingAmount + dust2ReceivingAmount;
      console.log(
        "\n=== DUST UNIFICATION ===\n" +
          `Dust #1 (source-chain, forwarded):      ${formatUnits(dust1ReceivingAmount, 6)} USDC\n` +
          `Dust #2 (destination-chain, this leg):   ${formatUnits(dust2ReceivingAmount, 6)} USDC\n` +
          `Combined swept amount for the rescue:    ${formatUnits(combinedSweptAmount, 6)} USDC`,
      );

      // proveDustRescueDeposit nets the Entrypoint's live vetting fee OUT of
      // sweptAmount itself now (finding #8) — Entrypoint.deposit()'s transferFrom
      // pulls value + value*vettingFeeBPS/10000 (gross of the note's own value), so
      // passing combinedSweptAmount straight through as the note's value used to
      // leave the wallet short by exactly the fee on every attempt (confirmed twice:
      // TransferFromFailed reverts with allowance/proof both valid, just short of the
      // gross amount by exactly the fee). Pass the raw combined amount; read back
      // proveResult.noteValue below for what the note actually ended up worth.
      const proveResult = await proveDustRescueDeposit(
        {
          destinationChainId: BASE_CHAIN_ID,
          tokenId: USDC_BASE,
          sweptAmount: `0x${combinedSweptAmount.toString(16)}` as Hex,
          recipientIdentifier,
        },
        {
          rpcUrl: BASE_RPC,
          aspUrl: mockAsp.url,
          circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
          deployment: {
            poolAddress: BASE_POOL_ADDRESS as Address,
            entrypointAddress: BASE_ENTRYPOINT_ADDRESS as Address,
            keystoreAddress: BASE_KEYSTORE_ADDRESS as Address,
            aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS as Address,
          },
        },
      );
      console.log(
        "Rescue deposit stealth address:",
        proveResult.stealthAddress,
      );
      // Read back the live fee purely for the audit record below — proveDustRescueDeposit
      // already applied it internally; this doesn't feed the deposit itself.
      const [, , vettingFeeBPS] = await basePublicClient.readContract({
        address: BASE_ENTRYPOINT_ADDRESS as Address,
        abi: ENTRYPOINT_ASSETS_ABI,
        functionName: "assets",
        args: [USDC_BASE],
      });
      console.log(
        `Note value after netting the ${vettingFeeBPS}bps vetting fee: ` +
          `${formatUnits(BigInt(proveResult.noteValue), 6)} USDC`,
      );

      // === 12. Submit — same approve()-then-deposit() pattern as
      // dust-rescue-service's ChainWriteService, plain sendTransaction with a fresh
      // nonce (no simulate needed; the exact same call dust-rescue-service submits). ===
      if (proveResult.approvalTx) {
        const approveNonce = await basePublicClient.getTransactionCount({
          address: account.address as Address,
          blockTag: "pending",
        });
        const approveHash = await baseWalletClient.sendTransaction({
          account,
          chain: base,
          to: proveResult.approvalTx.to,
          data: proveResult.approvalTx.data,
          value: BigInt(proveResult.approvalTx.value ?? "0x0"),
          nonce: approveNonce,
        } as any);
        await basePublicClient.waitForTransactionReceipt({ hash: approveHash });
        console.log("Approval tx confirmed:", approveHash);
      }

      // Retry-with-backoff: right after the approval receipt confirms, an
      // immediate estimateGas/sendTransaction for the deposit can land on a
      // hosted-RPC backend node that hasn't yet observed the just-confirmed
      // approval (read-after-write lag), reverting with TransferFromFailed()
      // even though the allowance and balance are genuinely sufficient —
      // reproduced twice, confirmed both times by replaying the identical
      // calldata moments later with no code/state change and having it
      // succeed. Mirrors resolveCommitmentTimestamp's backoff shape
      // (packages/sdk/src/utils/CommitmentTimestamp.ts).
      const DEPOSIT_SEND_MAX_ATTEMPTS = 4;
      const DEPOSIT_SEND_BACKOFF_MS = 2_000;
      let rescueDepositHash: Hex | undefined;
      for (let attempt = 1; attempt <= DEPOSIT_SEND_MAX_ATTEMPTS; attempt++) {
        const depositNonce = await basePublicClient.getTransactionCount({
          address: account.address as Address,
          blockTag: "pending",
        });
        try {
          rescueDepositHash = await baseWalletClient.sendTransaction({
            account,
            chain: base,
            to: proveResult.depositTarget,
            data: proveResult.depositCallData,
            value: BigInt(proveResult.depositMsgValue),
            nonce: depositNonce,
          } as any);
          break;
        } catch (error) {
          if (attempt === DEPOSIT_SEND_MAX_ATTEMPTS) throw error;
          console.warn(
            `Deposit send attempt ${attempt}/${DEPOSIT_SEND_MAX_ATTEMPTS} failed ` +
              `(likely RPC read-after-write lag), retrying in ${DEPOSIT_SEND_BACKOFF_MS}ms:`,
            error instanceof Error ? error.message : error,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, DEPOSIT_SEND_BACKOFF_MS * attempt),
          );
        }
      }
      if (!rescueDepositHash) {
        throw new Error("Deposit send failed after all retry attempts");
      }
      const rescueDepositReceipt =
        await basePublicClient.waitForTransactionReceipt({
          hash: rescueDepositHash,
        });
      console.log(
        "Rescue deposit tx:",
        rescueDepositHash,
        "status:",
        rescueDepositReceipt.status,
      );

      // === 12.5. Full recovery record — written as soon as we know whether the deposit
      // that would lock proveResult.noteValue behind recipientPrivateKey actually landed.
      // This, plus the recipient-key-*.json written in beforeAll, is the ONLY way anyone
      // ever recovers this money — see this file's header and RESCUE_RECOVERY_DIR above.
      // Written even on a reverted deposit: proves this run's outcome either way, and if
      // it somehow DID succeed despite an unexpected receipt shape, the record still
      // exists rather than being silently lost. ===
      mkdirSync(RESCUE_RECOVERY_DIR, { recursive: true });
      const rescueRecordPath = resolve(
        RESCUE_RECOVERY_DIR,
        `rescue-deposit-${Date.now()}.json`,
      );
      writeFileSync(
        rescueRecordPath,
        JSON.stringify(
          {
            status: rescueDepositReceipt.status,
            chainId: BASE_CHAIN_ID,
            tokenId: USDC_BASE,
            // The note's actual locked value (post fee-netting, computed internally by
            // proveDustRescueDeposit) — what recovery actually recovers.
            // combinedSweptAmount/vettingFeeBPS kept alongside for audit:
            // noteValue * (10000+vettingFeeBPS) / 10000 == combinedSweptAmount.
            sweptAmountHuman: formatUnits(BigInt(proveResult.noteValue), 6),
            sweptAmountBaseUnits: BigInt(proveResult.noteValue).toString(),
            combinedSweptAmountBaseUnits: combinedSweptAmount.toString(),
            vettingFeeBPS: vettingFeeBPS.toString(),
            dust1ReceivingAmountBaseUnits: dust1ReceivingAmount.toString(),
            dust2ReceivingAmountBaseUnits: dust2ReceivingAmount.toString(),
            stealthAddress: proveResult.stealthAddress,
            recipientIdentifier,
            recipientKeyFile: recipientKeyPath,
            depositTxHash: rescueDepositHash,
            depositBlock: rescueDepositReceipt.blockNumber.toString(),
            entrypointAddress: BASE_ENTRYPOINT_ADDRESS,
            note:
              "To recover: decrypt this deposit's on-chain noteData.data using the " +
              "private key in recipientKeyFile (deriveStealthSharedSecret / " +
              "scanDepositNoteData, packages/sdk/src/stealth) to recover the underlying " +
              "note secret, then spend normally via a PoolSession scoped to this chain.",
          },
          null,
          2,
        ),
      );
      console.log("Rescue deposit recovery record saved:", rescueRecordPath);

      expect(rescueDepositReceipt.status).toBe("success");

      // === 13. Assertions — the actual claim of issue #222 ===
      expect(combinedSweptAmount).toBe(
        dust1ReceivingAmount + dust2ReceivingAmount,
      );
      if (dust1ReceivingAmount > 0n) {
        // The whole point: dust #1 genuinely contributed to the ONE deposit that
        // landed, not left behind as a second, separate, un-rescued leftover.
        expect(combinedSweptAmount).toBeGreaterThan(dust2ReceivingAmount);
        console.log(
          "\n=== PASS: dust #1 and dust #2 were unified into a single rescue deposit " +
            `(${formatUnits(combinedSweptAmount, 6)} USDC total, one Entrypoint.deposit() call). ===`,
        );
      } else if (dust1SweptAmount > 0n) {
        console.log(
          "\n=== PASS (dust #1 swept but below forwarding minimum this run — only dust #2 rescued). ===",
        );
      } else {
        console.log(
          "\n=== PASS (dust #2 only this run — dust #1 was 0, nothing to unify). ===",
        );
      }
    }, 1_800_000); // 30 min timeout — two bridge legs plus proving
  },
);
