/**
 * SKETCH — not wired into any test runner yet (`.sketch.ts`, not `.test.ts`). Drafted
 * 2026-08-20 while waiting on the Owner-only IAM grants for the Pub/Sub + Cloud
 * Scheduler wiring (see dust_Collector_deploy_handoff.md "Also still open" #2/#3).
 * Updated 2026-08-21: those grants landed and item 2 is done, so this pass fills in
 * every TODO the first draft left open — relayer signer address (derived + on-chain
 * cross-checked), the missing `aspUrl` (a real bug: PoolSessionBuilder has no implicit
 * default and would have thrown at `.create()`), the source-note funding steps
 * including an ASP-approval wait the live (non-local) ASP requires, the
 * `inputCommitments` placeholder, and completion detection via a direct Firestore REST
 * read + independent on-chain verification. Still open: RESHIELD_SLIPPAGE's actual
 * dust yield can only be confirmed live (price-dependent), and this has still never
 * been executed end-to-end — do not run against real funds without a fresh read-through.
 *
 * Goal: the final item on that punch list — a real cross-chain-reshield-with-
 * `dustRescue` call through the LIVE deployed relayer, that produces a job the LIVE
 * deployed dust-rescue-service picks up over real Pub/Sub, proves, and submits — with
 * NOTHING mocked or driven in-test. This is deliberately the mirror image of
 * `mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue.integration.test.ts`,
 * whose own header explains it drives `proveDustRescueDeposit` directly in-test
 * "because no live GCP deployment exists yet". That gap is what this test closes.
 *
 * Scenario: a source note on Optimism (chain 10) reshielded cross-chain into Mainnet
 * (chain 1), with `dustRescue` opted in. Source/output tokens are parametrized via
 * RESHIELD_SRC_TOKEN / RESHIELD_OUT_TOKEN ∈ {USDC, ETH} (see the token block below).
 *
 * This direction's destination is Ethereum Mainnet, so it is EXPECTED TO FAIL at the
 * relaySwap step for every token combination — LiFi's contractCalls route into Mainnet
 * is Stargate/LayerZero only, which needs a native `msg.value` the current
 * `RelaySwaps.execute()` doesn't fund (`RelaySwaps_SwapFailed`). The B2 plan
 * (`detailed_b2_plan_for_mainnet_reshield.md`) is what unblocks it. Run these to confirm
 * the two failure shapes:
 *
 *   # OP USDC -> Mainnet USDC (ERC-20 branch of RelaySwaps.execute)
 *   RESHIELD_OUT_TOKEN=USDC LIVE_DUST_RESCUE_CONFIRM=yes npx vitest run \
 *     --config vitest.sketch-run.config.ts live-relayer-optimism-to-mainnet-eth-dust-rescue...
 *
 *   # OP ETH -> Mainnet ETH (native branch — _swapAmount short of fromAmount + LZ fee)
 *   RESHIELD_SRC_TOKEN=ETH RESHIELD_OUT_TOKEN=ETH LIVE_DUST_RESCUE_CONFIRM=yes npx vitest run \
 *     --config vitest.sketch-run.config.ts live-relayer-optimism-to-mainnet-eth-dust-rescue...
 *
 * The mirror sketch `live-relayer-mainnet-to-optimism-eth-dust-rescue...` runs the
 * one combination that SHOULD pass (Mainnet USDC -> Optimism USDC).
 *
 * Everything below is real code shape, reusing the exact SDK calls the reference test
 * uses — but several values are marked TODO/CONFIRM because they depend on either (a)
 * the Pub/Sub+Scheduler wiring actually landing, or (b) live values this sketch pass
 * couldn't independently re-verify. Do not run this against real funds until every
 * TODO below is resolved and reviewed — this moves real money through a live bridge.
 *
 * ============================================================================
 * KNOWN FOOTGUN — read before touching contract addresses in this file
 * ============================================================================
 * Addresses are sourced from `packages/swaps/contracts/deployments-it-003.json`
 * (via `getContract()`/`test/helpers/deployment-loader.ts`, pointed at it-003
 * instead of that helper's it-002 default — see the env override below), NOT
 * hardcoded inline. That file is the verified Optimism/Mainnet set
 * (dust_Collector_deploy_handoff.md, cross-checked four ways) and documents, per
 * chain, the cross-chain address COINCIDENCES that make this pair easy to
 * transpose by copy-paste (Optimism's PoolVault == Mainnet's Entrypoint, etc.) —
 * see each entry's own `footgunWarning` field rather than duplicating it here.
 *
 * Every other test in this directory stays hardcoded to
 * `deployments-it-002.json` (the Arbitrum/Base "it-002" iteration) — do NOT
 * change `deployment-loader.ts`'s default path. This file's `RELAY_SWAPS_DEPLOYMENTS_PATH`
 * override is local to this module only, set before any `getContract()` call —
 * confirmed during drafting that it-002 has a COMPLETELY DIFFERENT, unrelated
 * Optimism entry (different PoolVault/Entrypoint/RelaySwaps addresses entirely)
 * and no chainId 1 entry at all, so the two files must never be conflated.
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
import { existsSync, mkdirSync, writeFileSync } from "fs";
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
// below). Confirmed 2026-08-21: this env var's key derives to exactly that address in
// both local .env / .env.relayer files. Unlike the reference test (which uses a
// distinct FAT_WALLET_A_2 depositor and only needs ASP_POSTMAN_PRIVATE_KEY for its own
// LocalASPTreeService label-registration calls), this sketch has no separate depositor
// key — there's nothing for one to buy here beyond what the approved wallet already does.
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY; // FAT_WALLET_A_0, ASP-approved

// The live services, not a locally-started relayer process — this is the whole point
// of this test vs. every other mainnet-*.integration.test.ts in this directory.
const RELAYER_URL =
  process.env.LIVE_RELAYER_URL ??
  "https://relayer-v2-testing-149184580131.us-east1.run.app";
// dust-collector-testing's own URL (https://dust-collector-testing-149184580131.us-east1.run.app)
// isn't called from this test — completion detection goes through Firestore directly
// (step 4/5 below), not a manual /sweep trigger: that route needs `run.invoker` on the
// service, which only the pubsub-invoker/scheduler-invoker SAs have, not poroto@ or
// whoever else ends up running this test.

const OP_RPC = process.env.RPC_URL_10!;
const MAINNET_RPC = process.env.RPC_URL_1!;

// Source deposit amount, in the source token's own base units. Default depends on the
// source token (set in the token-parametrization block below): 10 USDC (6 dp) or
// 0.003 ETH (18 dp). Override with DEPOSIT_AMOUNT (raw base units).
const DEPOSIT_AMOUNT_ENV = process.env.DEPOSIT_AMOUNT;

// Artificially widened LiFi slippage tolerance, same knob/precedent as
// packages/swaps/scripts/dust-leftover-observer.ts's DUST_OBSERVER_SLIPPAGE — needed
// because organic leftover on a $10-ish reshield is well under the $2 minWorthUsdMicros
// floor (observed ~0.3-0.5% at default ~3% tolerance, per that script's own numbers).
// STILL OPEN: whether 0.25 actually clears $2 combined (dust #1 + dust #2) depends on
// live OP/ETH prices and LiFi's actual routing at run time — not something this sketch
// pass can verify statically. Re-check with a live estimateReshieldCrosschainAmount()
// call immediately before running for real; 0.25 remains a starting guess.
const RESHIELD_SLIPPAGE = Number(process.env.RESHIELD_SLIPPAGE ?? "0.25");
// LiFi's `fly` exchange embeds a swap-calldata deadline shorter than this flow's
// proof-gen + ASP + relay latency tolerates — every reference test denies it.
const DENY_EXCHANGES = ["fly"];
// Same >=20% warning gate dust-leftover-observer.ts's DUST_OBSERVER_SLIPPAGE uses — real
// sandwich-attack surface on a live swap, not a free knob.
if (RESHIELD_SLIPPAGE >= 0.2) {
  console.warn(
    `WARNING: RESHIELD_SLIPPAGE=${RESHIELD_SLIPPAGE} is wide (>=20%). This is a real ` +
      "sandwich-attack surface on a live swap, not just a safe knob.",
  );
}

// GCP project the live services run in (dust_Collector_deploy_handoff.md) — used only
// for the completion-detection Firestore read in step 4, via ambient `gcloud` credentials.
const GCP_PROJECT = process.env.GCP_PROJECT ?? "boxwood-chassis-454014-j1";

// ASP wait timings (see dust_rescue_asp_label_status_postmortem.md). Label approval itself
// is fast (~21s observed); the tree-inclusion wait is the slow, uncertain part — 40+
// minutes observed in one run, with no confirmed upper bound yet, hence the generous
// default. Override via env once the ASP team's answer narrows this down.
const ASP_LABEL_APPROVAL_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_LABEL_APPROVAL_TIMEOUT_MS ?? 300_000,
);
const ASP_TREE_INCLUSION_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_TREE_INCLUSION_TIMEOUT_MS ?? 60 * 60_000,
);
const ASP_POLL_INTERVAL_MS = Number(
  process.env.LIVE_ASP_POLL_INTERVAL_MS ?? 15_000,
);
// Real, irreversible spend gate — same shape as dust-leftover-observer.ts's
// DUST_OBSERVER_CONFIRM=yes. Required immediately before the one call in this test that
// actually moves money (step 3, relayReshieldCrosschain).
const LIVE_DUST_RESCUE_CONFIRM = process.env.LIVE_DUST_RESCUE_CONFIRM === "yes";

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const OP_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.live-op-mainnet-dust-rescue-op-notes",
);
const MAINNET_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.live-op-mainnet-dust-rescue-mainnet-notes",
);
// Same non-negotiable rule as the reference test: this key is the ONLY way to ever
// recover the rescue deposit. Not registered with any PoolSession, not derivable from
// protocolKeys. Written the instant it's generated, before anything irreversible.
const RESCUE_RECOVERY_DIR = resolve(
  __dirname,
  "../.live-op-mainnet-dust-rescue-recovery-notes",
);
// Two-layer-protection snapshot (integration_test_standards.org) for the SOURCE deposit
// note itself — separate from RESCUE_RECOVERY_DIR above, which is the rescue note's own
// (unrelated) recovery key.
const OP_RECOVERY_SNAPSHOT_DIR = resolve(
  __dirname,
  "../.live-op-mainnet-dust-rescue-op-deposit-notes",
);

// ============================================================================
// Config — contract addresses, sourced from deployments-it-003.json (see footgun
// warning above and each entry's own `footgunWarning` field in that file).
// TODO: re-verify with a fresh `cast call ... "keystore()"/"aspRegistry()"` pass
// immediately before this test is actually run — "verified once at deploy time" is
// not the same guarantee as "still correct now" (project convention, not optional).
// ============================================================================
const SOURCE_CHAIN_ID = 10; // Optimism
const DEST_CHAIN_ID = 1; // Mainnet

// --- Token parametrization ---
// RESHIELD_SRC_TOKEN / RESHIELD_OUT_TOKEN ∈ {"USDC", "ETH"}. The three scenarios this
// sketch is run for (see file header / branch_adaptation_plan):
//   (default) RESHIELD_OUT_TOKEN=ETH   — OP USDC -> Mainnet ETH  (B2: expected relaySwap failure, LZ fee)
//   RESHIELD_OUT_TOKEN=USDC            — OP USDC -> Mainnet USDC  (B2: expected relaySwap failure)
//   RESHIELD_SRC_TOKEN=ETH RESHIELD_OUT_TOKEN=ETH — OP ETH -> Mainnet ETH (B2: expected relaySwap failure, native branch)
// The SDK's PoolSessionDeposit handles native ETH natively (computeMsgValue / no approve),
// so no source-side branching is needed here — only the token address changes.
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
  process.env.RESHIELD_OUT_TOKEN ?? "ETH"
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
  (SRC_TOKEN.decimals === 18 ? "3000000000000000" : "10000000");

const OP_POOL_ADDRESS = getContract(SOURCE_CHAIN_ID, "PoolVault");
const OP_ENTRYPOINT_ADDRESS = getContract(SOURCE_CHAIN_ID, "Entrypoint");
const OP_KEYSTORE_ADDRESS = getContract(SOURCE_CHAIN_ID, "Keystore");
const OP_ASP_REGISTRY_ADDRESS = getContract(SOURCE_CHAIN_ID, "ASPRegistry");
const OP_RELAY_SWAPS_ADDRESS = getContract(SOURCE_CHAIN_ID, "RelaySwaps");

// Real ASP both chains' live dust-rescue-service config already points at
// (.dust-rescue-service.config.json / .asp_data's ASP_DOMAIN, cross-checked matching).
// PoolSessionBuilder has NO implicit default here — `aspUrl` (or an explicit
// `.withAspDataProvider()` override) is a REQUIRED config field; omitting it throws at
// `.create()`. The version of this sketch drafted 2026-08-20 omitted it entirely.
const ASP_URL = process.env.LIVE_ASP_URL ?? "https://api-dev.0xbow.io";

// Envio HyperIndex-backed leaf-cache seed for the Mainnet-side destSession only —
// coverage-checked 2026-08-24 (see leaf_indexer_context.md): this indexer's
// chain_metadata claims full Optimism coverage but has ZERO leaf-event rows for our
// real chain-10 contracts (checked directly: no PoolVaultV2_LeavesInserted /
// Keystore_LeafInserted / Keystore_LeafUpdated row anywhere in Optimism's real block
// range), so it must NOT be used for the source (Optimism) session. Mainnet is
// different: its indexed PoolVault (0x8884DC0c0DEcd2558F128ee00dD522ABfa21Dd52) is an
// EXACT match to deployments-it-003.json's real, four-ways-verified chain-1 PoolVault —
// confirmed real coverage, safe to use here. `isKnownRoot()` is not yet wired in
// anywhere in the SDK (see leaf_indexer_context.md item 3), so this is deliberately
// used for the destSession's own convenience only, never to seed a proof directly
// trusted without the session's normal on-chain reconciliation.
const HYPERINDEX_ENDPOINT =
  process.env.HYPERINDEX_ENDPOINT ??
  "https://indexer.hyperindex.xyz/cf03704/v1/graphql";
const GQL_KEY = process.env.GQL_KEY;

const MAINNET_POOL_ADDRESS = getContract(DEST_CHAIN_ID, "PoolVault");
const MAINNET_ENTRYPOINT_ADDRESS = getContract(DEST_CHAIN_ID, "Entrypoint");
const MAINNET_KEYSTORE_ADDRESS = getContract(DEST_CHAIN_ID, "Keystore");
const MAINNET_ASP_REGISTRY_ADDRESS = getContract(DEST_CHAIN_ID, "ASPRegistry");

// Event-scan lower bounds — see getDeployBlock()'s own doc comment on why the
// "past implementations" block (not necessarily literal proxy creation) is fine here.
// getDeployBlock() returns Hex | undefined (a chain can lack a deployBlock entry);
// both chains have one filled in in deployments-it-003.json, so fail fast here instead
// of letting a future missing entry surface as a confusing type/runtime error deep in
// saveRecoverySnapshot()'s required (non-optional) `deploymentBlock: Hex`.
const OP_DEPLOYMENT_BLOCK = getDeployBlock(SOURCE_CHAIN_ID);
const MAINNET_DEPLOYMENT_BLOCK = getDeployBlock(DEST_CHAIN_ID);
if (!OP_DEPLOYMENT_BLOCK || !MAINNET_DEPLOYMENT_BLOCK) {
  throw new Error(
    "Missing deployBlock for chain 10 or chain 1 in deployments-it-003.json — required for saveRecoverySnapshot().",
  );
}

// The dust-rescue-service's own signer/recipient wallet (handoff doc: reused
// ASP_POSTMAN_PRIVATE_KEY / SIGNER_PRIVATE_KEY_8453 identity, deliberate staging
// deviation from isolated-key custody). This is `dust_rescue_recipient_address` in
// both chains' relayer config — the address dust #1 ultimately lands at on the
// destination chain after DustRescueForwardingService.forward() bridges it over.
// Textually IDENTICAL to `account.address` (derived from ASP_POSTMAN_PRIVATE_KEY above)
// — NOT a coincidence, and not the same role: `account` submits the source-chain
// deposit/reshield txs in this test; this constant is asserted in step 5 as the
// SENDER of the separate, later rescue-deposit tx dust-rescue-service itself submits
// on Mainnet. They happen to be the same staging key for the reasons the deviation note
// above explains — re-verify this assertion still makes sense if that key reuse is ever
// unwound (see "Deliberate deviation, still open" in dust_Collector_deploy_handoff.md).
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
// — not part of the SDK's public export surface, so re-declared here rather than
// reaching into SDK internals, same convention the reference test uses for its own
// local ERC20_TRANSFER_EVENT_ABI.
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
 * Ambient `gcloud` credentials — same mechanism already used to verify the deploy
 * itself (dust_Collector_deploy_handoff.md). Whoever runs this test needs `gcloud auth
 * login` done beforehand; no service-account key is embedded here.
 */
function firestoreAccessToken(): string {
  return execSync("gcloud auth print-access-token", {
    encoding: "utf8",
  }).trim();
}

/**
 * Minimal decoder for the top-level scalar fields this test actually reads (state,
 * depositTxHash, lastError) — NOT a general Firestore REST value decoder. Nested
 * map/array fields (usdRate, recipientIdentifier, ...) are ignored; extend this if a
 * future check needs them.
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
 * Reads `dustRescueJobs/{sourceTxHash}` (job.types.ts: doc ID is the job's own
 * sourceTxHash) directly via the Firestore REST API — dust-rescue-service exposes no
 * HTTP job-status route (confirmed: only POST /sweep and POST /pubsub/pending).
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
  "LIVE cross-chain reshield + dust rescue: Optimism USDC -> Mainnet ETH",
  () => {
    let account: ReturnType<typeof privateKeyToAccount>;
    let sourceSession: PoolSession;
    let destSession: PoolSession;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let recipientPrivateKey: Uint8Array;
    let recipientIdentifier: StealthRecipientIdentifier;
    let opWalletClient: ReturnType<typeof createWalletClient>;
    let mainnetWalletClient: ReturnType<typeof createWalletClient>;
    let opPublicClient: ReturnType<typeof createPublicClient>;
    let mainnetPublicClient: ReturnType<typeof createPublicClient>;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;

    beforeAll(async () => {
      // ASP-approved wallet, not an arbitrary depositor — see the config comment above.
      account = privateKeyToAccount(ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`);
      opWalletClient = createWalletClient({
        account,
        chain: optimism,
        transport: http(OP_RPC),
      });
      mainnetWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });
      // Cast needed for opPublicClient specifically: viem's OP-Stack chain config
      // (optimism) infers an extra "deposit" transaction variant that doesn't structurally
      // match the bare `ReturnType<typeof createPublicClient>` annotation above — same
      // issue and same fix the reference test uses for its own basePublicClient.
      opPublicClient = createPublicClient({
        chain: optimism,
        transport: http(OP_RPC),
      }) as unknown as ReturnType<typeof createPublicClient>;
      mainnetPublicClient = createPublicClient({
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });

      // --- Fresh stealth identity for the rescue note, same as the reference test ---
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
        resolve(__dirname, "../.live-op-mainnet-dust-rescue-state.json"),
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

      // relayerInfo — points at the LIVE relayer, chain 10 (source-chain reshield
      // is submitted through the relayer's Optimism-scoped route/processor).
      relayerInfo = {
        url: RELAYER_URL,
        name: "live-testing",
        chainId: SOURCE_CHAIN_ID,
        chainType: "evm",
        status: "active",
        // Relayer's own Optimism (chain 10) signer address — derived locally from
        // RELAYER-TEST-CONFIG.JSON's chains.evm[10].signer_private_key (the private key
        // itself was never printed or logged, only the address it derives to), then
        // cross-checked directly against Optimism mainnet: nonce 19950 as of
        // 2026-08-21 — consistent with an active relayer hot wallet, not a fresh/unused
        // key. Confirmed distinct from DUST_RESCUE_SERVICE_WALLET, as expected (this is
        // the relayer's own operational signer; that constant is dust-rescue-service's
        // forwarding target — different roles). Note: 0 ETH balance at verification
        // time — the relayer presumably tops up gas per-batch; re-check first if the
        // relay-swap call itself reverts for insufficient funds.
        address: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf" as Address,
        processorAddress: OP_RELAY_SWAPS_ADDRESS,
      };

      // --- SOURCE session (Optimism). Deliberately NOT LocalASPTreeService — unlike
      // the reference test's fully self-contained Arb/Base flow, this hits the REAL
      // ASP (api-dev.0xbow.io, per .asp_data's ASP_DOMAIN) the live relayer and
      // dust-rescue-service both already depend on, via `aspUrl` below (RESOLVED:
      // PoolSessionBuilder has no implicit default ASP provider — `aspUrl` or an
      // explicit `.withAspDataProvider()` override is REQUIRED, or `.create()` throws
      // "aspUrl or ipfsGatewayUrl is required..."; the 2026-08-20 draft of this sketch
      // omitted it entirely). ---
      // A second real bug found on the first live retry (2026-08-26): sourceSession has
      // no swapQuoteProvider, which estimateReshieldCrosschainAmount() requires — throws
      // InvalidTransactParams before ever reaching the relayer. The reference test wires
      // this via LiFiSwapQuoteProvider; mirrored below.
      lifiProvider = new LiFiSwapQuoteProvider({});

      sourceSession = await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: OP_RPC,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: OP_POOL_ADDRESS,
          entrypointAddress: OP_ENTRYPOINT_ADDRESS,
          keystoreAddress: OP_KEYSTORE_ADDRESS,
          aspRegistryAddress: OP_ASP_REGISTRY_ADDRESS,
          relaySwapsAddress: OP_RELAY_SWAPS_ADDRESS,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: OP_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: opWalletClient as any,
        },
        destinationChainId: DEST_CHAIN_ID,
        destinationRpcUrl: MAINNET_RPC,
        destinationDeployment: {
          poolAddress: MAINNET_POOL_ADDRESS,
          entrypointAddress: MAINNET_ENTRYPOINT_ADDRESS,
          keystoreAddress: MAINNET_KEYSTORE_ADDRESS,
          aspRegistryAddress: MAINNET_ASP_REGISTRY_ADDRESS,
        },
        logger: consoleLogger,
        deploymentBlock: OP_DEPLOYMENT_BLOCK,
      } as any)
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .create();

      // --- Mainnet leaf-cache seeds from the Envio HyperIndex indexer, coverage-checked
      // above (see the HYPERINDEX_ENDPOINT comment) — skips a live RPC scan for
      // destSession's keystore/state trees. Optional: falls back to the session's normal
      // RPC scan if GQL_KEY isn't set, same as any other unseeded session. ---
      let mainnetKeystoreLeafCacheSeed: LeafCacheSeed | undefined;
      let mainnetStateLeafCacheSeed: LeafCacheSeed | undefined;
      if (GQL_KEY) {
        const indexerConfig: IndexerConfig = {
          endpoint: HYPERINDEX_ENDPOINT,
          apiKey: GQL_KEY,
        };
        console.log("Fetching Mainnet leaf-cache seeds from HyperIndex...");
        [mainnetKeystoreLeafCacheSeed, mainnetStateLeafCacheSeed] =
          await Promise.all([
            fetchKeystoreLeafCacheSeed(
              indexerConfig,
              DEST_CHAIN_ID,
              MAINNET_KEYSTORE_ADDRESS,
            ),
            fetchStateLeafCacheSeed(
              indexerConfig,
              DEST_CHAIN_ID,
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
          "GQL_KEY not set — destSession will do a normal live RPC scan on Mainnet.",
        );
      }

      // --- DEST session (Mainnet) — for prepareDeposit() of the primary reshield note.
      // aspUrl is still a required constructor field even though this session's own
      // calls (prepareDeposit, registerKeystore) never touch the ASP. ---
      destSession = await PoolSessionBuilder.fromConfig({
        chainId: DEST_CHAIN_ID,
        rpcUrl: MAINNET_RPC,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: MAINNET_POOL_ADDRESS,
          entrypointAddress: MAINNET_ENTRYPOINT_ADDRESS,
          keystoreAddress: MAINNET_KEYSTORE_ADDRESS,
          aspRegistryAddress: MAINNET_ASP_REGISTRY_ADDRESS,
        },
        keystoreLeafCacheSeed: mainnetKeystoreLeafCacheSeed,
        stateLeafCacheSeed: mainnetStateLeafCacheSeed,
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        // Required even though destSession never actually relays anything (only
        // prepareDeposit/registerKeystore, both local/on-chain-direct) — PoolSessionBuilder
        // throws InvalidBuilderConfig ("At least one relayer is required...") on an empty
        // list regardless. Same "unused" placeholder shape the reference test uses for its
        // own destSession.
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
          walletClient: mainnetWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: MAINNET_DEPLOYMENT_BLOCK,
      } as any).create();
    }, 120_000);

    it(
      `full flow: reshield ${RESHIELD_SRC_TOKEN} (Optimism) -> ${RESHIELD_OUT_TOKEN} (Mainnet), dustRescue opted in, verified via LIVE pipeline`,
      async () => {
        const depositAmount = BigInt(DEPOSIT_AMOUNT);

        // === 1. Fund the source note (deposit USDC on Optimism) ===
        // ERC-20 approve is handled internally by prepareDeposit/executeDeposit
        // (PoolSessionDeposit.ts builds an approval tx sized value+fee automatically
        // when the current allowance is insufficient) — no manual vetting-fee read or
        // approve() call needed; the reference test relies on this same auto-approve,
        // it just doesn't call it out explicitly.
        console.log(
          `\nDepositing ${formatUnits(depositAmount, SRC_TOKEN.decimals)} ${SRC_TOKEN.label} on Optimism...`,
        );
        if (!(await sourceSession.isKeystoreRegistered())) {
          const sourceReceipts = await sourceSession.registerKeystore();
          expect(sourceReceipts.every((r) => r.status)).toBe(true);
        }

        const sourceDepositResult = await sourceSession.prepareDeposit({
          tokenId: SRC_TOKEN.address,
          value: `0x${depositAmount.toString(16)}` as Hex,
        });
        mkdirSync(OP_NOTE_STORAGE_DIR, { recursive: true });
        writeFileSync(
          resolve(OP_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
          JSON.stringify(sourceDepositResult.pendingNote, null, 2),
        );

        const sourceDepositReceipt =
          await sourceSession.executeDeposit(sourceDepositResult);
        expect(sourceDepositReceipt.status).toBe(true);
        console.log("Optimism deposit tx:", sourceDepositReceipt.txHash);

        const sourceDepositTx = await opPublicClient.getTransaction({
          hash: sourceDepositReceipt.txHash as Hex,
        });
        const depositSnapshotPath = await saveRecoverySnapshot({
          publicClient: opPublicClient as any,
          chainId: SOURCE_CHAIN_ID,
          depositTxHash: sourceDepositReceipt.txHash as Hex,
          depositBlock: sourceDepositTx.blockNumber!,
          deploymentBlock: OP_DEPLOYMENT_BLOCK,
          ownerAddress: account.address as Address,
          contracts: {
            pool: OP_POOL_ADDRESS,
            entrypoint: OP_ENTRYPOINT_ADDRESS,
            keystore: OP_KEYSTORE_ADDRESS,
            aspRegistry: OP_ASP_REGISTRY_ADDRESS,
          },
          protocolKeys: state.protocolKeys,
          note: sourceDepositResult.pendingNote,
          storageDir: OP_RECOVERY_SNAPSHOT_DIR,
        });

        // Real ASP (unlike LocalASPTreeService) approves labels asynchronously off its
        // own on-chain event scan — there's no client-side "register" call to make.
        //
        // NOT gated on discoverNotes()'s return value (that was the bug in the first live
        // run — see dust_rescue_asp_label_status_postmortem.md "confirmed bug on our
        // side"): the returned array only contains notes newly discovered in that specific
        // call. A note already known to the SDK is excluded from later calls' return value
        // regardless of its current status, so tracking "is it ACTIVE yet" from that array
        // across repeated polls silently degrades to "not found" — exactly what happened.
        //
        // Also NOT sufficient on its own: `/labels/{labelHash}/status` reaching "approved".
        // Direct investigation (same postmortem doc) found approval happens fast (~21s) but
        // is DECOUPLED from the label hash actually appearing in
        // `/association-set/leaves` — observed 40+ minutes of gap in practice. Spending
        // requires a ZK proof of tree membership, not just an approval flag; a note whose
        // label was "approved" but isn't yet in the tree will fail that proof. So: poll
        // approval first (fast, cheap), then poll the actual tree for our label hash
        // (the real gate), THEN let the SDK's own discoverNotes() catch its internal state
        // up before we try to spend anything.
        const fromBlock =
          `0x${(sourceDepositTx.blockNumber! - 1n).toString(16)}` as Hex;
        const hashService = await PoseidonHashService.create();
        const noteComputationService = new NoteComputationService({
          hashService,
          cryptoService: new CryptoService(),
        });
        const labelHash = noteComputationService.computeLabelHash(
          sourceDepositResult.pendingNote.label as Hash,
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
          `Label ${sourceDepositResult.pendingNote.label} was not ASP-approved`,
        );

        console.log(
          "Label approved. Waiting for it to appear in the association-set tree " +
            "(the actual gate for a valid membership proof — approval alone isn't enough, " +
            "see dust_rescue_asp_label_status_postmortem.md)...",
        );
        await pollUntil(
          async () => {
            const res = await fetch(
              `${ASP_URL}/association-set/leaves?chainId=${SOURCE_CHAIN_ID}&entrypoint=${OP_ENTRYPOINT_ADDRESS}`,
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

        // Now let the SDK's own internal NoteManager catch up so it reflects ACTIVE
        // before we try to spend this note.
        await sourceSession.discoverNotes({ fromBlock });
        console.log(
          "Source note ACTIVE — ASP approved and tree-included. Proceeding to reshield.",
        );

        // === 2. Estimate + prepare the cross-chain reshield, dustRescue opted in ===
        const estimate = await sourceSession.estimateReshieldCrosschainAmount({
          relayerInfo,
          amount: `0x${depositAmount.toString(16)}` as Hex,
          tokenId: SRC_TOKEN.address,
          outputToken: OUT_TOKEN.address,
          toChainId: DEST_CHAIN_ID,
          toChainType: "evm",
          slippage: RESHIELD_SLIPPAGE,
          denyExchanges: DENY_EXCHANGES,
        });

        if (!(await destSession.isKeystoreRegistered())) {
          const receipts = await destSession.registerKeystore();
          expect(receipts.every((r) => r.status)).toBe(true);
        }

        const destDepositResult = await destSession.prepareDeposit({
          tokenId: OUT_TOKEN.address,
          value: estimate.noteValue,
        });

        const prepared = await sourceSession.prepareReshieldCrosschainQuote({
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
          "Resolved dustRecipient (source-chain, dust #1):",
          prepared.dustRecipient,
        );

        // === 3. Execute — this is the real, irreversible, real-money step ===
        if (!LIVE_DUST_RESCUE_CONFIRM) {
          throw new Error(
            "Refusing to submit the real, irreversible relayReshieldCrosschain call: set " +
              "LIVE_DUST_RESCUE_CONFIRM=yes to proceed. This moves real money through a live bridge.",
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
        console.log("Optimism RelaySwaps tx (sourceTxHash):", txReceipt.txHash);
        expect(txReceipt.status).toBe(true);
        const sourceTxHash = txReceipt.txHash as Hex;
        markAsRecovered(depositSnapshotPath);

        // At this point, per relay.controller.ts -> evm.relay.service.ts, the live
        // relayer has (a) awaited DustRescueForwardingService.forward() synchronously
        // for dust #1, and (b) called DustRescueOrchestratorService.registerPending()
        // to publish the combined-dust job to Pub/Sub — both already happened by the
        // time this HTTP call returned. Nothing left to trigger from our side.

        // === 4. Wait for the LIVE pipeline: Pub/Sub -> dust-rescue-service ->
        // Firestore -> proving -> on-chain submission ===
        // No HTTP job-status route exists on dust-rescue-service (confirmed — only
        // POST /sweep and POST /pubsub/pending), so this polls the `dustRescueJobs`
        // Firestore collection directly via REST (fetchDustRescueJob, top of file).
        // Timeout is generous: proving alone runs 30-60s per the reference test's own
        // comment, a cold-start Cloud Run instance adds more, and in the worst case the
        // push subscription is slow enough that this has to wait for Cloud Scheduler's
        // next /sweep tick (every 5 min).
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

        // === 5. Independent on-chain verification of the result — don't trust
        // Firestore's `state` field alone (same "don't trust the service's own
        // accounting of itself" principle as sumTransfersTo() in the reference test). ===
        const depositReceipt = await mainnetPublicClient.getTransactionReceipt({
          hash: job.depositTxHash as Hex,
        });
        expect(depositReceipt.status).toBe("success");
        expect(getAddress(depositReceipt.from)).toBe(
          getAddress(DUST_RESCUE_SERVICE_WALLET),
        );

        const depositedEvent = depositReceipt.logs
          .filter(
            (log) =>
              getAddress(log.address) === getAddress(MAINNET_POOL_ADDRESS),
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
          "Rescue deposit confirmed on-chain — commitment:",
          depositedEvent!.args.outputCommitment,
        );

        // TODO (stretch, not yet implemented): recover/decrypt the resulting note with
        // recipientPrivateKey, same as mainnet-recover-dust-rescue-notes
        // .integration.test.ts's companion recovery flow, to prove the value is
        // actually spendable by the intended recipient, not just "a deposit tx happened".
      },
      // Generous overall budget: ASP label-approval wait (up to 5 min) + the
      // association-set tree-inclusion wait (up to 60 min — the slow, uncertain part per
      // the postmortem) + LiFi/proving steps (reference test's own comment: these run
      // long) + the dust-rescue-service pipeline's own up-to-15-min wait, with margin.
      90 * 60_000,
    );
  },
);

// Ported verbatim from mainnet-crosschain-relay-swaps-reshield-to-base-dust-rescue
// .integration.test.ts — same EIP-712 domain/payload, so this derives the SAME
// protocolKeys for a given account+signature regardless of which test asks for them.
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
