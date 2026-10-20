/**
 * Deployment utilities for Privacy Pools V2 Stellar contracts.
 *
 * Provides helpers for:
 * - Stellar CLI wrapper functions (deploy, invoke, identity)
 * - Deployment state persistence (read/write testnet.json)
 * - VK conversion from snarkjs JSON to Soroban contract format
 * - XDR encoding helpers for U256 and BytesN types
 *
 * Deliberately dependency-free (only Node built-ins) — `packages/contracts-stellar` isn't part of
 * the pnpm workspace, so it has no `node_modules` of its own. Run directly via `node <file>.mts`,
 * relying on Node's native TypeScript type-stripping (no flag needed on Node >=22.18; use
 * `--experimental-strip-types` on Node 22.6–22.17). `.mts` (not `.mjs`) so type annotations are
 * allowed while still forcing ESM regardless of the missing `package.json`'s absent `"type"` field.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const DEPLOYMENTS_DIR = join(__dirname, "../deployments");
const WASM_DIR = join(ROOT_DIR, "target", "wasm32v1-none", "release");

// Ensure deployments directory exists
mkdirSync(DEPLOYMENTS_DIR, { recursive: true });

// ─── Stellar CLI helpers ───────────────────────────────────────────────

export interface RunOptions {
    /** Suppress stderr output. */
    silent?: boolean;
}

/** Error shape `execSync` throws — augments `Error` with the captured stdio. */
interface ExecError extends Error {
    stdout?: Buffer | string;
}

/**
 * Run a shell command and return trimmed stdout.
 */
export function run(cmd: string, opts: RunOptions = {}): string {
    try {
        const result = execSync(cmd, {
            encoding: "utf-8",
            stdio: opts.silent ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "inherit"],
            cwd: ROOT_DIR,
        });
        return result.trim();
    } catch (err) {
        const execErr = err as ExecError;
        if (execErr.stdout) return execErr.stdout.toString().trim();
        throw err;
    }
}

/**
 * Check that the stellar CLI is available.
 */
export function checkStellarCLI(): void {
    try {
        run("stellar --version", { silent: true });
    } catch {
        throw new Error("stellar CLI not found. Install it: https://soroban.stellar.org/docs/getting-started/setup");
    }
}

/**
 * Get or create a Stellar identity for deployment.
 * If the identity doesn't exist, generates a new one and funds it via friendbot.
 *
 * @param name - Identity name (e.g., "ppv2-deployer")
 * @param network - Network name (e.g., "testnet")
 * @returns Public address (G...)
 */
export function ensureIdentity(name: string, network: string): string {
    try {
        const addr = run(`stellar keys address ${name}`, { silent: true });
        if (addr) {
            console.log(`  Identity "${name}" exists: ${addr}`);
            return addr;
        }
    } catch {
        // Identity doesn't exist, create it
    }

    console.log(`  Creating identity "${name}"...`);
    run(`stellar keys generate ${name} --network ${network} --fund`, { silent: true });
    const addr = run(`stellar keys address ${name}`, { silent: true });
    console.log(`  Created and funded: ${addr}`);
    return addr;
}

/**
 * Fund an account via friendbot (testnet/futurenet only).
 */
export async function fundAccount(address: string): Promise<void> {
    const url = `https://friendbot.stellar.org?addr=${address}`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) {
            const body = await resp.text();
            // Already funded accounts return 400 — that's fine
            if (!body.includes("createAccountAlreadyExist")) {
                console.warn(`  Friendbot warning: ${resp.status} ${body.slice(0, 200)}`);
            }
        }
    } catch (err) {
        console.warn(`  Friendbot request failed: ${(err as Error).message}`);
    }
}

/**
 * Deploy a WASM contract to the network.
 *
 * @param wasmPath - Path to the .wasm file
 * @param source - Deployer identity name or secret key
 * @param network - Network name
 * @returns Contract ID (C...)
 */
export function deployWasm(wasmPath: string, source: string, network: string): string {
    if (!existsSync(wasmPath)) {
        throw new Error(`WASM file not found: ${wasmPath}`);
    }

    const output = run(`stellar contract deploy --wasm "${wasmPath}" --source-account "${source}" --network ${network}`, {
        silent: true,
    });

    // Extract contract ID from output (C followed by 55 alphanumeric chars)
    const match = output.match(/C[A-Z0-9]{55}/);
    if (!match) {
        throw new Error(`Failed to parse contract ID from deploy output:\n${output}`);
    }
    return match[0];
}

/**
 * Single-quotes a shell argument, escaping any embedded single quotes —
 * needed because `run()` executes through `/bin/sh -c`, which would
 * otherwise strip unquoted `"`/`{`/`}`/`:` characters out of JSON-valued
 * args (e.g. `--vk`) before the stellar CLI ever sees them.
 */
function shellQuote(value: string): string {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * Invoke a contract function via the stellar CLI.
 *
 * @param contractId - Contract ID (C...)
 * @param fn - Function name
 * @param args - CLI args (e.g., ["--admin", "G...", "--root_history_size", "64"])
 * @param source - Deployer identity name
 * @param network - Network name
 * @returns Invocation output
 */
export function invokeContract(contractId: string, fn: string, args: string[], source: string, network: string): string {
    const argsStr = args.map(shellQuote).join(" ");
    const cmd = `stellar contract invoke --id ${contractId} --source-account "${source}" --network ${network} -- ${fn} ${argsStr}`;
    return run(cmd);
}

// ─── WASM paths ────────────────────────────────────────────────────────

export interface WasmPaths {
    pool: string;
    keystore: string;
    aspRegistry: string;
    relay: string;
    yieldBlendAdapter: string;
    yieldToken: string;
    yieldRouter: string;
}

/**
 * Get the WASM file paths for all contracts.
 * Must run `stellar contract build` first.
 */
export function getWasmPaths(): WasmPaths {
    return {
        pool: join(WASM_DIR, "pool.wasm"),
        keystore: join(WASM_DIR, "keystore.wasm"),
        aspRegistry: join(WASM_DIR, "asp_registry.wasm"),
        relay: join(WASM_DIR, "relay.wasm"),
        yieldBlendAdapter: join(WASM_DIR, "yield_blend_adapter.wasm"),
        yieldToken: join(WASM_DIR, "yield_token.wasm"),
        yieldRouter: join(WASM_DIR, "yield_router.wasm"),
    };
}

/**
 * Build all contracts using the stellar CLI.
 */
export function buildContracts(): void {
    console.log("Building contracts...");
    run("stellar contract build", { silent: false });
    console.log("Build complete.");
}

// ─── Deployment state persistence ──────────────────────────────────────

export interface DeploymentState {
    network: string;
    deployer: string;
    timestamp: string;
    aspRegistry: string;
    keystore: string;
    pool: string;
    relay: string;
    initialized: boolean;
    vksRegistered: boolean;
    assetsConfigured: boolean;
    rootHistorySize?: number;
    keystoreRootLiveness?: number;
    maxStateTreeSize?: number;
    maxKeystoreTreeSize?: number;
    assets?: string[];
    vkCount?: number;
    /** The yield modules `deploy-yield.mts` has deployed and verified, one per underlying. */
    yields?: YieldDeploymentState[];
    /** Legacy single-module record (before `yields`); read through {@link yieldsOf}, never written. */
    yield?: YieldDeploymentState;
}

/** Every yield module a deployment records — `yields`, or the legacy single `yield`. */
export function yieldsOf(deployment: Pick<DeploymentState, "yields" | "yield">): YieldDeploymentState[] {
    return deployment.yields ?? (deployment.yield ? [deployment.yield] : []);
}

/** One yield deployment: a Blend adapter, the share wrapper (the shielded asset) and its router. */
export interface YieldDeploymentState {
    adapter: string;
    /** The share token — registered as a pool asset; what yield notes are denominated in. */
    token: string;
    /** The pool processor for yield withdrawals and the entry point for yield deposits. */
    router: string;
    blendPool: string;
    underlying: string;
    underlyingDecimals: number;
    underlyingSymbol: string;
    /**
     * `CODE:ISSUER` when the underlying is a classic asset other than XLM (holding it needs a
     * trustline); absent for native XLM.
     */
    classicAsset?: string;
    shareDecimals: number;
    initialFeeBps: number;
    decimalsOffset: number;
}

/**
 * Load deployment state from disk.
 */
export function loadDeployment(network: string): DeploymentState | null {
    const path = join(DEPLOYMENTS_DIR, `${network}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8")) as DeploymentState;
}

/**
 * Save deployment state to disk.
 */
export function saveDeployment(network: string, state: DeploymentState): void {
    const path = join(DEPLOYMENTS_DIR, `${network}.json`);
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
    console.log(`  Saved deployment state to ${path}`);
}

// ─── VK conversion helpers ─────────────────────────────────────────────

/** snarkjs affine G1 point: [x, y, "1"] (decimal strings). */
type SnarkjsG1Point = [string, string, string];
/** snarkjs Fq2 G2 point: [[c0, c1], [c0, c1], ["1", "0"]] (real/imag decimal strings). */
type SnarkjsG2Point = [[string, string], [string, string], [string, string]];

export interface SnarkjsVerificationKey {
    vk_alpha_1: SnarkjsG1Point;
    vk_beta_2: SnarkjsG2Point;
    vk_gamma_2: SnarkjsG2Point;
    vk_delta_2: SnarkjsG2Point;
    IC: SnarkjsG1Point[];
}

export interface ConvertedVK {
    alpha: string;
    beta: string;
    gamma: string;
    delta: string;
    ic: string[];
}

/**
 * Convert a BigInt (or its decimal-string form) to a 32-byte big-endian hex string (64 hex chars).
 */
function bigintToHex32(n: string): string {
    return BigInt(n).toString(16).padStart(64, "0");
}

/**
 * Convert a snarkjs G1 point to a hex string (64 bytes = 128 hex chars).
 * snarkjs format: [x, y, "1"] (decimal strings, affine)
 * Soroban format: [x(32 BE), y(32 BE)]
 */
function g1ToHex(point: SnarkjsG1Point): string {
    return bigintToHex32(point[0]) + bigintToHex32(point[1]);
}

/**
 * Convert a snarkjs G2 point to a hex string (128 bytes = 256 hex chars).
 * snarkjs format: [[c0/real, c1/imag], [c0/real, c1/imag], ["1", "0"]]
 * Soroban format: [x_c1(imag), x_c0(real), y_c1(imag), y_c0(real)]
 *
 * IMPORTANT: snarkjs stores Fq2 as [real, imag] but Soroban/EVM expects [imag, real].
 */
function g2ToHex(point: SnarkjsG2Point): string {
    const xC0 = point[0][0]; // real
    const xC1 = point[0][1]; // imag
    const yC0 = point[1][0]; // real
    const yC1 = point[1][1]; // imag
    return bigintToHex32(xC1) + bigintToHex32(xC0) + bigintToHex32(yC1) + bigintToHex32(yC0);
}

/**
 * Convert a snarkjs verification key JSON to the hex format expected by the contract.
 */
export function convertVK(vkJson: SnarkjsVerificationKey): ConvertedVK {
    return {
        alpha: g1ToHex(vkJson.vk_alpha_1),
        beta: g2ToHex(vkJson.vk_beta_2),
        gamma: g2ToHex(vkJson.vk_gamma_2),
        delta: g2ToHex(vkJson.vk_delta_2),
        ic: vkJson.IC.map((p) => g1ToHex(p)),
    };
}

/**
 * Build the stellar CLI args for a set_vk invocation.
 * The contract expects VerificationKeyBytes { alpha: BytesN<64>, beta: BytesN<128>,
 *   gamma: BytesN<128>, delta: BytesN<128>, ic: Vec<BytesN<64>> }
 *
 * The stellar CLI accepts --vk with JSON-formatted XDR-compatible values.
 */
export function vkToCliJson(vk: ConvertedVK): string {
    const obj = {
        alpha: { bytes: vk.alpha },
        beta: { bytes: vk.beta },
        gamma: { bytes: vk.gamma },
        delta: { bytes: vk.delta },
        ic: vk.ic.map((h) => ({ bytes: h })),
    };
    return JSON.stringify(obj);
}

// ─── Circuit directory helpers ─────────────────────────────────────────

const CIRCUITS_DIR = join(ROOT_DIR, "../circuits/build");

/**
 * Load a verification key from the circuit build directory.
 *
 * @param circuitName - e.g., "deposit", "ragequit", "transact_1x1"
 */
export function loadVK(circuitName: string): SnarkjsVerificationKey {
    const vkPath = join(CIRCUITS_DIR, circuitName, "groth16_vkey.json");
    if (!existsSync(vkPath)) {
        throw new Error(`VK file not found: ${vkPath}`);
    }
    return JSON.parse(readFileSync(vkPath, "utf-8")) as SnarkjsVerificationKey;
}

export interface AvailableVK {
    name: string;
    path: string;
}

/**
 * List available circuit VK files.
 */
export function listAvailableVKs(): AvailableVK[] {
    const results: AvailableVK[] = [];
    const circuits: { name: string; dir: string }[] = [
        { name: "deposit", dir: "deposit" },
        { name: "ragequit", dir: "ragequit" },
    ];
    for (let n = 1; n <= 5; n++) {
        for (let m = 1; m <= 5; m++) {
            circuits.push({ name: `transact_${n}x${m}`, dir: `transact_${n}x${m}` });
        }
    }
    for (const c of circuits) {
        const vkPath = join(CIRCUITS_DIR, c.dir, "groth16_vkey.json");
        if (existsSync(vkPath)) {
            results.push({ name: c.name, path: vkPath });
        }
    }
    return results;
}

// ─── Logging helpers ───────────────────────────────────────────────────

export function step(msg: string): void {
    console.log(`\n==> ${msg}`);
}

export function success(msg: string): void {
    console.log(`  OK: ${msg}`);
}

export function warn(msg: string): void {
    console.warn(`  WARN: ${msg}`);
}

export { ROOT_DIR, DEPLOYMENTS_DIR, WASM_DIR, CIRCUITS_DIR };
