/**
 * Anvil-fork harness helper — spins up a local `anvil` process forked from a
 * real chain, and deploys / configures a fresh `RelaySwaps` on it via Foundry.
 *
 * Why this exists: every `*.integration.test.ts` in this suite talks to a LIVE
 * RPC directly (vitest's `pool: "forks"` is process isolation, NOT chain
 * forking). The B2 rollout (detailed_b2_plan_for_mainnet_reshield.md §13 step 3)
 * needs the opposite — a forked source chain with a NOT-YET-DEPLOYED RelaySwaps
 * on it, driven by a local relayer + the live reshield sketch with real LiFi
 * quotes. This module is the missing piece.
 *
 * Nothing here touches real funds: `anvil` mines locally, and the deploy uses a
 * well-known anvil dev key (account #0). The fork's upstream RPC is only read.
 *
 * Requires `anvil`, `forge` and `cast` on PATH (Foundry — already a dev
 * dependency of packages/swaps/contracts).
 */
import { spawn, type ChildProcess } from "child_process";
import { execFileSync } from "child_process";
import { resolve } from "path";
import { createPublicClient, http, type Address, type Hex } from "viem";

// Foundry's canonical dev account #0 (mnemonic "test test … junk") — funded with
// 10000 ETH on every fresh anvil instance. Public, throwaway, safe to hardcode.
// Verify with: cast wallet private-key --mnemonic "test test test test test test test test test test test junk"
export const ANVIL_ACCOUNT_0 = {
  address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address,
  privateKey:
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex,
} as const;

const CONTRACTS_DIR = resolve(__dirname, "../../contracts");

export interface AnvilFork {
  /** `http://127.0.0.1:<port>` — pass to viem / the relayer / the SDK session. */
  rpcUrl: string;
  port: number;
  /** SIGKILLs the anvil child. Idempotent. Registered on process exit too. */
  stop: () => void;
}

export interface StartForkOptions {
  /** Upstream RPC to fork from (e.g. `process.env.RPC_URL_10`). */
  forkUrl: string;
  /** Pin the fork to a block for reproducibility. Strongly recommended. */
  forkBlockNumber?: number | bigint;
  /** Defaults to 8546 to avoid clashing with a local relayer on 8545. */
  port?: number;
  /** Chain id anvil should report. Defaults to the upstream chain's id. */
  chainId?: number;
  /** ms to wait for `eth_blockNumber` to answer before giving up. Default 30s. */
  readyTimeoutMs?: number;
  /** Pipe anvil stdout/stderr to the console. Default false. */
  verbose?: boolean;
}

/** Starts an anvil fork and resolves once it answers `eth_blockNumber`. */
export async function startAnvilFork(
  opts: StartForkOptions,
): Promise<AnvilFork> {
  const port = opts.port ?? 8546;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const args = [
    "--fork-url",
    opts.forkUrl,
    "--port",
    String(port),
    "--host",
    "127.0.0.1",
    // Deterministic, snappy mining; no base-fee surprises for the deploy.
    "--base-fee",
    "0",
    "--gas-price",
    "0",
  ];
  if (opts.forkBlockNumber !== undefined) {
    args.push("--fork-block-number", String(opts.forkBlockNumber));
  }
  if (opts.chainId !== undefined) {
    args.push("--chain-id", String(opts.chainId));
  }

  const child: ChildProcess = spawn("anvil", args, {
    stdio: opts.verbose ? "inherit" : "ignore",
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  process.once("exit", stop);
  child.once("error", (err) => {
    throw new Error(
      `Failed to spawn anvil (is Foundry on PATH?): ${err.message}`,
    );
  });

  const client = createPublicClient({ transport: http(rpcUrl) });
  const deadline = Date.now() + (opts.readyTimeoutMs ?? 30_000);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited early with code ${child.exitCode}`);
    }
    try {
      await client.getBlockNumber();
      break;
    } catch {
      if (Date.now() > deadline) {
        stop();
        throw new Error(`anvil fork on ${rpcUrl} did not become ready in time`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return { rpcUrl, port, stop };
}

export interface DeployRelaySwapsOptions {
  rpcUrl: string;
  /** Real (forked) PoolVault on the source chain. */
  poolAddress: Address;
  /** Real (forked) Entrypoint on the source chain. */
  entrypointAddress: Address;
  /** Routers to allowlist: the LiFi Diamond and (LiFi v4) its ERC20Proxy. */
  routers: Address[];
  /** Deployer / UPGRADER_ROLE. Defaults to anvil account #0. */
  deployerPrivateKey?: Hex;
}

/**
 * Deploys `RelaySwaps` to the fork and `approveRouter`s every entry in
 * `routers`. Returns the new address. Uses `forge create` + `cast send` rather
 * than `script/DeployRelaySwaps.s.sol` so we can allowlist an arbitrary number
 * of routers (the script only takes ROUTER + one APPROVAL_ADDRESS) and skip its
 * MockPool-codehash guard (irrelevant here — POOL_ADDRESS is the real forked
 * PoolVault, which does verify proofs).
 */
export function deployRelaySwapsToFork(opts: DeployRelaySwapsOptions): Address {
  const key = opts.deployerPrivateKey ?? ANVIL_ACCOUNT_0.privateKey;
  const forgeArgs = [
    "create",
    "src/RelaySwaps.sol:RelaySwaps",
    "--rpc-url",
    opts.rpcUrl,
    "--private-key",
    key,
    "--broadcast",
    "--json",
    "--constructor-args",
    opts.poolAddress,
    opts.entrypointAddress,
    ANVIL_ACCOUNT_0.address, // upgraderRole
    opts.routers[0], // constructor allowlists the first router
  ];
  const out = execFileSync("forge", forgeArgs, {
    cwd: CONTRACTS_DIR,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  // `--json` prints the result object on its own line; compiler/solc warnings may
  // precede it. Take the last line that parses as an object with `deployedTo`.
  // forge >= 1.x pretty-prints the --json result over several lines; older builds emit a
  // single line. Match the field directly instead of assuming a line-delimited JSON stream.
  const match = /"deployedTo"\s*:\s*"(0x[0-9a-fA-F]{40})"/.exec(out);
  const relaySwaps: Address | undefined = match
    ? (match[1] as Address)
    : undefined;
  if (!relaySwaps) {
    throw new Error(
      `forge create did not report a deployedTo address:\n${out}`,
    );
  }

  // Allowlist the remaining routers (constructor took routers[0]).
  for (const router of opts.routers.slice(1)) {
    approveRouterOnFork(opts.rpcUrl, relaySwaps, router, key);
  }
  return relaySwaps;
}

/**
 * `approveRouter(router)` on a fork-deployed RelaySwaps, signed by the deployer
 * (its owner). Call this after a LiFi quote comes back to allowlist whatever
 * `swapTarget` / `approvalAddress` LiFi actually chose — the repo never hardcodes
 * the LiFi v4 ERC20Proxy address; it varies and is only known from the quote.
 */
export function approveRouterOnFork(
  rpcUrl: string,
  relaySwaps: Address,
  router: Address,
  deployerPrivateKey: Hex = ANVIL_ACCOUNT_0.privateKey,
): void {
  execFileSync(
    "cast",
    [
      "send",
      relaySwaps,
      "approveRouter(address)",
      router,
      "--rpc-url",
      rpcUrl,
      "--private-key",
      deployerPrivateKey,
    ],
    { cwd: CONTRACTS_DIR, encoding: "utf8" },
  );
}

/** anvil cheat: set an account's native balance (wei). */
/**
 * Allowlists a PPYieldTokenZap on a fork-deployed RelaySwaps (`approveZap(zap)`), as the
 * owner. The contract cross-checks the zap against its share and aToken on-chain.
 */
export function approveZapOnFork(
  rpcUrl: string,
  relaySwaps: Address,
  zap: Address,
  ownerPrivateKey: Hex = ANVIL_ACCOUNT_0.privateKey,
): void {
  execFileSync(
    "cast",
    [
      "send",
      relaySwaps,
      "approveZap(address)",
      zap,
      "--rpc-url",
      rpcUrl,
      "--private-key",
      ownerPrivateKey,
    ],
    { stdio: "pipe" },
  );
}

export async function anvilSetBalance(
  rpcUrl: string,
  address: Address,
  wei: bigint,
): Promise<void> {
  await rpc(rpcUrl, "anvil_setBalance", [address, `0x${wei.toString(16)}`]);
}

/** anvil cheat: impersonate `from` for subsequent eth_sendTransaction calls. */
export async function anvilImpersonate(
  rpcUrl: string,
  address: Address,
): Promise<void> {
  await rpc(rpcUrl, "anvil_impersonateAccount", [address]);
}

export async function anvilStopImpersonate(
  rpcUrl: string,
  address: Address,
): Promise<void> {
  await rpc(rpcUrl, "anvil_stopImpersonatingAccount", [address]);
}

/**
 * Moves `amount` of an ERC20 from an on-fork holder to `to` by impersonating the
 * holder (no signature). `whale` must actually hold >= `amount` at the fork
 * block. Use this rather than storage-slot pokes — it's proxy-layout-agnostic.
 */
export async function fundErc20FromWhale(
  rpcUrl: string,
  token: Address,
  whale: Address,
  to: Address,
  amount: bigint,
): Promise<void> {
  await anvilSetBalance(rpcUrl, whale, 10n ** 18n); // gas for the transfer
  await anvilImpersonate(rpcUrl, whale);
  try {
    // transfer(address,uint256) selector 0xa9059cbb
    const data =
      "0xa9059cbb" +
      to.toLowerCase().replace(/^0x/, "").padStart(64, "0") +
      amount.toString(16).padStart(64, "0");
    const txHash = (await rpc(rpcUrl, "eth_sendTransaction", [
      { from: whale, to: token, data, gas: "0x30000" },
    ])) as Hex;
    // anvil auto-mines, but eth_sendTransaction can return before the receipt is
    // queryable — poll briefly instead of reading it once (a null receipt here is
    // "not mined yet", not "reverted").
    let receipt: { status?: Hex } | null = null;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      receipt = (await rpc(rpcUrl, "eth_getTransactionReceipt", [txHash])) as {
        status?: Hex;
      } | null;
      if (receipt) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!receipt || receipt.status !== "0x1") {
      throw new Error(
        `whale transfer reverted (whale ${whale} may not hold ${amount} of ${token} at this fork block)`,
      );
    }
  } finally {
    await anvilStopImpersonate(rpcUrl, whale);
  }
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
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result;
}
