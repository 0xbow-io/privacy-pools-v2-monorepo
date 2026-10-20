/**
 * Cross-chain reshield: withdraw already-deposited USDC on Arbitrum, bridge
 * via LiFi, and redeposit as USDC on Optimism — via the high-level
 * `PoolSessionReshieldCrosschain` convenience methods
 * (`estimateReshieldCrosschainAmount` / `prepareReshieldCrosschainQuote` /
 * `relayReshieldCrosschain`), exercised end-to-end for the first time in
 * this suite.
 *
 * RESEARCH GOAL (see test/integration_test_standards.org and
 * ~/Documentos/FatSolutions/RelayerPrivacyPools/cross_chain_reshield_current_state_brief.org):
 * the stealth dust-rescue feature's automatic submission trigger is not yet
 * wired up (DustRescueOrchestratorService.attemptRescue() computes but never
 * submits), so this test does NOT opt into `dustRescue`. Instead it observes
 * where destination-chain leftover actually lands now that `fallbackAddress`
 * is wired through to LiFi's `toFallbackAddress` and defaults to the
 * relayer's own address (this session's fix, 2026-08-13) — per poroto's
 * transient-design decision: no end-user wallet exists on the destination
 * chain for this flow, so leftover should land at a relayer-controlled
 * address instead. This test snapshots that address's Optimism USDC balance
 * before/after to see whether anything shows up there.
 */
import { describe, it, expect, beforeAll } from "vitest";
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
import { getContract } from "./helpers/deployment-loader.js";
import { DEPLOYMENT_BLOCK as ARB_DEPLOYMENT_BLOCK } from "./contract.config.js";

// --- Contract addresses (from deployments-it-002.json) ---
const ARB_POOL_ADDRESS = getContract(42161, "PoolVault");
const ARB_ENTRYPOINT_ADDRESS = getContract(42161, "Entrypoint");
const ARB_KEYSTORE_ADDRESS = getContract(42161, "Keystore");
const ARB_ASP_REGISTRY_ADDRESS = getContract(42161, "ASPRegistry");
const ARB_RELAY_SWAPS_ADDRESS = getContract(42161, "RelaySwaps");

const OP_POOL_ADDRESS = getContract(10, "PoolVault");
const OP_ENTRYPOINT_ADDRESS = getContract(10, "Entrypoint");
const OP_KEYSTORE_ADDRESS = getContract(10, "Keystore");
const OP_ASP_REGISTRY_ADDRESS = getContract(10, "ASPRegistry");
const OP_RELAY_SWAPS_ADDRESS = getContract(10, "RelaySwaps");

// --- Tokens ---
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as Address;
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;

// --- Config ---
const ARB_CHAIN_ID = 42161;
const OP_CHAIN_ID = 10;
const ARB_RPC = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const OP_RPC = process.env.OP_RPC_URL ?? "https://mainnet.optimism.io";
const PRIVATE_KEY = process.env.PRIVATE_KEY;
// Separate from PRIVATE_KEY on purpose: the depositor owns the note and must
// match the session's ownerAddress, but registering the label needs
// POSTMAN_ROLE on the live ASPRegistry — a different wallet. Same key holds
// POSTMAN_ROLE on both Arbitrum and Optimism (deployments-it-002.json).
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const RELAYER_OP_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
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
// (Optimism) note (left UNRECOVERED — it's a live deposit, not spent by this
// suite) — chainId is per-snapshot, so the sweep test needs no changes to
// pick up either.
const RECOVERY_SNAPSHOT_DIR = resolve(__dirname, "../.mainnet-deposit-notes");
// Optimism stack deploy block (2026-08-16, broadcast/Deploy.s.sol/10/run-latest.json).
// Override with OP_DEPLOYMENT_BLOCK if a future redeploy moves it.
const OP_DEPLOYMENT_BLOCK = (process.env.OP_DEPLOYMENT_BLOCK ??
  "0x9473A98") as Hex; // 155663000 — safely before the first deploy tx at 155663648
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
  "Cross-Chain Reshield: Arbitrum -> Optimism (withdraw USDC, redeposit USDC)",
  () => {
    let arbPublicClient: ReturnType<typeof createPublicClient>;
    let arbWalletClient: ReturnType<typeof createWalletClient>;
    let arbPostmanWalletClient: ReturnType<typeof createWalletClient>;
    let opPublicClient: ReturnType<typeof createPublicClient>;
    let opWalletClient: ReturnType<typeof createWalletClient>;
    let opPostmanWalletClient: ReturnType<typeof createWalletClient>;
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

      // Cast: Optimism's op-stack formatters widen the client type beyond the
      // bare `createPublicClient` return type used for the declaration —
      // same pattern as opPublicClient in the withdraw-to-optimism suite.
      opPublicClient = createPublicClient({
        chain: optimism,
        transport: http(OP_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;
      opWalletClient = createWalletClient({
        account,
        chain: optimism,
        transport: http(OP_RPC),
      });
      opPostmanWalletClient = createWalletClient({
        account: postmanAccount,
        chain: optimism,
        transport: http(OP_RPC),
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
        aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS,
        walletClient: opPostmanWalletClient as any,
        publicClient: opPublicClient as any,
      });
      console.log("Optimism ASP tree initialized (fresh)");

      // --- Relayer setup (Arbitrum only — relaySwap() executes whatever
      // proof-bound calldata it's given with no server-side awareness of
      // toChainId; see withdraw-and-swap.md §Cross-Chain Reshield). ---
      relayerInfo = {
        url: RELAYER_OP_URL,
        name: "local",
        chainId: ARB_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: ARB_RELAY_SWAPS_ADDRESS as Address,
      };

      lifiProvider = new LiFiSwapQuoteProvider({});

      // --- Build source PoolSession (Arbitrum), configured for cross-chain
      // reshield into Optimism. ---
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
        destinationChainId: OP_CHAIN_ID,
        destinationRpcUrl: OP_RPC,
        destinationDeployment: {
          poolAddress: OP_POOL_ADDRESS as Address,
          entrypointAddress: OP_ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: OP_KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: OP_RELAY_SWAPS_ADDRESS as Address,
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

      // --- Build destination PoolSession (Optimism) — used only to generate the
      // redeposit proof via prepareDeposit(); prepareReshieldCrosschainQuote
      // requires this to come from a session scoped to the destination
      // chain's own Entrypoint (see PoolSessionReshieldCrosschain.md §3.1). ---
      destSession = await PoolSessionBuilder.fromConfig({
        chainId: OP_CHAIN_ID,
        rpcUrl: OP_RPC,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: OP_POOL_ADDRESS as Address,
          entrypointAddress: OP_ENTRYPOINT_ADDRESS as Address,
          keystoreAddress: OP_KEYSTORE_ADDRESS as Address,
          aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS as Address,
          relaySwapsAddress: OP_RELAY_SWAPS_ADDRESS as Address,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        // Unused by prepareDeposit(); satisfies builder validation only.
        relayers: [
          {
            url: "http://localhost:3000",
            name: "unused",
            chainId: OP_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: account.address as Address,
            processorAddress: account.address as Address,
          },
        ],
        persistentStorage: { type: "memory" },
        walletInteractor: {
          type: "viem",
          walletClient: opWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: OP_DEPLOYMENT_BLOCK,
      })
        .withAspDataProvider(destASP)
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: opPublicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(OP_DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create();

      console.log(
        "Source (Arbitrum) and destination (Optimism) sessions ready",
      );
    }, 120_000);

    it("full flow: keystore -> deposit USDC (Arb) -> ASP register -> reshield USDC(Arb)->USDC(Optimism) -> register on Optimism", async () => {
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
      console.log("\n=== CROSS-CHAIN RESHIELD: Arbitrum -> Optimism ===");
      console.log(
        "Withdraw",
        formatUnits(withdrawAmount, 6),
        "USDC (Arbitrum) -> redeposit USDC (Optimism)",
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
        outputToken: USDC_OP,
        toChainId: OP_CHAIN_ID,
        toChainType: "evm",
        denyExchanges: ["fly"],
      });
      console.log(
        "Recommended Optimism note value:",
        formatUnits(BigInt(estimate.noteValue), 6),
        "USDC",
      );
      console.log(
        "Total deposit cost (Optimism):",
        formatUnits(BigInt(estimate.totalDepositCost), 6),
        "USDC",
      );

      // === 4.5. Register in Optimism's keystore (idempotent). Not required for
      // prepareDeposit() to succeed — the deposit proof is fully
      // self-contained and doesn't read keystore state — but registration is
      // scoped per-chain (a Set<chainId> in KeystoreManager, and Optimism has its
      // own Keystore contract, separate from Arbitrum's). Skipping this would
      // leave the resulting Optimism note undepositable-from-later: not lost, but
      // unspendable until this identity registers on Optimism at some point.
      // Doing it now, before the reshield executes, means the note is
      // genuinely usable the moment it lands. ===
      const destRegistered = await destSession.isKeystoreRegistered();
      if (destRegistered) {
        console.log("Already registered in Optimism keystore, skipping");
      } else {
        console.log("Registering in Optimism keystore...");
        const destReceipts = await destSession.registerKeystore();
        expect(destReceipts.length).toBeGreaterThan(0);
        expect(destReceipts.every((r) => r.status)).toBe(true);
        console.log("Optimism keystore registration complete");
      }

      // === 5. Generate the destination (Optimism) deposit proof ===
      console.log("\nGenerating Optimism deposit proof...");
      const destDepositResult = await destSession.prepareDeposit({
        tokenId: USDC_OP,
        value: estimate.noteValue,
      });
      console.log(
        "Optimism deposit commitment:",
        destDepositResult.pendingNote.commitment,
      );

      // === 5.5. Write the Optimism note's raw secrets to disk immediately —
      // first line of defense. Nothing about the Optimism deposit is on-chain
      // yet (it only lands once the Arbitrum reshield tx confirms AND the
      // bridge completes), so there is no recovery-snapshot-worthy state to
      // capture yet either. But the note's secret material itself
      // (noteSecret/value/tokenId/label) is already fully determined right
      // now — if the process dies anywhere between here and the real
      // recovery snapshot (step 9.5 below), this file is what stands
      // between the eventual Optimism deposit and being permanently
      // unprovable. Same convention every other suite already uses for its
      // own pending notes (see NOTE_STORAGE_DIR usage elsewhere in this
      // file), just applied to the destination-chain note too. ===
      mkdirSync(NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `op-pending-${Date.now()}.json`),
        JSON.stringify(destDepositResult.pendingNote, null, 2),
      );

      // === 6. Snapshot the relayer's own Optimism USDC balance BEFORE — this is
      // the "where does destination leftover land" observation. account IS
      // relayerInfo.address in this test env (same wallet plays depositor +
      // relayer + postman across both chains), so this doubles as "the
      // depositor's own Optimism balance" — acceptable for this research pass
      // since the point is confirming ANY leftover reaches a known,
      // observable address at all, not isolating relayer vs. user identity. ===
      const relayerOpUsdcBefore = await opPublicClient.readContract({
        address: USDC_OP,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      console.log(
        "Relayer Optimism USDC balance before:",
        formatUnits(relayerOpUsdcBefore, 6),
      );
      const opPoolUsdcBefore = await opPublicClient.readContract({
        address: USDC_OP,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [OP_POOL_ADDRESS as `0x${string}`],
      });

      // === 7. prepareReshieldCrosschainQuote — LiFi contractCalls quote
      // (bridge + swap + destination deposit), committed relayer fee quote ===
      console.log("\nPreparing cross-chain reshield quote...");
      const prepared = await sourceSession.prepareReshieldCrosschainQuote({
        relayerInfo,
        amount: `0x${withdrawAmount.toString(16)}` as Hex,
        tokenId: USDC_ARB,
        outputToken: USDC_OP,
        toChainId: OP_CHAIN_ID,
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
        outputToken: USDC_OP,
        toChainId: OP_CHAIN_ID,
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

      // === 9. Wait for the bridge + destination deposit to land on Optimism.
      // Driven by LiFi's status endpoint rather than balance polling alone
      // (same fix as the deposit-from-ethereum suite) — this is what gives
      // us the actual Optimism tx hash/block, which balance polling alone
      // cannot, and which the real recovery snapshot below requires. ===
      console.log(
        "\nWaiting for bridge + deposit on Optimism (polling LiFi status)...",
      );
      const maxWaitMs = 600_000; // 10 minutes
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let destinationTxHash: Hex | undefined;

      while (Date.now() - start < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash: txReceipt.txHash as Hex,
          fromChainId: ARB_CHAIN_ID,
          toChainId: OP_CHAIN_ID,
        });

        if (status.status === "DONE" && status.receiving?.txHash) {
          destinationTxHash = status.receiving.txHash;
          console.log("Bridge complete! Optimism tx:", destinationTxHash);
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

      const opPoolUsdcAfter = await opPublicClient.readContract({
        address: USDC_OP,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [OP_POOL_ADDRESS as `0x${string}`],
      });
      console.log("Optimism pool USDC after:", formatUnits(opPoolUsdcAfter, 6));
      expect(opPoolUsdcAfter).toBeGreaterThan(opPoolUsdcBefore);

      // === 9.5. Real recovery snapshot for the Optimism note — uses the exact
      // same general helper/sweep as every other suite
      // (saveRecoverySnapshot() + mainnet-recover-snapshots.integration.test.ts),
      // so recovering it later needs no bespoke tooling. Left UNRECOVERED
      // on purpose: this suite doesn't spend the Optimism note, it's a live
      // deposit for the sweep (or a later withdraw test) to find. The 5.5
      // fallback file (op-pending-*.json) is superseded by this but left
      // in place — harmless, and not picked up by the sweep either way
      // (only recovery-*.json files are). ===
      const destinationTx = await opPublicClient.getTransaction({
        hash: destinationTxHash,
      });
      const destSnapshotPath = await saveRecoverySnapshot({
        publicClient: opPublicClient as any,
        chainId: OP_CHAIN_ID,
        depositTxHash: destinationTxHash,
        depositBlock: destinationTx.blockNumber,
        deploymentBlock: OP_DEPLOYMENT_BLOCK,
        ownerAddress: account.address as Address,
        contracts: {
          pool: OP_POOL_ADDRESS as Address,
          entrypoint: OP_ENTRYPOINT_ADDRESS as Address,
          keystore: OP_KEYSTORE_ADDRESS as Address,
          aspRegistry: OP_ASP_REGISTRY_ADDRESS as Address,
        },
        protocolKeys: state.protocolKeys,
        note: destDepositResult.pendingNote,
        storageDir: RECOVERY_SNAPSHOT_DIR,
      });
      console.log("Optimism recovery snapshot saved:", destSnapshotPath);

      // === 10. THE OBSERVATION: did any leftover land at the relayer's own
      // Optimism address? Logged, not strictly asserted — a same-token
      // (USDC->USDC) bridge may legitimately leave zero dust. ===
      const relayerOpUsdcAfter = await opPublicClient.readContract({
        address: USDC_OP,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const leftover = relayerOpUsdcAfter - relayerOpUsdcBefore;
      console.log(
        "\n=== DESTINATION LEFTOVER OBSERVATION ===\n" +
          `Relayer Optimism USDC before: ${formatUnits(relayerOpUsdcBefore, 6)}\n` +
          `Relayer Optimism USDC after:  ${formatUnits(relayerOpUsdcAfter, 6)}\n` +
          `Leftover observed:        ${formatUnits(leftover, 6)} USDC\n` +
          (leftover > 0n
            ? "-> fallbackAddress wiring DOES catch destination leftover at the relayer's address."
            : "-> No leftover observed this run (same-token bridge may have delivered exactly enough, or LiFi's executor doesn't sweep on the success path — inconclusive from a single run)."),
      );

      // === 11. Register the resulting Optimism note so it's genuinely usable,
      // not left PENDING forever (same rationale as the deposit-from-ethereum
      // suite's registerLabel retrofit). ===
      const destLabel = destDepositResult.pendingNote.label as Hash;
      console.log("\nRegistering Optimism label in ASP tree:", destLabel);
      await destASP.registerLabel(destLabel);
      console.log(
        "Optimism ASP root updated on-chain:",
        await destASP.getRoot(),
      );

      // Sync from the exact destination block (known precisely now, via
      // destinationTx from the recovery-snapshot step above) to promote the
      // Optimism note from PENDING to ACTIVE.
      const destFromBlock =
        `0x${(destinationTx.blockNumber - 1n).toString(16)}` as Hex;
      await destSession.discoverNotes({ fromBlock: destFromBlock });
      console.log("Optimism notes synced");

      console.log("\n=== Cross-Chain Reshield (Arbitrum -> Optimism) PASS ===");
    }, 1_200_000); // 20 min timeout for proof + bridge
  },
);
