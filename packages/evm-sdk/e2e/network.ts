/**
 * Idempotent bootstrap for the evm-sdk e2e suite: starts a local anvil (Sepolia's chain id) per lane
 * (see `lanes.ts`) unless one is already running, deploys the core protocol stack to it if that hasn't
 * happened yet for this node, and returns everything the test needs to build a `PoolSessionBuilder`
 * session against it.
 *
 * A plain anvil, not a Sepolia fork: the suite only needs three canonical contracts from Sepolia
 * (PoseidonT3/T4 and the ERC-5564 Announcer, all stateless), and their runtime code is installed from
 * `fixtures/canonical-code.json`. A fork made every new account read and every mined block a round
 * trip to the upstream RPC (`anvil_mine 70` ~20 s vs ~4 ms plain), and a non-archive upstream pruned
 * the fork block mid-run. Set `EVM_E2E_FORK_URL` to fork anyway.
 *
 * Mirrors `packages/stellar-sdk/e2e/network.ts` → `ensureDeployed()`, but — unlike Stellar, which
 * delegates to a sibling deploy package — implements both steps directly here, since evm-sdk has
 * no equivalent contracts-side deploy-automation package to call into.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import type { Address, Hex } from "../src/internal.js";
import { laneRpcUrl } from "./lanes.js";
import { stopProcessGroup } from "./processGroup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(__dirname, "../../contracts");
const SWAPS_CONTRACTS_DIR = join(__dirname, "../../swaps/contracts");
const DEPLOYMENTS_DIR = join(__dirname, "deployments");

/** Opt-in: fork this RPC instead of starting a plain anvil (see the header). */
const FORK_URL = process.env.EVM_E2E_FORK_URL;
const CANONICAL_CODE_PATH = join(__dirname, "fixtures/canonical-code.json");
/** `0` always deploys from scratch, ignoring (and not writing) the post-deploy anvil snapshot. */
const SNAPSHOT_ENABLED = process.env.EVM_E2E_SNAPSHOT !== "0" && !FORK_URL;
const SNAPSHOT_PREFIX = "anvil-state-";
/** Scratch file a snapshot's state is unpacked into for `anvil --load-state`; removed once the anvils are up. */
const LOAD_STATE_PATH = join(DEPLOYMENTS_DIR, "anvil-load-state.json");
const CHAIN_ID = 11_155_111;

/**
 * e2e-suite-only test key — NOT one of anvil's well-known default genesis accounts (those are
 * reused by other scripts/docs in this repo; a dedicated key avoids any ambiguity about which
 * suite a given key belongs to). Fixed and deterministic so `network.ts`, `relayer.ts`, and
 * `DeployE2ELocal.s.sol`'s `SystemConfig` all agree on the same address. Doubles as the deployer
 * and the `postman` role holder (see `DeployE2ELocal.s.sol`), so `mockAspServer.ts` can sign
 * `updateASPRoot` directly with it instead of needing `anvil_impersonateAccount`. Funded via
 * `anvil_setBalance` before the deploy — it is not an anvil genesis account.
 */
export const DEPLOYER_PRIVATE_KEY: Hex =
    "0x77d28084a5fdd3067a2f59f001775187199e1f1da27ffb5765545135cb21b7b3" as Hex;

export interface EvmE2ENetwork {
    rpcUrl: string;
    chainId: number;
    poolAddress: Address;
    entrypointAddress: Address;
    keystoreAddress: Address;
    aspRegistryAddress: Address;
    relaySwapsAddress: Address;
    privacyPoolRelayAddress: Address;
    /** Stands in for the real LiFi Diamond — LiFi has no solver/liquidity on local/test chains,
     * so `packages/evm-sdk/e2e/fakeSwapQuoteProviders.ts` targets this mock instead. */
    mockRouterAddress: Address;
    mockErc20Address: Address;
    /** Stands in for LiFi's Executor — a same-chain swap into a native deposit is composed through
     * it (`PoolSessionBuilder.withSwapExecutor`), since LIFI_SWAP_EXECUTORS has no Sepolia entry. */
    mockExecutorAddress: Address;
    /** The mock Executor's ERC20Proxy — the approval spender for that swap's input token. */
    mockErc20ProxyAddress: Address;
    /** `PPYieldToken` — the ERC-4626 share wrapper deployed by DeployE2ELocalYield.s.sol,
     * standing in for a real Aave-backed ppUSDC deployment (see that script's own doc comment). */
    yieldTokenAddress: Address;
    /** `PPYieldTokenZap` — allowlisted on RelaySwaps via `approveZap()` right after deploy, so
     * `RelaySwaps.executeUnwrapped()` can unwrap this share. */
    yieldZapAddress: Address;
    /** `PPRouter` — the combined USDC<->ppUSDC wrap/shield router. */
    yieldRouterAddress: Address;
    /** The mock underlying (`yUSDC`) `yieldTokenAddress`'s shares redeem into. */
    yieldUnderlyingAddress: Address;
    /** `PPYieldToken` over WETH (ppWETH) — the native-coin yield deployment, its router in NATIVE mode. */
    nativeYieldTokenAddress: Address;
    /** The ppWETH share's `PPYieldTokenZap`. */
    nativeYieldZapAddress: Address;
    /** `PPRouter` in native mode: deposits are funded with ETH, withdrawals pay out ETH. */
    nativeYieldRouterAddress: Address;
    /** The `MockWETH9` the native router wraps ETH into. */
    nativeYieldUnderlyingAddress: Address;
    /** Holds POSTMAN_ROLE on the ASPRegistry — see {@link DEPLOYER_PRIVATE_KEY}'s doc comment. */
    deployerPrivateKey: Hex;
    /**
     * Block the core stack was deployed at. `discoverNotes()`'s default scan starts from the
     * NoteManager's sync cursor, which starts at block 0 for a fresh session — a forked anvil
     * (`EVM_E2E_FORK_URL`) only serves `eth_getLogs` from its fork point onward, not from genesis,
     * and starting at the deploy block keeps scans short either way. Every `discoverNotes()` call in
     * the e2e test passes `{ fromBlock: network.deploymentBlock }`.
     */
    deploymentBlock: Hex;
}

export interface EnsureDeployedResult {
    /** By lane: one anvil each, all holding the same deployment (see `lanes.ts`). */
    networks: EvmE2ENetwork[];
    /** Stops the anvils this call started — reusing an already-running instance never tears it
     * down (see the "process lifecycle toggle" in the e2e suite's plan). */
    stopAnvils: () => Promise<void>;
}

interface DeploymentFile {
    poolAddress: Address;
    entrypointAddress: Address;
    keystoreAddress: Address;
    aspRegistryAddress: Address;
    privacyPoolRelayAddress: Address;
    deploymentBlock: Hex;
    relaySwapsAddress: Address;
    mockRouterAddress: Address;
    mockErc20Address: Address;
    mockExecutorAddress: Address;
    mockErc20ProxyAddress: Address;
    yieldTokenAddress: Address;
    yieldZapAddress: Address;
    yieldRouterAddress: Address;
    yieldUnderlyingAddress: Address;
    nativeYieldTokenAddress: Address;
    nativeYieldZapAddress: Address;
    nativeYieldRouterAddress: Address;
    nativeYieldUnderlyingAddress: Address;
}

/** Opt-in: leave the anvils this run started running afterwards (warm starts make re-runs cheap anyway). */
const KEEP_ALIVE = process.env.EVM_E2E_KEEP_ALIVE === "1";

export async function ensureDeployed(lanes: number): Promise<EnsureDeployedResult> {
    const snapshotPath = SNAPSHOT_ENABLED ? join(DEPLOYMENTS_DIR, `${SNAPSHOT_PREFIX}${snapshotKey()}.json`) : undefined;
    const networks: EvmE2ENetwork[] = [];
    const stops: (() => Promise<void>)[] = [];
    const stopAnvils = async (): Promise<void> => {
        await Promise.all(stops.map((stop) => stop()));
    };
    try {
        // One lane at a time: lane 0 deploys and writes the snapshot when there is none, so the
        // others start from it (and concurrent `forge script`s would share broadcast files).
        for (let lane = 0; lane < lanes; lane++) {
            const { network, stopAnvil } = await ensureLaneDeployed(laneRpcUrl(lane), snapshotPath);
            networks.push(network);
            if (stopAnvil) stops.push(stopAnvil);
        }
    } catch (error) {
        await stopAnvils();
        throw error;
    }
    return { networks, stopAnvils };
}

/** Starts (or reuses) the anvil at `rpcUrl` and makes sure it holds the deployment. */
async function ensureLaneDeployed(
    rpcUrl: string,
    snapshotPath: string | undefined,
): Promise<{ network: EvmE2ENetwork; stopAnvil?: () => Promise<void> }> {
    const deploymentPath = join(DEPLOYMENTS_DIR, `local-${new URL(rpcUrl).port}.json`);
    const { stopAnvil, freshlyStarted, restored } = await startLocalNetworkIfNeeded(rpcUrl, snapshotPath);
    if (freshlyStarted && existsSync(deploymentPath)) {
        // A fresh node has no state — a cached deployment from a previous (now-gone) node would
        // point at addresses that don't exist on this one.
        rmSync(deploymentPath);
    }
    if (restored) writeDeployment(deploymentPath, restored.deployment);

    // The deploy key is a fixed e2e-only key, not an anvil genesis account — it starts at zero, so
    // the broadcast below (and the mock ASP's root updates) would fail for insufficient funds
    // without this. Idempotent and cheap, so just always top it up.
    await fundAddress(rpcUrl, privateKeyToAccount(DEPLOYER_PRIVATE_KEY).address as Address);
    // Idempotent too, and the deploy links against the Poseidon libraries.
    await installCanonicalCode(rpcUrl);

    let deployment = readDeployment(deploymentPath);
    if (!deployment) {
        deployment = await deploy(rpcUrl);
        writeDeployment(deploymentPath, deployment);
        if (freshlyStarted && snapshotPath !== undefined) await saveSnapshot(rpcUrl, snapshotPath, deployment);
    }

    return {
        network: { rpcUrl, chainId: CHAIN_ID, ...deployment, deployerPrivateKey: DEPLOYER_PRIVATE_KEY },
        stopAnvil,
    };
}

/**
 * Starts anvil at `rpcUrl` unless one is already serving there. A fresh one starts from the
 * snapshot at `snapshotPath` when it has one that loads, and from genesis otherwise.
 */
async function startLocalNetworkIfNeeded(
    rpcUrl: string,
    snapshotPath: string | undefined,
): Promise<{
    stopAnvil?: () => Promise<void>;
    freshlyStarted: boolean;
    /** The snapshot the fresh anvil started from, if it did. */
    restored?: Snapshot;
}> {
    if (await isHealthy(rpcUrl)) {
        return { freshlyStarted: false };
    }

    const snapshot = snapshotPath === undefined ? undefined : readSnapshot(snapshotPath);
    if (snapshot) {
        // `--load-state` wants the plain JSON `anvil_dumpState` gzips; the RPC `anvil_loadState`
        // refuses a large dump (a request-size limit), so the state goes in at startup instead.
        writeFileSync(LOAD_STATE_PATH, gunzipSync(Buffer.from(snapshot.state.slice(2), "hex")));
        try {
            const started = await startAnvil(rpcUrl, ["--load-state", LOAD_STATE_PATH]);
            if (started) return { ...started, freshlyStarted: true, restored: snapshot };
        } finally {
            rmSync(LOAD_STATE_PATH, { force: true });
        }
    }
    const started = await startAnvil(rpcUrl, []);
    if (!started) throw new Error(`anvil exited before becoming ready at ${rpcUrl}`);
    return { ...started, freshlyStarted: true };
}

/** `undefined` when anvil exits before it serves (e.g. a state file it can't load). */
async function startAnvil(
    rpcUrl: string,
    extraArgs: string[],
): Promise<{ stopAnvil?: () => Promise<void> } | undefined> {
    // Always detached (own process group) regardless of KEEP_ALIVE — matches relayer.ts's
    // `ensureRelayerRunning`: killing via the process group (`process.kill(-child.pid, ...)`) is
    // reliable even if the launched command ever turns out to fork its own children, whereas
    // `.unref()` alone only controls whether it outlives this process, not how it's torn down.
    const child = spawn(
        "anvil",
        [
            "--host",
            "0.0.0.0",
            "--port",
            new URL(rpcUrl).port,
            "--chain-id",
            String(CHAIN_ID),
            ...(FORK_URL ? ["--fork-url", FORK_URL] : []),
            ...extraArgs,
        ],
        {
            stdio: "ignore",
            detached: true,
        },
    );
    if (KEEP_ALIVE) {
        child.unref();
    }

    for (let attempt = 0; attempt < 120; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) return undefined;
        if (await isHealthy(rpcUrl)) {
            return { stopAnvil: KEEP_ALIVE ? undefined : () => stopProcessGroup(child.pid) };
        }
        await sleep(500);
    }
    await stopProcessGroup(child.pid);
    throw new Error(`anvil did not become ready at ${rpcUrl} within 60s`);
}

/** Tops up `address` to a large native balance via `anvil_setBalance` — e2e-only keys aren't
 * genesis accounts, so they start at zero. 1000 ETH, well above anything a single e2e run needs
 * for gas. */
export async function fundAddress(rpcUrl: string, address: Address): Promise<void> {
    await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "anvil_setBalance",
            params: [address, "0x3635C9ADC5DEA00000"], // 1000 ETH
        }),
    });
}

/** Puts the canonical Sepolia contracts' runtime code at their real addresses via `anvil_setCode`.
 * All three are stateless (pure libraries, an event-only Announcer), so code alone is the whole
 * contract; the libraries' call guard compares against their own address, which is unchanged. */
async function installCanonicalCode(rpcUrl: string): Promise<void> {
    const contracts = JSON.parse(readFileSync(CANONICAL_CODE_PATH, "utf-8")) as Record<
        string,
        { address: Address; code: Hex }
    >;
    for (const { address, code } of Object.values(contracts)) {
        const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setCode", params: [address, code] }),
        });
        const body = (await response.json()) as { error?: { message: string } };
        if (body.error) throw new Error(`anvil_setCode ${address}: ${body.error.message}`);
    }
}

async function isHealthy(rpcUrl: string): Promise<boolean> {
    try {
        const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_chainId",
                params: [],
            }),
        });
        const body = (await response.json()) as { result?: string };
        return typeof body.result === "string";
    } catch {
        return false;
    }
}

/** Only `approveZap` — the one call `deploy()` itself needs to make directly, bridging
 * the two independent Foundry projects' deploy outputs (RelaySwaps and the yield stack can't call
 * each other's deploy scripts — see its own comment below). */
const RELAY_SWAPS_APPROVE_ZAP_ABI = [
    {
        name: "approveZap",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "_zap", type: "address" }],
        outputs: [],
    },
] as const;

/**
 * Post-deploy anvil snapshots. The three `forge script` deploys cost ~40 s; a fresh anvil
 * instead starts from the chain as it stood right after a previous deploy (`anvil_dumpState` /
 * `anvil --load-state` — accounts, storage, blocks, receipts and logs, so the deploy block's events
 * are still served). The key hashes everything the deploy depends on, so any change to it deploys
 * from scratch and writes a new snapshot. Every lane's anvil starts from the same one, so all lanes
 * hold the same deployment at the same addresses.
 */
function snapshotKey(): string {
    const hash = createHash("sha256");
    const add = (path: string): void => {
        if (!existsSync(path)) return;
        if (statSync(path).isDirectory()) {
            for (const entry of readdirSync(path).sort()) add(join(path, entry));
            return;
        }
        hash.update(relative(join(__dirname, "../../.."), path));
        hash.update(readFileSync(path));
    };
    for (const dir of [CONTRACTS_DIR, SWAPS_CONTRACTS_DIR]) {
        for (const entry of ["src", "script", "foundry.toml", "remappings.txt"]) add(join(dir, entry));
    }
    // Solidity dependencies resolve from node_modules: their versions are pinned by these.
    add(join(CONTRACTS_DIR, "package.json"));
    add(join(SWAPS_CONTRACTS_DIR, "../package.json"));
    add(join(__dirname, "../../../pnpm-lock.yaml"));
    add(CANONICAL_CODE_PATH);
    add(fileURLToPath(import.meta.url)); // the deploy steps themselves
    // The dump format is anvil's own; a snapshot from another anvil version may not load.
    hash.update(execFileSync("anvil", ["--version"], { encoding: "utf-8" }));
    return hash.digest("hex").slice(0, 16);
}

interface Snapshot {
    state: Hex;
    deployment: DeploymentFile;
}

/** The snapshot at `path`; `undefined` (deploy instead) when there is none or it can't be read. */
function readSnapshot(path: string): Snapshot | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const snapshot = JSON.parse(readFileSync(path, "utf-8")) as Snapshot;
        return snapshot.deployment && typeof snapshot.state === "string" ? snapshot : undefined;
    } catch {
        return undefined;
    }
}

/** Saves the just-deployed chain as the only snapshot (older keys are stale by definition). */
async function saveSnapshot(rpcUrl: string, path: string, deployment: DeploymentFile): Promise<void> {
    const state = (await rpcCall(rpcUrl, "anvil_dumpState", [])) as Hex;
    for (const entry of readdirSync(DEPLOYMENTS_DIR)) {
        if (entry.startsWith(SNAPSHOT_PREFIX)) rmSync(join(DEPLOYMENTS_DIR, entry));
    }
    writeFileSync(path, JSON.stringify({ state, deployment } satisfies Snapshot));
}

async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = (await response.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
}

/** The deployment recorded at `path` for a running anvil, `undefined` when there is none. */
function readDeployment(path: string): DeploymentFile | undefined {
    if (!existsSync(path)) return undefined;
    const cached = JSON.parse(readFileSync(path, "utf-8")) as DeploymentFile;
    // A file from before the native yield stack or the mock executor existed lacks their
    // addresses: redeploy rather than hand the suite a deployment it cannot run against.
    return cached.nativeYieldTokenAddress && cached.mockExecutorAddress ? cached : undefined;
}

function writeDeployment(path: string, deployment: DeploymentFile): void {
    mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
    writeFileSync(path, JSON.stringify(deployment, null, 4));
}

/** Deploys the whole stack to the anvil at `rpcUrl`. */
async function deploy(rpcUrl: string): Promise<DeploymentFile> {

    // PoolVault/Keystore link against the poseidon-solidity library (PoseidonT3/PoseidonT4),
    // which also exceeds EIP-170's 24576-byte size limit — script/README.md's "Poseidon Library
    // Linking" section requires these `--libraries` flags on every broadcast deploy so forge
    // links against the canonical CREATE2 addresses (installed by `installCanonicalCode`) instead
    // of trying to deploy fresh (oversized) copies.
    const output = execFileSync(
        "forge",
        [
            "script",
            "script/DeployE2ELocal.s.sol",
            "--sig",
            "runLocal()",
            "--rpc-url",
            rpcUrl,
            "--broadcast",
            // One tx at a time, each waited on: a plain anvil automines fast enough that a burst of
            // broadcasts can leave one stranded in the mempool, unmined, and the deploy hangs.
            "--slow",
            "--libraries",
            "poseidon-solidity/PoseidonT3.sol:PoseidonT3:0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93",
            "--libraries",
            "poseidon-solidity/PoseidonT4.sol:PoseidonT4:0x4443338EF595F44e0121df4C21102677B142ECF0",
        ],
        {
            cwd: CONTRACTS_DIR,
            encoding: "utf-8",
            env: { ...process.env, PRIVATE_KEY: DEPLOYER_PRIVATE_KEY },
        },
    );

    const poolAddress = extractAddress(output, "POOLVAULT");
    const entrypointAddress = extractAddress(output, "ENTRYPOINT");

    // RelaySwaps + a mock router standing in for the LiFi Diamond (LiFi has no
    // solver/liquidity on local/test chains) live in a separate Foundry project
    // (packages/swaps/contracts has its own foundry.toml; packages/contracts has no remapping
    // back into it) — a second, independent forge script run, same idempotency envelope.
    const swapsOutput = execFileSync(
        "forge",
        [
            "script",
            "script/DeployE2ELocalSwaps.s.sol",
            "--sig",
            "runLocal()",
            "--rpc-url",
            rpcUrl,
            "--broadcast",
            "--slow",
        ],
        {
            cwd: SWAPS_CONTRACTS_DIR,
            encoding: "utf-8",
            env: {
                ...process.env,
                PRIVATE_KEY: DEPLOYER_PRIVATE_KEY,
                POOL_ADDRESS: poolAddress,
                ENTRYPOINT_ADDRESS: entrypointAddress,
            },
        },
    );

    const relaySwapsAddress = extractAddress(swapsOutput, "RELAYSWAPS");

    // The ppUSDC-over-mock-Aave yield stack lives in packages/contracts (a third, independent
    // forge invocation — same idempotency envelope as the swaps deploy above), for
    // RelaySwaps.executeUnwrapped coverage. See DeployE2ELocalYield.s.sol's own doc comment.
    const yieldOutput = execFileSync(
        "forge",
        [
            "script",
            "script/DeployE2ELocalYield.s.sol",
            "--sig",
            "run()",
            "--rpc-url",
            rpcUrl,
            "--broadcast",
            "--slow",
        ],
        {
            cwd: CONTRACTS_DIR,
            encoding: "utf-8",
            env: {
                ...process.env,
                PRIVATE_KEY: DEPLOYER_PRIVATE_KEY,
                POOL_ADDRESS: poolAddress,
                ENTRYPOINT_ADDRESS: entrypointAddress,
            },
        },
    );
    const yieldZapAddress = extractAddress(yieldOutput, "PPYIELDZAP");

    // Allowlists the yield zap on RelaySwaps so `executeUnwrapped()` can unwrap it. Neither forge
    // project can make this call itself: it needs BOTH RelaySwaps (deployed by the swaps project)
    // and the zap (deployed by the yield stack, a separate Foundry project) — the only place that
    // sees both addresses is here, in TypeScript, after both scripts have run. Signed by the
    // deployer key, which is RelaySwaps' owner (see DeployE2ELocalSwaps.s.sol).
    const deployerWalletClient = createWalletClient({
        account: privateKeyToAccount(DEPLOYER_PRIVATE_KEY),
        transport: http(rpcUrl),
    });
    // Both yield zaps: the relayer refuses to boot while an "Underlying"-quoted share has no
    // allowlisted zap (YieldZapRegistry), so the native stack's zap needs it as much as yUSDC's.
    for (const zap of [yieldZapAddress, extractAddress(yieldOutput, "NATIVEYIELDZAP")]) {
        const approveZapHash = await deployerWalletClient.writeContract({
            address: relaySwapsAddress,
            abi: RELAY_SWAPS_APPROVE_ZAP_ABI,
            functionName: "approveZap",
            args: [zap],
            chain: null,
        });
        await waitForTransaction(rpcUrl, approveZapHash);
    }

    const deployment: DeploymentFile = {
        poolAddress,
        entrypointAddress,
        keystoreAddress: extractAddress(output, "KEYSTORE"),
        aspRegistryAddress: extractAddress(output, "ASPREGISTRY"),
        privacyPoolRelayAddress: extractAddress(output, "PRIVACYPOOLRELAY"),
        deploymentBlock: extractDeployBlock(output),
        relaySwapsAddress,
        mockRouterAddress: extractAddress(swapsOutput, "MOCKROUTER"),
        mockErc20Address: extractAddress(swapsOutput, "MOCKERC20"),
        mockExecutorAddress: extractAddress(swapsOutput, "MOCKEXECUTOR"),
        mockErc20ProxyAddress: extractAddress(swapsOutput, "MOCKERC20PROXY"),
        yieldTokenAddress: extractAddress(yieldOutput, "PPYIELDTOKEN"),
        yieldZapAddress,
        yieldRouterAddress: extractAddress(yieldOutput, "PPROUTER"),
        yieldUnderlyingAddress: extractAddress(yieldOutput, "YIELDUNDERLYING"),
        nativeYieldTokenAddress: extractAddress(yieldOutput, "NATIVEYIELDTOKEN"),
        nativeYieldZapAddress: extractAddress(yieldOutput, "NATIVEYIELDZAP"),
        nativeYieldRouterAddress: extractAddress(yieldOutput, "NATIVEPPROUTER"),
        nativeYieldUnderlyingAddress: extractAddress(yieldOutput, "NATIVEYIELDUNDERLYING"),
    };

    return deployment;
}

/** Polls `eth_getTransactionReceipt` until `hash` is mined — a minimal stand-in for viem's
 * `publicClient.waitForTransactionReceipt`, since `deploy` has no public client of its
 * own (every other on-chain read here goes through `forge script`'s own RPC calls, not viem). */
async function waitForTransaction(rpcUrl: string, hash: Hex): Promise<void> {
    for (let attempt = 0; attempt < 120; attempt++) {
        const response = await fetch(rpcUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "eth_getTransactionReceipt",
                params: [hash],
            }),
        });
        const body = (await response.json()) as { result?: { status?: Hex } };
        if (body.result) return;
        await sleep(500);
    }
    throw new Error(`transaction ${hash} was not mined within 60s`);
}

function extractAddress(output: string, key: string): Address {
    const match = new RegExp(`\\b${key} (0x[0-9a-fA-F]{40})`).exec(output);
    if (!match) {
        throw new Error(`DeployE2ELocal.s.sol output is missing a "${key} 0x..." line:\n${output}`);
    }
    return match[1] as Address;
}

function extractDeployBlock(output: string): Hex {
    const match = /DEPLOYBLOCK (\d+)/.exec(output);
    if (!match) {
        throw new Error(`DeployE2ELocal.s.sol output is missing a "DEPLOYBLOCK <number>" line:\n${output}`);
    }
    return `0x${BigInt(match[1]!).toString(16)}` as Hex;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
