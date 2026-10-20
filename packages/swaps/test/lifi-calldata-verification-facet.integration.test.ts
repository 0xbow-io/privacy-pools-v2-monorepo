import { describe, it, expect } from "vitest";
import { createPublicClient, http, toFunctionSelector } from "viem";
import { arbitrum, optimism, base, mainnet } from "viem/chains";
import { LiFiSwapQuoteProvider } from "@privacy-pools-v2/evm-sdk";
import type { SwapQuoteRequest } from "@privacy-pools-v2/evm-sdk";
import { tryGetContract } from "./helpers/deployment-loader.js";

// LiFi deploys its Diamond at the same address across all EVM chains via CREATE2.
const LIFI_DIAMOND_DEFAULT = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

const CHAINS = [
  {
    name: "Arbitrum",
    chain: arbitrum,
    rpcUrl: process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc",
    diamondAddress: process.env.ARB_LIFI_DIAMOND ?? LIFI_DIAMOND_DEFAULT,
  },
  {
    name: "Optimism",
    chain: optimism,
    rpcUrl: process.env.OP_RPC_URL ?? "https://mainnet.optimism.io",
    diamondAddress: process.env.OP_LIFI_DIAMOND ?? LIFI_DIAMOND_DEFAULT,
  },
  {
    name: "Base",
    chain: base,
    rpcUrl: process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
    diamondAddress: process.env.BASE_LIFI_DIAMOND ?? LIFI_DIAMOND_DEFAULT,
  },
  {
    name: "Ethereum",
    chain: mainnet,
    rpcUrl: process.env.ETH_RPC_URL ?? "https://eth.llamarpc.com",
    diamondAddress: process.env.ETH_LIFI_DIAMOND ?? LIFI_DIAMOND_DEFAULT,
  },
] as const;

// ERC-2535 DiamondLoupe — facetAddress returns the facet that owns a given selector,
// or the zero address if the selector is not registered.
const DIAMOND_LOUPE_ABI = [
  {
    name: "facetAddress",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "_functionSelector", type: "bytes4" }],
    outputs: [{ name: "facetAddress_", type: "address" }],
  },
] as const;

// CalldataVerificationFacet functions to probe. `neededForVerification` marks
// the two functions the SDK needs to validate the swap output recipient before
// proof-binding. They are asserted as required only on chains where RelaySwaps
// is deployed (per deployments-it-002.json or RELAY_SWAPS_DEPLOYMENTS_PATH).
const FUNCTIONS = [
  {
    name: "extractBridgeData",
    selector: toFunctionSelector("extractBridgeData(bytes)"),
    neededForVerification: false,
  },
  {
    name: "extractSwapData",
    selector: toFunctionSelector("extractSwapData(bytes)"),
    neededForVerification: false,
  },
  {
    name: "extractMainParameters",
    selector: toFunctionSelector("extractMainParameters(bytes)"),
    neededForVerification: true,
  },
  {
    name: "extractGenericSwapParameters",
    selector: toFunctionSelector("extractGenericSwapParameters(bytes)"),
    neededForVerification: true,
  },
  {
    name: "validateCalldata",
    selector: toFunctionSelector(
      "validateCalldata(bytes,string,address,address,uint256,uint256,bool,bool)",
    ),
    neededForVerification: false,
  },
  {
    name: "validateDestinationCalldata",
    selector: toFunctionSelector(
      "validateDestinationCalldata(bytes,bytes,bytes)",
    ),
    neededForVerification: false,
  },
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// --- Calldata-parsing tests ---

const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" as const;
const USDT_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9" as const;
const USDC_OPT = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as const;
const RELAY_SWAPS_ARB = tryGetContract(42161, "RelaySwaps")!;
// Fixed test-fixture address; not funded — we only verify field encoding.
const TEST_RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
const TEST_FALLBACK = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

const EXTRACT_GENERIC_SWAP_ABI = [
  {
    name: "extractGenericSwapParameters",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [
      { name: "sendingAssetId", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "receivingAssetId", type: "address" },
      { name: "receivingAmount", type: "uint256" },
    ],
  },
] as const;

const EXTRACT_MAIN_ABI = [
  {
    name: "extractMainParameters",
    type: "function",
    stateMutability: "pure",
    inputs: [{ name: "data", type: "bytes" }],
    outputs: [
      { name: "bridge", type: "string" },
      { name: "sendingAssetId", type: "address" },
      { name: "receiver", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "destinationChainId", type: "uint256" },
      { name: "hasSourceSwaps", type: "bool" },
      { name: "hasDestinationCall", type: "bool" },
    ],
  },
] as const;

// Suppress diagnostic output unless VERBOSE_TESTING=1 is set.
const log = process.env.VERBOSE_TESTING ? console.log : () => {};

// Shared Arbitrum client for the calldata-parsing describe block below.
const ARB_RPC_URL = process.env.ARB_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const arbClient = createPublicClient({
  chain: arbitrum,
  transport: http(ARB_RPC_URL),
});
const lifi = new LiFiSwapQuoteProvider({});

describe("LiFi CalldataVerificationFacet — on-chain availability", () => {
  for (const { name, chain, rpcUrl, diamondAddress } of CHAINS) {
    const relaySwapsAddress = tryGetContract(chain.id, "RelaySwaps");
    const relaySwapsDeployed = relaySwapsAddress !== null;

    describe(`${name} (RelaySwaps: ${relaySwapsAddress ?? "not deployed"})`, () => {
      const client = createPublicClient({ chain, transport: http(rpcUrl) });

      for (const fn of FUNCTIONS) {
        const required = fn.neededForVerification && relaySwapsDeployed;

        it(`${fn.name} [${fn.selector}] is registered on the Diamond`, async () => {
          const facetAddr = await client.readContract({
            address: diamondAddress as `0x${string}`,
            abi: DIAMOND_LOUPE_ABI,
            functionName: "facetAddress",
            args: [fn.selector],
          });

          const registered = facetAddr !== ZERO_ADDRESS;

          log(
            `  ${name} | ${fn.name}: ${registered ? `✓ facet @ ${facetAddr}` : "✗ not registered"}`,
          );

          if (required) {
            expect(
              registered,
              `${fn.name} is not registered on the LiFi Diamond on ${name}, but RelaySwaps is deployed there — update deployments-it-002.json if this chain should be excluded`,
            ).toBe(true);
          } else {
            expect(typeof registered).toBe("boolean");
          }
        });
      }
    });
  }
});

describe("LiFi CalldataVerificationFacet — real calldata parsing (Arbitrum)", () => {
  it("extractGenericSwapParameters returns TEST_RECIPIENT for a real same-chain USDC→USDT quote", async () => {
    const quote = await lifi.getSwapQuote({
      fromChainId: 42161,
      toChainId: 42161,
      fromToken: USDC_ARB,
      toToken: USDT_ARB,
      fromAddress: RELAY_SWAPS_ARB,
      toAddress: TEST_RECIPIENT,
      amount: "1000000",
      amountType: "from",
    } satisfies SwapQuoteRequest);

    log(
      `  same-chain | tool: ${quote.tool ?? "unknown"} | toAmountMin: ${quote.toAmountMin}`,
    );
    log(`  same-chain | transactionTo: ${quote.transactionTo}`);

    const [, , receiver] = await arbClient.readContract({
      address: LIFI_DIAMOND_DEFAULT as `0x${string}`,
      abi: EXTRACT_GENERIC_SWAP_ABI,
      functionName: "extractGenericSwapParameters",
      args: [quote.transactionData],
    });

    log(`  same-chain | facet decoded receiver: ${receiver}`);
    expect(receiver.toLowerCase()).toBe(TEST_RECIPIENT.toLowerCase());
  }, 30_000);

  it("extractMainParameters returns TEST_RECIPIENT for a real cross-chain USDC ARB→OPT quote", async () => {
    const quote = await lifi.getSwapQuote({
      fromChainId: 42161,
      toChainId: 10,
      fromToken: USDC_ARB,
      toToken: USDC_OPT,
      fromAddress: RELAY_SWAPS_ARB,
      toAddress: TEST_RECIPIENT,
      fallbackAddress: TEST_FALLBACK,
      amount: "1000000",
      amountType: "from",
    } satisfies SwapQuoteRequest);

    log(
      `  cross-chain | tool: ${quote.tool ?? "unknown"} | toAmountMin: ${quote.toAmountMin}`,
    );
    log(`  cross-chain | transactionTo: ${quote.transactionTo}`);

    const [bridge, , receiver] = await arbClient.readContract({
      address: LIFI_DIAMOND_DEFAULT as `0x${string}`,
      abi: EXTRACT_MAIN_ABI,
      functionName: "extractMainParameters",
      args: [quote.transactionData],
    });

    log(
      `  cross-chain | facet decoded receiver: ${receiver} | bridge: ${bridge}`,
    );
    expect(receiver.toLowerCase()).toBe(TEST_RECIPIENT.toLowerCase());
  }, 30_000);
});
