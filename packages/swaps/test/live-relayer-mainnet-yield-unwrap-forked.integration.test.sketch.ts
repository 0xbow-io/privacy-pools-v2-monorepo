/**
 * SKETCH — RelaySwaps yield-unwrap forked e2e (plan §11 P6, see
 * docs/tech-design/future-ideas/relayswaps-yield-unwrap.md).
 *
 * On a forked Mainnet:
 *   - deploys the NEW RelaySwaps (unwrap registry) against the V2 PROD PoolVault/Entrypoint,
 *     allowlists the live LiFi periphery, allowlists ppUSDC's real Zap,
 *   - grants POSTMAN_ROLE to an anvil account via storage so a LOCAL ASP tree can push roots
 *     (no live ASP / no inclusion wait),
 *   - spawns a LOCAL relayer on a generated mainnet-only config (copy of the prod shape:
 *     `Underlying` quoter for ppUSDC, `allowed_processors`, fork RPC, fork RelaySwaps),
 *   - deposits USDC -> ppUSDC shares through the real PPRouter (SDK yield session),
 *   - drives prepareSwapQuote -> relayWithdrawAndSwap for the ppUSDC note (SDK quotes LiFi on
 *     USDC, relayer on shares) and asserts RelaySwaps.execute unwrapped + swapped to USDT.
 *
 * Requires:
 *   - anvil / forge / cast on PATH, relayer built (`pnpm build` in packages/relayer/relayer),
 *     circuits at ../../circuits/build
 *   - YIELD_FORKED_CONFIRM=yes (hits the real LiFi API)
 * Optional env:
 *   - YIELD_FORK_UPSTREAM (default: https://ethereum-rpc.publicnode.com), YIELD_FORK_BLOCK,
 *     YIELD_FORK_PORT (8546), YIELD_RELAYER_PORT (3055), YIELD_RELAYER_URL (attach instead of
 *     spawning), YIELD_FORK_RPC (attach to a running anvil), YIELD_RELAYSWAPS_ADDRESS (skip
 *     deploy), YIELD_TEST_PRIVATE_KEY (default: anvil account #2), USDC_WHALE, DEPOSIT_USDC
 *     (default 25), LIFI_API_KEY, YIELD_FORK_VERBOSE.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeAbiParameters,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  stringToHex,
  toHex,
  type Hash,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { resolve } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { execFileSync, spawn, type ChildProcess } from "child_process";
import {
  APP_IDENTIFIER,
  PoolSessionBuilder,
  CryptoService,
  KeystoreManager,
  LiFiSwapQuoteProvider,
} from "@privacy-pools-v2/evm-sdk";
import type {
  Address,
  ILogger,
  EvmPoolSession,
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
  approveZapOnFork,
  fundErc20FromWhale,
  anvilSetBalance,
  ANVIL_ACCOUNT_0,
  type AnvilFork,
} from "./helpers/anvil-fork.js";

const CHAIN_ID = 1;
const UPSTREAM_RPC =
  process.env.YIELD_FORK_UPSTREAM ?? "https://ethereum-rpc.publicnode.com";
const FORK_PORT = Number(process.env.YIELD_FORK_PORT ?? "8546");
const FORK_BLOCK = process.env.YIELD_FORK_BLOCK
  ? Number(process.env.YIELD_FORK_BLOCK)
  : undefined;
const RELAYER_PORT = Number(process.env.YIELD_RELAYER_PORT ?? "3055");
const CONFIRM = process.env.YIELD_FORKED_CONFIRM === "yes";
const DEPOSIT_USDC = parseUnits(process.env.DEPOSIT_USDC ?? "25", 6);
const DENY_EXCHANGES = ["fly"];

// V2 PROD mainnet stack (verified on-chain 2026-09-04) + yield wrappers + LiFi periphery.
const POOL_VAULT = "0x0Eb42804BF897662aF851370eaeAdcDBEC1b97ed" as Address;
const ENTRYPOINT = "0xca1e072236D231130059eeA6Bfceb7F4e9a1F0C3" as Address;
const KEYSTORE = "0x6E463391c79b7e1A88eF26E0B023f9A6C9938a71" as Address;
const ASP_REGISTRY = "0x259C0BEa1d783c202509BD3b2688d23b8AEf58B0" as Address;
const ACCESS_ROUTER = "0x40a6bC296D87f71Ab31Ca3Bfb50513441fBD5160" as Address;
/** Block the V2 PROD PoolVault/Entrypoint/Keystore got code (first-code binary search, 2026-09-05). */
const V2_PROD_DEPLOY_BLOCK = 25_884_330;
const PP_USDC = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
const PP_ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
const PP_ZAP = "0x9Ea986BcDF6784D85B518b15bEEE1E65b585817B" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as Address;
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as Address;
const LIFI_EXECUTOR = "0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88" as Address;
const LIFI_ERC20_PROXY =
  "0x68E1Acfa805dcA813116Ed6507E01c38D44318f0" as Address;
const USDC_WHALE = (process.env.USDC_WHALE ??
  "0x55FE002aefF02F77364de339a1292923A15844B8") as Address;

// Well-known anvil keys. #0 = RelaySwaps owner + POSTMAN, #1 = relayer signer, #2 = user.
const RELAYER_SIGNER = {
  address: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address,
  privateKey:
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex,
};
// Fresh key per run unless pinned: note labels derive deterministically from the keys, so
// re-running against a fork that already holds this user's earlier deposits would collide
// with those notes (discovery resolves the old commitment, `NoteNotFoundError` on relay).
const USER_KEY = (process.env.YIELD_TEST_PRIVATE_KEY ??
  generatePrivateKey()) as Hex;

const CIRCUIT_ARTIFACTS_DIR = resolve(__dirname, "../../circuits/build");
const NOTE_STORAGE_ROOT = resolve(__dirname, "../.yield-forked-notes");
const STATE_DIR = resolve(__dirname, "../.yield-forked-state");
const RELAYER_DIST = resolve(__dirname, "../../relayer/relayer/dist/main.js");
const RELAYER_CONFIG_FILE = resolve(
  __dirname,
  "../.relayer-yield-fork-config.json",
);

const consoleLogger: ILogger = {
  level: "info",
  child(service: string): ILogger {
    return {
      ...consoleLogger,
      debug: (m, o) => console.log(`[${service}]`, m, o ?? ""),
    };
  },
  debug: () => {},
  info: (m, o) => console.log("[sdk]", m, o ?? ""),
  warn: (m, o) => console.warn("[sdk]", m, o ?? ""),
  error: (m, o) => console.error("[sdk]", m, o ?? ""),
  fatal: (m, o) => console.error("[sdk:fatal]", m, o ?? ""),
};

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;
const UNWRAPPED_EVENT_ABI = [
  {
    type: "event",
    name: "Unwrapped",
    inputs: [
      { name: "share", type: "address", indexed: true },
      { name: "underlying", type: "address", indexed: true },
      { name: "shares", type: "uint256", indexed: false },
      { name: "underlyingOut", type: "uint256", indexed: false },
      { name: "feeUnderlying", type: "uint256", indexed: false },
    ],
  },
] as const;

/** OZ AccessControl (slot 0): _roles[role].hasRole[account] */
function roleSlot(role: Hex, account: Address): Hex {
  const inner = keccak256(
    encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [role, 0n]),
  );
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }],
      [account, inner],
    ),
  );
}

async function rpc(
  url: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as {
    result?: unknown;
    error?: { message: string };
  };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function relayerConfig(forkRpc: string, relaySwaps: Address): unknown {
  return {
    chains: {
      evm: [
        {
          id: CHAIN_ID,
          name: "mainnet-fork",
          rpc_url: forkRpc,
          entrypoint_contract: ENTRYPOINT,
          relay_contract: "0x01a8Fa4dbb60187aD8d3c3d08E7Fb8C14198A461",
          pool_vault_contract: POOL_VAULT,
          relay_swaps_contract: relaySwaps,
          allowed_processors: [PP_ROUTER],
          fee_receiver_address: RELAYER_SIGNER.address,
          signer_private_key: RELAYER_SIGNER.privateKey,
          flat_fee_amount: "21000",
          native_currency: { name: "Ether", symbol: "ETH", decimals: 18 },
          supported_assets: [
            {
              address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
              ticker: "ETH",
              quoter: "Native",
              fee_bps: "10",
              decimals: 18,
            },
            { address: USDC, ticker: "USDC", quoter: "Cowswap", decimals: 6 },
            { address: USDT, ticker: "USDT", quoter: "Cowswap", decimals: 6 },
            {
              address: PP_USDC,
              ticker: "ppUSDC",
              quoter: "Underlying",
              underlying: USDC,
              zap: PP_ZAP,
              decimals: 18,
            },
          ],
        },
      ],
    },
  };
}

const ERROR_SELECTORS: Record<string, string> = JSON.parse(
  readFileSync(
    resolve(__dirname, "./helpers/contract-error-selectors.json"),
    "utf8",
  ),
) as Record<string, string>;

/** eth_call the tx first; on revert, print the decoded custom error (selector map from the contracts). */
async function simulateOrExplain(
  rpcUrl: string,
  from: Address,
  label: string,
  to: Address,
  data: Hex,
  value: bigint,
): Promise<void> {
  try {
    await rpc(rpcUrl, "eth_call", [
      { from, to, data, value: `0x${value.toString(16)}` },
      "latest",
    ]);
  } catch (e) {
    const msg = String((e as Error).message);
    const m = /0x[0-9a-fA-F]{8,}/.exec(msg);
    const sel = m ? m[0].slice(0, 10).toLowerCase() : undefined;
    const name = sel ? ERROR_SELECTORS[sel] : undefined;
    throw new Error(
      `${label} would revert: ${name ?? "unknown selector " + sel} — raw: ${msg.slice(0, 400)}`,
    );
  }
}

async function waitForRelayer(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/v1/details/evm/${CHAIN_ID}`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`relayer at ${url} did not come up within ${timeoutMs}ms`);
}

const hasCircuits = existsSync(resolve(CIRCUIT_ARTIFACTS_DIR, "deposit"));

describe.skipIf(!hasCircuits)(
  "Yield unwrap forked e2e: ppUSDC note -> RelaySwaps unwrap -> LiFi USDC->USDT",
  () => {
    let fork: AnvilFork;
    let relaySwaps: Address;
    let relayerProc: ChildProcess | undefined;
    let relayerUrl: string;
    let account: ReturnType<typeof privateKeyToAccount>;
    let session: EvmPoolSession;
    let relayerInfo: RelayerInfo;
    let publicClient: ReturnType<typeof createPublicClient>;
    let walletClient: ReturnType<typeof createWalletClient>;
    let localAsp: LocalASPTreeService;
    let persistence: TestStatePersistence;
    let noteStorageDir: string;

    beforeAll(async () => {
      account = privateKeyToAccount(USER_KEY);
      noteStorageDir = resolve(
        NOTE_STORAGE_ROOT,
        account.address.toLowerCase(),
      );
      console.log(
        `Test user ${account.address}${process.env.YIELD_TEST_PRIVATE_KEY ? " (pinned)" : " (fresh key)"}`,
      );

      // 1. Fork
      if (process.env.YIELD_FORK_RPC) {
        fork = { rpcUrl: process.env.YIELD_FORK_RPC, port: 0, stop: () => {} };
        console.log(`Attached to anvil at ${fork.rpcUrl}`);
      } else {
        const upstream = createPublicClient({
          chain: mainnet,
          transport: http(UPSTREAM_RPC),
        });
        const pinBlock =
          FORK_BLOCK ?? Number((await upstream.getBlockNumber()) - 8n);
        console.log(
          `Forking Mainnet at block ${pinBlock} on port ${FORK_PORT} from ${UPSTREAM_RPC}...`,
        );
        fork = await startAnvilFork({
          forkUrl: UPSTREAM_RPC,
          forkBlockNumber: pinBlock,
          port: FORK_PORT,
          chainId: CHAIN_ID,
          verbose: !!process.env.YIELD_FORK_VERBOSE,
        });
      }
      const chain = {
        ...mainnet,
        rpcUrls: { default: { http: [fork.rpcUrl] } },
      };
      publicClient = createPublicClient({
        chain,
        transport: http(fork.rpcUrl),
      }) as never;
      walletClient = createWalletClient({
        account,
        chain,
        transport: http(fork.rpcUrl),
      });

      // 2. New RelaySwaps + LiFi periphery + unwrap registry
      relaySwaps =
        (process.env.YIELD_RELAYSWAPS_ADDRESS as Address | undefined) ??
        deployRelaySwapsToFork({
          rpcUrl: fork.rpcUrl,
          poolAddress: POOL_VAULT,
          entrypointAddress: ENTRYPOINT,
          routers: [LIFI_DIAMOND, LIFI_EXECUTOR, LIFI_ERC20_PROXY],
        });
      if (!process.env.YIELD_RELAYSWAPS_ADDRESS) {
        approveZapOnFork(fork.rpcUrl, relaySwaps, PP_ZAP);
      }
      const zapApproved = await publicClient.readContract({
        address: relaySwaps,
        abi: [
          {
            type: "function",
            name: "approvedZaps",
            stateMutability: "view",
            inputs: [{ type: "address" }],
            outputs: [{ type: "bool" }],
          },
        ],
        functionName: "approvedZaps",
        args: [PP_ZAP],
      });
      expect(zapApproved).toBe(true);
      console.log(
        `Forked RelaySwaps ${relaySwaps}: approvedZaps(${PP_ZAP}) = true`,
      );

      // 3. POSTMAN_ROLE for the local ASP pusher (anvil #0) via AccessControl storage
      const postmanRole = keccak256(stringToHex("POSTMAN_ROLE"));
      await rpc(fork.rpcUrl, "anvil_setStorageAt", [
        ACCESS_ROUTER,
        roleSlot(postmanRole, ANVIL_ACCOUNT_0.address),
        `0x${"0".repeat(63)}1`,
      ]);
      const hasRole = await publicClient.readContract({
        address: ACCESS_ROUTER,
        abi: [
          {
            type: "function",
            name: "hasRole",
            stateMutability: "view",
            inputs: [{ type: "bytes32" }, { type: "address" }],
            outputs: [{ type: "bool" }],
          },
        ],
        functionName: "hasRole",
        args: [postmanRole, ANVIL_ACCOUNT_0.address],
      });
      expect(hasRole).toBe(true);

      // 4. Funding
      await anvilSetBalance(
        fork.rpcUrl,
        account.address as Address,
        parseUnits("5", 18),
      );
      await anvilSetBalance(
        fork.rpcUrl,
        RELAYER_SIGNER.address,
        parseUnits("5", 18),
      );
      await anvilSetBalance(
        fork.rpcUrl,
        ANVIL_ACCOUNT_0.address,
        parseUnits("5", 18),
      );
      await fundErc20FromWhale(
        fork.rpcUrl,
        USDC,
        USDC_WHALE,
        account.address as Address,
        DEPOSIT_USDC * 3n,
      );

      // 5. Local relayer on a generated mainnet-only config
      if (process.env.YIELD_RELAYER_URL) {
        relayerUrl = process.env.YIELD_RELAYER_URL;
      } else {
        if (!existsSync(RELAYER_DIST))
          throw new Error(
            `relayer not built: ${RELAYER_DIST} (run pnpm build in packages/relayer/relayer)`,
          );
        // A previous YIELD_KEEP_FORK run leaves its relayer on the port; a second instance
        // fails to bind and the readiness probe hits the stale one. Clear the port first.
        try {
          execFileSync("bash", [
            "-c",
            `fuser -k ${RELAYER_PORT}/tcp >/dev/null 2>&1 || true`,
          ]);
        } catch {
          /* no stale listener */
        }
        writeFileSync(
          RELAYER_CONFIG_FILE,
          JSON.stringify(relayerConfig(fork.rpcUrl, relaySwaps), null, 2),
        );
        relayerUrl = `http://127.0.0.1:${RELAYER_PORT}`;
        // The relayer honours RPC_URL_<chainId> / SIGNER_PRIVATE_KEY_<chainId> env overrides.
        // Sourcing .env for the upstream RPC would silently point the spawned relayer at REAL
        // mainnet (where the anvil signer has 0 ETH -> "gas required exceeds allowance (0)"),
        // so strip every such override before spawning.
        const childEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            ([k]) =>
              !/^(RPC_URL_|SIGNER_PRIVATE_KEY_|FEE_RECEIVER_ADDRESS_|ASP_POSTMAN_PRIVATE_KEY$)/.test(
                k,
              ),
          ),
        );
        relayerProc = spawn("node", [RELAYER_DIST], {
          // Run from the relayer package: its dotenv loads `.env` from cwd, and this package's
          // `.env` carries RPC_URL_1 (real mainnet), which would override the fork RPC.
          cwd: resolve(RELAYER_DIST, "../.."),
          env: {
            ...childEnv,
            CONFIG_PATH: RELAYER_CONFIG_FILE,
            PORT: String(RELAYER_PORT),
            RPC_TIMEOUT_MS: "20000",
            RPC_WRITE_TIMEOUT_MS: "60000",
            QUOTE_DEADLINE_MS: "60000",
          },
          stdio: process.env.YIELD_FORK_VERBOSE ? "inherit" : "pipe",
        });
        relayerProc.stderr?.on("data", (d) =>
          console.error("[relayer:err]", String(d).trimEnd()),
        );
        relayerProc.on("exit", (code, signal) =>
          console.error(`[relayer] exited code=${code} signal=${signal}`),
        );
        relayerProc.on("exit", (code, signal) =>
          console.error(`[relayer] exited code=${code} signal=${signal}`),
        );
        // Nest logs to stdout; forward it (and keep the pipe drained so the child never blocks).
        relayerProc.stdout?.on("data", (d) =>
          console.log("[relayer]", String(d).trimEnd()),
        );
        await waitForRelayer(relayerUrl, 120_000);
        console.log(
          `Local relayer up at ${relayerUrl} (config ${RELAYER_CONFIG_FILE})`,
        );
      }
      // The relayer may override the config signer via SIGNER_PRIVATE_KEY_<chainId> (and the
      // test's env is inherited), so take the signer it actually reports and fund THAT.
      const details = (await (
        await fetch(`${relayerUrl}/v1/details/evm/${CHAIN_ID}`)
      ).json()) as {
        address?: string;
        relayerAddress?: string;
        contracts?: { relaySwaps?: string };
      };
      const relayerSigner =
        ((details.address ?? details.relayerAddress) as Address | undefined) ??
        RELAYER_SIGNER.address;
      await anvilSetBalance(fork.rpcUrl, relayerSigner, parseUnits("5", 18));
      console.log(
        `Relayer signer ${relayerSigner} funded; details.contracts.relaySwaps = ${details.contracts?.relaySwaps}`,
      );
      relayerInfo = {
        url: relayerUrl,
        name: "local-yield-fork",
        chainId: CHAIN_ID,
        chainType: "evm",
        status: "active",
        address: relayerSigner,
        processorAddress: relaySwaps,
      };

      // 6. Local ASP + session
      const aspWallet = createWalletClient({
        account: privateKeyToAccount(ANVIL_ACCOUNT_0.privateKey),
        chain,
        transport: http(fork.rpcUrl),
      });
      localAsp = await LocalASPTreeService.create({
        aspRegistryAddress: ASP_REGISTRY,
        walletClient: aspWallet as never,
        publicClient: publicClient as never,
      });
      mkdirSync(STATE_DIR, { recursive: true });
      persistence = new TestStatePersistence(
        resolve(STATE_DIR, `${account.address.toLowerCase()}.json`),
      );
      const saved = persistence.load();
      const protocolKeys =
        saved?.protocolKeys ??
        (await deriveProtocolKeys(account, walletClient));
      const state: MainnetTestState = saved ?? {
        protocolKeys,
        aspLeaves: [],
        keystoreRegistered: false,
      };
      state.protocolKeys = protocolKeys;
      persistence.save(state);
      const lifi = new LiFiSwapQuoteProvider({
        ...(process.env.LIFI_API_KEY
          ? { apiKey: process.env.LIFI_API_KEY }
          : {}),
      });

      session = (await PoolSessionBuilder.fromConfig({
        chainId: CHAIN_ID,
        rpcUrl: fork.rpcUrl,
        httpClientConfig: { timeout: 300_000, retryAttempts: 0 },
        ownerAddress: account.address as Address,
        deployment: {
          poolAddress: POOL_VAULT,
          entrypointAddress: ENTRYPOINT,
          keystoreAddress: KEYSTORE,
          aspRegistryAddress: ASP_REGISTRY,
          relaySwapsAddress: relaySwaps,
        },
        protocolKeys,
        circuitArtifactsDir: CIRCUIT_ARTIFACTS_DIR,
        relayers: [relayerInfo],
        persistentStorage: { type: "file", dirPath: noteStorageDir },
        walletInteractor: { type: "viem", walletClient: walletClient as never },
        logger: consoleLogger,
        // Full leaf history is needed to rebuild the state tree root the proof commits to.
        deploymentBlock: `0x${V2_PROD_DEPLOY_BLOCK.toString(16)}`,
      } as any)
        .withAspDataProvider(localAsp)
        .withSwapQuoteProvider(lifi)
        .withYieldDeployment({
          ppRouter: PP_ROUTER,
          zap: PP_ZAP,
          ppUSDC: PP_USDC,
          ppUSDCDecimals: 18,
          underlying: USDC,
          underlyingDecimals: 6,
          underlyingSymbol: "USDC",
        })
        .create()) as EvmPoolSession;
    });

    afterAll(() => {
      if (process.env.YIELD_KEEP_FORK) {
        console.log(
          `YIELD_KEEP_FORK set: leaving anvil (${fork?.rpcUrl}) and relayer (${relayerUrl}) running for replay.`,
        );
        return;
      }
      relayerProc?.kill("SIGKILL");
      fork?.stop();
    });

    it("deposits USDC as ppUSDC shares, then withdraws+swaps the share note to USDT through RelaySwaps", async () => {
      if (!CONFIRM)
        throw new Error(
          "Set YIELD_FORKED_CONFIRM=yes to run (hits the real LiFi API).",
        );
      expect(session.yield).toBeDefined();

      if (!(await session.isKeystoreRegistered())) {
        const receipts = await session.registerKeystore();
        expect(receipts.every((r) => r.status)).toBe(true);
        console.log("Keystore registered on fork.");
      }

      // --- Deposit: USDC -> ppUSDC shares via the real PPRouter ---
      const shares =
        await session.yield!.deposit.sharesForUnderlying(DEPOSIT_USDC);
      const prepared = await session.yield!.deposit.prepareYieldDeposit({
        value: shares,
      });
      console.log(
        `Yield deposit: ${shares} shares for <= ${formatUnits(prepared.maxUnderlyingIn, 6)} USDC`,
      );
      for (const [label, tx] of [
        ["approvalTx", prepared.approvalTx],
        ["depositTx", prepared.depositTx],
      ] as const) {
        // No approval is needed when the allowance already covers the deposit.
        if (!tx) continue;
        await simulateOrExplain(
          fork.rpcUrl,
          account.address as Address,
          label,
          tx.to,
          tx.data,
          BigInt(tx.value),
        );
        const hash = await walletClient.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: BigInt(tx.value),
          account,
          chain: walletClient.chain,
        });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        expect(receipt.status, `${label} reverted on-chain (tx ${hash})`).toBe(
          "success",
        );
      }
      mkdirSync(noteStorageDir, { recursive: true });
      writeFileSync(
        resolve(noteStorageDir, `pending-${Date.now()}.json`),
        JSON.stringify(prepared.pendingNote, null, 2),
      );
      await localAsp.registerLabel(prepared.pendingNote.label as Hex);
      const depositBlock = await publicClient.getBlockNumber();
      await session.discoverNotes({
        fromBlock: `0x${(depositBlock - 3n).toString(16)}` as Hex,
      });
      console.log("ppUSDC note ACTIVE (local ASP).");

      // --- Withdraw + swap: ppUSDC note -> (unwrap to USDC in RelaySwaps) -> LiFi -> USDT ---
      const usdtBefore = await publicClient.readContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const feeUsdcBefore = await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RELAYER_SIGNER.address],
      });

      const quote = await session.prepareSwapQuote({
        relayerInfo,
        amount: `0x${shares.toString(16)}` as Hex,
        tokenId: PP_USDC,
        outputToken: USDT,
        recipientAddress: account.address as Address,
        denyExchanges: DENY_EXCHANGES,
      });
      expect(quote.swapInputToken.toLowerCase()).toBe(USDC.toLowerCase());
      console.log(
        `Quote: fee ${formatUnits(BigInt(quote.feeAmount), 18)} ppUSDC, LiFi in USDC, est. out ${formatUnits(BigInt(quote.estimatedOutput), 6)} USDT, min ${formatUnits(BigInt(quote.minOutputAmount), 6)}, dust ${quote.dustAmount} USDC`,
      );

      const t0 = Date.now();
      const receipt = await session.relayWithdrawAndSwap({
        inputCommitments: [prepared.pendingNote.commitment as Hash],
        amount: quote.netAmount,
        tokenId: PP_USDC,
        recipientAddress: account.address as Address,
        outputToken: USDT,
        minOutputAmount: quote.minOutputAmount,
        swapCalldata: quote.swapCalldata,
        selectedQuote: quote.selectedQuote,
        swapTarget: quote.swapTarget,
        approvalAddress: quote.approvalAddress,
      });
      console.log(
        `Proof + relay in ${((Date.now() - t0) / 1000).toFixed(1)}s, tx ${receipt.txHash}, status ${receipt.status}`,
      );
      expect(receipt.status).toBe(true);

      const usdtAfter = await publicClient.readContract({
        address: USDT,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      });
      const feeUsdcAfter = await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [RELAYER_SIGNER.address],
      });
      console.log(
        `USDT received: ${formatUnits(usdtAfter - usdtBefore, 6)}; relayer fee received: ${formatUnits(feeUsdcAfter - feeUsdcBefore, 6)} USDC`,
      );
      expect(usdtAfter - usdtBefore).toBeGreaterThanOrEqual(
        BigInt(quote.minOutputAmount),
      );
      expect(feeUsdcAfter - feeUsdcBefore).toBeGreaterThan(0n);

      const txReceipt = await publicClient.getTransactionReceipt({
        hash: receipt.txHash as Hex,
      });
      const unwrapped = txReceipt.logs
        .filter((l) => l.address.toLowerCase() === relaySwaps.toLowerCase())
        .map((l) => {
          try {
            return decodeEventLog({
              abi: UNWRAPPED_EVENT_ABI,
              data: l.data,
              topics: l.topics,
            });
          } catch {
            return undefined;
          }
        })
        .find((e) => e?.eventName === "Unwrapped");
      expect(unwrapped).toBeDefined();
      console.log("Unwrapped:", unwrapped!.args);
      expect(unwrapped!.args.shares).toBe(
        BigInt(quote.selectedQuote.quote.feeCommitment.amountSent),
      );

      const sharesLeft = await publicClient.readContract({
        address: PP_USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [relaySwaps],
      });
      const usdcLeft = await publicClient.readContract({
        address: USDC,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [relaySwaps],
      });
      expect(sharesLeft).toBe(0n);
      expect(usdcLeft).toBe(0n);
    });
  },
);

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
