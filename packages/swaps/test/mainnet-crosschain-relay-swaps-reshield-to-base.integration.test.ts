/**
 * Cross-chain reshield: withdraw already-deposited USDC on Arbitrum, bridge
 * via LiFi, and redeposit as USDC on Base — via the high-level
 * `PoolSessionReshieldCrosschain` convenience methods
 * (`estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` /
 * `relayReshieldCrosschain`), exercised end-to-end for the first time in
 * this suite.
 *
 * RESEARCH GOAL (see test/integration_test_standards.org,
 * ~/Documentos/FatSolutions/RelayerPrivacyPools/cross_chain_reshield_current_state_brief.org,
 * and dust_collection_service_detailed_design.org): the stealth dust-rescue
 * feature's detection/proving/submission now lives in the standalone
 * `packages/relayer/dust-rescue-service` (relayer's `DustRescueOrchestratorService`
 * is just a Pub/Sub publisher), but that service has no live GCP deployment this
 * suite can drive end-to-end, so this test still does NOT opt into `dustRescue`.
 * Instead it observes
 * where destination-chain leftover actually lands now that `fallbackAddress`
 * is wired through to LiFi's `toFallbackAddress` and defaults to the
 * relayer's own address (this session's fix, 2026-08-13) — per poroto's
 * transient-design decision: no end-user wallet exists on the destination
 * chain for this flow, so leftover should land at a relayer-controlled
 * address instead. This test snapshots that address's Base USDC balance
 * before/after to see whether anything shows up there.
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
import { arbitrum, base } from "viem/chains";
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
// Separate from PRIVATE_KEY on purpose: the depositor owns the note and must
// match the session's ownerAddress, but registering the label needs
// POSTMAN_ROLE on the live ASPRegistry — a different wallet. Same key holds
// POSTMAN_ROLE on both Arbitrum and Base (deployments-it-002.json).
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const RELAYER_BASE_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDC
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-crosschain-reshield-notes",
);
// Shared with the other mainnet suites and scanned by
// mainnet-recover-snapshots.integration.test.ts — deliberately NOT
// NOTE_STORAGE_DIR above. Covers BOTH the SOURCE (Arbitrum) deposit note
// (marked recovered once the reshield spends it) and the destination
// (Base) note (left UNRECOVERED — it's a live deposit, not spent by this
// suite) — chainId is per-snapshot, so the sweep test needs no changes to
// pick up either.
const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");
// Binary-searched via `cast code` on the Base Keystore address (2026-08-13) —
// see test/integration_test_standards.org. Override with BASE_DEPLOYMENT_BLOCK
// if a future redeploy moves it.
const BASE_DEPLOYMENT_BLOCK = (process.env.BASE_DEPLOYMENT_BLOCK ??
  "0x2F904AE") as Hex; // 49874094
// ARB_DEPLOYMENT_BLOCK imported from contract.config.js above — deliberately
// not a separately hardcoded literal here. A hand-computed hex literal
// previously used in this file (0x1CC9EFEC) was silently wrong (decoded to
// 482996204, not the intended 482545313 — a hex-typo, off by ~450k blocks)
// and got baked into two real recovery snapshots, poisoning their
// keystore-leaf scan window and blocking ragequit recovery. Importing the
// single shared source of truth instead of hand-converting hex eliminates
// this whole class of bug.

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
  "Cross-Chain Reshield: Arbitrum -> Base (withdraw USDC, redeposit USDC)",
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

      // Cast: Base's op-stack formatters widen the client type beyond the
      // bare `createPublicClient` return type used for the declaration —
      // same pattern as opPublicClient in the withdraw-to-optimism suite.
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

      persistence = new TestStatePersistence(
        resolve(__dirname, "../.mainnet-crosschain-reshield-state.json"),
      );
      const savedState = persistence.load();

      // --- Derive or load protocol keys (source-chain signature; same
      // keyset is used for the destination-chain session too — one identity
      // across chains, matching how prepareDepositFor's "blind" path is NOT
      // used here, this is a real owned deposit). ---
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

      // --- Local ASP trees. Signed by the postman wallet on each chain —
      // POSTMAN_ROLE lives there, and registerLabel() reverts otherwise. ---
      sourceASP = await LocalASPTreeService.create(
        {
          aspRegistryAddress: ARB_ASP_REGISTRY_ADDRESS,
          walletClient: arbPostmanWalletClient as any,
          publicClient: arbPublicClient as any,
        },
        state.aspLeaves.length > 0 ? state.aspLeaves : undefined,
      );
      console.log(
        "Arbitrum ASP tree initialized with",
        state.aspLeaves.length,
        "leaves",
      );

      destASP = await LocalASPTreeService.create({
        aspRegistryAddress: BASE_ASP_REGISTRY_ADDRESS,
        walletClient: basePostmanWalletClient as any,
        publicClient: basePublicClient as any,
      });
      console.log("Base ASP tree initialized (fresh)");

      // --- Relayer setup (Arbitrum only — relaySwap() executes whatever
      // proof-bound calldata it's given with no server-side awareness of
      // toChainId; see withdraw-and-swap.md §Cross-Chain Reshield). ---
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

      // --- Build source PoolSession (Arbitrum), configured for cross-chain
      // reshield into Base. ---
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
        persistentStorage: {
          type: "file",
          dirPath: NOTE_STORAGE_DIR,
        },
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
        // Paid RPC: giant getLogs chunks; the default 10k-block crawl over the
        // Arbitrum deployment range takes minutes and expires the relayer fee
        // commitment (~3min TTL) before relaySwap can fire.
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: arbPublicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(ARB_DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create();

      // --- Build destination PoolSession (Base) — used only to generate the
      // redeposit proof via prepareDeposit(); prepareReshieldCrosschainQuote
      // requires this to come from a session scoped to the destination
      // chain's own Entrypoint (see PoolSessionReshieldCrosschain.md §3.1). ---
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
        // Unused by prepareDeposit(); satisfies builder validation only.
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
        .withAspDataProvider(destASP)
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

      console.log("Source (Arbitrum) and destination (Base) sessions ready");
    }, 120_000);

    afterAll(() => {
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
    });

    it("full flow: keystore -> deposit USDC (Arb) -> ASP register -> reshield USDC(Arb)->USDC(Base) -> register on Base", async () => {
      // === 1. Register in keystore on Arbitrum (idempotent) ===
      const registered = await sourceSession.isKeystoreRegistered();
      if (registered) {
        console.log("Already registered in keystore, skipping");
      } else {
        console.log("Registering in keystore...");
        const receipts = await sourceSession.registerKeystore();
        expect(receipts.length).toBeGreaterThan(0);
        expect(receipts.every((r) => r.status)).toBe(true);
        state.keystoreRegistered = true;
        persistence.save(state);
        console.log("Keystore registration complete");
      }

      // === 2. Deposit USDC into the Arbitrum pool (the note we'll reshield) ===
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
      console.log(
        "Deposit proof generated. Commitment:",
        depositResult.pendingNote.commitment,
      );

      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
        JSON.stringify(depositResult.pendingNote, null, 2),
      );
      persistence.save(state);

      const depositReceipt = await sourceSession.executeDeposit(depositResult);
      expect(depositReceipt.status).toBe(true);
      console.log("Arbitrum deposit tx:", depositReceipt.txHash);

      // === 2.5. Recovery snapshot for the source note — see the pattern in
      // test/integration_test_standards.org. Saved before ASP registration
      // deliberately: the deposit is already irreversible, but registerLabel
      // or the reshield steps below can still fail. Marked recovered below
      // once the reshield succeeds (note spent, not stuck). ===
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

      // === 3. Register the source label in Arbitrum's ASP tree ===
      const label = depositResult.pendingNote.label as Hash;
      console.log("\nRegistering label in Arbitrum ASP tree:", label);
      await sourceASP.registerLabel(label);
      const serialized = sourceASP.serialize();
      state.aspLeaves = serialized.leaves;
      persistence.save(state);
      console.log(
        "Arbitrum ASP root updated on-chain:",
        await sourceASP.getRoot(),
      );

      // === 3.5. Sync notes to promote PENDING -> ACTIVE ===
      console.log("\nSyncing notes from deposit block...");
      const fromBlock =
        `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
      await sourceSession.discoverNotes({ fromBlock });
      console.log("Notes synced");

      // === 4. Reshield: estimate the destination-chain note value ===
      const withdrawAmount = depositAmount;
      console.log("\n=== CROSS-CHAIN RESHIELD: Arbitrum -> Base ===");
      console.log(
        "Withdraw",
        formatUnits(withdrawAmount, 6),
        "USDC (Arbitrum) -> redeposit USDC (Base)",
      );

      // fallbackAddress deliberately omitted here and below: no end-user
      // wallet exists on the destination chain for this flow. It defaults to
      // relayerInfo.address (this session's fix, 2026-08-13) — the exact
      // behavior this test is set up to observe.
      // denyExchanges excludes "fly" — see the established pattern in
      // test/integration_test_standards.org.
      const estimate = await sourceSession.estimateReshieldCrosschainAmount({
        relayerInfo,
        amount: `0x${withdrawAmount.toString(16)}` as Hex,
        tokenId: USDC_ARB,
        outputToken: USDC_BASE,
        toChainId: BASE_CHAIN_ID,
        toChainType: "evm",
        denyExchanges: ["fly"],
      });
      console.log(
        "Recommended Base note value:",
        formatUnits(BigInt(estimate.noteValue), 6),
        "USDC",
      );
      console.log(
        "Total deposit cost (Base):",
        formatUnits(BigInt(estimate.totalDepositCost), 6),
        "USDC",
      );

      // === 4.5. Register in Base's keystore (idempotent). Not required for
      // prepareDeposit() to succeed — the deposit proof is fully
      // self-contained and doesn't read keystore state — but registration is
      // scoped per-chain (a Set<chainId> in KeystoreManager, and Base has its
      // own Keystore contract, separate from Arbitrum's). Skipping this would
      // leave the resulting Base note undepositable-from-later: not lost, but
      // unspendable until this identity registers on Base at some point.
      // Doing it now, before the reshield executes, means the note is
      // genuinely usable the moment it lands. ===
      const destRegistered = await destSession.isKeystoreRegistered();
      if (destRegistered) {
        console.log("Already registered in Base keystore, skipping");
      } else {
        console.log("Registering in Base keystore...");
        const destReceipts = await destSession.registerKeystore();
        expect(destReceipts.length).toBeGreaterThan(0);
        expect(destReceipts.every((r) => r.status)).toBe(true);
        console.log("Base keystore registration complete");
      }

      // === 5. Generate the destination (Base) deposit proof ===
      console.log("\nGenerating Base deposit proof...");
      const destDepositResult = await destSession.prepareDeposit({
        tokenId: USDC_BASE,
        value: estimate.noteValue,
      });
      console.log(
        "Base deposit commitment:",
        destDepositResult.pendingNote.commitment,
      );

      // === 5.5. Write the Base note's raw secrets to disk immediately —
      // first line of defense. Nothing about the Base deposit is on-chain
      // yet (it only lands once the Arbitrum reshield tx confirms AND the
      // bridge completes), so there is no recovery-snapshot-worthy state to
      // capture yet either. But the note's secret material itself
      // (noteSecret/value/tokenId/label) is already fully determined right
      // now — if the process dies anywhere between here and the real
      // recovery snapshot (step 9.5 below), this file is what stands
      // between the eventual Base deposit and being permanently
      // unprovable. Same convention every other suite already uses for its
      // own pending notes (see NOTE_STORAGE_DIR usage elsewhere in this
      // file), just applied to the destination-chain note too. ===
      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `base-pending-${Date.now()}.json`),
        JSON.stringify(destDepositResult.pendingNote, null, 2),
      );

      // === 6. Snapshot the relayer's own Base USDC balance BEFORE — this is
      // the "where does destination leftover land" observation. account IS
      // relayerInfo.address in this test env (same wallet plays depositor +
      // relayer + postman across both chains), so this doubles as "the
      // depositor's own Base balance" — acceptable for this research pass
      // since the point is confirming ANY leftover reaches a known,
      // observable address at all, not isolating relayer vs. user identity. ===
      const relayerBaseUsdcBefore = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log(
        "Relayer Base USDC balance before:",
        formatUnits(relayerBaseUsdcBefore, 6),
      );
      const basePoolUsdcBefore = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [BASE_POOL_ADDRESS as `0x${string}`],
      });

      // === 7. prepareReshieldCrosschainQuote — LiFi contractCalls quote
      // (bridge + swap + destination deposit), committed relayer fee quote ===
      console.log("\nPreparing cross-chain reshield quote...");
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
      });
      console.log("Resolved fallbackAddress:", prepared.fallbackAddress);
      console.log("Resolved dustRecipient:", prepared.dustRecipient);
      expect(prepared.fallbackAddress.toLowerCase()).toBe(
        account.address.toLowerCase(),
      );

      // === 8. Execute the reshield via RelaySwaps ===
      console.log("\nGenerating transact proof (this takes 30-60s)...");
      const proofStart = Date.now();
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
      });
      console.log(
        `Proof + relay completed in ${((Date.now() - proofStart) / 1000).toFixed(1)}s`,
      );
      console.log("Arbitrum RelaySwaps tx:", txReceipt.txHash);
      console.log("Status:", txReceipt.status);
      expect(txReceipt.status).toBe(true);

      // Close out the source recovery snapshot — the input note is now
      // spent (pulled via POOL.transact() inside the reshield tx), not
      // stuck.
      markAsRecovered(snapshotPath);
      console.log(
        "Recovery snapshot marked as recovered (note spent by reshield).",
      );

      // === 9. Wait for the bridge + destination deposit to land on Base.
      // Driven by LiFi's status endpoint rather than balance polling alone
      // (same fix as the deposit-from-ethereum suite) — this is what gives
      // us the actual Base tx hash/block, which balance polling alone
      // cannot, and which the real recovery snapshot below requires. ===
      console.log(
        "\nWaiting for bridge + deposit on Base (polling LiFi status)...",
      );
      const maxWaitMs = 600_000; // 10 minutes
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let destinationTxHash: Hex | undefined;

      while (Date.now() - start < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash: txReceipt.txHash as Hex,
          fromChainId: ARB_CHAIN_ID,
          toChainId: BASE_CHAIN_ID,
        });

        if (status.status === "DONE" && status.receiving?.txHash) {
          destinationTxHash = status.receiving.txHash;
          console.log("Bridge complete! Base tx:", destinationTxHash);
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

      const basePoolUsdcAfter = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [BASE_POOL_ADDRESS as `0x${string}`],
      });
      console.log("Base pool USDC after:", formatUnits(basePoolUsdcAfter, 6));
      expect(basePoolUsdcAfter).toBeGreaterThan(basePoolUsdcBefore);

      // === 9.5. Real recovery snapshot for the Base note — uses the exact
      // same general helper/sweep as every other suite
      // (saveRecoverySnapshot() + mainnet-recover-snapshots.integration.test.ts),
      // so recovering it later needs no bespoke tooling. Left UNRECOVERED
      // on purpose: this suite doesn't spend the Base note, it's a live
      // deposit for the sweep (or a later withdraw test) to find. The 5.5
      // fallback file (base-pending-*.json) is superseded by this but left
      // in place — harmless, and not picked up by the sweep either way
      // (only recovery-*.json files are). ===
      const destinationTx = await basePublicClient.getTransaction({
        hash: destinationTxHash,
      });
      const destSnapshotPath = await saveRecoverySnapshot({
        publicClient: basePublicClient as any,
        chainId: BASE_CHAIN_ID,
        depositTxHash: destinationTxHash,
        depositBlock: destinationTx.blockNumber,
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
      console.log("Base recovery snapshot saved:", destSnapshotPath);

      // === 10. THE OBSERVATION: did any leftover land at the relayer's own
      // Base address? Logged, not strictly asserted — a same-token
      // (USDC->USDC) bridge may legitimately leave zero dust. ===
      const relayerBaseUsdcAfter = await basePublicClient.readContract({
        address: USDC_BASE,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const leftover = relayerBaseUsdcAfter - relayerBaseUsdcBefore;
      console.log(
        "\n=== DESTINATION LEFTOVER OBSERVATION ===\n" +
          `Relayer Base USDC before: ${formatUnits(relayerBaseUsdcBefore, 6)}\n` +
          `Relayer Base USDC after:  ${formatUnits(relayerBaseUsdcAfter, 6)}\n` +
          `Leftover observed:        ${formatUnits(leftover, 6)} USDC\n` +
          (leftover > 0n
            ? "-> fallbackAddress wiring DOES catch destination leftover at the relayer's address."
            : "-> No leftover observed this run (same-token bridge may have delivered exactly enough, or LiFi's executor doesn't sweep on the success path — inconclusive from a single run)."),
      );

      // === 11. Register the resulting Base note so it's genuinely usable,
      // not left PENDING forever (same rationale as the deposit-from-ethereum
      // suite's registerLabel retrofit). ===
      const destLabel = destDepositResult.pendingNote.label as Hash;
      console.log("\nRegistering Base label in ASP tree:", destLabel);
      await destASP.registerLabel(destLabel);
      console.log("Base ASP root updated on-chain:", await destASP.getRoot());

      // Sync from the exact destination block (known precisely now, via
      // destinationTx from the recovery-snapshot step above) to promote the
      // Base note from PENDING to ACTIVE.
      const destFromBlock =
        `0x${(destinationTx.blockNumber - 1n).toString(16)}` as Hex;
      await destSession.discoverNotes({ fromBlock: destFromBlock });
      console.log("Base notes synced");

      console.log("\n=== Cross-Chain Reshield (Arbitrum -> Base) PASS ===");
    }, 1_200_000); // 20 min timeout for proof + bridge
  },
);
