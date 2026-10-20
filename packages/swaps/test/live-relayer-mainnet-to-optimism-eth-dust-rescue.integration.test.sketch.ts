/**
 * SKETCH — not wired into any test runner yet (`.sketch.ts`, not `.test.ts`).
 * Drafted 2026-08-28 as the DIRECTION MIRROR of
 * `live-relayer-optimism-to-mainnet-eth-dust-rescue.integration.test.sketch.ts`.
 *
 * WHY A MIRROR: the Optimism -> Mainnet sketch is blocked at the relay-swap step by a
 * routing gap — LiFi's `/quote/contractCalls` for ANY corridor whose DESTINATION is
 * Ethereum Mainnet returns only a Stargate/LayerZero route, which needs a native
 * `msg.value` (the LZ messaging fee) that `RelaySwaps.execute()`'s ERC-20 branch does
 * not fund (`RelaySwaps_SwapFailed`). See `detailed_b2_plan_for_mainnet_reshield.md`.
 *
 * This mirror flips the direction: source = Mainnet (chain 1), destination = Optimism
 * (chain 10) — an L2, so no B2 blocker. Source/output tokens are parametrized via
 * RESHIELD_SRC_TOKEN / RESHIELD_OUT_TOKEN ∈ {USDC, ETH} (token block below).
 *
 *   # DEFAULT: Mainnet USDC -> Optimism USDC (ERC-20 -> ERC-20) — the combination that
 *   # SHOULD PASS end-to-end. LiFi routes via Across (value 0); priceForRescue
 *   # short-circuits because OP USDC is REFERENCE_STABLECOIN_BY_CHAIN_ID[10].
 *   LIVE_DUST_RESCUE_CONFIRM=yes npx vitest run --config vitest.sketch-run.config.ts \
 *     live-relayer-mainnet-to-optimism-eth-dust-rescue...
 *
 *   # Mainnet USDC -> Optimism ETH — currently fails at priceForRescue: no
 *   # WRAPPED_NATIVE_BY_CHAIN_ID[10] (dustRescueWarning, reshield still succeeds).
 *   RESHIELD_OUT_TOKEN=ETH LIVE_DUST_RESCUE_CONFIRM=yes npx vitest run ...
 *
 * Verified 2026-08-28: `USDC(Mainnet) -> USDC/ETH(Optimism)` contractCalls routes via
 * **Across**, `transactionRequest.value: 0x0` — runs against the CURRENT RelaySwaps
 * (`getContract(1, "RelaySwaps")` = 0x5F39...57F7 on Mainnet), no B2 changes required.
 *
 * WHAT IT PROVES (Item 3 in dust_Collector_deploy_handoff.md — never yet completed):
 *  - a real cross-chain-reshield-with-`dustRescue` call through the LIVE relayer that
 *    produces a job the LIVE dust-rescue-service picks up over real Pub/Sub, proves,
 *    and submits — NOTHING mocked;
 *  - the relayer's `priceForRescue()` native-ETH fix (WRAPPED_NATIVE_BY_CHAIN_ID = {1:
 *    WETH}) exercised on its home chain, source-side — still unverified live;
 *  - `RelaySwaps.execute` on the Mainnet deployment + the Mainnet pool.
 *
 * COST / PREREQUISITES (read before running — this moves real money AND real L1 gas):
 *  - The SOURCE deposit + `RelaySwaps.execute` run on Ethereum Mainnet L1. Proof verify
 *    + swap + `POOL.transact` + Across dispatch is 400-600k gas; at 10-30 gwei that is
 *    ~$5-25 for the reshield tx alone, plus the deposit tx (~$3-10), plus a possible
 *    ragequit recovery on L1 (~$5-15) if it strands. Budget ~$15-50 of gas for a
 *    ~$25-value test. DEPOSIT_AMOUNT defaults to 25 USDC for that reason — a $10 test is
 *    uneconomical on L1.
 *  - The ASP-whitelisted wallet (ASP_POSTMAN_PRIVATE_KEY ->
 *    0x0967755AfA2016866D12EefB820705026842dCe8) must hold USDC + ETH gas ON MAINNET.
 *  - The relayer's own chain-1 signer must hold ETH ON MAINNET for the `execute` tx.
 *    Its address is required via RELAYER_MAINNET_SIGNER_ADDRESS (see beforeAll) — it is
 *    a DIFFERENT key from the chain-10 signer the OP->Mainnet sketch hardcodes.
 *  - ASP approval/tree-inclusion timing for MAINNET deposits is less characterized than
 *    Optimism (dust_rescue_asp_label_status_postmortem.md is Optimism-only). Timeouts
 *    below are the same generous defaults; adjust from observation.
 *
 * ============================================================================
 * KNOWN FOOTGUN — read before touching contract addresses in this file
 * ============================================================================
 * Addresses come from `packages/swaps/contracts/deployments-it-003.json` via
 * `getContract()` / `test/helpers/deployment-loader.ts`, pointed at it-003 by the env
 * override below (NOT that helper's it-002 default — every other test in this directory
 * stays on it-002; do NOT change the loader default). That file documents, per chain,
 * the cross-chain address COINCIDENCES that make the Optimism/Mainnet pair easy to
 * transpose by copy-paste (Optimism's PoolVault == Mainnet's Entrypoint, etc.) — see
 * each entry's own `footgunWarning` field. Constants here keep their chain-name prefix
 * (`MAINNET_*` / `OP_*`); only their SOURCE vs DEST role flips relative to the
 * OP->Mainnet sketch. it-002 has a completely different, unrelated Optimism entry and
 * no chainId-1 entry at all — never conflate the two files.
 * ============================================================================
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  getAddress,
  http,
  keccak256,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { mainnet, optimism } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

import {
  PoolSessionBuilder,
  APP_IDENTIFIER,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
  NoteComputationService,
  PoseidonHashService,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  ILogger,
  LeafCacheSeed,
  PoolSession,
  RelayerInfo,
} from "@privacy-pools-v2/evm-sdk";
import type { StealthRecipientIdentifier } from "@privacy-pools-v2/dust-rescue-prover";

// --- reused test-suite conventions (see mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue.integration.test.ts) ---
import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import { getContract, getDeployBlock } from "./helpers/deployment-loader.js";
import {
  saveRecoverySnapshot,
  markAsRecovered,
} from "./helpers/recovery-snapshot.js";
import {
  fetchKeystoreLeafCacheSeed,
  fetchStateLeafCacheSeed,
  type IndexerConfig,
} from "./helpers/leaf-cache-from-indexer.js";

// Points getContract() at the it-003 registry for every call below — local to this
// module (deployment-loader.ts reads this env var lazily, per-call, inside
// loadDeployments() — not at import time — so setting it here, after the import but
// before any getContract() call actually runs, is safe). Never touches
// deployment-loader.ts's it-002 default the rest of this suite relies on.
process.env.RELAY_SWAPS_DEPLOYMENTS_PATH = resolve(
  __dirname,
  "../contracts/deployments-it-003.json",
);

// ============================================================================
// Config — env
// ============================================================================
// Depositor AND ASP postman are the SAME wallet here, deliberately — this staging ASP
// (per .asp_data's ASP_ENABLE_WALLET) only approves deposits from
// 0x0967755AfA2016866D12EefB820705026842dCe8; depositing from any other address would
// leave the source note stuck PENDING forever (see the ASP-approval poll in step 1
// below). Same key-reuse deviation the OP->Mainnet sketch documents — it just applies
// on Mainnet here instead of Optimism.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY; // FAT_WALLET_A_0, ASP-approved

// The live services, not a locally-started relayer process — this is the whole point
// of this test vs. every other mainnet-*.integration.test.ts in this directory. Point
// LIVE_RELAYER_URL at http://localhost:3000 to drive a locally-built relayer instead
// (see testing_dust_with_local_relayer.org).
const RELAYER_URL =
  process.env.LIVE_RELAYER_URL ??
  "https://relayer-v2-testing-149184580131.us-east1.run.app";
// dust-collector-testing's own URL isn't called from this test — completion detection
// goes through Firestore directly (steps 4/5), not a manual /sweep trigger (that route
// needs run.invoker, which only the invoker SAs have).

const MAINNET_RPC = process.env.RPC_URL_1!; // SOURCE chain RPC
const OP_RPC = process.env.RPC_URL_10!; // DEST chain RPC

// Source deposit amount, in the source token's own base units. Default depends on the
// source token (token-parametrization block below): 25 USDC (6 dp) — a $10 test is
// uneconomical against Ethereum L1 gas — or 0.01 ETH (18 dp). Override with DEPOSIT_AMOUNT.
const DEPOSIT_AMOUNT_ENV = process.env.DEPOSIT_AMOUNT;

// LiFi slippage tolerance. Lower default than the OP->Mainnet sketch's 0.25: the
// Mainnet->Optimism contractCalls route goes via Across (cheap, token-deductible fees,
// NO LayerZero native fee), so far less headroom is needed to clear the ~$2
// minWorthUsdMicros combined-dust floor. STILL price-dependent — re-check with a live
// estimateReshieldCrosschainAmount() immediately before running for real.
const RESHIELD_SLIPPAGE = Number(process.env.RESHIELD_SLIPPAGE ?? "0.08");
// Same >=20% warning gate dust-leftover-observer.ts's DUST_OBSERVER_SLIPPAGE uses.
if (RESHIELD_SLIPPAGE >= 0.2) {
  console.warn(
    `WARNING: RESHIELD_SLIPPAGE=${RESHIELD_SLIPPAGE} is wide (>=20%). This is a real ` +
      "sandwich-attack surface on a live swap, not just a safe knob.",
  );
}

// GCP project the live services run in — used only for the completion-detection
// Firestore read in step 4, via ambient `gcloud` credentials.
const GCP_PROJECT = process.env.GCP_PROJECT ?? "boxwood-chassis-454014-j1";

// ASP wait timings (see dust_rescue_asp_label_status_postmortem.md — Optimism-only, so
// treat these as upper bounds for Mainnet until observed). Label approval is fast
// (~21s on OP); tree inclusion is the slow, uncertain part.
const ASP_LABEL_APPROVAL_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_LABEL_APPROVAL_TIMEOUT_MS ?? 300_000,
);
const ASP_TREE_INCLUSION_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_TREE_INCLUSION_TIMEOUT_MS ?? 60 * 60_000,
);
const ASP_POLL_INTERVAL_MS = Number(
  process.env.LIVE_ASP_POLL_INTERVAL_MS ?? 15_000,
);
// Real, irreversible spend gate — required immediately before the one call that
// actually moves money (step 3, relayReshieldCrosschain).
const LIVE_DUST_RESCUE_CONFIRM = process.env.LIVE_DUST_RESCUE_CONFIRM === "yes";

// The relayer's own chain-1 (Mainnet) signer address. This drives `relayerInfo.address`
// and, through it, the default `dustRecipient` / `fallbackAddress`
// (PoolSessionReshieldCrosschain.ts), so it is load-bearing, not cosmetic. It is a
// DIFFERENT key from the chain-10 signer the OP->Mainnet sketch hardcodes. Derive it
// locally from the running relayer's config `chains.evm[]` entry with `id === 1`
// (`signer_private_key`, or the `SIGNER_PRIVATE_KEY_1` env override if that relayer
// sets one) via a Node script that prints ONLY the derived address, then cross-check it
// on-chain (nonce > 0, active hot wallet). Required — beforeAll throws if unset.
const RELAYER_MAINNET_SIGNER_ADDRESS = process.env
  .RELAYER_MAINNET_SIGNER_ADDRESS as Address | undefined;

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const MAINNET_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.live-mainnet-op-dust-rescue-mainnet-notes",
);
const OP_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.live-mainnet-op-dust-rescue-op-notes",
);
// The rescue note's own recovery key — the ONLY way to ever recover the rescue deposit.
// Not registered with any PoolSession, not derivable from protocolKeys. Written the
// instant it's generated, before anything irreversible.
const RESCUE_RECOVERY_DIR = resolve(
  __dirname,
  "../.live-mainnet-op-dust-rescue-recovery-notes",
);
// Two-layer-protection snapshot (integration_test_standards.org) for the SOURCE deposit
// note itself — separate from RESCUE_RECOVERY_DIR above. The source note strands on
// MAINNET here, so recovery is a ragequit on L1 — a `recover-mainnet-dust-note.ts`
// sibling of `test/recover-op-dust-note.ts` is needed (retarget chain 1, RPC_URL_1,
// `mainnet` chain object). Expensive but works.
const MAINNET_RECOVERY_SNAPSHOT_DIR = resolve(
  __dirname,
  "../.live-mainnet-op-dust-rescue-mainnet-deposit-notes",
);

// ============================================================================
// Config — contract addresses, sourced from deployments-it-003.json (see footgun
// warning above and each entry's own `footgunWarning` field in that file).
// TODO: re-verify with a fresh `cast call ... "keystore()"/"aspRegistry()"` pass
// immediately before this test is actually run — "verified once at deploy time" is not
// the same guarantee as "still correct now" (project convention, not optional).
// ============================================================================
const SOURCE_CHAIN_ID = 1; // Mainnet
const DEST_CHAIN_ID = 10; // Optimism

// SOURCE (Mainnet) — used by sourceSession + the relayer's chain-1 route.
const MAINNET_POOL_ADDRESS = getContract(SOURCE_CHAIN_ID, "PoolVault");
const MAINNET_ENTRYPOINT_ADDRESS = getContract(SOURCE_CHAIN_ID, "Entrypoint");
const MAINNET_KEYSTORE_ADDRESS = getContract(SOURCE_CHAIN_ID, "Keystore");
const MAINNET_ASP_REGISTRY_ADDRESS = getContract(
  SOURCE_CHAIN_ID,
  "ASPRegistry",
);
const MAINNET_RELAY_SWAPS_ADDRESS = getContract(SOURCE_CHAIN_ID, "RelaySwaps");

// --- Token parametrization ---
// RESHIELD_SRC_TOKEN / RESHIELD_OUT_TOKEN ∈ {"USDC", "ETH"}. Scenarios (see file header):
//   (default) USDC -> USDC  — Mainnet USDC -> Optimism USDC (ERC-20 -> ERC-20 into an L2:
//             the case that should PASS end-to-end; Across route, value 0, priceForRescue
//             short-circuits since OP USDC is REFERENCE_STABLECOIN_BY_CHAIN_ID[10])
//   RESHIELD_OUT_TOKEN=ETH  — Mainnet USDC -> Optimism ETH  (needs WRAPPED_NATIVE_BY_CHAIN_ID[10],
//             not yet configured — priceForRescue would throw -> dustRescueWarning)
// The SDK's PoolSessionDeposit handles native ETH natively, so no source-side branching.
const NATIVE_ETH = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address; // matches packages/sdk/src/constant/PoolSession.ts (SDK's own export resolves undefined from the package entry — 2026-08-26 bug note)
const TOKENS: Record<
  number,
  Record<string, { address: Address; decimals: number; label: string }>
> = {
  1: {
    USDC: {
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
      decimals: 6,
      label: "USDC",
    }, // Mainnet native USDC
    ETH: { address: NATIVE_ETH, decimals: 18, label: "ETH" },
  },
  10: {
    USDC: {
      address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" as Address,
      decimals: 6,
      label: "USDC",
    }, // cast-verified 2026-08-29: symbol USDC, 6 dp, deployed
    ETH: { address: NATIVE_ETH, decimals: 18, label: "ETH" },
  },
};
const RESHIELD_SRC_TOKEN = (
  process.env.RESHIELD_SRC_TOKEN ?? "USDC"
).toUpperCase();
const RESHIELD_OUT_TOKEN = (
  process.env.RESHIELD_OUT_TOKEN ?? "USDC"
).toUpperCase();
const SRC_TOKEN = TOKENS[SOURCE_CHAIN_ID]?.[RESHIELD_SRC_TOKEN];
const OUT_TOKEN = TOKENS[DEST_CHAIN_ID]?.[RESHIELD_OUT_TOKEN];
if (!SRC_TOKEN || !OUT_TOKEN) {
  throw new Error(
    `Unknown token alias — RESHIELD_SRC_TOKEN=${RESHIELD_SRC_TOKEN} on chain ${SOURCE_CHAIN_ID}, ` +
      `RESHIELD_OUT_TOKEN=${RESHIELD_OUT_TOKEN} on chain ${DEST_CHAIN_ID}. Known: USDC, ETH.`,
  );
}
const DEPOSIT_AMOUNT =
  DEPOSIT_AMOUNT_ENV ??
  (SRC_TOKEN.decimals === 18 ? "10000000000000000" : "25000000");

// DEST (Optimism) — used by destSession for prepareDeposit() of the primary reshield note.
const OP_POOL_ADDRESS = getContract(DEST_CHAIN_ID, "PoolVault");
const OP_ENTRYPOINT_ADDRESS = getContract(DEST_CHAIN_ID, "Entrypoint");
const OP_KEYSTORE_ADDRESS = getContract(DEST_CHAIN_ID, "Keystore");
const OP_ASP_REGISTRY_ADDRESS = getContract(DEST_CHAIN_ID, "ASPRegistry");

// Real ASP both chains' live dust-rescue-service config already points at
// (.dust-rescue-service.config.json / .asp_data's ASP_DOMAIN). PoolSessionBuilder has
// NO implicit default — `aspUrl` (or an explicit `.withAspDataProvider()` override) is
// REQUIRED or `.create()` throws.
const ASP_URL = process.env.LIVE_ASP_URL ?? "https://api-dev.0xbow.io";

// Envio HyperIndex-backed leaf-cache seed for the SOURCE (Mainnet) session — coverage
// checked 2026-08-24 (leaf_indexer_context.md): the indexer's chain-1 PoolVault
// (0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52) is an EXACT match to
// deployments-it-003.json's real chain-1 PoolVault, with leaf values spot-checked
// byte-for-byte against a `cast logs` RPC scan — confirmed real coverage. This is the
// OPPOSITE side from the OP->Mainnet sketch (which seeds its Mainnet DEST session): here
// Mainnet is the source. Optimism (now the DEST) has ZERO indexed leaf-event rows for
// our real chain-10 contracts, so destSession is left on a normal live RPC scan.
const HYPERINDEX_ENDPOINT =
  process.env.HYPERINDEX_ENDPOINT ??
  "https://indexer.hyperindex.xyz/cf03704/v1/graphql";
const GQL_KEY = process.env.GQL_KEY;

// Event-scan lower bounds — see getDeployBlock()'s own doc comment. Both chains have a
// deployBlock entry in deployments-it-003.json; fail fast here otherwise.
const MAINNET_DEPLOYMENT_BLOCK = getDeployBlock(SOURCE_CHAIN_ID);
const OP_DEPLOYMENT_BLOCK = getDeployBlock(DEST_CHAIN_ID);
if (!MAINNET_DEPLOYMENT_BLOCK || !OP_DEPLOYMENT_BLOCK) {
  throw new Error(
    "Missing deployBlock for chain 1 or chain 10 in deployments-it-003.json — required for saveRecoverySnapshot().",
  );
}

// LiFi's `fly` exchange embeds a swap-calldata deadline shorter than this flow's
// proof-gen + ASP + relay latency tolerates — every reference test denies it and the
// OP->Mainnet sketch is missing it (a latent bug). Passed to the LiFi-touching SDK
// calls below.
const DENY_EXCHANGES = ["fly"];

// dust-rescue-service's own signer/recipient wallet (`dust_rescue_recipient_address` in
// both chains' relayer config; staging key-reuse deviation — same address as `account`
// here). Asserted in step 5 as the SENDER of the separate, later rescue-deposit tx the
// service submits — now on OPTIMISM (the DEST).
const DUST_RESCUE_SERVICE_WALLET =
  "0x0967755AfA2016866D12EefB820705026842dCe8" as Address;

const consoleLogger: ILogger = {
  level: "debug",
  child(service: string): ILogger {
    return {
      ...consoleLogger,
      debug: (msg, obj) => console.log(`[${service}]`, msg, obj ?? ""),
    };
  },
  debug: (msg, obj) => console.log("[sdk]", msg, obj ?? ""),
  info: (msg, obj) => console.log("[sdk]", msg, obj ?? ""),
  warn: (msg, obj) => console.warn("[sdk]", msg, obj ?? ""),
  error: (msg, obj) => console.error("[sdk]", msg, obj ?? ""),
  fatal: (msg, obj) => console.error("[sdk:fatal]", msg, obj ?? ""),
};

// Local copy of the SDK's internal POOL_VAULT_DEPOSITED_EVENT_ABI (ContractInteractor.ts)
// — not part of the SDK's public export surface.
const POOL_VAULT_DEPOSITED_EVENT_ABI = [
  {
    type: "event",
    name: "Deposited",
    inputs: [
      { name: "outputCommitment", type: "uint256", indexed: false },
      { name: "asset", type: "address", indexed: true },
      { name: "depositedValue", type: "uint256", indexed: false },
      { name: "caller", type: "address", indexed: true },
    ],
  },
] as const;

interface DustRescueJobSnapshot {
  state?: string;
  depositTxHash?: Hex;
  lastError?: string;
}

/**
 * Ambient `gcloud` credentials — whoever runs this test needs `gcloud auth login` done
 * beforehand; no service-account key is embedded here.
 */
function firestoreAccessToken(): string {
  return execSync("gcloud auth print-access-token", {
    encoding: "utf8",
  }).trim();
}

/**
 * Minimal decoder for the top-level scalar fields this test reads (state,
 * depositTxHash, lastError) — NOT a general Firestore REST value decoder.
 */
function decodeFirestoreFields(
  fields: Record<string, { stringValue?: string; integerValue?: string }>,
): DustRescueJobSnapshot {
  const get = (key: string): string | undefined =>
    fields[key]?.stringValue ?? fields[key]?.integerValue;
  return {
    state: get("state"),
    depositTxHash: get("depositTxHash") as Hex | undefined,
    lastError: get("lastError"),
  };
}

/**
 * Reads `dustRescueJobs/{sourceTxHash}` (doc ID is the job's own sourceTxHash) directly
 * via the Firestore REST API — dust-rescue-service exposes no HTTP job-status route.
 */
async function fetchDustRescueJob(
  sourceTxHash: Hex,
): Promise<DustRescueJobSnapshot | undefined> {
  const url =
    `https://firestore.googleapis.com/v1/projects/${GCP_PROJECT}/databases/(default)/` +
    `documents/dustRescueJobs/${sourceTxHash}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${firestoreAccessToken()}` },
  });
  if (res.status === 404) return undefined; // job not yet created — Pub/Sub delivery still in flight
  if (!res.ok) {
    throw new Error(`Firestore read failed: ${res.status} ${await res.text()}`);
  }
  const doc = (await res.json()) as {
    fields?: Record<string, { stringValue?: string; integerValue?: string }>;
  };
  return decodeFirestoreFields(doc.fields ?? {});
}

/** Polls `check` until it resolves true, or throws `timeoutMessage` after `timeoutMs`. */
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

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

describe.skipIf(!ASP_POSTMAN_PRIVATE_KEY || !hasCircuits)(
  "LIVE cross-chain reshield + dust rescue: Mainnet USDC -> Optimism ETH",
  () => {
    let account: ReturnType<typeof privateKeyToAccount>;
    let sourceSession: PoolSession;
    let destSession: PoolSession;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let recipientPrivateKey: Uint8Array;
    let recipientIdentifier: StealthRecipientIdentifier;
    let mainnetWalletClient: ReturnType<typeof createWalletClient>;
    let opWalletClient: ReturnType<typeof createWalletClient>;
    let mainnetPublicClient: ReturnType<typeof createPublicClient>;
    let opPublicClient: ReturnType<typeof createPublicClient>;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;

    beforeAll(async () => {
      if (!RELAYER_MAINNET_SIGNER_ADDRESS) {
        throw new Error(
          "RELAYER_MAINNET_SIGNER_ADDRESS is required — the relayer's own chain-1 signer " +
            "address (drives relayerInfo.address and the default dustRecipient/fallbackAddress). " +
            "Derive it from the running relayer's config entry with id===1 (signer_private_key, " +
            "or SIGNER_PRIVATE_KEY_1 if set) via a script that prints only the address, then " +
            "cross-check it on-chain.",
        );
      }

      // ASP-approved wallet, not an arbitrary depositor — see the config comment above.
      account = privateKeyToAccount(ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`);
      mainnetWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });
      opWalletClient = createWalletClient({
        account,
        chain: optimism,
        transport: http(OP_RPC),
      });
      mainnetPublicClient = createPublicClient({
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });
      // Cast needed for opPublicClient specifically: viem's OP-Stack chain config
      // (optimism) infers an extra "deposit" transaction variant that doesn't
      // structurally match the bare `ReturnType<typeof createPublicClient>` annotation.
      opPublicClient = createPublicClient({
        chain: optimism,
        transport: http(OP_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;

      // --- Fresh stealth identity for the rescue note ---
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
      mkdirSync(RESCUE_RECOVERY_DIR, { recursive: true });
      writeFileSync(
        resolve(RESCUE_RECOVERY_DIR, `recipient-key-${Date.now()}.json`),
        JSON.stringify(
          {
            note: "ONLY way to recover this run's rescue deposit. Keep until recovered.",
            recipientPrivateKey: `0x${Buffer.from(recipientPrivateKey).toString("hex")}`,
            recipientIdentifier,
          },
          null,
          2,
        ),
      );

      persistence = new TestStatePersistence(
        resolve(__dirname, "../.live-mainnet-op-dust-rescue-state.json"),
      );
      const saved = persistence.load();
      const protocolKeys =
        saved?.protocolKeys ??
        (await deriveProtocolKeys(account, mainnetWalletClient));
      state = saved ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);

      // relayerInfo — points at the LIVE relayer, chain 1 (source-chain reshield is
      // submitted through the relayer's Mainnet-scoped route/processor).
      relayerInfo = {
        url: RELAYER_URL,
        name: "live-testing",
        chainId: SOURCE_CHAIN_ID,
        chainType: "evm",
        status: "active",
        address: RELAYER_MAINNET_SIGNER_ADDRESS,
        processorAddress: MAINNET_RELAY_SWAPS_ADDRESS,
      };

      // --- SOURCE session (Mainnet). Hits the REAL ASP (api-dev.0xbow.io) the live
      // relayer + dust-rescue-service both depend on, via `aspUrl`. Wires
      // LiFiSwapQuoteProvider for estimateReshieldCrosschainAmount() /
      // prepareReshieldCrosschainQuote(). ---
      lifiProvider = new LiFiSwapQuoteProvider({});

      let mainnetKeystoreLeafCacheSeed: LeafCacheSeed | undefined;
      let mainnetStateLeafCacheSeed: LeafCacheSeed | undefined;
      if (GQL_KEY) {
        const indexerConfig: IndexerConfig = {
          endpoint: HYPERINDEX_ENDPOINT,
          apiKey: GQL_KEY,
        };
        console.log(
          "Fetching Mainnet (SOURCE) leaf-cache seeds from HyperIndex...",
        );
        [mainnetKeystoreLeafCacheSeed, mainnetStateLeafCacheSeed] =
          await Promise.all([
            fetchKeystoreLeafCacheSeed(
              indexerConfig,
              SOURCE_CHAIN_ID,
              MAINNET_KEYSTORE_ADDRESS,
            ),
            fetchStateLeafCacheSeed(
              indexerConfig,
              SOURCE_CHAIN_ID,
              MAINNET_POOL_ADDRESS,
            ),
          ]);
        console.log(
          `Mainnet leaf-cache seeds fetched: ${mainnetKeystoreLeafCacheSeed.leaves.length} keystore ` +
            `leaves, ${mainnetStateLeafCacheSeed.leaves.length} state leaves, toBlock ` +
            `${mainnetKeystoreLeafCacheSeed.toBlock}.`,
        );
      } else {
        console.log(
          "GQL_KEY not set — sourceSession will do a normal live RPC scan on Mainnet.",
        );
      }

      sourceSession = await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: MAINNET_RPC,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: MAINNET_POOL_ADDRESS,
          entrypointAddress: MAINNET_ENTRYPOINT_ADDRESS,
          keystoreAddress: MAINNET_KEYSTORE_ADDRESS,
          aspRegistryAddress: MAINNET_ASP_REGISTRY_ADDRESS,
          relaySwapsAddress: MAINNET_RELAY_SWAPS_ADDRESS,
        },
        // Seed the SOURCE (Mainnet) scan from the indexer — coverage-checked above.
        // Falls back to a normal RPC scan if GQL_KEY isn't set.
        keystoreLeafCacheSeed: mainnetKeystoreLeafCacheSeed,
        stateLeafCacheSeed: mainnetStateLeafCacheSeed,
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: MAINNET_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: mainnetWalletClient as any,
        },
        destinationChainId: DEST_CHAIN_ID,
        destinationRpcUrl: OP_RPC,
        destinationDeployment: {
          poolAddress: OP_POOL_ADDRESS,
          entrypointAddress: OP_ENTRYPOINT_ADDRESS,
          keystoreAddress: OP_KEYSTORE_ADDRESS,
          aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS,
        },
        logger: consoleLogger,
        deploymentBlock: MAINNET_DEPLOYMENT_BLOCK,
      } as any)
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .create();

      // --- DEST session (Optimism) — for prepareDeposit() of the primary reshield note.
      // No leaf-cache seed: the indexer has no coverage for our chain-10 contracts, so
      // this does a normal live RPC scan. aspUrl is still a required constructor field
      // even though this session's own calls never touch the ASP. ---
      destSession = await PoolSessionBuilder.fromConfig({
        chainId: DEST_CHAIN_ID,
        rpcUrl: OP_RPC,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: OP_POOL_ADDRESS,
          entrypointAddress: OP_ENTRYPOINT_ADDRESS,
          keystoreAddress: OP_KEYSTORE_ADDRESS,
          aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        // Required even though destSession never relays anything (only
        // prepareDeposit/registerKeystore, both local/on-chain-direct) —
        // PoolSessionBuilder throws InvalidBuilderConfig on an empty list.
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
        persistentStorage: { type: "file", dirPath: OP_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: opWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: OP_DEPLOYMENT_BLOCK,
      } as any).create();
    }, 120_000);

    it(
      `full flow: reshield ${RESHIELD_SRC_TOKEN} (Mainnet) -> ${RESHIELD_OUT_TOKEN} (Optimism), dustRescue opted in, verified via LIVE pipeline`,
      async () => {
        const depositAmount = BigInt(DEPOSIT_AMOUNT);

        // === 1. Source note: REUSE an existing ACTIVE note if one exists, else deposit ===
        // (patched for debug iteration — a stranded ACTIVE note from a prior failed run is
        // reusable as-is: it's already deposited, ASP-approved and tree-included, and no
        // failing step before relayReshieldCrosschain spends it. Avoids a fresh 25-USDC
        // deposit + ragequit on every iteration.)
        if (!(await sourceSession.isKeystoreRegistered())) {
          const sourceReceipts = await sourceSession.registerKeystore();
          expect(sourceReceipts.every((r) => r.status)).toBe(true);
        }

        // Read the NoteManager's persisted state directly — discoverNotes() only returns
        // notes found in the delta scan past the stored cursor, not already-known ACTIVE
        // ones. The session itself already loaded this note (with secrets) from the same
        // file at create(), so relayReshieldCrosschain() can build its proof by commitment.
        let reusableNote:
          | {
              commitment: string;
              label: string;
              value: string;
              tokenId: string;
            }
          | undefined;
        try {
          const notesFile = resolve(
            MAINNET_NOTE_STORAGE_DIR,
            "privacy-pool-notes.json",
          );
          if (existsSync(notesFile)) {
            const raw = JSON.parse(readFileSync(notesFile, "utf8")) as Record<
              string,
              {
                notes?: Array<{
                  commitment: string;
                  label: string;
                  value: string;
                  tokenId: string;
                  status: string;
                }>;
              }
            >;
            for (const entry of Object.values(raw)) {
              reusableNote = (entry.notes ?? []).find(
                (n) =>
                  n.tokenId.toLowerCase() === SRC_TOKEN.address.toLowerCase() &&
                  BigInt(n.value) === depositAmount &&
                  n.status === "ACTIVE",
              );
              if (reusableNote) break;
            }
          }
        } catch (e) {
          console.warn("Could not read persisted notes for reuse:", e);
        }
        // Sync the session so its view is current for proof-building.
        await sourceSession.discoverNotes();

        let sourceDepositResult: {
          pendingNote: { commitment: Hash; label: Hash };
        };
        let depositSnapshotPath: string | undefined;

        if (reusableNote) {
          console.log(
            `REUSING existing ACTIVE note ${reusableNote.commitment} ` +
              `(${formatUnits(BigInt(reusableNote.value), SRC_TOKEN.decimals)} ${SRC_TOKEN.label}) ` +
              `— skipping deposit + ASP wait.`,
          );
          sourceDepositResult = {
            pendingNote: {
              commitment: reusableNote.commitment as Hash,
              label: reusableNote.label as Hash,
            },
          };
          // If this run actually spends the note, mark its existing recovery snapshot recovered.
          const existingSnap = resolve(
            MAINNET_RECOVERY_SNAPSHOT_DIR,
            "recovery-0x12cf8440-1788047082704.json",
          );
          depositSnapshotPath = existsSync(existingSnap)
            ? existingSnap
            : undefined;
        } else {
          // === 1b. Fund a fresh source note (deposit USDC on Mainnet) ===
          console.log(
            `\nDepositing ${formatUnits(depositAmount, SRC_TOKEN.decimals)} ${SRC_TOKEN.label} on Mainnet...`,
          );
          const freshDeposit = await sourceSession.prepareDeposit({
            tokenId: SRC_TOKEN.address,
            value: `0x${depositAmount.toString(16)}` as Hex,
          });
          sourceDepositResult = freshDeposit;
          mkdirSync(MAINNET_NOTE_STORAGE_DIR, { recursive: true });
          writeFileSync(
            resolve(MAINNET_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
            JSON.stringify(freshDeposit.pendingNote, null, 2),
          );

          const sourceDepositReceipt =
            await sourceSession.executeDeposit(freshDeposit);
          expect(sourceDepositReceipt.status).toBe(true);
          console.log("Mainnet deposit tx:", sourceDepositReceipt.txHash);

          const sourceDepositTx = await mainnetPublicClient.getTransaction({
            hash: sourceDepositReceipt.txHash as Hex,
          });
          depositSnapshotPath = await saveRecoverySnapshot({
            publicClient: mainnetPublicClient as any,
            chainId: SOURCE_CHAIN_ID,
            depositTxHash: sourceDepositReceipt.txHash as Hex,
            depositBlock: sourceDepositTx.blockNumber!,
            deploymentBlock: MAINNET_DEPLOYMENT_BLOCK,
            ownerAddress: account.address as Address,
            contracts: {
              pool: MAINNET_POOL_ADDRESS,
              entrypoint: MAINNET_ENTRYPOINT_ADDRESS,
              keystore: MAINNET_KEYSTORE_ADDRESS,
              aspRegistry: MAINNET_ASP_REGISTRY_ADDRESS,
            },
            protocolKeys: state.protocolKeys,
            note: freshDeposit.pendingNote,
            storageDir: MAINNET_RECOVERY_SNAPSHOT_DIR,
          });

          // Real ASP approves labels asynchronously off its own on-chain event scan — no
          // client-side "register" call. Poll approval first (fast), then poll the actual
          // association-set tree for our label hash (the real gate — approval alone isn't
          // enough; see dust_rescue_asp_label_status_postmortem.md), THEN let the SDK's
          // discoverNotes() catch its internal state up before spending.
          const fromBlock =
            `0x${(sourceDepositTx.blockNumber! - 1n).toString(16)}` as Hex;
          const hashService = await PoseidonHashService.create();
          const noteComputationService = new NoteComputationService({
            hashService,
            cryptoService: new CryptoService(),
          });
          const labelHash = noteComputationService.computeLabelHash(
            freshDeposit.pendingNote.label as Hash,
          );
          const labelHashDecimal = BigInt(labelHash).toString();

          console.log("Waiting for the ASP to approve the deposit's label...");
          await pollUntil(
            async () => {
              const res = await fetch(
                `${ASP_URL}/labels/${labelHashDecimal}/status`,
              );
              if (!res.ok) return false;
              const body = (await res.json()) as { status?: string };
              console.log("  label status:", body.status ?? "(no response)");
              return body.status === "approved";
            },
            ASP_LABEL_APPROVAL_TIMEOUT_MS,
            ASP_POLL_INTERVAL_MS,
            `Label ${freshDeposit.pendingNote.label} was not ASP-approved`,
          );

          console.log(
            "Label approved. Waiting for it to appear in the association-set tree " +
              "(the actual gate for a valid membership proof)...",
          );
          await pollUntil(
            async () => {
              const res = await fetch(
                `${ASP_URL}/association-set/leaves?chainId=${SOURCE_CHAIN_ID}&entrypoint=${MAINNET_ENTRYPOINT_ADDRESS}`,
              );
              if (!res.ok) return false;
              const body = (await res.json()) as { leaves?: string[] };
              const leaves = body.leaves ?? [];
              const included = leaves.includes(labelHashDecimal);
              console.log(
                `  leaf present in association set: ${included} (${leaves.length} total leaves)`,
              );
              return included;
            },
            ASP_TREE_INCLUSION_TIMEOUT_MS,
            ASP_POLL_INTERVAL_MS,
            `Label hash ${labelHash} did not appear in the association-set tree`,
          );

          await sourceSession.discoverNotes({ fromBlock });
        }
        console.log("Source note ACTIVE — proceeding to reshield.");

        // === 2. Estimate + prepare the cross-chain reshield, dustRescue opted in ===
        // The SDK leaves only ~1% margin between LiFi's frozen fromAmount and
        // net (amount − committed fee). The relayer's fee jitters between its
        // preliminary and committed quotes (live ETH→USDC gas pricing), so
        // assertLifiBudget trips intermittently — the SDK's own remedy is "retry".
        // Re-run the whole estimate→prepare with fresh quotes until one lands inside
        // the margin.
        if (!(await destSession.isKeystoreRegistered())) {
          const receipts = await destSession.registerKeystore();
          expect(receipts.every((r) => r.status)).toBe(true);
        }

        const RESHIELD_PREPARE_ATTEMPTS = Number(
          process.env.RESHIELD_PREPARE_ATTEMPTS ?? "10",
        );
        let prepared:
          | Awaited<
              ReturnType<typeof sourceSession.prepareReshieldCrosschainQuote>
            >
          | undefined;
        for (let attempt = 1; attempt <= RESHIELD_PREPARE_ATTEMPTS; attempt++) {
          try {
            const estimate =
              await sourceSession.estimateReshieldCrosschainAmount({
                relayerInfo,
                amount: `0x${depositAmount.toString(16)}` as Hex,
                tokenId: SRC_TOKEN.address,
                outputToken: OUT_TOKEN.address,
                toChainId: DEST_CHAIN_ID,
                toChainType: "evm",
                slippage: RESHIELD_SLIPPAGE,
                denyExchanges: DENY_EXCHANGES,
              });

            const destDepositResult = await destSession.prepareDeposit({
              tokenId: OUT_TOKEN.address,
              value: estimate.noteValue,
            });

            prepared = await sourceSession.prepareReshieldCrosschainQuote({
              relayerInfo,
              amount: `0x${depositAmount.toString(16)}` as Hex,
              tokenId: SRC_TOKEN.address,
              outputToken: OUT_TOKEN.address,
              toChainId: DEST_CHAIN_ID,
              toChainType: "evm",
              depositResult: destDepositResult,
              totalDepositCost: estimate.totalDepositCost,
              slippage: RESHIELD_SLIPPAGE,
              denyExchanges: DENY_EXCHANGES,
              dustRescue: { recipientIdentifier },
            });
            console.log(
              `prepareReshieldCrosschainQuote succeeded on attempt ${attempt}.`,
            );
            break;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const retryable =
              /Invalid transact params/.test(msg) &&
              /LiFi needs .* input but only .* available after fee/.test(msg);
            if (!retryable || attempt === RESHIELD_PREPARE_ATTEMPTS) throw e;
            console.warn(
              `  attempt ${attempt}/${RESHIELD_PREPARE_ATTEMPTS} tripped assertLifiBudget ` +
                `(${msg.replace(/^.*LiFi needs/, "LiFi needs").slice(0, 90)}) — retrying...`,
            );
          }
        }
        if (!prepared)
          throw new Error("prepareReshieldCrosschainQuote never succeeded");
        console.log(
          "Resolved dustRecipient (source-chain, dust #1):",
          prepared.dustRecipient,
        );

        // === 3. Execute — this is the real, irreversible, real-money step (on L1) ===
        if (!LIVE_DUST_RESCUE_CONFIRM) {
          throw new Error(
            "Refusing to submit the real, irreversible relayReshieldCrosschain call: set " +
              "LIVE_DUST_RESCUE_CONFIRM=yes to proceed. This moves real money through a live bridge " +
              "and spends real Ethereum L1 gas.",
          );
        }
        const txReceipt = await sourceSession.relayReshieldCrosschain({
          inputCommitments: [
            sourceDepositResult.pendingNote.commitment as Hash,
          ],
          amount: prepared.netAmount,
          tokenId: SRC_TOKEN.address,
          outputToken: OUT_TOKEN.address,
          toChainId: DEST_CHAIN_ID,
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
        console.log("Mainnet RelaySwaps tx (sourceTxHash):", txReceipt.txHash);
        expect(txReceipt.status).toBe(true);
        const sourceTxHash = txReceipt.txHash as Hex;
        if (depositSnapshotPath) markAsRecovered(depositSnapshotPath);

        // At this point the live relayer has (a) awaited DustRescueForwardingService
        // .forward() synchronously for dust #1, and (b) called
        // DustRescueOrchestratorService.registerPending() to publish the combined-dust
        // job to Pub/Sub. Nothing left to trigger from our side.

        // === 4. Wait for the LIVE pipeline: Pub/Sub -> dust-rescue-service ->
        // Firestore -> proving -> on-chain submission (on Optimism) ===
        console.log("\nWaiting for dust-rescue-service to process the job...");
        const PIPELINE_TERMINAL_STATES = new Set([
          "BELOW_THRESHOLD",
          "CONFIRMED",
          "FAILED",
        ]);
        const PIPELINE_TIMEOUT_MS = 15 * 60_000;
        const PIPELINE_POLL_MS = 15_000;
        const pipelineStart = Date.now();
        let job: DustRescueJobSnapshot | undefined;
        while (Date.now() - pipelineStart < PIPELINE_TIMEOUT_MS) {
          job = await fetchDustRescueJob(sourceTxHash);
          console.log("  job state:", job?.state ?? "(not created yet)");
          if (job?.state && PIPELINE_TERMINAL_STATES.has(job.state)) break;
          await new Promise((r) => setTimeout(r, PIPELINE_POLL_MS));
        }
        if (!job?.state || !PIPELINE_TERMINAL_STATES.has(job.state)) {
          throw new Error(
            `dust-rescue-service did not reach a terminal state within ${PIPELINE_TIMEOUT_MS / 1000}s ` +
              `(last observed: ${job?.state ?? "job not found in Firestore"}, lastError: ${job?.lastError ?? "n/a"})`,
          );
        }
        console.log(
          "Job reached terminal state:",
          job.state,
          job.lastError ? `(lastError: ${job.lastError})` : "",
        );
        expect(job.state).toBe("CONFIRMED");
        expect(job.depositTxHash).toBeTruthy();

        // === 5. Independent on-chain verification — the rescue deposit tx lands on
        // OPTIMISM (the DEST). Don't trust Firestore's `state` field alone. ===
        const depositReceipt = await opPublicClient.getTransactionReceipt({
          hash: job.depositTxHash as Hex,
        });
        expect(depositReceipt.status).toBe("success");
        expect(getAddress(depositReceipt.from)).toBe(
          getAddress(DUST_RESCUE_SERVICE_WALLET),
        );

        const depositedEvent = depositReceipt.logs
          .filter(
            (log) => getAddress(log.address) === getAddress(OP_POOL_ADDRESS),
          )
          .map((log) => {
            try {
              return decodeEventLog({
                abi: POOL_VAULT_DEPOSITED_EVENT_ABI,
                data: log.data,
                topics: log.topics as [Hex, ...Hex[]],
              });
            } catch {
              return undefined;
            }
          })
          .find((decoded) => decoded?.eventName === "Deposited");
        expect(depositedEvent).toBeDefined();
        console.log(
          "Rescue deposit confirmed on-chain (Optimism) — commitment:",
          depositedEvent!.args.outputCommitment,
        );

        // TODO (stretch): recover/decrypt the resulting note with recipientPrivateKey to
        // prove the value is spendable by the intended recipient, not just "a deposit tx
        // happened".
      },
      // Generous overall budget: ASP label-approval wait (up to 5 min) + tree-inclusion
      // wait (up to 60 min) + LiFi/proving steps + the dust-rescue-service pipeline's
      // own up-to-15-min wait, with margin.
      90 * 60_000,
    );
  },
);

// Ported verbatim from the OP->Mainnet sketch / the reference test — same EIP-712
// domain/payload (no chainId in the domain), so this derives the SAME protocolKeys for
// a given account+signature regardless of which chain's wallet client signs.
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
