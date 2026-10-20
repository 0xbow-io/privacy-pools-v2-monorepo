/**
 * PROD cross-chain reshield: Ethereum mainnet -> BSC, against the V2 PRODUCTION
 * stack (the contracts v2.privacypools.com, the prod relayer and the prod ASP
 * serve). Written 2026-09-23 to reproduce the "BNB reshield broken on prod"
 * report with real prod infrastructure end to end.
 *
 * Default route: mainnet ppUSDC share note -> (RelaySwaps.executeUnwrapped
 * redeems to USDC) -> LiFi swap+bridge -> PPRouter.depositExactShares on BSC ->
 * ppUSDT share note. Override the endpoints with SOURCE_TOKEN / DEST_TOKEN
 * (any Entrypoint-enabled asset on that chain: a yield share, or the native
 * coin; raw USDC/USDT are NOT enabled on prod, see contracts/deployments-prod.json).
 *
 * HOW THIS DIFFERS FROM EVERY OTHER SUITE (read before running):
 *
 *  - WE HAVE NO ADMIN ACCESS. No POSTMAN_ROLE (no LocalASPTreeService), no
 *    Entrypoint config, no relayer config. The source deposit is polled on the
 *    PROD ASP (https://api-v2.0xbow.io) until its label is approved AND included
 *    in the association set; then `discoverNotes()` promotes it to ACTIVE. If
 *    the prod ASP never approves the depositor wallet, the note stays PENDING
 *    and the test times out at step 3 — nothing after that runs, and the note
 *    is recoverable via its snapshot (ragequit).
 *
 *  - PROD RELAYER by default (RELAYER_URL). Its address / RelaySwaps / yield
 *    deployments are read from its own GET /v1/details, so relayerInfo.address
 *    (which drives the default fallbackAddress + dustRecipient) is whatever the
 *    prod relayer publishes — NOT a wallet we control. Set RELAYER_URL to a
 *    local relayer started with run_prod_relayer_local.sh to get server-side
 *    logs for the same on-chain path.
 *
 *  - YIELD SHARES on both sides. Source deposit goes through
 *    `session.yieldFor(SOURCE_TOKEN).deposit` (approve + depositExactShares from
 *    the depositor wallet); the destination deposit is
 *    `prepareYieldSwapDeposit(destSession.yieldFor(DEST_TOKEN), budget)` funded
 *    by LiFi's Executor. The source session is built with
 *    `withDestinationYieldDepositTargets(destSession.yields)`.
 *
 *  - REAL FUNDS, REAL L1 GAS. DEPOSIT_AMOUNT is in the SOURCE UNDERLYING's
 *    units (USDC 6 dp for ppUSDC; wei for ETH). Minimum prod note is 10 shares
 *    (ppUSDC/ppUSDT) or 0.004 ETH / 0.02 BNB. Deposit (~600k gas) +
 *    RelaySwaps.executeUnwrapped (~1.6M gas) are on Ethereum mainnet.
 *
 * Every step logs enough to diagnose where a prod reshield breaks: the relayer
 * quote, the LiFi route (tool / value / calldata size), the prepared quote
 * (dumped to DIAG_DIR), the relay result and the LiFi status trail. A failure
 * in `relayReshieldCrosschain` is rethrown with the full error text after
 * being written to DIAG_DIR too.
 *
 * Recovery follows test/integration_test_standards.org: source snapshot right
 * after the deposit confirms, marked recovered once the reshield spends it;
 * destination snapshot once the bridge lands, left UNRECOVERED.
 *
 * Reuse: REUSE_COMMITMENT=<commitment> skips the deposit + ASP wait and spends
 * that ACTIVE note (it must be discoverable by the source session).
 *
 * Env (see run_prod_eth_bsc_reshield.sh):
 *   PRIVATE_KEY               depositor / session owner (needs underlying + ETH on mainnet, BNB on BSC)
 *   ETH_RPC_URL, BSC_RPC_URL  paid RPCs
 *   RELAYER_URL               default: prod relayer
 *   PROD_ASP_URL              default: https://api-v2.0xbow.io
 *   SOURCE_TOKEN / DEST_TOKEN default: ppUSDC (mainnet) / ppUSDT (BSC)
 *   DEPOSIT_AMOUNT            default: 12 USDC (12000000)
 *   REUSE_COMMITMENT, RESHIELD_SLIPPAGE, RESHIELD_PREPARE_ATTEMPTS, ASP timeouts
 *   DRY_RUN=1                 quote + proofs only, no deposit / relay (free diagnostic)
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
import { mainnet, bsc } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

import {
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
  NoteComputationService,
  PoseidonHashService,
  ViemRPCInteractor,
  APP_IDENTIFIER,
  CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
  prepareYieldSwapDeposit,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  Hash,
  Hex,
  ILogger,
  EvmPoolSession,
  PendingNote,
  PrepareDepositResult,
  RelayerInfo,
  YieldDeployment,
} from "@privacy-pools-v2/evm-sdk";

import {
  saveRecoverySnapshot,
  markAsRecovered,
} from "./helpers/recovery-snapshot.js";
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import { getContract, getDeployBlock } from "./helpers/deployment-loader.js";

// Point getContract()/getDeployBlock() at the PROD registry for this module
// only (the loader reads the env var lazily per call; the it-002 default the
// rest of the suite relies on is untouched).
process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-prod.json",
);

// --- Chains ---
const ETH_CHAIN_ID = 1;
const BSC_CHAIN_ID = 56;

// --- Contract addresses (deployments-prod.json; verified on-chain 2026-09-23) ---
const ETH_POOL_ADDRESS = getContract(ETH_CHAIN_ID, "PoolVault");
const ETH_ENTRYPOINT_ADDRESS = getContract(ETH_CHAIN_ID, "Entrypoint");
const ETH_KEYSTORE_ADDRESS = getContract(ETH_CHAIN_ID, "Keystore");
const ETH_ASP_REGISTRY_ADDRESS = getContract(ETH_CHAIN_ID, "ASPRegistry");
const ETH_RELAY_SWAPS_ADDRESS = getContract(ETH_CHAIN_ID, "RelaySwaps");

const BSC_POOL_ADDRESS = getContract(BSC_CHAIN_ID, "PoolVault");
const BSC_ENTRYPOINT_ADDRESS = getContract(BSC_CHAIN_ID, "Entrypoint");
const BSC_KEYSTORE_ADDRESS = getContract(BSC_CHAIN_ID, "Keystore");
const BSC_ASP_REGISTRY_ADDRESS = getContract(BSC_CHAIN_ID, "ASPRegistry");
const BSC_RELAY_SWAPS_ADDRESS = getContract(BSC_CHAIN_ID, "RelaySwaps");

const ETH_DEPLOYMENT_BLOCK = getDeployBlock(ETH_CHAIN_ID);
const BSC_DEPLOYMENT_BLOCK = getDeployBlock(BSC_CHAIN_ID);
if (!ETH_DEPLOYMENT_BLOCK || !BSC_DEPLOYMENT_BLOCK) {
  throw new Error(
    "Missing deployBlock for chain 1 or chain 56 in deployments-prod.json",
  );
}

// The SDK's native sentinel (`NATIVE_ASSET_ADDRESS`) is not re-exported from the
// package root at runtime, so it is spelled out here.
const NATIVE_ASSET_ADDRESS =
  "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;

// --- Prod yield shares (Entrypoint-enabled; see deployments-prod.json) ---
const PP_USDC_ETH = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
const PP_USDT_BSC = "0x6C17bE9c864254CA4b2d36223f31AdE94B4d64c2" as Address;

// --- Env ---
const ETH_RPC = process.env.ETH_RPC_URL ?? process.env.RPC_URL_1;
const BSC_RPC = process.env.BSC_RPC_URL ?? process.env.RPC_URL_56;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RELAYER_BASE_URL =
  process.env.RELAYER_URL ??
  "https://relayer-v2-prod-149184580131.us-east1.run.app";
const ASP_URL = process.env.PROD_ASP_URL ?? "https://api-v2.0xbow.io";
const SOURCE_TOKEN = (process.env.SOURCE_TOKEN ?? PP_USDC_ETH) as Address;
const DEST_TOKEN = (process.env.DEST_TOKEN ?? PP_USDT_BSC) as Address;
// Source deposit in the source UNDERLYING's units (USDC 6 dp -> 12 USDC).
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "12000000";
const REUSE_COMMITMENT = process.env.REUSE_COMMITMENT as Hash | undefined;
// DRY_RUN=1: no deposit, no relay. Runs the prod relayer fee quote, the LiFi
// contractCalls quote, the BSC deposit proof and prepareReshieldCrosschainQuote
// for a hypothetical note of DEPOSIT_AMOUNT, then stops. Free (no tx).
const DRY_RUN = process.env.DRY_RUN === "1";
const RESHIELD_SLIPPAGE = Number(process.env.RESHIELD_SLIPPAGE ?? "0.05");
// Rate headroom for the destination share sizing (see the NOTE at the
// prepareYieldSwapDeposit call). Default: the SDK's cross-chain constant (500 ppm).
const DEST_HEADROOM_PPM = BigInt(
  process.env.DEST_HEADROOM_PPM ??
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM.toString(),
);
// LiFi's "fly" tool embeds a deadline shorter than proof-gen + relay latency —
// guaranteed ExpiredTransaction() revert (integration_test_standards.org §4).
const DENY_EXCHANGES = ["fly"];

const ASP_LABEL_APPROVAL_TIMEOUT_MS = Number(
  process.env.PROD_ASP_LABEL_APPROVAL_TIMEOUT_MS ?? 30 * 60_000,
);
const ASP_TREE_INCLUSION_TIMEOUT_MS = Number(
  process.env.PROD_ASP_TREE_INCLUSION_TIMEOUT_MS ?? 90 * 60_000,
);
const ASP_POLL_INTERVAL_MS = Number(
  process.env.PROD_ASP_POLL_INTERVAL_MS ?? 20_000,
);
const DEST_ASP_WAIT_MS = Number(process.env.DEST_ASP_WAIT_MS ?? 5 * 60_000);
const BRIDGE_WAIT_MS = Number(process.env.BRIDGE_WAIT_MS ?? 20 * 60_000);

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const ETH_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-prod-eth-bsc-reshield-eth-notes",
);
const BSC_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.mainnet-prod-eth-bsc-reshield-bsc-notes",
);
// Prod snapshots get their own dirs: the recovery sweep must never mix prod
// notes with the test-stack ones, and ragequit on prod is a real-money action.
const ETH_RECOVERY_SNAPSHOT_DIR = resolve(
  __dirname,
  "../.mainnet-prod-eth-bsc-reshield-eth-deposit-notes",
);
const BSC_RECOVERY_SNAPSHOT_DIR = resolve(
  __dirname,
  "../.mainnet-prod-eth-bsc-reshield-bsc-deposit-notes",
);
const DIAG_DIR = resolve(__dirname, "../.mainnet-prod-eth-bsc-reshield-diag");
const STATE_FILE = resolve(
  __dirname,
  "../.mainnet-prod-eth-bsc-reshield-state.json",
);

const ERC20_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

// --- Relayer /v1/details (the prod relayer publishes everything we need) ---
type RelayerDetailsYield = {
  ppToken: Address;
  underlying: Address;
  router: Address;
  zap?: Address;
  ppDecimals: number;
  underlyingDecimals: number;
  underlyingSymbol: string;
};
type RelayerDetailsChain = {
  id: number;
  name: string;
  contracts: { entrypoint: Address; poolVault: Address; relaySwaps?: Address };
  relayerAddress: Address;
  processors?: Address[];
  yield?: RelayerDetailsYield[];
};
type RelayerDetails = { version: string; chains: RelayerDetailsChain[] };

async function fetchRelayerDetails(): Promise<RelayerDetails> {
  const res = await fetch(`${RELAYER_BASE_URL}/v1/details`);
  if (!res.ok) {
    throw new Error(
      `GET ${RELAYER_BASE_URL}/v1/details -> ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as RelayerDetails;
}

function yieldDeploymentsOf(chain: RelayerDetailsChain): YieldDeployment[] {
  return (chain.yield ?? []).map((y) => ({
    ppRouter: y.router,
    zap: y.zap,
    ppUSDC: y.ppToken,
    ppUSDCDecimals: y.ppDecimals,
    underlying: y.underlying,
    underlyingDecimals: y.underlyingDecimals,
    underlyingSymbol: y.underlyingSymbol,
  }));
}

// --- EIP-712 typed data for secret derivation (same as every other suite) ---
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

async function pollUntil(
  check: () => Promise<boolean>,
  timeoutMs: number,
  pollIntervalMs: number,
  timeoutMessage: string,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`${timeoutMessage} within ${timeoutMs / 1000}s`);
}

async function fetchLabelStatus(labelHashDecimal: string): Promise<string> {
  const res = await fetch(`${ASP_URL}/labels/${labelHashDecimal}/status`);
  if (!res.ok) return `(http ${res.status})`;
  const body = (await res.json()) as { status?: string };
  return body.status ?? `(no status: ${JSON.stringify(body).slice(0, 200)})`;
}

async function isLeafInAssociationSet(
  chainId: number,
  entrypoint: Address,
  labelHashDecimal: string,
): Promise<{ included: boolean; total: number }> {
  const res = await fetch(
    `${ASP_URL}/association-set/leaves?chainId=${chainId}&entrypoint=${entrypoint}`,
  );
  if (!res.ok) return { included: false, total: -1 };
  const body = (await res.json()) as { leaves?: string[] };
  const leaves = body.leaves ?? [];
  return { included: leaves.includes(labelHashDecimal), total: leaves.length };
}

const hexBig = (v: bigint): Hex => `0x${v.toString(16)}` as Hex;
const isNative = (t: Address) =>
  t.toLowerCase() === NATIVE_ASSET_ADDRESS.toLowerCase();

/** JSON.stringify that survives bigints and trims giant calldata for the diag dump. */
function diagJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (typeof v === "string" && v.startsWith("0x") && v.length > 4000) {
        return `${v.slice(0, 200)}...(${v.length} chars)`;
      }
      return v;
    },
    2,
  );
}

function writeDiag(name: string, value: unknown): string {
  mkdirSync(DIAG_DIR, { recursive: true });
  const path = resolve(DIAG_DIR, `${Date.now()}-${name}.json`);
  // dest-deposit dumps keep the full calldata (needed to replay the LiFi request).
  const raw =
    name.startsWith("dest-deposit") || name.startsWith("prepared-raw");
  writeFileSync(
    path,
    typeof value === "string"
      ? value
      : raw
        ? JSON.stringify(
            value,
            (_k, v) => (typeof v === "bigint" ? v.toString() : v),
            2,
          )
        : diagJson(value),
  );
  return path;
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

describe.skipIf(!PRIVATE_KEY || !ETH_RPC || !BSC_RPC || !hasCircuits)(
  "PROD Cross-Chain Reshield: Ethereum mainnet -> BSC (V2 prod stack, prod ASP, prod relayer)",
  () => {
    let ethPublicClient: ReturnType<typeof createPublicClient>;
    let ethWalletClient: ReturnType<typeof createWalletClient>;
    let bscPublicClient: ReturnType<typeof createPublicClient>;
    let bscWalletClient: ReturnType<typeof createWalletClient>;
    let account: ReturnType<typeof privateKeyToAccount>;

    let sourceSession: EvmPoolSession;
    let destSession: EvmPoolSession;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let relayerDetails: RelayerDetails;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;
    let noteComputationService: NoteComputationService;

    // Resolved per SOURCE_TOKEN / DEST_TOKEN in beforeAll.
    let sourceYield: YieldDeployment | undefined;
    let destYield: YieldDeployment | undefined;
    let sourceDecimals: number;
    let destDecimals: number;

    beforeAll(async () => {
      account = privateKeyToAccount(PRIVATE_KEY! as `0x${string}`);
      console.log("Depositor / session owner:", account.address);
      console.log("Relayer:", RELAYER_BASE_URL);
      console.log("ASP:", ASP_URL);

      ethPublicClient = createPublicClient({
        chain: mainnet,
        transport: http(ETH_RPC),
      });
      ethWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(ETH_RPC),
      });
      bscPublicClient = createPublicClient({
        chain: bsc,
        transport: http(BSC_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;
      bscWalletClient = createWalletClient({
        account,
        chain: bsc,
        transport: http(BSC_RPC),
      });

      // --- Relayer self-description: address, RelaySwaps, yield deployments ---
      relayerDetails = await fetchRelayerDetails();
      const ethChain = relayerDetails.chains.find((c) => c.id === ETH_CHAIN_ID);
      const bscChain = relayerDetails.chains.find((c) => c.id === BSC_CHAIN_ID);
      if (!ethChain || !bscChain) {
        throw new Error(
          `Relayer ${RELAYER_BASE_URL} does not serve chains 1 + 56: ${relayerDetails.chains.map((c) => c.id).join(",")}`,
        );
      }
      writeDiag("relayer-details", relayerDetails);
      console.log(
        `Relayer chain-1: address ${ethChain.relayerAddress}, RelaySwaps ${ethChain.contracts.relaySwaps}, ` +
          `yield [${(ethChain.yield ?? []).map((y) => y.underlyingSymbol).join(", ")}]`,
      );
      console.log(
        `Relayer chain-56: address ${bscChain.relayerAddress}, RelaySwaps ${bscChain.contracts.relaySwaps}, ` +
          `yield [${(bscChain.yield ?? []).map((y) => y.underlyingSymbol).join(", ")}]`,
      );
      // The relayer must execute through the RelaySwaps the registry (and the
      // proof) binds — a mismatch is PoolVault_ProofContextMismatch at relay time.
      expect(ethChain.contracts.relaySwaps?.toLowerCase()).toBe(
        ETH_RELAY_SWAPS_ADDRESS.toLowerCase(),
      );
      expect(ethChain.contracts.poolVault.toLowerCase()).toBe(
        ETH_POOL_ADDRESS.toLowerCase(),
      );
      expect(bscChain.contracts.poolVault.toLowerCase()).toBe(
        BSC_POOL_ADDRESS.toLowerCase(),
      );

      const ethYields = yieldDeploymentsOf(ethChain);
      const bscYields = yieldDeploymentsOf(bscChain);
      sourceYield = ethYields.find(
        (d) => d.ppUSDC.toLowerCase() === SOURCE_TOKEN.toLowerCase(),
      );
      destYield = bscYields.find(
        (d) => d.ppUSDC.toLowerCase() === DEST_TOKEN.toLowerCase(),
      );
      if (!sourceYield && !isNative(SOURCE_TOKEN)) {
        throw new Error(
          `SOURCE_TOKEN ${SOURCE_TOKEN} is neither a relayer-published yield share nor the native coin; ` +
            `prod only enables shares + native (deployments-prod.json).`,
        );
      }
      if (!destYield && !isNative(DEST_TOKEN)) {
        throw new Error(
          `DEST_TOKEN ${DEST_TOKEN} is neither a relayer-published yield share nor the native coin; ` +
            `prod BSC only enables ppUSDT + BNB (deployments-prod.json).`,
        );
      }
      sourceDecimals = sourceYield?.ppUSDCDecimals ?? 18;
      destDecimals = destYield?.ppUSDCDecimals ?? 18;
      console.log(
        `Route: ${sourceYield ? `${sourceYield.underlyingSymbol}->pp share ${SOURCE_TOKEN}` : "native ETH"} (mainnet) ` +
          `-> ${destYield ? `pp share ${DEST_TOKEN} (funded in ${destYield.underlyingSymbol})` : "native BNB"} (BSC)`,
      );

      // --- Pre-flight balances: fail fast with a clear message ---
      const depositAmount = BigInt(DEPOSIT_AMOUNT);
      const [ethBal, bnbBal] = await Promise.all([
        ethPublicClient.getBalance({ address: account.address }),
        bscPublicClient.getBalance({ address: account.address }),
      ]);
      const underlyingBal = sourceYield
        ? await ethPublicClient.readContract({
            address: sourceYield.underlying,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [account.address],
          })
        : ethBal;
      const underlyingDecimals = sourceYield?.underlyingDecimals ?? 18;
      const underlyingSymbol = sourceYield?.underlyingSymbol ?? "ETH";
      console.log(
        `Depositor mainnet: ${formatUnits(ethBal, 18)} ETH, ${formatUnits(underlyingBal, underlyingDecimals)} ${underlyingSymbol}; ` +
          `BSC: ${formatUnits(bnbBal, 18)} BNB`,
      );
      if (!REUSE_COMMITMENT && !DRY_RUN && underlyingBal < depositAmount) {
        throw new Error(
          `Depositor ${account.address} holds ${formatUnits(underlyingBal, underlyingDecimals)} ${underlyingSymbol} on mainnet, ` +
            `needs ${formatUnits(depositAmount, underlyingDecimals)} (DEPOSIT_AMOUNT).`,
        );
      }
      if (ethBal === 0n && !DRY_RUN) {
        throw new Error(
          `Depositor holds 0 ETH on mainnet — cannot pay deposit gas.`,
        );
      }

      persistence = new TestStatePersistence(STATE_FILE);
      const savedState = persistence.load();
      const protocolKeys =
        savedState?.protocolKeys ??
        (await deriveProtocolKeys(account, ethWalletClient));
      state = savedState ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);
      console.log(
        savedState?.protocolKeys
          ? "Loaded protocol keys from state file"
          : "Derived fresh protocol keys (saved to state file)",
      );

      const hashService = await PoseidonHashService.create();
      noteComputationService = new NoteComputationService({
        hashService,
        cryptoService: new CryptoService(),
      });

      relayerInfo = {
        url: RELAYER_BASE_URL,
        name: "prod",
        chainId: ETH_CHAIN_ID,
        chainType: "evm",
        status: "active" as const,
        address: ethChain.relayerAddress,
        processorAddress: ETH_RELAY_SWAPS_ADDRESS,
      };

      lifiProvider = new LiFiSwapQuoteProvider({});

      // --- Destination session (BSC prod) FIRST: its `yields` become the
      // source session's destinationYieldDepositTargets. ---
      destSession = (await PoolSessionBuilder.fromConfig({
        chainId: BSC_CHAIN_ID,
        rpcUrl: BSC_RPC!,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: BSC_POOL_ADDRESS,
          entrypointAddress: BSC_ENTRYPOINT_ADDRESS,
          keystoreAddress: BSC_KEYSTORE_ADDRESS,
          aspRegistryAddress: BSC_ASP_REGISTRY_ADDRESS,
          relaySwapsAddress: BSC_RELAY_SWAPS_ADDRESS,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        // Unused by prepareDeposit()/prepareYieldDeposit(); satisfies builder validation only.
        relayers: [
          {
            url: RELAYER_BASE_URL,
            name: "prod",
            chainId: BSC_CHAIN_ID,
            chainType: "evm",
            status: "active" as const,
            address: bscChain.relayerAddress,
            processorAddress: BSC_RELAY_SWAPS_ADDRESS,
          },
        ],
        persistentStorage: { type: "file", dirPath: BSC_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: bscWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: BSC_DEPLOYMENT_BLOCK,
      } as any)
        .withYieldDeployments(bscYields)
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: bscPublicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(BSC_DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create()) as EvmPoolSession;

      // --- Source session (mainnet prod), prod ASP, cross-chain into BSC ---
      sourceSession = (await PoolSessionBuilder.fromConfig({
        chainId: ETH_CHAIN_ID,
        rpcUrl: ETH_RPC!,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: ETH_POOL_ADDRESS,
          entrypointAddress: ETH_ENTRYPOINT_ADDRESS,
          keystoreAddress: ETH_KEYSTORE_ADDRESS,
          aspRegistryAddress: ETH_ASP_REGISTRY_ADDRESS,
          relaySwapsAddress: ETH_RELAY_SWAPS_ADDRESS,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: ETH_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: ethWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: ETH_DEPLOYMENT_BLOCK,
        destinationChainId: BSC_CHAIN_ID,
        destinationRpcUrl: BSC_RPC!,
        destinationDeployment: {
          poolAddress: BSC_POOL_ADDRESS,
          entrypointAddress: BSC_ENTRYPOINT_ADDRESS,
          keystoreAddress: BSC_KEYSTORE_ADDRESS,
          aspRegistryAddress: BSC_ASP_REGISTRY_ADDRESS,
          relaySwapsAddress: BSC_RELAY_SWAPS_ADDRESS,
        },
      } as any)
        .withYieldDeployments(ethYields)
        .withDestinationYieldDepositTargets([...destSession.yields])
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .withRpcInteractor(
          new ViemRPCInteractor(
            {
              publicClient: ethPublicClient as any,
              chunkSize: 2_000_000n,
              minFromBlock: BigInt(ETH_DEPLOYMENT_BLOCK),
            },
            { logger: consoleLogger },
          ),
        )
        .create()) as EvmPoolSession;

      if (sourceYield)
        expect(sourceSession.yieldFor(SOURCE_TOKEN)).toBeDefined();
      if (destYield) expect(destSession.yieldFor(DEST_TOKEN)).toBeDefined();
      console.log(
        "Source (mainnet prod) and destination (BSC prod) sessions ready",
      );
    }, 300_000);

    it(
      "full flow: keystore -> deposit (mainnet prod) -> prod ASP approval -> reshield -> lands on BSC prod",
      async () => {
        const depositAmount = BigInt(DEPOSIT_AMOUNT);
        let inputCommitment: Hash;
        let inputNoteValue: bigint;
        let snapshotPath: string | undefined;

        if (DRY_RUN) {
          // === 0. Hypothetical note: what a DEPOSIT_AMOUNT deposit would mint ===
          inputCommitment = `0x${"0".repeat(64)}` as Hash;
          inputNoteValue = sourceYield
            ? await sourceSession
                .yieldFor(SOURCE_TOKEN)!
                .deposit.sharesForUnderlying(depositAmount)
            : depositAmount;
          console.log(
            `DRY_RUN: quoting a reshield of ${formatUnits(inputNoteValue, sourceDecimals)} ${SOURCE_TOKEN} — no deposit, no relay.`,
          );
        } else if (REUSE_COMMITMENT) {
          // === 1-alt. Spend an already-ACTIVE note from a previous run ===
          console.log(
            "REUSE_COMMITMENT set — skipping deposit, syncing notes...",
          );
          const notes = await sourceSession.discoverNotes({});
          const note = notes.find(
            (n) =>
              n.commitment.toLowerCase() === REUSE_COMMITMENT.toLowerCase(),
          );
          if (!note) {
            throw new Error(
              `REUSE_COMMITMENT ${REUSE_COMMITMENT} not found among ${notes.length} discovered notes`,
            );
          }
          console.log(
            `Reusing note ${note.commitment}: status ${note.status}, value ${formatUnits(BigInt(note.value), sourceDecimals)}, token ${note.tokenId}`,
          );
          expect(note.tokenId.toLowerCase()).toBe(SOURCE_TOKEN.toLowerCase());
          inputCommitment = note.commitment as Hash;
          inputNoteValue = BigInt(note.value);
        } else {
          // === 1. Register in the mainnet keystore (idempotent) ===
          if (await sourceSession.isKeystoreRegistered()) {
            console.log("Already registered in mainnet keystore, skipping");
          } else {
            console.log("Registering in mainnet keystore...");
            const receipts = await sourceSession.registerKeystore();
            expect(receipts.length).toBeGreaterThan(0);
            expect(receipts.every((r) => r.status)).toBe(true);
            state.keystoreRegistered = true;
            persistence.save(state);
            console.log("Mainnet keystore registration complete");
          }

          // === 2. Deposit on the mainnet prod pool: a yield share through its
          // PPRouter, or the native coin straight through the Entrypoint. ===
          let pendingNote: PendingNote;
          let depositTxHash: Hex;
          if (sourceYield) {
            const y = sourceSession.yieldFor(SOURCE_TOKEN)!;
            const shares = await y.deposit.sharesForUnderlying(depositAmount);
            console.log(
              `\nDepositing ${formatUnits(depositAmount, sourceYield.underlyingDecimals)} ${sourceYield.underlyingSymbol} ` +
                `as ${formatUnits(shares, sourceYield.ppUSDCDecimals)} ${SOURCE_TOKEN} shares via PPRouter ${sourceYield.ppRouter}...`,
            );
            const prepared = await y.deposit.prepareYieldDeposit({
              value: shares,
            });
            pendingNote = prepared.pendingNote;
            console.log(
              `Yield deposit prepared: ${shares} shares for <= ${formatUnits(prepared.maxUnderlyingIn, sourceYield.underlyingDecimals)} ${sourceYield.underlyingSymbol}; ` +
                `${prepared.approvalTxs.length} approval tx(s). Commitment: ${pendingNote.commitment}`,
            );
            mkdirSync(ETH_NOTE_STORAGE_DIR, { recursive: true });
            writeFileSync(
              resolve(ETH_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
              JSON.stringify(pendingNote, null, 2),
            );
            const txs = [
              ...prepared.approvalTxs.map(
                (tx, i) => [`approvalTx[${i}]`, tx] as const,
              ),
              ["depositTx", prepared.depositTx] as const,
            ];
            depositTxHash = "0x" as Hex;
            for (const [label, tx] of txs) {
              const hash = await ethWalletClient.sendTransaction({
                to: tx.to,
                data: tx.data,
                value: BigInt(tx.value),
                account,
                chain: mainnet,
              });
              const receipt = await ethPublicClient.waitForTransactionReceipt({
                hash,
              });
              console.log(`${label}: ${hash} -> ${receipt.status}`);
              expect(
                receipt.status,
                `${label} reverted on-chain (tx ${hash})`,
              ).toBe("success");
              depositTxHash = hash;
            }
          } else {
            console.log(
              `\nDepositing ${formatUnits(depositAmount, 18)} ETH on mainnet prod...`,
            );
            const depositResult = await sourceSession.prepareDeposit({
              tokenId: NATIVE_ASSET_ADDRESS,
              value: hexBig(depositAmount),
            });
            pendingNote = depositResult.pendingNote;
            mkdirSync(ETH_NOTE_STORAGE_DIR, { recursive: true });
            writeFileSync(
              resolve(ETH_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
              JSON.stringify(pendingNote, null, 2),
            );
            const depositReceipt =
              await sourceSession.executeDeposit(depositResult);
            expect(depositReceipt.status).toBe(true);
            depositTxHash = depositReceipt.txHash as Hex;
            console.log("Mainnet deposit tx:", depositTxHash);
          }
          inputCommitment = pendingNote.commitment as Hash;
          inputNoteValue = BigInt(pendingNote.value);

          // === 2.5. Recovery snapshot — before anything else can fail ===
          const depositTx = await ethPublicClient.getTransaction({
            hash: depositTxHash,
          });
          snapshotPath = await saveRecoverySnapshot({
            publicClient: ethPublicClient as any,
            chainId: ETH_CHAIN_ID,
            depositTxHash,
            depositBlock: depositTx.blockNumber!,
            deploymentBlock: ETH_DEPLOYMENT_BLOCK,
            ownerAddress: account.address as Address,
            contracts: {
              pool: ETH_POOL_ADDRESS,
              entrypoint: ETH_ENTRYPOINT_ADDRESS,
              keystore: ETH_KEYSTORE_ADDRESS,
              aspRegistry: ETH_ASP_REGISTRY_ADDRESS,
            },
            protocolKeys: state.protocolKeys,
            note: pendingNote,
            storageDir: ETH_RECOVERY_SNAPSHOT_DIR,
          });
          console.log("Mainnet recovery snapshot saved:", snapshotPath);

          // === 3. PROD ASP: label approved, then included in the association
          // set. We cannot push roots ourselves — this is the real gate. ===
          const labelHash = noteComputationService.computeLabelHash(
            pendingNote.label as Hash,
          );
          const labelHashDecimal = BigInt(labelHash).toString();
          console.log(
            `\nWaiting for the PROD ASP (${ASP_URL}) to approve label ${pendingNote.label} (hash ${labelHashDecimal})...`,
          );
          await pollUntil(
            async () => {
              const status = await fetchLabelStatus(labelHashDecimal);
              console.log("  label status:", status);
              return status === "approved";
            },
            ASP_LABEL_APPROVAL_TIMEOUT_MS,
            ASP_POLL_INTERVAL_MS,
            `Label ${pendingNote.label} was not approved by the prod ASP (depositor ${account.address} may not be vetted; note recoverable via ${snapshotPath})`,
          );
          console.log(
            "Label approved. Waiting for association-set inclusion on chain 1...",
          );
          await pollUntil(
            async () => {
              const { included, total } = await isLeafInAssociationSet(
                ETH_CHAIN_ID,
                ETH_ENTRYPOINT_ADDRESS,
                labelHashDecimal,
              );
              console.log(
                `  leaf in association set: ${included} (${total} leaves)`,
              );
              return included;
            },
            ASP_TREE_INCLUSION_TIMEOUT_MS,
            ASP_POLL_INTERVAL_MS,
            `Label hash ${labelHash} never appeared in the chain-1 association set`,
          );

          // === 3.5. Sync notes to promote PENDING -> ACTIVE ===
          const fromBlock = hexBig(depositTx.blockNumber! - 1n);
          const notes = await sourceSession.discoverNotes({ fromBlock });
          const mine = notes.find(
            (n) => n.commitment.toLowerCase() === inputCommitment.toLowerCase(),
          );
          console.log(
            `Notes synced — source note status: ${mine?.status ?? "(not discovered)"}`,
          );
        }

        // === 4. Register in the BSC keystore (idempotent) so the landed note is
        // spendable the moment it arrives. Needs BNB on the depositor. ===
        if (DRY_RUN) {
          console.log("DRY_RUN: skipping BSC keystore registration");
        } else if (await destSession.isKeystoreRegistered()) {
          console.log("Already registered in BSC keystore, skipping");
        } else {
          console.log("Registering in BSC keystore...");
          const destReceipts = await destSession.registerKeystore();
          expect(destReceipts.length).toBeGreaterThan(0);
          expect(destReceipts.every((r) => r.status)).toBe(true);
          console.log("BSC keystore registration complete");
        }

        // === 5. Estimate -> destination deposit proof -> prepare. Retried on
        // assertLifiBudget jitter (relayer fee moves between the preliminary and
        // committed quotes; the SDK's own remedy is "retry with fresh quotes"). ===
        const reshieldAmount = inputNoteValue;
        console.log(
          `\n=== PROD CROSS-CHAIN RESHIELD: ${formatUnits(reshieldAmount, sourceDecimals)} of ${SOURCE_TOKEN} (mainnet) -> ${DEST_TOKEN} (BSC) ===`,
        );
        const RESHIELD_PREPARE_ATTEMPTS = Number(
          process.env.RESHIELD_PREPARE_ATTEMPTS ?? "12",
        );
        let lifiBudgetTrips = 0;
        let sizingRaceTrips = 0;
        let lifiTransientTrips = 0;
        let unaffordableTrips = 0;
        let prepared:
          | Awaited<
              ReturnType<typeof sourceSession.prepareReshieldCrosschainQuote>
            >
          | undefined;
        let destDepositResult: PrepareDepositResult | undefined;
        for (let attempt = 1; attempt <= RESHIELD_PREPARE_ATTEMPTS; attempt++) {
          try {
            const estimate =
              await sourceSession.estimateReshieldCrosschainAmount({
                relayerInfo,
                amount: hexBig(reshieldAmount),
                tokenId: SOURCE_TOKEN,
                outputToken: DEST_TOKEN,
                toChainId: BSC_CHAIN_ID,
                toChainType: "evm",
                slippage: RESHIELD_SLIPPAGE,
                denyExchanges: DENY_EXCHANGES,
              });
            writeDiag(`estimate-attempt${attempt}`, estimate);
            console.log(
              `Estimate: relayer fee ${formatUnits(BigInt(estimate.feeAmount), sourceDecimals)} (source units), ` +
                `swap input ${estimate.swapInputToken} ${estimate.netSwapAmount}, ` +
                `LiFi est. out ${estimate.estimatedOutput} / min ${estimate.estimatedMinOutput}, ` +
                `note ${formatUnits(BigInt(estimate.noteValue), destDecimals)} ${destYield ? "shares" : "BNB"}, ` +
                `total deposit cost (funding units) ${estimate.totalDepositCost}`,
            );

            // NOTE (2026-09-23 dry run): pool-session.md prescribes
            // `prepareYieldSwapDeposit(target, BigInt(estimate.totalDepositCost))`,
            // whose default headroom is DEPOSIT_RATE_HEADROOM_PPM = 1 ppm — while
            // the estimate above sized `noteValue` with the 500 ppm cross-chain
            // headroom. With 1 ppm the BSC sizing tripped `InvalidYieldAmount`
            // ("router quote exceeds the spendable budget") on the second quote,
            // and a deposit that survives sizing lands minutes later with a cap
            // only 1 ppm above the router's price at sizing time (Aave accrues
            // ~1 ppm / 10-15 min) -> PPRouter_SlippageExceeded on BSC -> LiFi
            // fallback -> raw USDT to the relayer. Pass the cross-chain headroom
            // explicitly, mirroring the estimate. Override via DEST_HEADROOM_PPM.
            destDepositResult = destYield
              ? await prepareYieldSwapDeposit(
                  destSession.yieldFor(DEST_TOKEN)!,
                  BigInt(estimate.totalDepositCost),
                  DEST_HEADROOM_PPM,
                )
              : await destSession.prepareDeposit({
                  tokenId: NATIVE_ASSET_ADDRESS,
                  value: estimate.noteValue,
                });
            writeDiag(`dest-deposit-attempt${attempt}`, {
              to: destDepositResult.depositTx.to,
              msgValue: destDepositResult.depositTx.value,
              callData: destDepositResult.depositTx.data,
              pendingNote: destDepositResult.pendingNote,
              totalDepositCost: estimate.totalDepositCost,
              netSwapAmount: estimate.netSwapAmount,
              swapInputToken: estimate.swapInputToken,
            });
            console.log(
              `BSC deposit prepared: to ${destDepositResult.depositTx.to}, value ${destDepositResult.depositTx.value}, ` +
                `note ${formatUnits(BigInt(destDepositResult.pendingNote.value), destDecimals)}, commitment ${destDepositResult.pendingNote.commitment}`,
            );
            // First line of defense for the BSC note's secrets — written before
            // anything irreversible happens.
            mkdirSync(BSC_NOTE_STORAGE_DIR, { recursive: true });
            writeFileSync(
              resolve(BSC_NOTE_STORAGE_DIR, `bsc-pending-${Date.now()}.json`),
              JSON.stringify(destDepositResult.pendingNote, null, 2),
            );

            prepared = await sourceSession.prepareReshieldCrosschainQuote({
              relayerInfo,
              amount: hexBig(reshieldAmount),
              tokenId: SOURCE_TOKEN,
              outputToken: DEST_TOKEN,
              toChainId: BSC_CHAIN_ID,
              toChainType: "evm",
              depositResult: destDepositResult,
              totalDepositCost: estimate.totalDepositCost,
              slippage: RESHIELD_SLIPPAGE,
              denyExchanges: DENY_EXCHANGES,
            });
            console.log(
              `prepareReshieldCrosschainQuote succeeded on attempt ${attempt} (sizing-race trips: ${sizingRaceTrips}, LiFi-budget trips: ${lifiBudgetTrips}, LiFi-422 trips: ${lifiTransientTrips}, unaffordable trips: ${unaffordableTrips}).`,
            );
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            writeDiag(`prepare-error-attempt${attempt}`, {
              message: msg,
              stack: e instanceof Error ? e.stack : undefined,
              error: e,
            });
            // Two known transient trips, both of which the SDK itself answers with
            // "retry with fresh quotes":
            //  - assertLifiBudget: the relayer fee moved between the preliminary
            //    and committed quotes.
            //  - InvalidYieldAmount "…moved while sizing, size again": the
            //    destination share sizing reads previewDeposit and the router
            //    re-quote on different blocks; on BSC (~0.75 s blocks, 18-dec
            //    USDT) the Aave accrual between those reads exceeds the check's
            //    zero tolerance almost every time (reproduced 6/6 with raw
            //    calls, 2026-09-23). Counted separately so the summary shows how
            //    often each one fires.
            const lifiBudgetTrip =
              /Invalid transact params/.test(msg) &&
              /LiFi needs .* input but only .* available after fee/.test(msg);
            const sizingRaceTrip =
              /Invalid yield amount/.test(msg) &&
              /moved while sizing/.test(msg);
            //  - LiFi 422 "Market conditions have changed, please request a new
            //    route": LiFi's own transient refusal of a contractCalls quote
            //    (seen once on 2026-09-23; the identical request succeeded seconds
            //    later through the same @lifi/sdk client).
            const lifiTransientTrip =
              /422/.test(msg) && /Market conditions have changed/.test(msg);
            //  - DestinationDepositUnaffordable: the fresh contractCalls route guarantees
            //    less than the estimate's probe did (quote-to-quote drift beyond the SDK's
            //    1% margin). The SDK hands back the affordable value; re-estimating from a
            //    fresh probe is the equivalent refit here.
            const unaffordableTrip =
              /exceeds the bridge's guaranteed delivery/.test(msg);
            if (lifiBudgetTrip) lifiBudgetTrips++;
            if (sizingRaceTrip) sizingRaceTrips++;
            if (lifiTransientTrip) lifiTransientTrips++;
            if (unaffordableTrip) unaffordableTrips++;
            const retryable =
              lifiBudgetTrip ||
              sizingRaceTrip ||
              lifiTransientTrip ||
              unaffordableTrip;
            if (!retryable || attempt === RESHIELD_PREPARE_ATTEMPTS) throw e;
            console.warn(
              `  attempt ${attempt}/${RESHIELD_PREPARE_ATTEMPTS} tripped ${lifiBudgetTrip ? "assertLifiBudget" : sizingRaceTrip ? "the destination sizing race" : unaffordableTrip ? "DestinationDepositUnaffordable (route guarantee drifted)" : "a LiFi 422 (market conditions changed)"} — retrying with fresh quotes...`,
            );
          }
        }
        if (!prepared || !destDepositResult) {
          throw new Error("prepareReshieldCrosschainQuote never succeeded");
        }
        const preparedDiag = writeDiag("prepared", prepared);
        // Full LiFi calldata (untruncated) + the destination deposit it embeds, for fork replays.
        writeDiag("prepared-raw", {
          swapCalldata: prepared.swapCalldata,
          swapTarget: prepared.swapTarget,
          depositTo: destDepositResult.depositTx.to,
          depositCallData: destDepositResult.depositTx.data,
          depositMsgValue: destDepositResult.depositTx.value,
          totalDepositCost: prepared.selectedQuote ? undefined : undefined,
          pendingNote: destDepositResult.pendingNote,
          netAmount: prepared.netAmount,
          feeAmount: prepared.feeAmount,
        });
        console.log(
          `Prepared: fee ${prepared.feeAmount}, net ${prepared.netAmount}, swapInputToken ${prepared.swapInputToken}, ` +
            `swapTarget ${prepared.swapTarget}, approval ${prepared.approvalAddress}, ` +
            `swapValue ${prepared.swapValue ?? 0n}, gasSwapMaxInput ${prepared.gasSwapMaxInput ?? 0n}, ` +
            `fallback ${prepared.fallbackAddress}, dustRecipient ${prepared.dustRecipient}, ` +
            `calldata ${prepared.swapCalldata.length} chars`,
        );
        console.log("Prepared quote dumped to", preparedDiag);
        if (DRY_RUN) {
          console.log(
            "\n=== DRY_RUN complete: prod relayer quote + LiFi route + BSC deposit proof + prepared reshield all succeeded. Nothing sent. ===",
          );
          return;
        }

        const readDestPoolBalance = () =>
          destYield
            ? bscPublicClient.readContract({
                address: DEST_TOKEN,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [BSC_POOL_ADDRESS as `0x${string}`],
              })
            : bscPublicClient.getBalance({ address: BSC_POOL_ADDRESS });
        const fallbackToken = destYield ? destYield.underlying : undefined;
        const readFallbackBalance = () =>
          fallbackToken
            ? bscPublicClient.readContract({
                address: fallbackToken,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [prepared!.fallbackAddress as `0x${string}`],
              })
            : bscPublicClient.getBalance({
                address: prepared!.fallbackAddress,
              });
        const destPoolBefore = await readDestPoolBalance();
        const fallbackBefore = await readFallbackBalance();

        // === 6. Execute via RelaySwaps on mainnet — the irreversible step ===
        console.log("\nGenerating transact proof + relaying (30-120s)...");
        const proofStart = Date.now();
        let txReceipt: Awaited<
          ReturnType<typeof sourceSession.relayReshieldCrosschain>
        >;
        try {
          txReceipt = await sourceSession.relayReshieldCrosschain({
            inputCommitments: [inputCommitment],
            amount: prepared.netAmount,
            tokenId: SOURCE_TOKEN,
            outputToken: DEST_TOKEN,
            toChainId: BSC_CHAIN_ID,
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
        } catch (e) {
          const path = writeDiag("relay-error", {
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
            error: e,
          });
          console.error(
            `\n!!! relayReshieldCrosschain FAILED after ${((Date.now() - proofStart) / 1000).toFixed(1)}s — full error in ${path}\n`,
            e,
          );
          throw e;
        }
        console.log(
          `Proof + relay completed in ${((Date.now() - proofStart) / 1000).toFixed(1)}s`,
        );
        console.log(
          "Mainnet RelaySwaps tx:",
          txReceipt.txHash,
          "status:",
          txReceipt.status,
        );
        writeDiag("relay-receipt", txReceipt);
        expect(txReceipt.status).toBe(true);
        if (snapshotPath) {
          markAsRecovered(snapshotPath);
          console.log(
            "Mainnet recovery snapshot marked as recovered (note spent).",
          );
        }

        // === 7. Wait for the bridge + destination deposit on BSC (LiFi status) ===
        console.log(
          "\nWaiting for bridge + deposit on BSC (polling LiFi status)...",
        );
        const pollIntervalMs = 15_000;
        const start = Date.now();
        let destinationTxHash: Hex | undefined;
        let lastStatus: unknown;
        while (Date.now() - start < BRIDGE_WAIT_MS) {
          const status = await lifiProvider.getSwapStatus({
            txHash: txReceipt.txHash as Hex,
            fromChainId: ETH_CHAIN_ID,
            toChainId: BSC_CHAIN_ID,
          });
          lastStatus = status;
          if (status.status === "DONE" && status.receiving?.txHash) {
            destinationTxHash = status.receiving.txHash;
            console.log(
              "Bridge complete! BSC tx:",
              destinationTxHash,
              "substatus:",
              status.substatus ?? "(none)",
            );
            break;
          }
          if (status.status === "FAILED") {
            writeDiag("lifi-status-failed", status);
            throw new Error(
              `LiFi bridge reported FAILED: ${status.substatusMessage ?? status.substatus ?? "no detail"}`,
            );
          }
          console.log(
            `  Polling... ${Math.round((Date.now() - start) / 1000)}s elapsed, status: ${status.status} ${status.substatus ?? ""}`,
          );
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        writeDiag("lifi-status-final", lastStatus);
        if (!destinationTxHash) {
          throw new Error(
            `Bridge did not complete within ${BRIDGE_WAIT_MS / 1000}s`,
          );
        }

        const destPoolAfter = await readDestPoolBalance();
        const fallbackAfter = await readFallbackBalance();
        console.log(
          `BSC pool ${destYield ? DEST_TOKEN : "BNB"}: ${formatUnits(destPoolBefore, destDecimals)} -> ${formatUnits(destPoolAfter, destDecimals)}`,
        );
        const fallbackDecimals = destYield ? destYield.underlyingDecimals : 18;
        console.log(
          `Fallback ${prepared.fallbackAddress} ${destYield ? destYield.underlyingSymbol : "BNB"}: ` +
            `${formatUnits(fallbackBefore, fallbackDecimals)} -> ${formatUnits(fallbackAfter, fallbackDecimals)} ` +
            `(leftover ${formatUnits(fallbackAfter - fallbackBefore, fallbackDecimals)})`,
        );
        // If the destination deposit failed, LiFi's receiver hands ALL bridged
        // funds to fallbackAddress and the pool gains nothing — surface that.
        expect(
          destPoolAfter,
          `BSC pool balance did not grow: the destination deposit most likely failed and the bridged funds went to fallback ${prepared.fallbackAddress}`,
        ).toBeGreaterThan(destPoolBefore);

        // === 7.5. Recovery snapshot for the BSC note — left UNRECOVERED (live deposit) ===
        const destinationTx = await bscPublicClient.getTransaction({
          hash: destinationTxHash,
        });
        const destSnapshotPath = await saveRecoverySnapshot({
          publicClient: bscPublicClient as any,
          chainId: BSC_CHAIN_ID,
          depositTxHash: destinationTxHash,
          depositBlock: destinationTx.blockNumber,
          deploymentBlock: BSC_DEPLOYMENT_BLOCK,
          ownerAddress: account.address as Address,
          contracts: {
            pool: BSC_POOL_ADDRESS,
            entrypoint: BSC_ENTRYPOINT_ADDRESS,
            keystore: BSC_KEYSTORE_ADDRESS,
            aspRegistry: BSC_ASP_REGISTRY_ADDRESS,
          },
          protocolKeys: state.protocolKeys,
          note: destDepositResult.pendingNote,
          storageDir: BSC_RECOVERY_SNAPSHOT_DIR,
        });
        console.log("BSC recovery snapshot saved:", destSnapshotPath);

        // === 8. Best-effort: wait for the prod ASP to approve the BSC note, then sync ===
        const destLabelHash = noteComputationService.computeLabelHash(
          destDepositResult.pendingNote.label as Hash,
        );
        const destLabelHashDecimal = BigInt(destLabelHash).toString();
        try {
          await pollUntil(
            async () => {
              const status = await fetchLabelStatus(destLabelHashDecimal);
              console.log("  BSC label status:", status);
              return status === "approved";
            },
            DEST_ASP_WAIT_MS,
            ASP_POLL_INTERVAL_MS,
            "BSC label not yet approved",
          );
        } catch (e) {
          console.warn(
            `BSC note not ASP-approved yet (${(e as Error).message}) — it will show PENDING until the prod ASP catches up. ` +
              `Label hash ${destLabelHashDecimal}.`,
          );
        }
        const destFromBlock = hexBig(destinationTx.blockNumber - 1n);
        const destNotes = await destSession.discoverNotes({
          fromBlock: destFromBlock,
        });
        const landed = destNotes.find(
          (n) =>
            n.commitment.toLowerCase() ===
            destDepositResult!.pendingNote.commitment.toLowerCase(),
        );
        console.log(
          `BSC notes synced — landed note status: ${landed?.status ?? "(not discovered)"}`,
        );

        console.log(
          "\n=== PROD Cross-Chain Reshield (mainnet -> BSC) PASS ===",
        );
        console.log("Source tx (mainnet):", txReceipt.txHash);
        console.log("Destination tx (BSC):", destinationTxHash);
      },
      180 * 60_000,
    ); // prod ASP waits dominate; bridge + proofs are minutes
  },
);
