/**
 * LIVE cross-chain reshield-and-TRANSFER: BSC (source) -> Mainnet (destination), deposited
 * as a yield share (ppUSDC) owned by a THIRD-PARTY recipient — via
 * `PoolSessionReshieldTransferCrosschain` (§5.1 of
 * `~/Documentos/FatSolutions/RelayerPrivacyPools/reshield_and_transfer.org`: verifying the
 * relayer treats a reshield-transfer request identically to a plain reshield's, against a
 * real deployment rather than by code inspection alone).
 *
 * WHY BSC -> MAINNET, NOT ARBITRUM -> BASE (unlike this directory's other
 * `mainnet-crosschain-relay-swaps-reshield-to-*` suites): those target it-002, a staging
 * pair where both ends still accept plain USDC. it-004 ("V2 PROD",
 * `packages/contracts/DEPLOYMENTS.md`) does not — its Mainnet Entrypoint had plain
 * USDC/USDT DISABLED on 2026-09-04 (see
 * `~/Documentos/FatSolutions/RelayerPrivacyPools/dust_Collector_deploy_handoff.md`,
 * "PAUSED (2026-09-04)" section) in favor of `ppUSDC`/`ppUSDT` (ERC-4626 wrappers over
 * Aave-yield `aEthUSDC`/`aEthUSDT`) plus native ETH. it-004's BSC Entrypoint has USDC
 * disabled too (only native BNB and USDT enabled). The only currently-viable real corridor
 * is therefore **BSC USDT -> Mainnet ppUSDC** — this suite is not a stylistic choice, it's
 * the only shape this feature can actually be exercised in in against real infra right now.
 *
 * WHY TRANSFER, NOT PLAIN RESHIELD: this session added `PoolSessionReshieldTransferCrosschain`
 * on top of the pre-existing `PoolSessionReshieldCrosschain` (see
 * `packages/sdk/src/services/poolSessions/PoolSessionReshieldTransferCrosschain.ts`) — same
 * estimate/quote/relay calls, but the destination deposit is built via
 * `prepareReshieldTransferCrosschainDeposit()` against a genuinely different recipient
 * address instead of the withdrawer's own. `RECIPIENT_ADDRESS` below is a second, unrelated
 * EOA — deliberately not derived from `ASP_POSTMAN_PRIVATE_KEY` — otherwise this test
 * would not actually exercise deposit-for-a-third-party at all.
 *
 * it-004 CORE ADDRESSES (mainnet, citrea, bsc — deliberately IDENTICAL across all three,
 * a real multi-chain CREATE2/factory deploy, not a copy-paste bug) and the ppUSDC/ppUSDT
 * yield deployment addresses below are inlined rather than read from
 * `packages/swaps/contracts/deployments-it-004.json` — that registry file was never
 * committed to this branch (only exists on `fat/swaps/pay-reshield-fee-with-value-rebased`,
 * commit a90a3d6e). Core contracts + ppUSDC's router/zap sourced from that branch's
 * `packages/contracts/DEPLOYMENTS.md` (verified on-chain 2026-09-01) and
 * `dust_Collector_deploy_handoff.md` (ppUSDC's router/zap, discovered via event-log
 * archaeology 2026-09-04 — no router-driven deposit event had been observed on ppUSDT at
 * that point, so its router/zap weren't found that way). Resolved directly on 2026-09-24:
 * the real `PPRouterFactory` (`0x8d238Db4279606F78B2479Be722F21B10a1A09D8` — found via the
 * ppUSDC router's on-chain creator, confirmed genuine because its own
 * `routerFor(ppUSDC vault)` round-trips to the already-known ppUSDC router) answers
 * `routerFor(ppUSDT vault)` with a real, deployed router; that router's and its zap's own
 * `VAULT()`/`UNDERLYING()`/`ENTRYPOINT()`/`POOL_VAULT()`/`POOL()` getters all cross-check
 * against known it-004/Aave-V3 addresses. **Re-verify with a fresh `cast` pass before
 * trusting any of these** — "verified once" is not "still correct now." Both deployments
 * are wired below (`withYieldDeployments([...])`), but this suite's actual run still
 * targets **ppUSDC only** (`OUTPUT_YIELD_DEPLOYMENT` below) — it's the one corridor
 * actually proven against real infra so far; ppUSDT is available for whenever that
 * changes, not exercised by this suite yet. Swapping the active corridor is a one-line
 * change (`OUTPUT_YIELD_DEPLOYMENT`'s assignment).
 *
 * ============================================================================
 * RELAYER — MUST be a local relayer pointed at it-004; no deployed instance can serve this
 * ============================================================================
 * `relayer-v2-testing`'s deployed config has a chain-56 entry that points at a different,
 * unrelated BSC deployment (entrypoint `0x88b0e5...`, not it-004's `0xca1e0722...`) — per
 * the handoff doc, "the deployed relayer-v2-testing cannot serve this matrix at all."
 * Set `LIVE_RELAYER_URL=http://localhost:3000` and run a local relayer hand-configured for
 * it-004 on chain 1 and chain 56 (see `~/Documentos/FatSolutions/RelayerPrivacyPools/
 * testing_dust_with_local_relayer.org` for the runbook and a known-good config shape from
 * a prior session, `relayer_local_1_it004.json`). `RELAYER_BSC_SIGNER_ADDRESS` MUST match
 * that local relayer's actual chain-56 signer — there is no safe hardcoded fallback.
 * ============================================================================
 *
 * ============================================================================
 * REAL ASP — approval latency on this corridor has ranged from seconds to 2+ HOURS
 * ============================================================================
 * `ASP_URL` defaults to `https://api-v2.0xbow.io` — the CORRECT it-004 host (confirmed by
 * the ASP operator 2026-09-02: it-004 is registered there as poolId 1/2/3 for
 * mainnet/citrea/bsc). Do not default to `api-dev.0xbow.io` — every earlier sketch still
 * pointing there is stale; it-004 was never registered on that host, and a real run against
 * it will simply time out waiting for label approval that will never come.
 * Even against the correct host, the handoff doc records real incidents: one Mainnet label
 * stuck "pending" for 2+ hours while other labels around it cleared normally (resolved,
 * cause never identified), and two same-day chain-56 tree-inclusion stalls. This suite's
 * default timeouts (`LIVE_ASP_LABEL_APPROVAL_TIMEOUT_MS` / `LIVE_ASP_TREE_INCLUSION_TIMEOUT_MS`
 * below) reflect that — expect to poll and wait, not to get an instant pass/fail.
 * ============================================================================
 *
 * Real funds move here. Follows this directory's four-part safety pattern
 * (`test/integration_test_standards.org`): postman/depositor wallet separation is NOT
 * applicable in the same way as the LocalASPTreeService suites — this it-004 staging ASP
 * only approves deposits from one specific wallet
 * (`0x0967755AfA2016866D12EefB820705026842dCe8`), so depositor and ASP-approved wallet are
 * deliberately the SAME key here (`ASP_POSTMAN_PRIVATE_KEY`), matching the sibling
 * dust-rescue sketch's own convention for this exact corridor. Recovery snapshot is saved
 * immediately after the irreversible BSC deposit, before ASP polling or the reshield itself
 * can still fail, and marked recovered once the source note is spent by the reshield.
 *
 * The DESTINATION note is NOT the depositor's to recover — it is owned by
 * `RECIPIENT_ADDRESS`, a different identity than `protocolKeys` here derives from. No
 * depositor-side recovery snapshot is saved for it (that would be misleading — the
 * snapshot's ragequit path assumes ownership by the snapshotted `protocolKeys`, which
 * does not hold here). If `RECIPIENT_ADDRESS` has no registered destination-chain viewing
 * key (the expected case for a fresh test address — see `allowOutOfBandFallback` below),
 * the ONLY recovery path is the `noteSecret` this suite writes to
 * `RESCUE_...`-style disk output — see step 4 below and its recovery dir. Losing that file
 * strands the deposit permanently; delivering it to whoever controls `RECIPIENT_ADDRESS`
 * is this test's own responsibility, exactly as `allowOutOfBandFallback`'s contract
 * requires of any real caller.
 *
 * Run:
 *   RESHIELD_SRC_TOKEN=USDT RECIPIENT_ADDRESS=0x... RELAYER_BSC_SIGNER_ADDRESS=0x... \
 *   ASP_POSTMAN_PRIVATE_KEY=0x... RPC_URL_1=https://... LIVE_RELAYER_URL=http://localhost:3000 \
 *   LIVE_TRANSFER_CONFIRM=yes npx vitest run --config vitest.sketch-run.config.ts \
 *   mainnet-crosschain-relay-swaps-reshield-transfer-bsc-to-mainnet-pp
 *
 * Set DRY_RUN_ESTIMATE=yes (no deposit, no ASP wait) to just quote the reshield-transfer
 * and see whether the resulting ppUSDC note value looks sane before committing real funds.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, bsc } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";

import {
  PoolSessionBuilder,
  APP_IDENTIFIER,
  CryptoService,
  EvmPoolSession,
  HTTPClient,
  KeystoreManager,
  LiFiSwapQuoteProvider,
} from "@privacy-pools-v2/evm-sdk";
import type { Address, ILogger, RelayerInfo } from "@privacy-pools-v2/evm-sdk";

import {
  TestStatePersistence,
  type MainnetTestState,
} from "./helpers/test-state-persistence.js";
import {
  saveRecoverySnapshot,
  markAsRecovered,
} from "./helpers/recovery-snapshot.js";

// ============================================================================
// it-004 addresses — inlined; see header for provenance and the "re-verify before
// trusting" caveat. Core contracts identical across mainnet/citrea/bsc by construction.
// ============================================================================
const SOURCE_CHAIN_ID = 56; // BSC
const DEST_CHAIN_ID = 1; // Mainnet

const IT004_CORE = {
  PoolVault: "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed" as Address,
  Entrypoint: "0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3" as Address,
  Keystore: "0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71" as Address,
  ASPRegistry: "0x259C0BEa1d783c202509BD3b2688d23b8AEf58B0" as Address,
  RelaySwaps: "0x5936aEfB2134550F3f526d65E984620582D270E7" as Address,
};
const BSC_DEPLOYMENT_BLOCK = "0x71E4093" as Hex; // 119404819 (RelaySwaps' own BSC deploy block)
const MAINNET_DEPLOYMENT_BLOCK = "0x18ABA55" as Hex; // 25884277 (PoolVault's own Mainnet deploy block)

// Binance-Peg USDT, 18dp — the only ENABLED BSC-source option at a small note size
// besides native BNB (min 0.02 BNB). BSC USDC is disabled on it-004's Entrypoint.
const BSC_USDT = {
  address: "0x55d398326f99059fF775485246999027B3197955" as Address,
  decimals: 18,
  label: "USDT",
};

// ppUSDC — ERC-4626 wrapper over Aave-yield aEthUSDC, 18dp share (always 18 for the
// current wrapper, per YieldDeployment's own doc comment). Discovered via event-log
// archaeology 2026-09-04 (dust_Collector_deploy_handoff.md) — recorded nowhere else in
// the repo on any branch.
const MAINNET_PP_USDC_DEPLOYMENT = {
  ppRouter: "0xe76e793d776c1e207ad7a7fa7c57d27420d85110" as Address,
  zap: "0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B" as Address,
  ppUSDC: "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address,
  ppUSDCDecimals: 18,
  underlying: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address, // Mainnet USDC
  underlyingDecimals: 6,
  underlyingSymbol: "USDC",
};

// ppUSDT — ERC-4626 wrapper over Aave-yield aEthUSDT, 18dp share. Its router/zap were
// never observed via event-log archaeology (no router-driven deposit ever made against
// it), so found directly on 2026-09-24 instead: `PPRouterFactory.routerFor(ppUSDT vault)`
// on the real factory (`0x8d238Db4279606F78B2479Be722F21B10a1A09D8`), then cross-checked
// against the returned router's/zap's own getters — see header for the full trail.
// `ppUSDC` below is `YieldDeployment`'s own (generic, share-token-agnostic) field name.
const MAINNET_PP_USDT_DEPLOYMENT = {
  ppRouter: "0x13a0b86bac3e0C29bd64fED7BCD2EE84f371f41C" as Address,
  zap: "0xDC3D922df81FC7B7f58229431ED91acB0482f3A5" as Address,
  ppUSDC: "0xA4cF419558Ef36CC6FfB666195684dC963910426" as Address, // ppUSDT
  ppUSDCDecimals: 18,
  underlying: "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address, // Mainnet USDT
  underlyingDecimals: 6,
  underlyingSymbol: "USDT",
};

// The corridor this suite actually runs against — ppUSDC, the only one proven against
// real infra so far (see header). Both deployments are still registered on the
// destination session below so a future switch to ppUSDT needs only this line changed.
const OUTPUT_YIELD_DEPLOYMENT = MAINNET_PP_USDC_DEPLOYMENT;

// ============================================================================
// Config — env
// ============================================================================
const ASP_POSTMAN_PRIVATE_KEY = process.env.ASP_POSTMAN_PRIVATE_KEY; // FAT_WALLET_A_0, ASP-approved; also the depositor here
const RECIPIENT_ADDRESS = process.env.RECIPIENT_ADDRESS as Address | undefined; // a DIFFERENT identity than the depositor — the whole point of this suite
const RELAYER_BSC_SIGNER_ADDRESS = process.env.RELAYER_BSC_SIGNER_ADDRESS as
  | Address
  | undefined;
const RELAYER_URL = process.env.LIVE_RELAYER_URL ?? "http://localhost:3000"; // no working deployed fallback for it-004, see header
const BSC_RPC = process.env.RPC_URL_56 ?? "https://bsc-dataseed.binance.org";
const MAINNET_RPC = process.env.RPC_URL_1;
const ASP_URL = process.env.LIVE_ASP_URL ?? "https://api-v2.0xbow.io"; // NOT api-dev — see header

const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT ?? "12000000000000000000"; // 12 USDT, 18dp — above the 10 USDT Entrypoint min
const RESHIELD_SLIPPAGE = Number(process.env.RESHIELD_SLIPPAGE ?? "0.1");
const DENY_EXCHANGES = ["fly"];
const RESHIELD_PREPARE_ATTEMPTS = Number(
  process.env.RESHIELD_PREPARE_ATTEMPTS ?? "10",
);

const ASP_LABEL_APPROVAL_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_LABEL_APPROVAL_TIMEOUT_MS ?? 300_000,
);
const ASP_TREE_INCLUSION_TIMEOUT_MS = Number(
  process.env.LIVE_ASP_TREE_INCLUSION_TIMEOUT_MS ?? 3 * 60 * 60_000,
); // 3h — see header's stuck-label history
const ASP_POLL_INTERVAL_MS = Number(
  process.env.LIVE_ASP_POLL_INTERVAL_MS ?? 15_000,
);

// Real, irreversible spend gate — required immediately before relayReshieldTransferCrosschain.
const LIVE_TRANSFER_CONFIRM = process.env.LIVE_TRANSFER_CONFIRM === "yes";

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const BSC_NOTE_STORAGE_DIR = resolve(
  __dirname,
  "../.live-bsc-mainnet-reshield-transfer-bsc-notes",
);
const BSC_RECOVERY_SNAPSHOT_DIR = resolve(
  __dirname,
  "../.live-bsc-mainnet-reshield-transfer-bsc-deposit-notes",
);
// The ONLY recovery path for the destination note when RECIPIENT_ADDRESS has no
// registered viewing key — see header.
const OUT_OF_BAND_RECOVERY_DIR = resolve(
  __dirname,
  "../.live-bsc-mainnet-reshield-transfer-recipient-secrets",
);

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

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
// — not part of the SDK's public export surface. Ported from the BSC-to-Mainnet
// dust-rescue sketch (fat/swaps/pay-reshield-fee-with-value-rebased).
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

// Ported verbatim from the it-004 dust-rescue sketch — same EIP-712 domain/payload every
// mainnet suite in this directory derives protocol keys from.
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

describe.skipIf(
  !ASP_POSTMAN_PRIVATE_KEY ||
    !RECIPIENT_ADDRESS ||
    !RELAYER_BSC_SIGNER_ADDRESS ||
    !MAINNET_RPC ||
    !hasCircuits,
)(
  "LIVE cross-chain reshield-and-transfer: BSC USDT -> Mainnet ppUSDC (it-004)",
  () => {
    let account: ReturnType<typeof privateKeyToAccount>;
    let sourceSession: EvmPoolSession;
    let destSession: EvmPoolSession;
    let state: MainnetTestState;
    let persistence: TestStatePersistence;
    let relayerInfo: RelayerInfo;
    let bscWalletClient: ReturnType<typeof createWalletClient>;
    let mainnetWalletClient: ReturnType<typeof createWalletClient>;
    let bscPublicClient: ReturnType<typeof createPublicClient>;
    let mainnetPublicClient: ReturnType<typeof createPublicClient>;
    let lifiProvider: InstanceType<typeof LiFiSwapQuoteProvider>;

    beforeAll(async () => {
      account = privateKeyToAccount(ASP_POSTMAN_PRIVATE_KEY! as `0x${string}`);
      bscWalletClient = createWalletClient({
        account,
        chain: bsc,
        transport: http(BSC_RPC),
      });
      mainnetWalletClient = createWalletClient({
        account,
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });
      bscPublicClient = createPublicClient({
        chain: bsc,
        transport: http(BSC_RPC),
      });
      mainnetPublicClient = createPublicClient({
        chain: mainnet,
        transport: http(MAINNET_RPC),
      });

      persistence = new TestStatePersistence(
        resolve(__dirname, "../.live-bsc-mainnet-reshield-transfer-state.json"),
      );
      const saved = persistence.load();
      const protocolKeys =
        saved?.protocolKeys ??
        (await deriveProtocolKeys(account, bscWalletClient));
      state = saved ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);

      relayerInfo = {
        url: RELAYER_URL,
        name: "live-testing",
        chainId: SOURCE_CHAIN_ID,
        chainType: "evm",
        status: "active",
        address: RELAYER_BSC_SIGNER_ADDRESS!,
        processorAddress: IT004_CORE.RelaySwaps,
      };

      lifiProvider = new LiFiSwapQuoteProvider({});

      // --- DEST session (Mainnet) first — its `.yields` feeds sourceSession's
      // `withDestinationYieldDepositTargets()` below. Hits the real ASP via `aspUrl`; no
      // registerKeystore() call here on purpose — the resulting note is owned by
      // RECIPIENT_ADDRESS, not by this session's own identity, so there is nothing to
      // register for this flow (recipient resolution happens two layers down, inside the
      // destination-chain-scoped PoolSessionYieldDeposit this session's `.yields` wraps). ---
      destSession = (await PoolSessionBuilder.fromConfig({
        chainId: DEST_CHAIN_ID,
        rpcUrl: MAINNET_RPC!,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: IT004_CORE.PoolVault,
          entrypointAddress: IT004_CORE.Entrypoint,
          keystoreAddress: IT004_CORE.Keystore,
          aspRegistryAddress: IT004_CORE.ASPRegistry,
          relaySwapsAddress: IT004_CORE.RelaySwaps,
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
        persistentStorage: { type: "memory" },
        walletInteractor: {
          type: "viem",
          walletClient: mainnetWalletClient as any,
        },
        logger: consoleLogger,
        deploymentBlock: MAINNET_DEPLOYMENT_BLOCK,
      } as any)
        .withYieldDeployments([
          MAINNET_PP_USDC_DEPLOYMENT,
          MAINNET_PP_USDT_DEPLOYMENT,
        ])
        .create()) as EvmPoolSession;

      // --- SOURCE session (BSC). Hits the real ASP via `aspUrl`. `.withHttpClient(...)`
      // works around the known SDK bug where the default 15s HTTP timeout retries
      // POST /relay-swap after a slow relay's receipt wait, re-submitting an
      // already-landed tx against an already-spent commitment and throwing a false
      // RelayerRejected (see dust_Collector_deploy_handoff.md's "known gotchas"). ---
      sourceSession = (await PoolSessionBuilder.fromConfig({
        chainId: SOURCE_CHAIN_ID,
        rpcUrl: BSC_RPC,
        aspUrl: ASP_URL,
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: IT004_CORE.PoolVault,
          entrypointAddress: IT004_CORE.Entrypoint,
          keystoreAddress: IT004_CORE.Keystore,
          aspRegistryAddress: IT004_CORE.ASPRegistry,
          relaySwapsAddress: IT004_CORE.RelaySwaps,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: BSC_NOTE_STORAGE_DIR },
        walletInteractor: {
          type: "viem",
          walletClient: bscWalletClient as any,
        },
        destinationChainId: DEST_CHAIN_ID,
        destinationRpcUrl: MAINNET_RPC,
        destinationDeployment: {
          poolAddress: IT004_CORE.PoolVault,
          entrypointAddress: IT004_CORE.Entrypoint,
          keystoreAddress: IT004_CORE.Keystore,
          aspRegistryAddress: IT004_CORE.ASPRegistry,
          relaySwapsAddress: IT004_CORE.RelaySwaps,
        },
        logger: consoleLogger,
        deploymentBlock: BSC_DEPLOYMENT_BLOCK,
      } as any)
        .withSwapQuoteProvider(lifiProvider)
        .withSwapAndDepositQuoteProvider(lifiProvider)
        .withDestinationYieldDepositTargets([...destSession.yields])
        .withHttpClient(new HTTPClient({ timeout: 120_000, retryAttempts: 0 }))
        .create()) as EvmPoolSession;

      console.log(
        "Source (BSC) and destination (Mainnet, ppUSDC-enabled) sessions ready",
      );
    }, 120_000);

    it("full flow: reshield-and-transfer USDT (BSC) -> ppUSDC (Mainnet), owned by RECIPIENT_ADDRESS", async () => {
      const depositAmount = BigInt(DEPOSIT_AMOUNT);

      // === 0. DRY_RUN_ESTIMATE — viability check with NO irreversible action ===
      if (process.env.DRY_RUN_ESTIMATE === "yes") {
        console.log(
          `DRY_RUN_ESTIMATE — quoting reshield-transfer of ${formatUnits(depositAmount, BSC_USDT.decimals)} ` +
            `USDT (BSC) -> ppUSDC (Mainnet), no deposit made.`,
        );
        const estimate =
          await sourceSession.estimateReshieldTransferCrosschainAmount({
            relayerInfo,
            amount: `0x${depositAmount.toString(16)}` as Hex,
            tokenId: BSC_USDT.address,
            outputToken: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
            toChainId: DEST_CHAIN_ID,
            toChainType: "evm",
            slippage: RESHIELD_SLIPPAGE,
            denyExchanges: DENY_EXCHANGES,
          });
        console.log("estimate:", JSON.stringify(estimate, null, 2));
        console.log(
          `=> ppUSDC noteValue = ${formatUnits(BigInt(estimate.noteValue), OUTPUT_YIELD_DEPLOYMENT.ppUSDCDecimals)} ` +
            `shares (raw ${estimate.noteValue}).`,
        );
        throw new Error(
          "DRY_RUN_ESTIMATE complete — no deposit made, no money moved. Unset DRY_RUN_ESTIMATE " +
            "(and set LIVE_TRANSFER_CONFIRM=yes) for the real run.",
        );
      }

      // === 1. Fund the source note (deposit USDT on BSC) ===
      console.log(
        `\nDepositing ${formatUnits(depositAmount, BSC_USDT.decimals)} USDT on BSC...`,
      );
      if (!(await sourceSession.isKeystoreRegistered())) {
        const receipts = await sourceSession.registerKeystore();
        expect(receipts.every((r) => r.status)).toBe(true);
      }

      const sourceDepositResult = await sourceSession.prepareDeposit({
        tokenId: BSC_USDT.address,
        value: `0x${depositAmount.toString(16)}` as Hex,
      });
      mkdirSync(BSC_NOTE_STORAGE_DIR, { recursive: true });
      writeFileSync(
        resolve(BSC_NOTE_STORAGE_DIR, `pending-${Date.now()}.json`),
        JSON.stringify(sourceDepositResult.pendingNote, null, 2),
      );

      const sourceDepositReceipt =
        await sourceSession.executeDeposit(sourceDepositResult);
      expect(sourceDepositReceipt.status).toBe(true);
      console.log("BSC deposit tx:", sourceDepositReceipt.txHash);

      const sourceDepositTx = await bscPublicClient.getTransaction({
        hash: sourceDepositReceipt.txHash as Hex,
      });
      const depositSnapshotPath = await saveRecoverySnapshot({
        publicClient: bscPublicClient as any,
        chainId: SOURCE_CHAIN_ID,
        depositTxHash: sourceDepositReceipt.txHash as Hex,
        depositBlock: sourceDepositTx.blockNumber!,
        deploymentBlock: BSC_DEPLOYMENT_BLOCK,
        ownerAddress: account.address as Address,
        contracts: {
          pool: IT004_CORE.PoolVault,
          entrypoint: IT004_CORE.Entrypoint,
          keystore: IT004_CORE.Keystore,
          aspRegistry: IT004_CORE.ASPRegistry,
        },
        protocolKeys: state.protocolKeys,
        note: sourceDepositResult.pendingNote,
        storageDir: BSC_RECOVERY_SNAPSHOT_DIR,
      });

      // Real ASP approves labels asynchronously off its own on-chain event scan — poll
      // approval first (fast), then the actual association-set tree (the real gate),
      // THEN let discoverNotes() catch up before spending. See header for how long this
      // has taken historically on this corridor.
      const fromBlock =
        `0x${(sourceDepositTx.blockNumber! - 1n).toString(16)}` as Hex;
      const labelHashDecimal = BigInt(
        sourceDepositResult.pendingNote.label,
      ).toString();

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
        "Label approved. Waiting for association-set tree inclusion...",
      );
      await pollUntil(
        async () => {
          const res = await fetch(
            `${ASP_URL}/association-set/leaves?chainId=${SOURCE_CHAIN_ID}&entrypoint=${IT004_CORE.Entrypoint}`,
          );
          if (!res.ok) return false;
          const body = (await res.json()) as { leaves?: string[] };
          const included = (body.leaves ?? []).includes(labelHashDecimal);
          console.log(
            `  leaf present in association set: ${included} (${(body.leaves ?? []).length} total)`,
          );
          return included;
        },
        ASP_TREE_INCLUSION_TIMEOUT_MS,
        ASP_POLL_INTERVAL_MS,
        `Label hash for ${sourceDepositResult.pendingNote.label} did not appear in the association-set tree`,
      );

      await sourceSession.discoverNotes({ fromBlock });
      console.log("Source note ACTIVE — proceeding to reshield-and-transfer.");

      // === 2. Estimate + prepare the destination (ppUSDC) deposit-for, with a retry loop
      // for LiFi route flakiness (same pattern the it-004 dust-rescue sketch uses) ===
      let estimate:
        | Awaited<
            ReturnType<
              typeof sourceSession.estimateReshieldTransferCrosschainAmount
            >
          >
        | undefined;
      let destDepositResult:
        | Awaited<
            ReturnType<
              typeof sourceSession.prepareReshieldTransferCrosschainDeposit
            >
          >
        | undefined;
      let prepared:
        | Awaited<
            ReturnType<
              typeof sourceSession.prepareReshieldTransferCrosschainQuote
            >
          >
        | undefined;

      for (let attempt = 1; attempt <= RESHIELD_PREPARE_ATTEMPTS; attempt++) {
        try {
          estimate =
            await sourceSession.estimateReshieldTransferCrosschainAmount({
              relayerInfo,
              amount: `0x${depositAmount.toString(16)}` as Hex,
              tokenId: BSC_USDT.address,
              outputToken: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
              toChainId: DEST_CHAIN_ID,
              toChainType: "evm",
              slippage: RESHIELD_SLIPPAGE,
              denyExchanges: DENY_EXCHANGES,
            });

          // The whole point of this suite: the destination note is built for
          // RECIPIENT_ADDRESS, not for `account`. allowOutOfBandFallback: true covers the
          // expected case (a fresh test address with no registered Mainnet viewing key) —
          // without it, an unregistered recipient throws DepositRecipientViewingKeyUnregistered.
          destDepositResult =
            await sourceSession.prepareReshieldTransferCrosschainDeposit({
              outputToken: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
              totalDepositCost: estimate.totalDepositCost,
              discoveryData: {
                evmAddress: RECIPIENT_ADDRESS!,
                allowOutOfBandFallback: true,
              },
            });

          prepared = await sourceSession.prepareReshieldTransferCrosschainQuote(
            {
              relayerInfo,
              amount: `0x${depositAmount.toString(16)}` as Hex,
              tokenId: BSC_USDT.address,
              outputToken: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
              toChainId: DEST_CHAIN_ID,
              toChainType: "evm",
              depositResult: destDepositResult,
              totalDepositCost: estimate.totalDepositCost,
              slippage: RESHIELD_SLIPPAGE,
              denyExchanges: DENY_EXCHANGES,
            },
          );
          console.log(
            `prepareReshieldTransferCrosschainQuote succeeded on attempt ${attempt}.`,
          );
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const assertLifiBudgetTrip =
            /Invalid transact params/.test(msg) &&
            /LiFi needs .* input but only .* available after fee/.test(msg);
          const lifiRouteStale =
            /Market conditions have changed/i.test(msg) ||
            /request a new route/i.test(msg) ||
            /SwapQuoteFailed/.test(msg) ||
            /\b(?:422|429|502|503|504)\b/.test(msg);
          const retryable = assertLifiBudgetTrip || lifiRouteStale;
          if (!retryable || attempt === RESHIELD_PREPARE_ATTEMPTS) throw e;
          console.warn(
            `  attempt ${attempt}/${RESHIELD_PREPARE_ATTEMPTS} failed retryably ` +
              `(${msg.replace(/\s+/g, " ").slice(0, 120)}) — retrying in 4s...`,
          );
          await new Promise((r) => setTimeout(r, 4000));
        }
      }
      if (!prepared || !destDepositResult)
        throw new Error(
          "prepareReshieldTransferCrosschainQuote never succeeded",
        );

      // === 3. Persist the ONLY recovery path for the destination note, before the
      // irreversible relay call — see header. ===
      mkdirSync(OUT_OF_BAND_RECOVERY_DIR, { recursive: true });
      if (destDepositResult.noteSecret) {
        const outOfBandPath = resolve(
          OUT_OF_BAND_RECOVERY_DIR,
          `recipient-secret-${Date.now()}.json`,
        );
        writeFileSync(
          outOfBandPath,
          JSON.stringify(
            {
              note:
                "ONLY way to recover this deposit. RECIPIENT_ADDRESS had no registered " +
                "Mainnet viewing key, so allowOutOfBandFallback fired. Deliver this file's " +
                "noteSecret to whoever controls RECIPIENT_ADDRESS, or the deposit is stranded.",
              recipientAddress: RECIPIENT_ADDRESS,
              noteAddressHash: destDepositResult.pendingNote.noteAddressHash,
              noteSecret: destDepositResult.noteSecret,
              commitment: destDepositResult.pendingNote.commitment,
              label: destDepositResult.pendingNote.label,
              tokenId: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
            },
            null,
            2,
          ),
        );
        console.log("Out-of-band recovery secret written:", outOfBandPath);
      } else {
        console.log(
          "RECIPIENT_ADDRESS was discoverable on-chain (registered viewing key) — no " +
            "out-of-band secret needed, the recipient's own client will find the note normally.",
        );
      }

      // === 4. Execute — real, irreversible, real money ===
      if (!LIVE_TRANSFER_CONFIRM) {
        throw new Error(
          "Refusing to submit the real, irreversible relayReshieldTransferCrosschain call: " +
            "set LIVE_TRANSFER_CONFIRM=yes to proceed. This moves real money through a live bridge.",
        );
      }
      const txReceipt = await sourceSession.relayReshieldTransferCrosschain({
        inputCommitments: [sourceDepositResult.pendingNote.commitment as Hash],
        amount: prepared.netAmount,
        tokenId: BSC_USDT.address,
        outputToken: OUTPUT_YIELD_DEPLOYMENT.ppUSDC,
        toChainId: DEST_CHAIN_ID,
        toChainType: "evm",
        fallbackAddress: prepared.fallbackAddress,
        swapCalldata: prepared.swapCalldata,
        selectedQuote: prepared.selectedQuote,
        dustRecipient: prepared.dustRecipient,
        swapTarget: prepared.swapTarget,
        approvalAddress: prepared.approvalAddress,
        // NB: no depositNote — ReshieldTransferCrosschainParams omits it at the type
        // level (the sender must never persist a note it doesn't own). No dustRescue
        // either — this suite verifies plain transfer parity, not the dust-rescue overlay
        // (already covered by unit tests + the same-chain plain-reshield dust-rescue fix).
      });
      console.log("BSC RelaySwaps tx (sourceTxHash):", txReceipt.txHash);
      expect(txReceipt.status).toBe(true);
      markAsRecovered(depositSnapshotPath);

      // === 5. Wait for the bridge + destination deposit to land on Mainnet, driven by
      // LiFi's own status endpoint (same pattern as the plain reshield-crosschain suites
      // in this directory) — gives the actual Mainnet tx hash, which balance polling
      // alone cannot. ===
      console.log(
        "\nWaiting for bridge + ppUSDC deposit on Mainnet (polling LiFi status)...",
      );
      const maxWaitMs = 600_000;
      const pollIntervalMs = 15_000;
      const start = Date.now();
      let destinationTxHash: Hex | undefined;

      while (Date.now() - start < maxWaitMs) {
        const status = await lifiProvider.getSwapStatus({
          txHash: txReceipt.txHash as Hex,
          fromChainId: SOURCE_CHAIN_ID,
          toChainId: DEST_CHAIN_ID,
        });
        if (status.status === "DONE" && status.receiving?.txHash) {
          destinationTxHash = status.receiving.txHash;
          console.log("Bridge complete! Mainnet tx:", destinationTxHash);
          break;
        }
        if (status.status === "FAILED") {
          throw new Error(
            `LiFi bridge reported FAILED: ${status.substatusMessage ?? status.substatus ?? "no detail"}`,
          );
        }
        console.log(
          `  Polling... ${Math.round((Date.now() - start) / 1000)}s elapsed, status: ${status.status}`,
        );
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }
      if (!destinationTxHash) {
        throw new Error(`Bridge did not complete within ${maxWaitMs / 1000}s`);
      }

      // === 6. Independent on-chain verification — decode the Deposited event directly
      // rather than trusting the bridge status alone, and confirm the commitment matches
      // what prepareReshieldTransferCrosschainDeposit computed for RECIPIENT_ADDRESS. ===
      const depositReceipt = await mainnetPublicClient.getTransactionReceipt({
        hash: destinationTxHash,
      });
      expect(depositReceipt.status).toBe("success");

      const depositedEvent = depositReceipt.logs
        .filter(
          (log) =>
            log.address.toLowerCase() === IT004_CORE.PoolVault.toLowerCase(),
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
      expect(depositedEvent!.args.asset.toLowerCase()).toBe(
        OUTPUT_YIELD_DEPLOYMENT.ppUSDC.toLowerCase(),
      );
      expect(depositedEvent!.args.outputCommitment).toBe(
        BigInt(destDepositResult.pendingNote.commitment),
      );
      console.log(
        "ppUSDC deposit confirmed on-chain (Mainnet), owned by RECIPIENT_ADDRESS — commitment:",
        depositedEvent!.args.outputCommitment,
      );

      console.log(
        "\n=== Cross-Chain Reshield-and-Transfer (BSC -> Mainnet, ppUSDC) PASS ===",
      );
    }, 1_200_000); // 20 min timeout for proof + ASP wait + bridge
  },
);
