/**
 * B2 minimum-viable reshield-size probe — answers open question §15.2 of
 * detailed_b2_plan_for_mainnet_reshield.md:
 *
 *   "Minimum viable reshield size into Mainnet after LZ fee + two swaps'
 *    slippage + minWorthUsdMicros — needs a live estimateReshieldCrosschainAmount
 *    measurement."
 *
 * and gives the data to retune `B2_ESTIMATE_MAINNET_RESERVE_BPS` (currently a
 * flat 3% guess in PoolSessionReshieldCrosschain.estimateReshieldCrosschainAmount).
 *
 * This is the B2 sibling of scripts/dust-rescue-cost-matrix.ts: read-only, no
 * broadcast, real LiFi quotes + the real SDK estimator across an amount grid.
 * The only network writes are the deployed relayer's `commit:false` prelim quote
 * (a read) and LiFi quote calls. Nothing is signed.
 *
 * For each grid amount it runs, on the OP-USDC -> Mainnet-USDC corridor:
 *   1. sourceSession.estimateReshieldCrosschainAmount({ toChainId: 1 }) — the
 *      authoritative SDK path (its Mainnet branch reserves the flat 3%).
 *   2. A hand-sized replay of the B2 pipeline (provisional contractCalls quote ->
 *      transactionValue -> 1.2x swapValue -> same-chain gas-swap quote ->
 *      gasSwapInput -> re-quote main leg) to expose the numbers the estimator
 *      hides: the real LZ fee, the exact gas-swap USDC slice, and what noteValue
 *      would be if the reserve were sized exactly instead of flat-3%.
 *
 * Output: a console table + scripts/results/b2-mainnet-reshield-sizing-<ts>.json,
 * plus a recommended `B2_ESTIMATE_MAINNET_RESERVE_BPS`.
 *
 * Usage (from packages/swaps/):
 *   . ./.env && npx tsx scripts/b2-mainnet-reshield-sizing.ts
 *
 * Env:
 *   RPC_URL_10 / RPC_URL_1     Optimism + Mainnet RPCs. Required.
 *   LIVE_RELAYER_URL           Relayer for the prelim fee quote. Default: the
 *                              deployed testing relayer.
 *   PRIVATE_KEY                Any address; read only for quote `fromAddress` /
 *                              ownerAddress. Never signs. Throwaway key if unset.
 *   B2_SIZING_AMOUNTS_USDC     Comma list of gross note amounts. Default
 *                              "5,10,25,50,100,250".
 *   B2_SIZING_SLIPPAGE         LiFi slippage (0-1). Default "0.03".
 *   MIN_WORTH_USD              dust-rescue-service minWorthUsdMicros as USD.
 *                              Default "2" (the deployed chains-1&10 config).
 *   LIFI_API_KEY               Recommended (unauthenticated LiFi is rate-limited).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  http,
  parseUnits,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, getContractCallsQuote } from "@lifi/sdk";
import type { ContractCallsQuoteRequest } from "@lifi/types";

import {
  CryptoService,
  LiFiSwapQuoteProvider,
  NoteComputationService,
  PoolSessionBuilder,
  PoseidonHashService,
  type PoolSession,
  type RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import { LocalASPTreeService } from "../test/helpers/local-asp-tree.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-it-003.json",
);
import { getContract } from "../test/helpers/deployment-loader.js";

const SOURCE_CHAIN_ID = 10;
const DEST_CHAIN_ID = 1;
const OP_RPC = process.env.RPC_URL_10;
const MAINNET_RPC = process.env.RPC_URL_1;
if (!OP_RPC || !MAINNET_RPC) {
  throw new Error("RPC_URL_10 and RPC_URL_1 are required (run `. ./.env` first).");
}
const RELAYER_URL =
  process.env.LIVE_RELAYER_URL ??
  "https://relayer-v2-testing-149184580131.us-east1.run.app";

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address;
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

const B2_SWAP_VALUE_HEADROOM_BPS = 12_000n; // mirrors the SDK (minr #14)
const B2_GAS_SWAP_OUT_HEADROOM_BPS = 10_500n;
const CURRENT_ESTIMATE_RESERVE_BPS = 300n; // B2_ESTIMATE_MAINNET_RESERVE_BPS today

const AMOUNTS = (process.env.B2_SIZING_AMOUNTS_USDC ?? "5,10,25,50,100,250")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SLIPPAGE = Number(process.env.B2_SIZING_SLIPPAGE ?? "0.03");
const MIN_WORTH_USD = Number(process.env.MIN_WORTH_USD ?? "2");

interface Row {
  amountUsdc: string;
  estimate:
    | {
        feeAmount: string;
        netSwapAmount: string;
        estimatedMinOutput: string;
        noteValue: string;
        noteValueUsdc: number;
        totalDepositCost: string;
        haircutPct: number;
      }
    | { error: string };
  handSized:
    | {
        lzFeeWei: string;
        lzFeeUsd: number | null;
        swapValueWei: string;
        gasSwapInputUsdc: number;
        gasSwapSlicePctOfPrincipal: number;
        reQuotedLzFeeWei: string;
        mainLegFromAmountUsdc: number;
        noteValueIfExactReserveUsdc: number | null;
        exactReserveBps: number | null;
      }
    | { error: string };
  clearsMinWorthFloor: boolean | null;
}

function placeholderRelayer(): RelayerInfo {
  const acct = privateKeyToAccount(
    (process.env.PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey(),
  );
  return {
    name: "b2-sizing",
    url: RELAYER_URL,
    chainId: SOURCE_CHAIN_ID,
    chainType: "evm",
    status: "active",
    address: acct.address,
    processorAddress: getContract(SOURCE_CHAIN_ID, "RelaySwaps"),
  } as RelayerInfo;
}

async function main() {
  const account = privateKeyToAccount(
    (process.env.PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey(),
  );
  const relayerInfo = placeholderRelayer();

  const crypto = new CryptoService();
  const hashService = await PoseidonHashService.create();
  const noteComp = new NoteComputationService({ hashService, cryptoService: crypto });
  const vkp = crypto.generateEphemeralKeyPair();
  const protocolKeys = {
    privateNullifyingKey: crypto.generateSecret(),
    privateRevocableKey: crypto.generateSecret(),
    revocableKeyIndex: "0x0" as Hex,
    viewingPrivateKey: vkp.privateKey,
    viewingPublicKey: vkp.publicKey,
  };

  const mainnetPublic = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });

  const lifi = new LiFiSwapQuoteProvider({
    ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
  });
  const lifiClient = createClient({
    integrator: "privacy-pools-v2",
    ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
  });

  // --- Source session (Optimism), destination Mainnet — enough to call
  //     estimateReshieldCrosschainAmount (no ASP / keystore / proofs involved). ---
  const sourceSession: PoolSession = await PoolSessionBuilder.fromConfig({
    chainId: SOURCE_CHAIN_ID,
    rpcUrl: OP_RPC,
    // estimateReshieldCrosschainAmount never touches the ASP; a dummy URL just
    // satisfies the builder's "aspUrl or ipfsGatewayUrl is required" check.
    aspUrl: "http://unused.local",
    ownerAddress: account.address,
    deployment: {
      poolAddress: getContract(SOURCE_CHAIN_ID, "PoolVault"),
      entrypointAddress: getContract(SOURCE_CHAIN_ID, "Entrypoint"),
      keystoreAddress: getContract(SOURCE_CHAIN_ID, "Keystore"),
      aspRegistryAddress: getContract(SOURCE_CHAIN_ID, "ASPRegistry"),
      relaySwapsAddress: getContract(SOURCE_CHAIN_ID, "RelaySwaps"),
    },
    protocolKeys,
    circuitArtifactsDir: resolve(__dirname, "../../circuits/build"),
    relayers: [relayerInfo],
    destinationChainId: DEST_CHAIN_ID,
    destinationRpcUrl: MAINNET_RPC,
    destinationDeployment: {
      poolAddress: getContract(DEST_CHAIN_ID, "PoolVault"),
      entrypointAddress: getContract(DEST_CHAIN_ID, "Entrypoint"),
      keystoreAddress: getContract(DEST_CHAIN_ID, "Keystore"),
      aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
    .withSwapQuoteProvider(lifi)
    .withSwapAndDepositQuoteProvider(lifi)
    .create();

  // Throwaway Mainnet session only for the hand-sized replay's embedded deposit proof.
  const destWallet = { account, chain: mainnet, transport: http(MAINNET_RPC) };
  const destASP = await LocalASPTreeService.create({
    aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
    walletClient: destWallet as never,
    publicClient: mainnetPublic as never,
  });
  const destSession: PoolSession = await PoolSessionBuilder.fromConfig({
    chainId: DEST_CHAIN_ID,
    rpcUrl: MAINNET_RPC,
    ownerAddress: account.address,
    deployment: {
      poolAddress: getContract(DEST_CHAIN_ID, "PoolVault"),
      entrypointAddress: getContract(DEST_CHAIN_ID, "Entrypoint"),
      keystoreAddress: getContract(DEST_CHAIN_ID, "Keystore"),
      aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
    },
    protocolKeys,
    circuitArtifactsDir: resolve(__dirname, "../../circuits/build"),
    relayers: [
      { ...relayerInfo, chainId: DEST_CHAIN_ID, processorAddress: account.address },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
    .withAspDataProvider(destASP)
    .create();

  const ethUsd = await fetchEthUsd(lifi);
  const rows: Row[] = [];

  for (const amountHuman of AMOUNTS) {
    const amountWei = parseUnits(amountHuman, 6);
    const amountHex = `0x${amountWei.toString(16)}` as Hex;
    const row: Row = {
      amountUsdc: amountHuman,
      estimate: { error: "not attempted" },
      handSized: { error: "not attempted" },
      clearsMinWorthFloor: null,
    };

    // --- 1. Authoritative SDK estimate. ---
    try {
      const est = await sourceSession.estimateReshieldCrosschainAmount({
        relayerInfo,
        amount: amountHex,
        tokenId: USDC_OP,
        outputToken: USDC_MAINNET,
        toChainId: DEST_CHAIN_ID,
        slippage: SLIPPAGE,
        denyExchanges: ["fly"],
      });
      const noteValue = BigInt(est.noteValue);
      const noteValueUsdc = Number(noteValue) / 1e6;
      row.estimate = {
        feeAmount: est.feeAmount,
        netSwapAmount: est.netSwapAmount,
        estimatedMinOutput: est.estimatedMinOutput,
        noteValue: noteValue.toString(),
        noteValueUsdc,
        totalDepositCost: est.totalDepositCost,
        haircutPct: (1 - noteValueUsdc / Number(amountHuman)) * 100,
      };
      row.clearsMinWorthFloor = noteValueUsdc >= MIN_WORTH_USD;
    } catch (e) {
      row.estimate = { error: (e as Error).message };
      row.clearsMinWorthFloor = false;
    }

    // --- 2. Hand-sized B2 replay (exposes LZ fee + gas-swap slice). ---
    try {
      const feeAmount =
        "error" in row.estimate ? 0n : BigInt(row.estimate.feeAmount);
      const netSwapAmount = amountWei - feeAmount;

      const provisional = await buildMainQuote(
        lifiClient,
        destSession,
        crypto,
        noteComp,
        account.address,
        netSwapAmount,
      );
      const lzFeeWei = BigInt(
        (provisional.transactionRequest!.value as Hex) ?? "0x0",
      );
      if (lzFeeWei === 0n) {
        row.handSized = {
          error: "value-free route (no Stargate/LZ fee) — B2 not exercised for this amount",
        };
      } else {
        const swapValue = (lzFeeWei * B2_SWAP_VALUE_HEADROOM_BPS) / 10_000n;
        const gasSwapTargetOut = (swapValue * B2_GAS_SWAP_OUT_HEADROOM_BPS) / 10_000n;
        const gasSwapQuote = await lifi.getSwapQuote({
          fromChainId: SOURCE_CHAIN_ID,
          toChainId: SOURCE_CHAIN_ID,
          fromToken: USDC_OP,
          toToken: NATIVE,
          fromAddress: account.address,
          amount: gasSwapTargetOut.toString(),
          amountType: "to",
          denyExchanges: ["fly"],
        });
        const gasSwapInput = BigInt(gasSwapQuote.fromAmount);
        const mainNet = netSwapAmount - gasSwapInput;
        const reQuote = await buildMainQuote(
          lifiClient,
          destSession,
          crypto,
          noteComp,
          account.address,
          mainNet,
        );
        const reQuotedLzFeeWei = BigInt(
          (reQuote.transactionRequest!.value as Hex) ?? "0x0",
        );

        // If the SDK's estimator sized the reserve EXACTLY (= gasSwapInput carved
        // from the pre-98% cappedMinOutput) instead of flat 3%, what noteValue
        // would it produce? cappedMinOutput ~= min(estimatedMinOutput, netSwapAmount).
        let noteValueIfExactReserveUsdc: number | null = null;
        let exactReserveBps: number | null = null;
        if (!("error" in row.estimate)) {
          const capped =
            BigInt(row.estimate.estimatedMinOutput) < netSwapAmount
              ? BigInt(row.estimate.estimatedMinOutput)
              : netSwapAmount;
          const exactReserved = capped - gasSwapInput;
          const safeMinOutput = (exactReserved * 98n) / 100n;
          // vettingFeeBPS on Mainnet USDC — read from the estimate's implied ratio
          // (noteValue * (10000+bps) = safeMinOutput_flat3% * 10000). Recover bps:
          const flat3Reserved = (capped * (10_000n - CURRENT_ESTIMATE_RESERVE_BPS)) / 10_000n;
          const flat3Safe = (flat3Reserved * 98n) / 100n;
          const nv = BigInt(row.estimate.noteValue);
          // bps = safe*10000/nv - 10000
          const bps = nv > 0n ? (flat3Safe * 10_000n) / nv - 10_000n : 0n;
          const nvExact = (safeMinOutput * 10_000n) / (10_000n + bps);
          noteValueIfExactReserveUsdc = Number(nvExact) / 1e6;
          exactReserveBps = Number(
            ((capped - exactReserved) * 10_000n) / (capped > 0n ? capped : 1n),
          );
        }

        row.handSized = {
          lzFeeWei: lzFeeWei.toString(),
          lzFeeUsd: ethUsd ? Number(formatEther(lzFeeWei)) * ethUsd : null,
          swapValueWei: swapValue.toString(),
          gasSwapInputUsdc: Number(gasSwapInput) / 1e6,
          gasSwapSlicePctOfPrincipal: (Number(gasSwapInput) / Number(amountWei)) * 100,
          reQuotedLzFeeWei: reQuotedLzFeeWei.toString(),
          mainLegFromAmountUsdc: Number(reQuote.estimate.fromAmount) / 1e6,
          noteValueIfExactReserveUsdc,
          exactReserveBps,
        };
      }
    } catch (e) {
      row.handSized = { error: (e as Error).message };
    }

    rows.push(row);
    printRow(row);
  }

  // --- Recommendation for B2_ESTIMATE_MAINNET_RESERVE_BPS ---
  const exactBpsValues = rows
    .map((r) => ("error" in r.handSized ? null : r.handSized.exactReserveBps))
    .filter((v): v is number => v !== null && v > 0);
  const recommendedReserveBps =
    exactBpsValues.length > 0
      ? Math.ceil((Math.max(...exactBpsValues) * 1.5) / 10) * 10 // 1.5x the worst observed, rounded up to 10
      : null;

  const minViable = rows.find(
    (r) => r.clearsMinWorthFloor === true && !("error" in r.estimate),
  );

  const outDir = resolve(__dirname, "results");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `b2-mainnet-reshield-sizing-${Date.now()}.json`);
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        corridor: "OP-USDC -> Mainnet-USDC",
        slippage: SLIPPAGE,
        minWorthUsd: MIN_WORTH_USD,
        ethUsd,
        currentEstimateReserveBps: Number(CURRENT_ESTIMATE_RESERVE_BPS),
        recommendedReserveBps,
        minViableReshieldUsdc: minViable ? Number(minViable.amountUsdc) : null,
        rows,
      },
      null,
      2,
    ),
  );

  console.log("\n" + "=".repeat(72));
  console.log(`ETH/USD (LiFi)                     : ${ethUsd ?? "unknown"}`);
  console.log(
    `min viable reshield (clears $${MIN_WORTH_USD}) : ${
      minViable ? `${minViable.amountUsdc} USDC` : "none in grid"
    }`,
  );
  console.log(
    `current B2_ESTIMATE_MAINNET_RESERVE_BPS : ${CURRENT_ESTIMATE_RESERVE_BPS} (3%)`,
  );
  console.log(
    `observed exact reserve need (worst)     : ${
      exactBpsValues.length ? `${Math.max(...exactBpsValues)} bps` : "n/a"
    }`,
  );
  console.log(
    `recommended B2_ESTIMATE_MAINNET_RESERVE_BPS : ${
      recommendedReserveBps ?? "insufficient data"
    }`,
  );
  console.log(`\nWrote ${outPath}`);
}

async function buildMainQuote(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lifiClient: any,
  destSession: PoolSession,
  crypto: CryptoService,
  noteComp: NoteComputationService,
  fromAddress: Address,
  mainNet: bigint,
) {
  const noteSecret = crypto.generateSecret();
  const noteAddressHash = noteComp.computeNoteAddressHash(fromAddress, noteSecret);
  const destDeposit = await destSession.prepareDepositFor({
    tokenId: USDC_MAINNET,
    value: `0x${mainNet.toString(16)}` as Hex,
    noteAddressHash,
  });
  const req: ContractCallsQuoteRequest = {
    fromChain: SOURCE_CHAIN_ID,
    fromToken: USDC_OP,
    toChain: DEST_CHAIN_ID,
    toToken: USDC_MAINNET,
    fromAddress,
    toAmount: mainNet.toString(),
    slippage: SLIPPAGE,
    integrator: "privacy-pools-v2",
    denyExchanges: ["fly"],
    contractCalls: [
      {
        fromAmount: mainNet.toString(),
        fromTokenAddress: USDC_MAINNET,
        toContractAddress: destDeposit.to,
        toContractCallData: destDeposit.callData,
        toContractGasLimit: "400000",
      },
    ],
  } as ContractCallsQuoteRequest;
  return getContractCallsQuote(lifiClient, req);
}

async function fetchEthUsd(lifi: LiFiSwapQuoteProvider): Promise<number | null> {
  try {
    const q = await lifi.getSwapQuote({
      fromChainId: SOURCE_CHAIN_ID,
      toChainId: SOURCE_CHAIN_ID,
      fromToken: NATIVE,
      toToken: USDC_OP,
      fromAddress: "0x0000000000000000000000000000000000000001",
      amount: parseUnits("1", 18).toString(),
      amountType: "from",
    });
    return Number(q.toAmount) / 1e6;
  } catch {
    return null;
  }
}

function printRow(row: Row): void {
  const e = row.estimate;
  const h = row.handSized;
  const estStr =
    "error" in e
      ? `estimate ERR: ${e.error.slice(0, 60)}`
      : `note=${e.noteValueUsdc.toFixed(3)} USDC  haircut=${e.haircutPct.toFixed(2)}%`;
  const hStr =
    "error" in h
      ? `handSized ERR: ${h.error.slice(0, 50)}`
      : `LZfee=${h.lzFeeUsd ? "$" + h.lzFeeUsd.toFixed(3) : formatEther(BigInt(h.lzFeeWei)) + "e"}  ` +
        `gasSwap=${h.gasSwapInputUsdc.toFixed(3)}USDC (${h.gasSwapSlicePctOfPrincipal.toFixed(2)}%)  ` +
        `exactReserve=${h.exactReserveBps ?? "?"}bps`;
  console.log(
    `${row.amountUsdc.padStart(5)} USDC | ${estStr.padEnd(48)} | ${hStr}` +
      (row.clearsMinWorthFloor === false ? "  [< min-worth floor]" : ""),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
