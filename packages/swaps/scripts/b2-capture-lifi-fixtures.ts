/**
 * B2 fixture capture — pulls a REAL LiFi contractCalls quote for an
 * OP-USDC -> Mainnet-USDC cross-chain reshield (the corridor that only routes
 * via Stargate V2 / LayerZero and therefore carries a native `transactionValue`,
 * see detailed_b2_plan_for_mainnet_reshield.md §1) PLUS the matching same-chain
 * USDC -> native-ETH "gas swap" quote, and writes both as calldata fixtures.
 *
 * Those fixtures are consumed by:
 *   - packages/swaps/contracts/test/RelaySwapsB2Fork.t.sol   (§15 open question 1:
 *     does Stargate refund excess msg.value to msg.sender, and does _sweepDust
 *     catch it — needs REAL Stargate calldata, can't be answered with a mock)
 *   - the b2-forked live sketch, as a deterministic offline fallback when the
 *     LiFi API is rate-limited mid-run.
 *
 * Read-only / no broadcast — same posture as scripts/dust-rescue-cost-matrix.ts:
 * it builds a real blind cold-start destination deposit proof (the
 * `prepareDepositFor` mechanism dust-rescue-prover uses) so the contractCalls
 * quote is the exact shape the real reshield flow produces, but never signs or
 * sends anything. Costs proving compute + LiFi/RPC calls only.
 *
 * Usage (from packages/swaps/):
 *   . ./.env && npx tsx scripts/b2-capture-lifi-fixtures.ts
 *
 * Env:
 *   RPC_URL_10 / RPC_URL_1     Optimism + Mainnet RPCs (Alchemy — public RPCs choke
 *                              on proof-carrying eth_call). Required.
 *   PRIVATE_KEY                Any address; only read for the quote's `fromAddress`
 *                              and to satisfy LocalASPTreeService's ctor. Never signs.
 *                              Falls back to a fresh throwaway key.
 *   B2_FIXTURE_WITHDRAW_USDC   Gross note amount in USDC. Default "25".
 *   B2_FIXTURE_FEE_USDC        Relay fee slice to subtract before the swap. Default "0.2".
 *   LIFI_API_KEY               Recommended (unauthenticated LiFi is rate-limited).
 *   B2_FIXTURE_OUT             Output file. Default test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  decodeAbiParameters,
  decodeFunctionData,
  http,
  parseUnits,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { optimism, mainnet } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createClient, getContractCallsQuote } from "@lifi/sdk";
import type { ContractCallsQuoteRequest } from "@lifi/types";

import {
  CryptoService,
  LiFiSwapQuoteProvider,
  NoteComputationService,
  PoolSessionBuilder,
  PoseidonHashService,
  type RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";

import { LocalASPTreeService } from "../test/helpers/local-asp-tree.js";
import { getContract } from "../test/helpers/deployment-loader.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

// Pin deployments to the it-003 registry (real Optimism + Mainnet stack) — same
// override the live O->M sketch uses. deployment-loader.ts reads this env var
// lazily, per-call (inside loadDeployments()), so setting it now — during module
// body execution, before any getContract() call in main() — is safe.
process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-it-003.json",
);

const SOURCE_CHAIN_ID = 10;
const DEST_CHAIN_ID = 1;
const OP_RPC = process.env.RPC_URL_10;
const MAINNET_RPC = process.env.RPC_URL_1;
if (!OP_RPC || !MAINNET_RPC) {
  throw new Error("RPC_URL_10 and RPC_URL_1 are required (run `. ./.env` first).");
}

const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
const USDC_OP = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address; // cast-verified 2026-08-29
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;

// SDK B2 sizing constants — mirror PoolSessionReshieldCrosschain.ts so the
// fixture's derived values match what the real pipeline would sign.
const B2_SWAP_VALUE_HEADROOM_BPS = 12_000n; // 1.2x — mirrors the SDK (minr #14)
const B2_GAS_SWAP_OUT_HEADROOM_BPS = 10_500n; // +5%
const B2_GAS_SWAP_MAX_INPUT_SLACK_BPS = 10_100n; // +1%

const WITHDRAW = parseUnits(process.env.B2_FIXTURE_WITHDRAW_USDC ?? "25", 6);
const FEE = parseUnits(process.env.B2_FIXTURE_FEE_USDC ?? "0.2", 6);
const OUT_PATH =
  process.env.B2_FIXTURE_OUT ??
  resolve(__dirname, "../test/fixtures/b2-lifi-op-usdc-to-mainnet-usdc.json");

// LiFi StargateFacetV2.swapAndStartBridgeTokensViaStargate — selector 0xa6010a66,
// verified against the live calldata 2026-08-31. Used to extract the destination
// compose payload for RelaySwapsB2DestFork.t.sol.
const STARGATE_FACET_ABI = [
  {
    type: "function",
    name: "swapAndStartBridgeTokensViaStargate",
    stateMutability: "payable",
    inputs: [
      {
        name: "_bridgeData",
        type: "tuple",
        components: [
          { name: "transactionId", type: "bytes32" },
          { name: "bridge", type: "string" },
          { name: "integrator", type: "string" },
          { name: "referrer", type: "address" },
          { name: "sendingAssetId", type: "address" },
          { name: "receiver", type: "address" },
          { name: "minAmount", type: "uint256" },
          { name: "destinationChainId", type: "uint256" },
          { name: "hasSourceSwaps", type: "bool" },
          { name: "hasDestinationCall", type: "bool" },
        ],
      },
      {
        name: "_swapData",
        type: "tuple[]",
        components: [
          { name: "callTo", type: "address" },
          { name: "approveTo", type: "address" },
          { name: "sendingAssetId", type: "address" },
          { name: "receivingAssetId", type: "address" },
          { name: "fromAmount", type: "uint256" },
          { name: "callData", type: "bytes" },
          { name: "requiresDeposit", type: "bool" },
        ],
      },
      {
        name: "_stargateData",
        type: "tuple",
        components: [
          { name: "assetId", type: "uint16" },
          {
            name: "sendParams",
            type: "tuple",
            components: [
              { name: "dstEid", type: "uint32" },
              { name: "to", type: "bytes32" },
              { name: "amountLD", type: "uint256" },
              { name: "minAmountLD", type: "uint256" },
              { name: "extraOptions", type: "bytes" },
              { name: "composeMsg", type: "bytes" },
              { name: "oftCmd", type: "bytes" },
            ],
          },
          {
            name: "fee",
            type: "tuple",
            components: [
              { name: "nativeFee", type: "uint256" },
              { name: "lzTokenFee", type: "uint256" },
            ],
          },
          { name: "refundAddress", type: "address" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

/** Extracts the destination-leg compose payload from a main-leg diamond calldata. */
function decodeStargateSend(data: Hex): {
  receiver: Address;
  amountLD: bigint;
  minAmountLD: bigint;
  composeMsg: Hex;
  payloadReceiver: Address;
} {
  const { args } = decodeFunctionData({ abi: STARGATE_FACET_ABI, data });
  const sendParams = (args as unknown as [unknown, unknown, { sendParams: {
    to: Hex; amountLD: bigint; minAmountLD: bigint; composeMsg: Hex;
  } }])[2].sendParams;
  // The compose payload LiFi's receiver decodes: (txId, SwapData[], payloadReceiver).
  const [, , payloadReceiver] = decodeAbiParameters(
    [
      { type: "bytes32" },
      {
        type: "tuple[]",
        components: [
          { name: "callTo", type: "address" },
          { name: "approveTo", type: "address" },
          { name: "sendingAssetId", type: "address" },
          { name: "receivingAssetId", type: "address" },
          { name: "fromAmount", type: "uint256" },
          { name: "callData", type: "bytes" },
          { name: "requiresDeposit", type: "bool" },
        ],
      },
      { type: "address" },
    ],
    sendParams.composeMsg,
  );
  return {
    receiver: `0x${sendParams.to.slice(-40)}` as Address,
    amountLD: sendParams.amountLD,
    minAmountLD: sendParams.minAmountLD,
    composeMsg: sendParams.composeMsg,
    payloadReceiver: payloadReceiver as Address,
  };
}

function placeholderRelayer(chainId: number): RelayerInfo {
  return {
    name: "b2-fixture-capture",
    url: "http://localhost",
    chainId,
    chainType: "evm",
    status: "active",
    address: "0x0000000000000000000000000000000000000001",
    processorAddress: "0x0000000000000000000000000000000000000001",
  } as RelayerInfo;
}

async function main() {
  const account = privateKeyToAccount(
    (process.env.PRIVATE_KEY as Hex | undefined) ?? generatePrivateKey(),
  );
  // The EXECUTOR is the address that will run the captured calldata — LiFi pins
  // it as the swap-output receiver (gas swap) and the Stargate refund address
  // (main leg), so the Foundry test MUST deploy RelaySwaps at exactly this
  // address (deployCodeTo). A random fromAddress here silently misdirects the
  // gas-swap ETH -> RelaySwaps_GasSwapInsufficient (observed 2026-08-31).
  const executor = (process.env.B2_EXECUTOR ??
    "0x00000000000000000000000000000000b2b2b2b2") as Address;

  const opPublic = createPublicClient({ chain: optimism, transport: http(OP_RPC) });

  // --- Destination (Mainnet) throwaway session, only for a blind cold-start
  //     deposit proof to embed in the contractCalls quote (ownership irrelevant). ---
  const crypto = new CryptoService();
  const hashService = await PoseidonHashService.create();
  const noteComp = new NoteComputationService({ hashService, cryptoService: crypto });
  const vkp = crypto.generateEphemeralKeyPair();

  const mainnetPublic = createPublicClient({ chain: mainnet, transport: http(MAINNET_RPC) });
  const mainnetWallet = { account, chain: mainnet, transport: http(MAINNET_RPC) };
  const destASP = await LocalASPTreeService.create({
    aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
    walletClient: mainnetWallet as never,
    publicClient: mainnetPublic as never,
  });

  const destSession = await PoolSessionBuilder.fromConfig({
    chainId: DEST_CHAIN_ID,
    rpcUrl: MAINNET_RPC,
    ownerAddress: account.address,
    deployment: {
      poolAddress: getContract(DEST_CHAIN_ID, "PoolVault"),
      entrypointAddress: getContract(DEST_CHAIN_ID, "Entrypoint"),
      keystoreAddress: getContract(DEST_CHAIN_ID, "Keystore"),
      aspRegistryAddress: getContract(DEST_CHAIN_ID, "ASPRegistry"),
    },
    protocolKeys: {
      privateNullifyingKey: crypto.generateSecret(),
      privateRevocableKey: crypto.generateSecret(),
      revocableKeyIndex: "0x0" as Hex,
      viewingPrivateKey: vkp.privateKey,
      viewingPublicKey: vkp.publicKey,
    },
    circuitArtifactsDir: resolve(__dirname, "../../circuits/build"),
    relayers: [placeholderRelayer(DEST_CHAIN_ID)],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)
    .withAspDataProvider(destASP)
    .create();

  const lifiClient = createClient({
    integrator: "privacy-pools-v2",
    ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
  });
  const lifi = new LiFiSwapQuoteProvider({
    ...(process.env.LIFI_API_KEY ? { apiKey: process.env.LIFI_API_KEY } : {}),
  });

  const netSwapAmount = WITHDRAW - FEE;

  // Mirrors PoolSessionReshieldCrosschain.prepareReshieldCrosschainQuote's B2
  // three-pass: (1) provisional main quote for `transactionValue`, (2) size the
  // gas swap, (3) re-quote the main leg against the REDUCED net so its encoded
  // `fromAmount` matches the USDC the contract will actually hold after step 9.5.
  // Mainnet vetting fee (100 bps live, but read it — the deposit proof's value must
  // satisfy value + value*vettingBps/10000 <= the amount LiFi budgets for the
  // destination call, or the deposit reverts on arrival even at full delivery
  // (observed: proof value = delivery target ignored vetting -> cost 22.046 vs
  // budget 21.937, structurally dead destination leg, 2026-08-31).
  const vettingBps = (
    (await mainnetPublic.readContract({
      address: getContract(DEST_CHAIN_ID, "Entrypoint") as Address,
      abi: [
        {
          type: "function",
          name: "assets",
          stateMutability: "view",
          inputs: [{ name: "_asset", type: "address" }],
          outputs: [
            {
              type: "tuple",
              components: [
                { name: "enabled", type: "bool" },
                { name: "minAmount", type: "uint256" },
                { name: "vettingFeeBPS", type: "uint256" },
                { name: "maxRelayFee", type: "uint256" },
              ],
            },
          ],
        },
      ] as const,
      functionName: "assets",
      args: [USDC_MAINNET],
    })) as { vettingFeeBPS: bigint }
  ).vettingFeeBPS;

  const buildMainQuote = async (mainNet: bigint, proofValueOverride?: bigint) => {
    const noteSecret = crypto.generateSecret();
    const noteAddressHash = noteComp.computeNoteAddressHash(account.address, noteSecret);
    // LiFi caps the destination call's budget at minAmountLD (~ toAmount * (1 - slippage)),
    // so size the proven note value off the WORST-CASE delivery, vetting fee included.
    const proofValue =
      proofValueOverride ?? (mainNet * 9700n * 10_000n) / (10_000n * (10_000n + vettingBps));
    const totalDepositCost = proofValue + (proofValue * vettingBps) / 10_000n;
    const destDeposit = await destSession.prepareDepositFor({
      tokenId: USDC_MAINNET,
      value: `0x${proofValue.toString(16)}` as Hex,
      noteAddressHash,
    });
    const req: ContractCallsQuoteRequest = {
      fromChain: SOURCE_CHAIN_ID,
      fromToken: USDC_OP,
      toChain: DEST_CHAIN_ID,
      toToken: USDC_MAINNET,
      fromAddress: executor,
      toAmount: mainNet.toString(),
      slippage: 0.03,
      integrator: "privacy-pools-v2",
      denyExchanges: ["fly"],
      contractCalls: [
        {
          fromAmount: totalDepositCost.toString(),
          fromTokenAddress: USDC_MAINNET,
          toContractAddress: destDeposit.to,
          toContractCallData: destDeposit.callData,
          // Groth16 verify + LeanIMT insert needs ~800k on the destination — the
          // shared 400k default OOGs a mainnet deposit (B2 plan §7 / SDK depositGasLimit).
          toContractGasLimit: "800000",
        },
      ],
    } as ContractCallsQuoteRequest;
    const quote = await getContractCallsQuote(lifiClient, req);
    return { quote, proofValue, totalDepositCost };
  };

  // --- Pass 1: provisional main quote → transactionValue (the LZ fee). ---
  const provisional = (await buildMainQuote(netSwapAmount)).quote;
  const transactionValue = BigInt((provisional.transactionRequest!.value as Hex) ?? "0x0");
  if (transactionValue === 0n) {
    throw new Error(
      "LiFi returned a value-free route for OP-USDC -> Mainnet-USDC — B2 is not " +
        "exercised. Re-run; if it persists the corridor may have gained an Across " +
        "route and this fixture is no longer representative.",
    );
  }
  const swapValue = (transactionValue * B2_SWAP_VALUE_HEADROOM_BPS) / 10_000n;

  // --- Pass 2: gas swap — same-chain OP-USDC -> native ETH, sized swapValue x 1.05 out. ---
  const gasSwapTargetOut = (swapValue * B2_GAS_SWAP_OUT_HEADROOM_BPS) / 10_000n;
  const gasSwapQuote = await lifi.getSwapQuote({
    fromChainId: SOURCE_CHAIN_ID,
    toChainId: SOURCE_CHAIN_ID,
    fromToken: USDC_OP,
    toToken: NATIVE,
    fromAddress: executor,
    amount: gasSwapTargetOut.toString(),
    amountType: "to",
    denyExchanges: ["fly"],
  });
  const gasSwapInput = BigInt(gasSwapQuote.fromAmount);
  const gasSwapMaxInput = (gasSwapInput * B2_GAS_SWAP_MAX_INPUT_SLACK_BPS) / 10_000n;

  // --- Pass 3: authoritative main quote against the reduced net. ---
  // `buildMainQuote`'s arg is the DELIVERY amount (toAmount + deposit value); LiFi
  // sizes fromAmount = delivery + bridge cost + slippage buffer, ~4% above it
  // (observed). Passing the source budget as the delivery target therefore
  // overdraws the contract's balance -> "transfer amount exceeds balance" at the
  // Stargate transferFrom (2026-08-31). Scale the delivery target down until the
  // quoted fromAmount fits the budget, like the SDK's estimate-haircut does.
  const mainNet = netSwapAmount - gasSwapInput;
  let deliveryTarget = mainNet;
  let main = await buildMainQuote(deliveryTarget);
  for (
    let i = 0;
    i < 3 && BigInt(main.quote.estimate.fromAmount) > mainNet;
    i++
  ) {
    deliveryTarget =
      (deliveryTarget * mainNet * 99n) / (BigInt(main.quote.estimate.fromAmount) * 100n);
    main = await buildMainQuote(deliveryTarget);
  }
  if (BigInt(main.quote.estimate.fromAmount) > mainNet) {
    throw new Error(
      `main-leg fromAmount ${main.quote.estimate.fromAmount} still exceeds the source ` +
        `budget ${mainNet} after scaling — re-run or lower B2_FIXTURE_WITHDRAW_USDC.`,
    );
  }

  // --- Pass 4: destination-leg fit check. LiFi caps the destination call's budget
  // at the bridge's minAmountLD; if the proven deposit cost exceeds it, the deposit
  // reverts on arrival even at full delivery. Re-prove once against the actual
  // minAmountLD if the conservative pre-sizing didn't fit.
  let destInfo = decodeStargateSend(main.quote.transactionRequest!.data as Hex);
  if (main.totalDepositCost > destInfo.minAmountLD) {
    const refitProofValue = (destInfo.minAmountLD * 10_000n) / (10_000n + vettingBps);
    main = await buildMainQuote(deliveryTarget, refitProofValue);
    destInfo = decodeStargateSend(main.quote.transactionRequest!.data as Hex);
    if (main.totalDepositCost > destInfo.minAmountLD) {
      throw new Error(
        `destination deposit cost ${main.totalDepositCost} still exceeds minAmountLD ` +
          `${destInfo.minAmountLD} after refit — re-run.`,
      );
    }
  }
  const mainStep = main.quote;
  const mainTx = mainStep.transactionRequest!;
  const reQuotedValue = BigInt((mainTx.value as Hex) ?? "0x0");
  if (reQuotedValue > swapValue) {
    throw new Error(
      `Re-quoted LZ fee ${reQuotedValue} exceeds sized swapValue ${swapValue} — ` +
        "headroom insufficient this run; re-capture (or raise B2_SWAP_VALUE_HEADROOM_BPS).",
    );
  }

  const mainSwapTarget = mainTx.to as Address;
  const mainApprovalAddress = (mainStep.estimate.approvalAddress ?? mainTx.to) as Address;
  const routerMatches =
    gasSwapQuote.transactionTo.toLowerCase() === mainSwapTarget.toLowerCase() &&
    gasSwapQuote.approvalAddress.toLowerCase() === mainApprovalAddress.toLowerCase();

  const fixture = {
    note:
      "Captured by scripts/b2-capture-lifi-fixtures.ts. Real LiFi calldata for an " +
      "OP-USDC -> Mainnet-USDC reshield (Stargate/LZ) + the same-chain gas swap that " +
      "funds its native fee. Consumed by RelaySwapsB2Fork.t.sol. Stale after a few " +
      "minutes (LiFi calldata carries deadlines) — re-capture before a fork run and " +
      "pin the fork to `sourceForkBlock`.",
    capturedAt: new Date().toISOString(),
    sourceChainId: SOURCE_CHAIN_ID,
    destChainId: DEST_CHAIN_ID,
    // Re-read AFTER all quotes: the deposit-proof build above takes ~a minute, and
    // a fork pinned to the script-start block replays calldata priced 30-60 OP
    // blocks later — observed as mid-route "transfer amount exceeds balance"
    // (2026-08-31). The block right after the final quote matches its state view.
    sourceForkBlock: Number(await opPublic.getBlockNumber()),
    // The address the calldata is bound to (gas-swap ETH receiver + Stargate
    // refund address). RelaySwapsB2Fork.t.sol MUST deployCodeTo RelaySwaps here.
    executor,
    inputToken: USDC_OP,
    outputToken: USDC_MAINNET,
    withdrawAmount: WITHDRAW.toString(),
    feeAmount: FEE.toString(),
    netSwapAmount: netSwapAmount.toString(),
    provisionalTransactionValue: transactionValue.toString(),
    routerMatches,
    tool: mainStep.estimate.tool,
    mainSwap: {
      swapTarget: mainSwapTarget,
      approvalAddress: mainApprovalAddress,
      transactionData: mainTx.data as Hex,
      // The re-quoted (pass 3) LZ fee — this is what execute() forwards as msg.value
      // is capped against (routing.swapValue, from `derived.swapValue`).
      transactionValue: reQuotedValue.toString(),
      fromAmount: mainStep.estimate.fromAmount,
      toAmountMin: mainStep.estimate.toAmountMin,
    },
    gasSwap: {
      swapTarget: gasSwapQuote.transactionTo,
      approvalAddress: gasSwapQuote.approvalAddress,
      transactionData: gasSwapQuote.transactionData,
      fromAmount: gasSwapInput.toString(),
      toAmount: gasSwapQuote.toAmount,
      toAmountMin: gasSwapQuote.toAmountMin,
      targetOut: gasSwapTargetOut.toString(),
    },
    derived: {
      swapValue: swapValue.toString(),
      gasSwapMaxInput: gasSwapMaxInput.toString(),
      mainLegNet: mainNet.toString(),
    },
    // Destination-leg payload for RelaySwapsB2DestFork.t.sol (mainnet fork):
    // replay `lzCompose` on LiFi's receiver with this composeMsg and watch the
    // embedded Entrypoint.deposit land (or fail -> funds to payloadReceiver).
    dest: {
      receiver: destInfo.receiver, // LiFi ReceiverStargateV2 on mainnet (sendParams.to)
      composeMsg: destInfo.composeMsg,
      amountLD: destInfo.amountLD.toString(),
      minAmountLD: destInfo.minAmountLD.toString(),
      payloadReceiver: destInfo.payloadReceiver, // failure fallback inside the payload
      depositProofValue: main.proofValue.toString(),
      totalDepositCost: main.totalDepositCost.toString(),
      vettingFeeBPS: vettingBps.toString(),
      entrypoint: getContract(DEST_CHAIN_ID, "Entrypoint"),
      poolVault: getContract(DEST_CHAIN_ID, "PoolVault"),
      srcEid: 30110, // LayerZero eid of the Optimism source
    },
  };

  mkdirSync(resolve(OUT_PATH, ".."), { recursive: true });
  writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2));

  console.log(`\nWrote ${OUT_PATH}`);
  console.log(`  tool                : ${fixture.tool}`);
  console.log(`  LZ fee (provisional): ${formatEther(transactionValue)} ETH`);
  console.log(`  LZ fee (re-quoted)  : ${formatEther(reQuotedValue)} ETH`);
  console.log(`  swapValue (1.2x)    : ${formatEther(swapValue)} ETH`);
  console.log(`  gasSwapInput        : ${(Number(gasSwapInput) / 1e6).toFixed(4)} USDC`);
  console.log(`  gasSwapMaxInput     : ${(Number(gasSwapMaxInput) / 1e6).toFixed(4)} USDC`);
  console.log(`  router match (main==gas): ${routerMatches}`);
  if (!routerMatches) {
    console.warn(
      "  WARNING: LiFi routed the gas swap through a different router/proxy than the " +
        "main leg. The SDK's sizeB2GasSwap() asserts these are equal (RelaySwaps runs " +
        "both against one `swapTarget`/`approvalAddress`) — a persistent mismatch is a " +
        "real B2 blocker, not a fixture glitch. Re-run; escalate if it sticks.",
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
