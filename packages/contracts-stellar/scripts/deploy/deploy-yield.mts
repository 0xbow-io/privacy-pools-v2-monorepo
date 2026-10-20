#!/usr/bin/env node
/**
 * Deploy, wire and verify the yield module against an already-deployed privacy pool.
 *
 * Usage: node scripts/deploy/deploy-yield.mts [--network testnet|local] [--source ppv2-deployer]
 *                                              [--dry-run] [--verify-only]
 *
 * Ported from upstream `ppv2-stellar@test/blend-testnet:scripts/deploy/deploy-yield.mjs`, which
 * deploys only the adapter + wrapper. This one completes the module: it also deploys the router
 * and registers the share token as a pool asset, without which `deposit_exact_shares` fails on the
 * pool's own asset check (upstream `docs/YIELD_DEPLOYMENT.md` step 4).
 *
 *   validate (pre-broadcast) -> deploy x3 -> adapter.initialize -> token.initialize
 *     -> router.initialize -> pool.set_asset_config(share token) -> verify (read everything back)
 *
 * Order is load-bearing: the wrapper's `initialize` calls back into the adapter (`underlying()`,
 * then the dead-share seed through `supply()`), so the adapter is initialized first, with the
 * WRAPPER's contract address as its owner.
 *
 * All three `initialize` functions are unauthenticated (the port-wide convention). A third party
 * calling one first between our deploy and our initialize is caught by the post-deploy read-back
 * (`token.admin`, `adapter`/`router` wiring) and fails this script loudly; nothing is announced or
 * written to the deployment file until it passes.
 *
 * One module is deployed per underlying. Venue config comes from
 * `scripts/deployments/local.blend.json` (written by `scripts/blend/deploy-local-blend.mts`) on local —
 * a native XLM module and a USDC one, so the e2e suite covers both underlying kinds — and from
 * `scripts/config/yield.<network>.json` elsewhere (one config object, or an array of them). The
 * result is stored under `yields` in `scripts/deployments/<network>.json`.
 *
 * Incremental: a module already recorded for an underlying is re-verified, not redeployed, so adding
 * an underlying to the config and re-running deploys only the new one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { checkStellarCLI, deployWasm, getWasmPaths, loadDeployment, saveDeployment, step, success, warn } from "./utils.mts";
import { yieldsOf } from "./utils.mts";
import type { YieldDeploymentState } from "./utils.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
        "dry-run": { type: "boolean", default: false },
        "verify-only": { type: "boolean", default: false },
    },
});
const network = args.network as string;
const source = args.source as string;

/** Venue + wrapper parameters for one network. */
export interface YieldConfig {
    /** The Blend lending pool the adapter supplies into. */
    blendPool: string;
    /** The reserve asset (the underlying the user holds). */
    underlying: string;
    underlyingDecimals: number;
    underlyingSymbol: string;
    /** `CODE:ISSUER` for a classic underlying other than XLM; absent for native XLM. */
    classicAsset?: string;
    /** Protocol fee on yield, bps; `<= MAX_FEE_BPS`. */
    initialFeeBps: number;
    /** Virtual-share offset: the first-depositor inflation buffer; `MIN..=MAX_DECIMALS_OFFSET`. */
    decimalsOffset: number;
    name: string;
    symbol: string;
    /** Pool asset config for the SHARE token, in share units. */
    minDepositShares: string;
    vettingFeeBps: number;
    maxRelayFeeShares: string;
}

/** Read a bound out of the contract source rather than restating it (upstream's #131 lesson). */
function rustConst(file: string, name: string): bigint {
    const src = readFileSync(join(ROOT_DIR, file), "utf-8");
    const m = src.match(new RegExp(`pub const ${name}: [a-z0-9]+ = ([0-9_]+);`));
    if (!m) throw new Error(`could not read ${name} from ${file}`);
    return BigInt(m[1]!.replace(/_/g, ""));
}
const YT = "contracts/yield-token/src/lib.rs";
const MAX_FEE_BPS = rustConst(YT, "MAX_FEE_BPS");
const MIN_DECIMALS_OFFSET = rustConst(YT, "MIN_DECIMALS_OFFSET");
const MAX_DECIMALS_OFFSET = rustConst(YT, "MAX_DECIMALS_OFFSET");
const MAX_DECIMALS = rustConst(YT, "MAX_DECIMALS");
const DEAD_SHARES = rustConst(YT, "DEAD_SHARES");

/**
 * Share decimals = underlying decimals + offset. `exchange_rate` values ONE WHOLE share
 * (`10^decimals` share units), and each underlying unit mints `10^offset` share units at genesis,
 * so anything smaller makes one share worth a fraction of a stroop and `exchange_rate` floors to 0.
 * (Upstream's testnet deploy passed the underlying's 7 here and has exactly that defect.)
 */
export function shareDecimals(cfg: Pick<YieldConfig, "underlyingDecimals" | "decimalsOffset">): number {
    return cfg.underlyingDecimals + cfg.decimalsOffset;
}

function stellar(cliArgs: string[]): string {
    return execFileSync("stellar", cliArgs, { encoding: "utf-8", cwd: ROOT_DIR, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function invoke(id: string, fn: string, fnArgs: string[] = []): string {
    return stellar(["contract", "invoke", "--id", id, "--source-account", source, "--network", network, "--", fn, ...fnArgs]);
}

/** Simulated read; the CLI prints the return value as JSON. */
function read<T = unknown>(id: string, fn: string, fnArgs: string[] = []): T {
    const out = stellar([
        "contract", "invoke", "--id", id, "--source-account", source, "--network", network, "--send=no", "--", fn, ...fnArgs,
    ]);
    return JSON.parse(out) as T;
}

/**
 * Defaults for one underlying. The pool config mirrors native XLM's (0.01 min, 1% vetting, 0.1 relay
 * fee cap) scaled into share units (x 10^offset at the genesis rate) — right for any 7-decimal
 * underlying, which every Stellar classic asset is.
 */
function defaultsFor(symbol: string) {
    return {
        underlyingSymbol: symbol,
        initialFeeBps: 500,
        decimalsOffset: 11,
        name: `Privacy Pools Yield ${symbol}`,
        symbol: `pp${symbol}`,
        minDepositShares: String(100_000n * 10n ** 11n),
        vettingFeeBps: 100,
        maxRelayFeeShares: String(1_000_000n * 10n ** 11n),
    };
}

function loadConfigs(deployer: string): YieldConfig[] {
    if (network === "local") {
        const blendPath = join(ROOT_DIR, "scripts/deployments/local.blend.json");
        if (!existsSync(blendPath)) {
            throw new Error(`No local Blend deployment at ${blendPath} — run scripts/blend/deploy-local-blend.mts first`);
        }
        const blend = JSON.parse(readFileSync(blendPath, "utf-8")) as {
            blendPool: string;
            underlying: string;
            underlyingDecimals: number;
            usdc: string;
        };
        return [
            { ...defaultsFor("XLM"), blendPool: blend.blendPool, underlying: blend.underlying, underlyingDecimals: blend.underlyingDecimals },
            // The deployer issues the local USDC (deploy-local-blend.mts), which is also a reserve of
            // the same pool — the non-native underlying the e2e suite needs.
            {
                ...defaultsFor("USDC"),
                blendPool: blend.blendPool,
                underlying: blend.usdc,
                underlyingDecimals: 7,
                classicAsset: `USDC:${deployer}`,
            },
        ];
    }
    const cfgPath = join(ROOT_DIR, `scripts/config/yield.${network}.json`);
    if (!existsSync(cfgPath)) throw new Error(`Missing yield config: ${cfgPath}`);
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as Partial<YieldConfig> | Partial<YieldConfig>[];
    return (Array.isArray(raw) ? raw : [raw]).map(
        (c) => ({ ...defaultsFor(c.underlyingSymbol ?? "XLM"), ...c }) as YieldConfig,
    );
}

/* ─── Pre-broadcast validation (audit #131 / AW-M-01) ─────────────────── */

export interface Check {
    ok: boolean;
    msg: string;
}

/** Pure: decide whether `cfg` may be broadcast, given what was read from the venue. */
export function evaluateConfig(input: {
    cfg: YieldConfig;
    blendStatus: number;
    reserve: { enabled: boolean; decimals: number } | null;
    deployerBalance: bigint;
}): Check[] {
    const { cfg, blendStatus, reserve, deployerBalance } = input;
    const rows: Check[] = [];
    const check = (ok: boolean, msg: string) => rows.push({ ok, msg });
    check(BigInt(cfg.initialFeeBps) <= MAX_FEE_BPS, `initialFeeBps ${cfg.initialFeeBps} <= MAX_FEE_BPS ${MAX_FEE_BPS}`);
    check(
        BigInt(cfg.decimalsOffset) >= MIN_DECIMALS_OFFSET && BigInt(cfg.decimalsOffset) <= MAX_DECIMALS_OFFSET,
        `decimalsOffset ${cfg.decimalsOffset} in ${MIN_DECIMALS_OFFSET}..=${MAX_DECIMALS_OFFSET}`,
    );
    check(BigInt(shareDecimals(cfg)) <= MAX_DECIMALS, `share decimals ${shareDecimals(cfg)} <= MAX_DECIMALS ${MAX_DECIMALS}`);
    // Blend v2: 0 = admin-active, 1 = active; everything above is on-ice / frozen / setup.
    check(blendStatus <= 1, `Blend pool status ${blendStatus} is active (0 or 1)`);
    check(reserve !== null, `underlying is a reserve in the Blend pool`);
    if (reserve) {
        check(reserve.enabled, `that reserve is enabled`);
        check(reserve.decimals === cfg.underlyingDecimals, `reserve decimals ${reserve.decimals} == config ${cfg.underlyingDecimals}`);
    }
    // The dead-share seed is bought through the deposit path: the funder must hold the underlying.
    check(deployerBalance > 0n, `deployer holds underlying for the dead-share seed (${deployerBalance})`);
    check(BigInt(cfg.vettingFeeBps) <= 10_000n, `share-token vettingFeeBps ${cfg.vettingFeeBps} <= 10000`);
    return rows;
}

function report(rows: Check[], what: string): void {
    const failed = rows.filter((r) => !r.ok);
    for (const r of rows) console.log(`  ${r.ok ? "ok  " : "FAIL"}  ${r.msg}`);
    if (failed.length) throw new Error(`${failed.length} ${what} check(s) failed`);
}

function validate(cfg: YieldConfig, deployer: string): void {
    step("Validating (pre-broadcast)");
    const blendStatus = read<{ status: number }>(cfg.blendPool, "get_config").status;
    let reserve: { enabled: boolean; decimals: number } | null = null;
    try {
        reserve = read<{ config: { enabled: boolean; decimals: number } }>(cfg.blendPool, "get_reserve", ["--asset", cfg.underlying]).config;
    } catch {
        reserve = null;
    }
    const deployerBalance = BigInt(read<string>(cfg.underlying, "balance", ["--id", deployer]));
    report(evaluateConfig({ cfg, blendStatus, reserve, deployerBalance }), "pre-broadcast");
}

/* ─── Post-deploy verification ────────────────────────────────────────── */

/** Pure: does what is on chain match what we meant to deploy? `fresh` = straight after initialize. */
export function evaluateDeployment(input: {
    seen: Record<string, unknown>;
    expected: { blendPool: string; underlying: string; adapter: string; token: string; pool: string; deployer: string };
    fresh: boolean;
}): Check[] {
    const { seen, expected, fresh } = input;
    const rows: Check[] = [];
    const check = (ok: boolean, msg: string) => rows.push({ ok, msg });
    check(seen["adapter.pool"] === expected.blendPool, `adapter.pool == Blend pool`);
    check(seen["adapter.underlying"] === expected.underlying, `adapter.underlying == config`);
    check(seen["token.adapter_address"] === expected.adapter, `token.adapter_address == adapter`);
    check(seen["token.underlying"] === expected.underlying, `token.underlying == config (callback reached the adapter)`);
    check(seen["token.admin"] === expected.deployer, `token.admin == deployer (nobody front-ran initialize)`);
    check(seen["router.pool"] === expected.pool, `router.pool == privacy pool (nobody front-ran initialize)`);
    check(seen["router.vault"] === expected.token, `router.vault == token`);
    check(seen["router.dust_recipient"] === expected.deployer, `router.dust_recipient == deployer`);
    check(seen["pool.share_enabled"] === true, `privacy pool accepts the share token`);
    // The seed shares sit at the token's own address with no key behind them: exactly the seed on
    // a fresh deploy, never less afterwards.
    const supply = BigInt(String(seen["token.total_supply"]));
    const held = BigInt(String(seen["token.held_by_self"]));
    check(fresh ? supply === DEAD_SHARES : supply >= DEAD_SHARES, `token.total_supply ${supply} vs dead-share seed ${DEAD_SHARES}`);
    check(fresh ? held === DEAD_SHARES : held >= DEAD_SHARES, `the seed is held unspendably by the token itself (${held})`);
    return rows;
}

function verify(y: YieldDeploymentState, pool: string, deployer: string, fresh: boolean): void {
    step("Verifying deployed state");
    let shareEnabled = false;
    try {
        shareEnabled = read<{ enabled: boolean }>(pool, "get_asset_config", ["--asset", y.token]).enabled;
    } catch {
        shareEnabled = false;
    }
    const seen: Record<string, unknown> = {
        "adapter.pool": read(y.adapter, "pool"),
        "adapter.underlying": read(y.adapter, "underlying"),
        "token.adapter_address": read(y.token, "adapter_address"),
        "token.underlying": read(y.token, "underlying"),
        "token.admin": read(y.token, "admin"),
        "token.total_supply": read(y.token, "total_supply"),
        "token.held_by_self": read(y.token, "balance", ["--id", y.token]),
        "router.pool": read(y.router, "pool"),
        "router.vault": read(y.router, "vault"),
        "router.dust_recipient": read(y.router, "dust_recipient"),
        "pool.share_enabled": shareEnabled,
    };
    report(
        evaluateDeployment({
            seen,
            expected: { blendPool: y.blendPool, underlying: y.underlying, adapter: y.adapter, token: y.token, pool, deployer },
            fresh,
        }),
        "post-deploy",
    );
}

/* ─── Deploy ──────────────────────────────────────────────────────────── */

function main(): void {
    console.log(`=== Privacy Pools V2 — Yield Module (${network}) ===`);
    checkStellarCLI();
    const deployment = loadDeployment(network);
    if (!deployment?.initialized || !deployment.assetsConfigured) {
        throw new Error(`No initialized core deployment for "${network}" — run deploy-all.mts first`);
    }
    const { pool, deployer } = deployment;

    const yields = yieldsOf(deployment);
    if (args["verify-only"]) {
        if (!yields.length) throw new Error(`No yield deployment recorded for "${network}"`);
        for (const y of yields) verify(y, pool, deployer, false);
        success("Existing yield deployments still verify");
        return;
    }

    for (const cfg of loadConfigs(deployer)) {
        const existing = yields.find((y) => y.underlying === cfg.underlying);
        if (existing) {
            warn(`${cfg.symbol} already deployed (token ${existing.token}) — re-verifying instead`);
            verify(existing, pool, deployer, false);
            continue;
        }
        const state = deployModule(cfg, pool, deployer);
        if (!state) continue;
        yields.push(state);
        deployment.yields = yields;
        delete deployment.yield;
        saveDeployment(network, deployment);
        success(`${cfg.symbol} deployed and verified (share token ${state.token})`);
    }
}

/** Deploys, wires and verifies one module; `undefined` on a dry run. */
function deployModule(cfg: YieldConfig, pool: string, deployer: string): YieldDeploymentState | undefined {
    console.log(`\n--- ${cfg.symbol} over ${cfg.underlyingSymbol} ---`);
    validate(cfg, deployer);
    if (args["dry-run"]) {
        success("Dry run — validation only, nothing broadcast");
        return undefined;
    }

    const wasm = getWasmPaths();
    step("Deploying yield contracts");
    const adapter = deployWasm(wasm.yieldBlendAdapter, source, network);
    const token = deployWasm(wasm.yieldToken, source, network);
    const router = deployWasm(wasm.yieldRouter, source, network);
    console.log(`  adapter: ${adapter}\n  token:   ${token}\n  router:  ${router}`);

    step("Initializing adapter (owner = the wrapper contract)");
    invoke(adapter, "initialize", ["--owner", token, "--pool", cfg.blendPool, "--underlying", cfg.underlying]);

    step("Initializing wrapper (buys the dead-share seed through the adapter)");
    invoke(token, "initialize", [
        "--admin", deployer,
        "--adapter", adapter,
        "--initial_fee_bps", String(cfg.initialFeeBps),
        "--decimals_offset", String(cfg.decimalsOffset),
        "--decimals", String(shareDecimals(cfg)),
        "--name", cfg.name,
        "--symbol", cfg.symbol,
        "--dead_share_funder", deployer,
    ]);

    step("Initializing router (the pool processor for yield withdrawals)");
    invoke(router, "initialize", ["--pool", pool, "--vault", token, "--dust_recipient", deployer]);

    step("Registering the share token as a pool asset");
    invoke(pool, "set_asset_config", [
        "--caller", deployer,
        "--asset", token,
        "--enabled", "true",
        "--min_deposit_amount", cfg.minDepositShares,
        "--vetting_fee_bps", String(cfg.vettingFeeBps),
        "--max_relay_fee", cfg.maxRelayFeeShares,
    ]);

    const state: YieldDeploymentState = {
        adapter,
        token,
        router,
        blendPool: cfg.blendPool,
        underlying: cfg.underlying,
        underlyingDecimals: cfg.underlyingDecimals,
        underlyingSymbol: cfg.underlyingSymbol,
        ...(cfg.classicAsset ? { classicAsset: cfg.classicAsset } : {}),
        shareDecimals: shareDecimals(cfg),
        initialFeeBps: cfg.initialFeeBps,
        decimalsOffset: cfg.decimalsOffset,
    };
    verify(state, pool, deployer, true);
    return state;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    try {
        main();
    } catch (err) {
        const e = err as { stderr?: string; message: string };
        console.error("\nYield deployment failed:", e.stderr?.toString() || e.message);
        process.exit(1);
    }
}
