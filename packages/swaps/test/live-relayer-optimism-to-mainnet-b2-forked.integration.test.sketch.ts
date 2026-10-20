/**
 * SKETCH — B2 rollout step 13.3 harness (detailed_b2_plan_for_mainnet_reshield.md
 * §13 step 3): "Local end-to-end: local relayer + the live sketch pointed at a
 * forked Optimism with the new RelaySwaps deployed locally, real LiFi quotes."
 *
 * This is the FORKED counterpart of
 * live-relayer-optimism-to-mainnet-eth-dust-rescue.integration.test.sketch.ts.
 * That sketch runs against the live deployed stack and is EXPECTED TO FAIL at
 * relaySwap (`RelaySwaps_SwapFailed`, the B2 blocker). THIS sketch:
 *
 *   - forks Optimism at a pinned block (test/helpers/anvil-fork.ts),
 *   - deploys the NEW (B2) RelaySwaps to the fork + allowlists the LiFi Diamond
 *     and its ERC20Proxy,
 *   - runs a self-contained deposit + LOCAL ASP (LocalASPTreeService — no live
 *     ASP / no 40-min tree-inclusion wait),
 *   - drives estimate -> prepare -> relayReshieldCrosschain through a LOCAL
 *     relayer built from `fat/dust/mainnet-pay-with-value` and pointed at the
 *     fork, with REAL LiFi quotes,
 *   - asserts the source-chain `RelaySwaps.execute` transaction SUCCEEDS (the
 *     B2 gas swap funds the LayerZero fee in-contract).
 *
 * It STOPS at source-chain success. The LayerZero message will not deliver on a
 * fork, and the dust-rescue-service pipeline is out of scope here (already proven
 * end-to-end in the M->O eighth pass; B2 does not change it).
 *
 * Requires (see b2_step13_e2e_and_s15_research.org for the full runbook):
 *   - anvil / forge / cast on PATH (Foundry)
 *   - a LOCAL relayer on LIVE_RELAYER_URL whose chain-10 config points rpc_url at
 *     this fork and relay_swaps_contract / allowed_processors at the deployed
 *     address this sketch prints in beforeAll (chicken-and-egg: run once to get
 *     the address, wire the relayer, run again — or use a fixed CREATE nonce)
 *   - RPC_URL_10 (fork source), RPC_URL_1 (real Mainnet, read-only)
 *   - ASP_POSTMAN_PRIVATE_KEY (POSTMAN_ROLE on the OP ASPRegistry; also the depositor)
 *   - OP_USDC_WHALE (an address holding >= DEPOSIT_AMOUNT USDC at the fork block)
 *   - RELAYER_SIGNER_ADDRESS_10 (the local relayer's chain-10 signer — funded on the fork)
 *   - LIFI_API_KEY (recommended)
 *   - B2_FORKED_CONFIRM=yes
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { optimism } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

import {
  PoolSessionBuilder,
  APP_IDENTIFIER,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  ILogger,
  PoolSession,
  RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import { LocalASPTreeService } from "./helpers/local-asp-tree.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import {
  startAnvilFork,
  deployRelaySwapsToFork,
  approveRouterOnFork,
  fundErc20FromWhale,
  anvilSetBalance,
  anvilImpersonate,
  type AnvilFork,
} from "./helpers/anvil-fork.js";

// it-003 registry (real OP + Mainnet stack). deployment-loader.ts reads this
// lazily per call, so setting it now is safe.
process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-it-003.json",
);
import { getContract, getDeployBlock } from "./helpers/deployment-loader.js";

const SOURCE_CHAIN_ID = 10;
const DEST_CHAIN_ID = 1;
const OP_UPSTREAM_RPC = process.env.RPC_URL_10!;
const MAINNET_RPC = process.env.RPC_URL_1!;
const RELAYER_URL = process.env.LIVE_RELAYER_URL ?? "http://localhost:3000";
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY;
const OP_USDC_WHALE = process.env.OP_USDC_WHALE as Address | undefined;
const RELAYER_SIGNER_ADDRESS_10 = process.env.RELAYER_SIGNER_ADDRESS_10 as
  | Address
  | undefined;
const B2_FORK_BLOCK = process.env.B2_FORK_BLOCK
  ? Number(process.env.B2_FORK_BLOCK)
  : undefined;
const B2_FORK_PORT = Number(process.env.B2_FORK_PORT ?? "8546");
const DEPOSIT_AMOUNT =
  process.env.DEPOSIT_AMOUNT ?? parseUnits("25", 6).toString();
const RESHIELD_SLIPPAGE = Number(process.env.RESHIELD_SLIPPAGE ?? "0.03");
const RESHIELD_PREPARE_ATTEMPTS = Number(
  process.env.RESHIELD_PREPARE_ATTEMPTS ?? "8",
);
const DENY_EXCHANGES = ["fly"];
const CONFIRM = process.env.B2_FORKED_CONFIRM === "yes";

const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

// LiFi Diamond — same CREATE2 address on every EVM chain. The v4 ERC20Proxy
// (`approvalAddress`) is NOT hardcoded — it varies and is allowlisted
// dynamically once the LiFi quote reveals it (see below).
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const OP_NOTE_STORAGE_DIR = resolve(__dirname, "../.b2-forked-op-notes");
const MAINNET_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.b2-forked-mainnet-notes",
);

const consoleLogger: ILogger = {
  level: "debug",
  child(service: string): ILogger {
    return {
      ...consoleLogger,
      debug: (m, o) => console.log(`[${service}]`, m, o ?? ""),
    };
  },
  debug: (m, o) => console.log("[sdk]", m, o ?? ""),
  info: (m, o) => console.log("[sdk]", m, o ?? ""),
  warn: (m, o) => console.warn("[sdk]", m, o ?? ""),
  error: (m, o) => console.error("[sdk]", m, o ?? ""),
  fatal: (m, o) => console.error("[sdk:fatal]", m, o ?? ""),
};

// Must mirror RelaySwaps.sol exactly — inputToken/outputToken are INDEXED
// (topics), so an all-non-indexed ABI makes decodeEventLog throw and the event
// silently "disappear" from the receipt (observed 2026-08-31).
const EXECUTED_EVENT_ABI = [
  {
    type: "event",
    name: "Executed",
    inputs: [
      { name: "inputToken", type: "address", indexed: true },
      { name: "outputToken", type: "address", indexed: true },
      { name: "inputAmount", type: "uint256", indexed: false },
      { name: "feeRecipient", type: "address", indexed: false },
      { name: "feeAmount", type: "uint256", indexed: false },
    ],
  },
] as const;

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

describe.skipIf(!ASP_POSTMAN_PRIVATE_KEY || !hasCircuits || !OP_UPSTREAM_RPC)(
  "B2 forked e2e: Optimism USDC -> Mainnet USDC reshield, new RelaySwaps, real LiFi",
  () => {
    let fork: AnvilFork;
    let forkedRelaySwaps: Address;
    let account: ReturnType<typeof privateKeyToAccount>;
    let sourceSession: PoolSession;
    let destSession: PoolSession;
    let relayerInfo: RelayerInfo;
    let opPublicClient: ReturnType<typeof createPublicClient>;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let localAsp: LocalASPTreeService;

    beforeAll(async () => {
      if (!OP_USDC_WHALE) {
        throw new Error(
          "OP_USDC_WHALE is required (an address holding >= DEPOSIT_AMOUNT USDC at the fork block).",
        );
      }
      if (!RELAYER_SIGNER_ADDRESS_10) {
        throw new Error(
          "RELAYER_SIGNER_ADDRESS_10 is required (the local relayer's chain-10 signer, funded on the fork).",
        );
      }
      account = privateKeyToAccount(ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`);

      // --- 1. Fork Optimism ---
      // B2_FORK_RPC: attach to an already-running anvil (the decoupled runbook
      // flow — deploy + wire the relayer first). Unset: spawn our own fork.
      if (process.env.B2_FORK_RPC) {
        fork = { rpcUrl: process.env.B2_FORK_RPC, port: 0, stop: () => {} };
        console.log(`Attached to existing anvil at ${fork.rpcUrl}`);
      } else {
        const upstream = createPublicClient({
          chain: optimism,
          transport: http(OP_UPSTREAM_RPC),
        });
        const pinBlock =
          B2_FORK_BLOCK ?? Number((await upstream.getBlockNumber()) - 8n);
        console.log(
          `Forking Optimism at block ${pinBlock} on port ${B2_FORK_PORT}...`,
        );
        fork = await startAnvilFork({
          forkUrl: OP_UPSTREAM_RPC,
          forkBlockNumber: pinBlock,
          port: B2_FORK_PORT,
          verbose: !!process.env.B2_FORK_VERBOSE,
        });
      }

      opPublicClient = createPublicClient({
        transport: http(fork.rpcUrl),
      }) as unknown as ReturnType<typeof createPublicClient>;

      // --- 2. Deploy the new RelaySwaps to the fork + allowlist LiFi ---
      // B2_RELAYSWAPS_ADDRESS lets you deploy separately (so the local relayer can
      // be wired to a known address BEFORE the run) — see the runbook's two-step
      // recipe. Unset: deploy here and print the address for a wire-then-rerun pass.
      forkedRelaySwaps =
        (process.env.B2_RELAYSWAPS_ADDRESS as Address | undefined) ??
        deployRelaySwapsToFork({
          rpcUrl: fork.rpcUrl,
          poolAddress: getContract(SOURCE_CHAIN_ID, "PoolVault"),
          entrypointAddress: getContract(SOURCE_CHAIN_ID, "Entrypoint"),
          routers: [LIFI_DIAMOND],
        });
      console.log("\n" + "!".repeat(72));
      console.log(`  Forked RelaySwaps deployed at: ${forkedRelaySwaps}`);
      console.log(
        "  Wire the LOCAL relayer's chain-10 config to this address:",
      );
      console.log(`    relay_swaps_contract = "${forkedRelaySwaps}"`);
      console.log(`    allowed_processors  += ["${forkedRelaySwaps}"]`);
      console.log(`    rpc_url             = "${fork.rpcUrl}"`);
      console.log("!".repeat(72) + "\n");

      // --- 3. Fund accounts on the fork ---
      await anvilSetBalance(
        fork.rpcUrl,
        account.address as Address,
        parseUnits("5", 18),
      );
      await anvilSetBalance(
        fork.rpcUrl,
        RELAYER_SIGNER_ADDRESS_10!,
        parseUnits("5", 18),
      );
      await fundErc20FromWhale(
        fork.rpcUrl,
        USDC_OP,
        OP_USDC_WHALE!,
        account.address as Address,
        BigInt(DEPOSIT_AMOUNT) * 3n, // deposit + vetting fee + slack
      );

      const opWalletClient = createWalletClient({
        account,
        chain: { ...optimism, rpcUrls: { default: { http: [fork.rpcUrl] } } },
        transport: http(fork.rpcUrl),
      });
      const mainnetPublicClient = createPublicClient({
        transport: http(MAINNET_RPC),
      });

      // --- 4. Sessions ---
      persistence = new TestStatePersistence(
        resolve(__dirname, "../.b2-forked-state.json"),
      );
      const saved = persistence.load();
      const protocolKeys =
        saved?.protocolKeys ??
        (await deriveProtocolKeys(account, opWalletClient));
      state = saved ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);

      relayerInfo = {
        url: RELAYER_URL,
        name: "local-b2",
        chainId: SOURCE_CHAIN_ID,
        chainType: "evm",
        status: "active",
        address: RELAYER_SIGNER_ADDRESS_10!,
        processorAddress: forkedRelaySwaps,
      };

      const lifi = new LiFiSwapQuoteProvider({
        ...(process.env.LIFI_API_KEY
          ? { apiKey: process.env.LIFI_API_KEY }
          : {}),
      });

      // The it-003 OP ASPRegistry's POSTMAN_ROLE is NOT held by our postman key
      // (updateASPRoot reverts Permissioned_NotAuthorized, selector 0x4259e7de,
      // verified on-fork 2026-08-31). Impersonate the registry's real root-pusher
      // (sender of its latest ASPRootUpdated on live OP) for the local root pushes.
      const aspRootPusher = (process.env.B2_ASP_ROOT_PUSHER ??
        "0x696fe46495688fc9e99bad2daf2133b33de364ea") as Address;
      await anvilImpersonate(fork.rpcUrl, aspRootPusher);
      await anvilSetBalance(fork.rpcUrl, aspRootPusher, parseUnits("1", 18));
      const aspWalletClient = createWalletClient({
        account: aspRootPusher,
        chain: { ...optimism, rpcUrls: { default: { http: [fork.rpcUrl] } } },
        transport: http(fork.rpcUrl),
      });
      localAsp = await LocalASPTreeService.create({
        aspRegistryAddress: getContract(SOURCE_CHAIN_ID, "ASPRegistry"),
        walletClient: aspWalletClient as never,
        publicClient: opPublicClient as never,
      });

      sourceSession = await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: fork.rpcUrl,
        // no aspUrl: the builder rejects aspUrl + withAspDataProvider together
        // Cold-fork simulations on the relayer side can take minutes (anvil
        // lazily fetches upstream state); the SDK default (15s timeout, 3
        // retries) would time out and REPLAY the non-idempotent relay-swap POST
        // (the known HTTPClient retry bug — see dust_Collector_deploy_handoff.md).
        httpClientConfig: { timeout: 300_000, retryAttempts: 0 },
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: getContract(SOURCE_CHAIN_ID, "PoolVault"),
          entrypointAddress: getContract(SOURCE_CHAIN_ID, "Entrypoint"),
          keystoreAddress: getContract(SOURCE_CHAIN_ID, "Keystore"),
          aspRegistryAddress: getContract(SOURCE_CHAIN_ID, "ASPRegistry"),
          relaySwapsAddress: forkedRelaySwaps,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: OP_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: opWalletClient as never,
        },
        destinationChainId: DEST_CHAIN_ID,
        destinationRpcUrl: MAINNET_RPC,
        destinationDeployment: {
          poolAddress: getContract(DEST_CHAIN_ID, "PoolVault"),
          entrypointAddress: getContract(DEST_CHAIN_ID, "Entrypoint"),
          keystoreAddress: getContract(DEST_CHAIN_ID, "Keystore"),
          aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
        },
        logger: consoleLogger,
        deploymentBlock: getDeployBlock(SOURCE_CHAIN_ID),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
        .withAspDataProvider(localAsp)
        .withSwapQuoteProvider(lifi)
        .withSwapAndDepositQuoteProvider(lifi)
        .create();

      const mainnetWalletClient = createWalletClient({
        account,
        chain: { id: DEST_CHAIN_ID } as never,
        transport: http(MAINNET_RPC),
      });
      destSession = await PoolSessionBuilder.fromConfig({
        chainId: DEST_CHAIN_ID,
        rpcUrl: MAINNET_RPC,
        // prepareDeposit's ASP-ciphertext step needs the real ASP (read-only here —
        // the fork run never lands the deposit on Mainnet, so nothing is submitted).
        aspUrl: process.env.LIVE_ASP_URL ?? "https://api-dev.0xbow.io",
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: getContract(DEST_CHAIN_ID, "PoolVault"),
          entrypointAddress: getContract(DEST_CHAIN_ID, "Entrypoint"),
          keystoreAddress: getContract(DEST_CHAIN_ID, "Keystore"),
          aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [
          {
            url: RELAYER_URL,
            name: "unused",
            chainId: DEST_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: account.address as Address,
            processorAddress: account.address as Address,
          },
        ],
        persistentStorage: { type: "file", dirPath: MAINNET_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: mainnetWalletClient as never,
        },
        logger: consoleLogger,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any).create();

      void mainnetPublicClient;
    }, 180_000);

    afterAll(() => {
      fork?.stop();
    });

    it(
      "source-chain RelaySwaps.execute succeeds for OP-USDC -> Mainnet-USDC (B2 gas swap funds the LZ fee)",
      async () => {
        if (!CONFIRM) {
          throw new Error(
            "Set B2_FORKED_CONFIRM=yes to run — this hits the real LiFi API and needs a local relayer wired to the printed forked RelaySwaps address.",
          );
        }
        const depositAmount = BigInt(DEPOSIT_AMOUNT);

        // === 1. Register keystore + deposit on the fork ===
        if (!(await sourceSession.isKeystoreRegistered())) {
          const receipts = await sourceSession.registerKeystore();
          expect(receipts.every((r) => r.status)).toBe(true);
        }
        const deposit = await sourceSession.prepareDeposit({
          tokenId: USDC_OP,
          value: `0x${depositAmount.toString(16)}` as Hex,
        });
        mkdirSync(OP_NOTE_STORAGE_DIR, { recursive: true });
        writeFileSync(
          resolve(OP_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
          JSON.stringify(deposit.pendingNote, null, 2),
        );
        const depositReceipt = await sourceSession.executeDeposit(deposit);
        expect(depositReceipt.status).toBe(true);
        console.log("Fork deposit tx:", depositReceipt.txHash);

        // LocalASPTreeService: register the label + push the ASP root on-chain (fork).
        // No live-ASP wait — this is the point of the local ASP on a fork.
        await localAsp.registerLabel(deposit.pendingNote.label as Hex);
        const depositTx = await opPublicClient.getTransaction({
          hash: depositReceipt.txHash as Hex,
        });
        const fromBlock =
          `0x${(depositTx.blockNumber! - 1n).toString(16)}` as Hex;
        await sourceSession.discoverNotes({ fromBlock });
        console.log("Source note ACTIVE (local ASP).");

        // === 2. Estimate + prepare (retry the assertLifiBudget flake) ===
        const estimate = await sourceSession.estimateReshieldCrosschainAmount({
          relayerInfo,
          amount: `0x${depositAmount.toString(16)}` as Hex,
          tokenId: USDC_OP,
          outputToken: USDC_MAINNET,
          toChainId: DEST_CHAIN_ID,
          toChainType: "evm",
          slippage: RESHIELD_SLIPPAGE,
          denyExchanges: DENY_EXCHANGES,
        });
        console.log(
          "estimate.noteValue:",
          estimate.noteValue,
          "totalDepositCost:",
          estimate.totalDepositCost,
        );

        if (!(await destSession.isKeystoreRegistered())) {
          const receipts = await destSession.registerKeystore();
          expect(receipts.every((r) => r.status)).toBe(true);
        }
        // The estimate's flat B2 reserve under-sizes small mainnet reshields (the LZ
        // fee is dollar-fixed); prepare's affordability gate then throws
        // DestinationDepositUnaffordable carrying the note value that DOES fit.
        // Rebuild the destination deposit with it and re-prepare (converges in one).
        // Nearest-rounded — the estimate's vettingFee is floor(noteValue*bps/10000), so a
        // floor division here can come out one bps low (100 -> 99) and desync the
        // refit's cost from prepare's own noteValue+fee recomputation.
        const vettingBps =
          ((BigInt(estimate.totalDepositCost) - BigInt(estimate.noteValue)) *
            10000n +
            BigInt(estimate.noteValue) / 2n) /
          BigInt(estimate.noteValue);
        let destDeposit = await destSession.prepareDeposit({
          tokenId: USDC_MAINNET,
          value: estimate.noteValue,
        });
        let totalDepositCost = estimate.totalDepositCost;

        let prepared:
          | Awaited<ReturnType<PoolSession["prepareReshieldCrosschainQuote"]>>
          | undefined;
        for (let attempt = 1; attempt <= RESHIELD_PREPARE_ATTEMPTS; attempt++) {
          try {
            prepared = await sourceSession.prepareReshieldCrosschainQuote({
              relayerInfo,
              amount: `0x${depositAmount.toString(16)}` as Hex,
              tokenId: USDC_OP,
              outputToken: USDC_MAINNET,
              toChainId: DEST_CHAIN_ID,
              toChainType: "evm",
              depositResult: destDeposit,
              totalDepositCost,
              slippage: RESHIELD_SLIPPAGE,
              denyExchanges: DENY_EXCHANGES,
            });
            break;
          } catch (e) {
            const msg = (e as Error).message;
            const unaffordable =
              (e as { name?: string; affordableNoteValue?: Hex }).name ===
              "DestinationDepositUnaffordable";
            if (unaffordable && attempt < RESHIELD_PREPARE_ATTEMPTS) {
              const affordable = (e as { affordableNoteValue: Hex })
                .affordableNoteValue;
              // Shave 0.5% off the affordable value so quote-to-quote minAmountLD
              // drift doesn't re-trip the gate on the next pass.
              const refitValue = (BigInt(affordable) * 995n) / 1000n;
              console.warn(
                `  prepare attempt ${attempt}: destination deposit unaffordable, refitting noteValue -> ${refitValue}`,
              );
              destDeposit = await destSession.prepareDeposit({
                tokenId: USDC_MAINNET,
                value: `0x${refitValue.toString(16)}` as Hex,
              });
              totalDepositCost = (
                refitValue +
                (refitValue * vettingBps) / 10000n
              ).toString();
              continue;
            }
            const retryable =
              /assertLifiBudget|LiFi needs|InvalidTransactParams/i.test(msg);
            if (!retryable || attempt === RESHIELD_PREPARE_ATTEMPTS) throw e;
            console.warn(
              `  prepare attempt ${attempt} tripped budget guard, retrying: ${msg}`,
            );
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
        if (!prepared)
          throw new Error("prepareReshieldCrosschainQuote exhausted retries");

        // B2 assertions on the sized quote — the corridor MUST have produced a
        // non-zero swapValue (Stargate/LZ route), else B2 is not exercised.
        console.log(
          "B2 swapValue:",
          prepared.swapValue,
          "gasSwapMaxInput:",
          prepared.gasSwapMaxInput,
        );
        expect(BigInt(prepared.swapValue ?? "0")).toBeGreaterThan(0n);
        expect((prepared.gasSwapCalldata ?? "0x").length).toBeGreaterThan(2);

        // Allowlist whatever router / approval proxy LiFi actually chose, on the
        // fork-deployed RelaySwaps (owner = anvil account #0). The constructor
        // only allowlisted the Diamond; the ERC20Proxy address is quote-derived.
        for (const r of [prepared.swapTarget, prepared.approvalAddress]) {
          if (r && getAddress(r) !== getAddress(LIFI_DIAMOND)) {
            approveRouterOnFork(fork.rpcUrl, forkedRelaySwaps, r as Address);
          }
        }

        // === 3. relayReshieldCrosschain through the LOCAL relayer -> forked RelaySwaps ===
        const txReceipt = await sourceSession.relayReshieldCrosschain({
          inputCommitments: [deposit.pendingNote.commitment],
          amount: prepared.netAmount,
          tokenId: USDC_OP,
          outputToken: USDC_MAINNET,
          toChainId: DEST_CHAIN_ID,
          toChainType: "evm",
          fallbackAddress: prepared.fallbackAddress,
          swapCalldata: prepared.swapCalldata,
          selectedQuote: prepared.selectedQuote,
          dustRecipient: prepared.dustRecipient,
          swapTarget: prepared.swapTarget,
          approvalAddress: prepared.approvalAddress,
          depositNote: prepared.depositNote,
          swapValue: prepared.swapValue,
          gasSwapMaxInput: prepared.gasSwapMaxInput,
          gasSwapCalldata: prepared.gasSwapCalldata,
        });

        // === 4. THE ASSERTION — pre-B2 this reverted RelaySwaps_SwapFailed ===
        console.log("Forked RelaySwaps.execute tx:", txReceipt.txHash);
        expect(txReceipt.status).toBe(true);

        const receipt = await opPublicClient.getTransactionReceipt({
          hash: txReceipt.txHash as Hex,
        });
        const executed = receipt.logs
          .filter((l) => getAddress(l.address) === getAddress(forkedRelaySwaps))
          .map((l) => {
            try {
              return decodeEventLog({
                abi: EXECUTED_EVENT_ABI,
                data: l.data,
                topics: l.topics as [Hex, ...Hex[]],
              });
            } catch {
              return undefined;
            }
          })
          .find((d) => d?.eventName === "Executed");
        expect(executed).toBeDefined();
        console.log("Executed:", executed!.args);

        // Nothing stranded in the contract (delta-only sweep invariant; also the
        // §15.1 "does _sweepDust catch the Stargate refund in-frame" check).
        const relaySwapsEthAfter = await opPublicClient.getBalance({
          address: forkedRelaySwaps,
        });
        expect(relaySwapsEthAfter).toBe(0n);

        // dustRecipient (relayer) got the gas-swap overshoot (+ any Stargate refund).
        const dustEth = await opPublicClient.getBalance({
          address: prepared.dustRecipient as Address,
        });
        console.log(
          `dustRecipient ${prepared.dustRecipient} ETH after: ${formatUnits(dustEth, 18)} ` +
            `(overshoot + any Stargate refund)`,
        );

        // Full trace for the record (Stargate refund path, gas-swap call tree).
        try {
          const trace = await opPublicClient.request({
            method: "debug_traceTransaction" as never,
            params: [txReceipt.txHash, { tracer: "callTracer" }] as never,
          });
          writeFileSync(
            resolve(OP_NOTE_STORAGE_DIR, `execute-trace-${Date.now()}.json`),
            JSON.stringify(trace, null, 2),
          );
        } catch {
          /* debug_traceTransaction not critical */
        }
      },
      15 * 60_000,
    );
  },
);

// Ported verbatim from the reference reshield-to-base-dust-rescue sketch.
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

async function deriveProtocolKeys(
  account: ReturnType<typeof privateKeyToAccount>,
  walletClient: ReturnType<typeof createWalletClient>,
): Promise<MainnetTestState["protocolKeys"]> {
  const cryptoService = new CryptoService();
  const payload = buildSecretDerivationPayload(account.address as Address);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const signature = await walletClient.signTypedData({
    ...payload,
    account,
  } as any);
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
  return {
    privateNullifyingKey: km.getPrivateNullifyingKey(),
    privateRevocableKey: km.getPrivateRevocableKey(),
    revocableKeyIndex: km.getRevocableKeyIndex(),
    viewingPrivateKey: viewingKeyPair.privateKey,
    viewingPublicKey: viewingKeyPair.publicKey,
  };
}
