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
import { existsSync, mkdirSync, writeFileSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
  RelayerInteractor,
  AddressSchema,
  HTTPClient,
  ViemRPCInteractor,
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
// Separate from PRIVATE_KEY on purpose: the depositor owns the note and must
// match the session's ownerAddress, but registering the label needs
// POSTMAN_ROLE on the live ASPRegistry — a different wallet. See the same
// fix in mainnet-deposit.integration.test.ts.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const RELAYER_BASE_URL = process.env.RELAYER_URL ?? "http://localhost:3000";
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "1000000"; // 1 USDC
const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-relay-swaps-reshield-notes",
);
// Shared with mainnet-deposit.integration.test.ts and scanned by
// mainnet-recover-snapshots.integration.test.ts — deliberately NOT
// NOTE_STORAGE_DIR above, so that one recovery sweep test covers deposits
// from every mainnet suite instead of needing a copy per suite.
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
  "Real RelaySwaps Reshield (Optimism Mainnet) — withdraw USDC + swap USDT + redeposit",
  () => {
    let publicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;
    let postmanWalletClient: ReturnType<typeof createWalletClient>;

    let session: PoolSession;
    let localASP: LocalASPTreeService;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let relayerInteractor: InstanceType<typeof RelayerInteractor<Address>>;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      const postmanAccount = privateKeyToAccount(
        ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`,
      );

      // Cast: Optimism's op-stack formatters widen the client type beyond the
      // bare `createPublicClient` return type used for the declaration —
      // same pattern as opPublicClient in the reshield-to-optimism suite.
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

      // --- Local ASP tree. Signed by the postman wallet, not the depositor —
      // POSTMAN_ROLE lives there, and registerLabel() reverts otherwise. ---
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

      // --- Relayer setup (points to RelaySwaps processor) ---
      relayerInfo = {
        url: RELAYER_BASE_URL,
        name: "local",
        chainId: OP_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: account.address as Address,
        processorAddress: RELAY_SWAPS_ADDRESS as Address,
      };

      relayerInteractor = new RelayerInteractor({
        relayers: [relayerInfo],
        httpClient: new HTTPClient(),
        addressSchema: AddressSchema,
      });

      // --- Build PoolSession ---
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
        // Paid RPC: giant getLogs chunks; the default 10k-block crawl takes ~4min
        // over the full deployment range and expires the relayer fee commitment.
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

    it("full flow: keystore -> deposit USDC -> ASP register -> reshield USDC->USDT (RelaySwaps)", async () => {
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
      // the reshield steps below can still fail, and a snapshot saved after
      // such a failure would never be written, losing recovery data for real,
      // spent funds. Shared with mainnet-recover-snapshots.integration.test.ts
      // via RECOVERY_SNAPSHOT_DIR. Marked recovered below if the reshield
      // succeeds, since the note is spent (not stuck) at that point — see
      // step 6. ===
      const depositTx = await publicClient.getTransaction({
        hash: depositReceipt.txHash as `0x${string}`,
      });
      const snapshotPath = await saveRecoverySnapshot({
        publicClient: publicClient as any,
        chainId: OP_CHAIN_ID,
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
        `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
      await session.discoverNotes({ fromBlock });
      console.log("Notes synced");

      // === 4. Reshield: withdraw USDC -> swap to USDT -> deposit USDT back into pool ===
      const withdrawAmount = BigInt(DEPOSIT_AMOUNT);
      console.log("\n=== RESHIELD FLOW ===");
      console.log(
        "Withdraw",
        formatUnits(withdrawAmount, 6),
        "USDC -> swap to USDT -> redeposit into pool",
      );

      // Step 1: Preliminary fee quote (no commitment)
      const prelimRes = await fetch(
        `${RELAYER_BASE_URL}/v1/quote/evm/${OP_CHAIN_ID}/swap`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            asset: USDC,
            amount: withdrawAmount.toString(),
            outputToken: USDT,
            recipient: "0x0000000000000000000000000000000000000000", // reshield — no source-chain recipient
            minOutputAmount: "0",
            dustRecipient: account.address,
            commit: false,
          }),
        },
      );
      const prelimQuote = (await prelimRes.json()) as { feeAmount: string };

      const feeAmount = BigInt(prelimQuote.feeAmount);
      const netSwapAmount = withdrawAmount - feeAmount;
      console.log("Relayer fee:", formatUnits(feeAmount, 6), "USDC");
      console.log(
        "Net amount for swap:",
        formatUnits(netSwapAmount, 6),
        "USDC",
      );

      // Step 2: Estimate deposit amount using LiFi swap quote (tight, not arbitrary 90%)
      // Get estimated swap output to set deposit amount close to actual market rate.
      // NOTE: Entrypoint.deposit() pulls value + vettingFee from msg.sender (LiFi Diamond).
      // The LiFi contractCalls depositAmount must include the vetting fee, otherwise
      // the Entrypoint's transferFrom fails (insufficient allowance).
      // denyExchanges excludes "fly" here too, so the estimate's sizing math
      // doesn't diverge from the actual contractCalls quote below — see that
      // call's comment for the ExpiredTransaction() root cause.
      const lifiEstimateProvider = new LiFiSwapQuoteProvider({});
      const swapEstimate = await lifiEstimateProvider.getSwapQuote({
        fromChainId: OP_CHAIN_ID,
        toChainId: OP_CHAIN_ID,
        fromToken: USDC,
        toToken: USDT,
        fromAddress: RELAY_SWAPS_ADDRESS as Address,
        amount: netSwapAmount.toString(),
        amountType: "from",
        denyExchanges: ["fly"],
      });
      console.log(
        "LiFi swap estimate - toAmount:",
        swapEstimate.toAmount,
        "toAmountMin:",
        swapEstimate.toAmountMin,
      );

      const VETTING_FEE_BPS = 100n; // 1% — from Entrypoint.assets(USDT).vettingFeeBPS
      const estimatedMinOutput = BigInt(swapEstimate.toAmountMin);
      // Apply 1% safety buffer: contractCalls quotes may need more input than simple swap quotes
      const safeMinOutput = (estimatedMinOutput * 99n) / 100n;
      // Work backwards from safe min output: noteValue = totalCost * 10000 / (10000 + feeBPS)
      const noteValueUsdt =
        (safeMinOutput * 10000n) / (10000n + VETTING_FEE_BPS);
      const vettingFee = (noteValueUsdt * VETTING_FEE_BPS) / 10000n;
      const totalDepositCost = noteValueUsdt + vettingFee;
      const noteValueHex = `0x${noteValueUsdt.toString(16)}` as Hex;
      console.log("Note value (USDT):", formatUnits(noteValueUsdt, 6));
      console.log("Vetting fee (1%):", formatUnits(vettingFee, 6));
      console.log(
        "Total deposit cost:",
        formatUnits(totalDepositCost, 6),
        "USDT",
      );

      // Step 3: Generate deposit proof for USDT (commits to note value, NOT total cost)
      console.log("\nGenerating deposit proof for USDT redeposit...");
      const depositProofStart = Date.now();
      const reshieldDepositResult = await session.prepareDeposit({
        tokenId: USDT,
        value: noteValueHex,
      });
      const depositProofTime = (Date.now() - depositProofStart) / 1000;
      console.log(`Deposit proof generated in ${depositProofTime.toFixed(1)}s`);
      console.log(
        "Reshield deposit commitment:",
        reshieldDepositResult.pendingNote.commitment,
      );

      // Persist reshield deposit note
      writeFileSync(
        resolve(NOTE_STORAGE_DIR, `reshield-deposit-${Date.now()}.json`),
        JSON.stringify(reshieldDepositResult.pendingNote, null, 2),
      );

      // Step 4: Get LiFi contractCalls quote — swap USDC->USDT + deposit into pool
      // depositAmount = totalDepositCost (value + vettingFee) so LiFi swaps enough
      // and approves the Entrypoint for the full amount it will transferFrom.
      // denyExchanges excludes "fly": its calldata embeds a transaction deadline
      // shorter than this protocol's proof generation (30-60s) plus relayer
      // round-trip, so it reliably reverts on-chain with ExpiredTransaction()
      // regardless of quote freshness — confirmed by direct reproduction.
      console.log("\nFetching LiFi contractCalls quote (swap + deposit)...");
      const lifiProvider = new LiFiSwapQuoteProvider({});
      const lifiQuoteStart = Date.now();

      const lifiQuote = await lifiProvider.getSwapAndDepositQuote({
        fromChainId: OP_CHAIN_ID,
        toChainId: OP_CHAIN_ID,
        fromToken: USDC,
        toToken: USDT,
        fromAddress: RELAY_SWAPS_ADDRESS as Address,
        depositAmount: totalDepositCost.toString(),
        depositCalldata: reshieldDepositResult.depositTx.data,
        poolAddress: reshieldDepositResult.depositTx.to,
        denyExchanges: ["fly"],
      } satisfies SwapAndDepositQuoteRequest);

      const lifiQuoteTimestamp = Date.now();
      const lifiQuoteTime = (lifiQuoteTimestamp - lifiQuoteStart) / 1000;
      console.log(`LiFi quote received in ${lifiQuoteTime.toFixed(1)}s`);
      console.log("LiFi fromAmount:", lifiQuote.fromAmount, "USDC");
      console.log("LiFi toAmount (deposit):", lifiQuote.toAmount, "USDT");
      console.log("LiFi transactionTo:", lifiQuote.transactionTo);
      console.log("LiFi approvalAddress:", lifiQuote.approvalAddress);

      // Step 5: Committed relayer quote with the full swapCalldata (proof-bound)
      const elapsedSinceQuote1 = (Date.now() - lifiQuoteTimestamp) / 1000;
      console.log(
        `\n[LiFi quote age: ${elapsedSinceQuote1.toFixed(1)}s] Getting committed relayer quote...`,
      );

      const relayerQuote = await relayerInteractor.getSwapQuote(relayerInfo, {
        asset: USDC as Hex,
        amount: withdrawAmount.toString(),
        outputToken: USDT as Hex,
        recipient: "0x0000000000000000000000000000000000000000" as Hex, // reshield — no source-chain recipient
        minOutputAmount: "0",
        swapCalldata: lifiQuote.transactionData as Hex,
        swapTarget: lifiQuote.transactionTo as Hex,
        approvalAddress: lifiQuote.approvalAddress as Hex,
        dustRecipient: account.address as Hex,
        commit: true,
      });

      const committedFee = BigInt(relayerQuote.feeAmount);
      const amountSent = BigInt(relayerQuote.feeCommitment.amountSent);
      const netAmount = amountSent - committedFee;
      const netAmountHex = `0x${netAmount.toString(16)}` as Hex;
      console.log("Committed fee:", formatUnits(committedFee, 6), "USDC");
      console.log("Net amount (excl fee):", formatUnits(netAmount, 6), "USDC");

      // Step 7: Execute reshield via RelaySwaps
      const elapsedSinceQuote2 = (Date.now() - lifiQuoteTimestamp) / 1000;
      console.log(
        `\n[LiFi quote age: ${elapsedSinceQuote2.toFixed(1)}s] Generating withdrawal proof (this takes 30-60s)...`,
      );

      const proofStart = Date.now();
      const txReceipt = await session.relayReshield({
        inputCommitments: [depositResult.pendingNote.commitment as Hash],
        amount: netAmountHex,
        tokenId: USDC,
        outputToken: USDT,
        swapCalldata: lifiQuote.transactionData as Hex,
        selectedQuote: {
          relayerInfo,
          quote: relayerQuote,
        },
      });

      const proofAndRelayTime = (Date.now() - proofStart) / 1000;
      const totalLifiAge = (Date.now() - lifiQuoteTimestamp) / 1000;
      console.log(
        `\nWithdrawal proof + relay completed in ${proofAndRelayTime.toFixed(1)}s`,
      );
      console.log(
        `Total LiFi quote age at execution: ${totalLifiAge.toFixed(1)}s`,
      );
      console.log("RelaySwaps reshield tx:", txReceipt.txHash);
      console.log("Status:", txReceipt.status);
      expect(txReceipt.status).toBe(true);

      // === 6. Close out the recovery snapshot from step 2.5 — the input note
      // is now spent (pulled via POOL.transact() inside the reshield tx), not
      // stuck, so there's nothing left for mainnet-recover-snapshots to do
      // for it. Marking it recovered here keeps that test's snapshot sweep
      // limited to genuinely-actionable deposits. ===
      markAsRecovered(snapshotPath);
      console.log(
        "Recovery snapshot marked as recovered (note spent by reshield).",
      );

      // Verify RelaySwaps contract holds no dust
      const contractUsdc = await publicClient.readContract({
        address: USDC as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RELAY_SWAPS_ADDRESS as `0x${string}`],
      });
      expect(contractUsdc).toBe(0n);

      const contractUsdt = await publicClient.readContract({
        address: USDT as `0x${string}`,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RELAY_SWAPS_ADDRESS as `0x${string}`],
      });
      expect(contractUsdt).toBe(0n);

      console.log("\n=== Real RelaySwaps RESHIELD PASS ===");
    }, 1_200_000);
  },
);
