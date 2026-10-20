#!/usr/bin/env node
/**
 * Stand up the real Blend v2 protocol on the LOCAL standalone network, so the yield module runs
 * against the same bytecode it runs against on testnet (`blend-contract-sdk` 2.25.0 ships the
 * exact `pool.wasm` the live `TestnetV2` pool runs — see upstream `docs/BLEND_BYTECODE_PIN.md`).
 *
 * Usage: node scripts/blend/deploy-local-blend.mts [--source ppv2-deployer] [--force]
 *
 * Mirrors `blend_contract_sdk::testutils::BlendFixture::deploy` step for step, then creates one
 * pool with a single native-XLM reserve and activates it:
 *
 *   1. BLND (fresh code per deploy) and USDC — classic assets issued by the deployer, wrapped in SACs. The issuer can
 *      send its own asset without a trustline, so every "pull from deployer" below mints.
 *   2. comet (the BLND:USDC 80/20 backstop LP) — `init` + `join_pool`.
 *   3. emitter — BLND's SAC admin is handed to it, then `initialize(blnd, backstop, comet)`.
 *   4. backstop and pool factory — each takes the other's address in its constructor, so both ids
 *      are PRE-COMPUTED from a salt (`stellar contract id wasm`) and then deployed at those salts.
 *   5. pool factory `deploy` → a pool; queue + set the XLM reserve; fund the backstop past its
 *      threshold; `set_status(3)` + `update_status` → active. Blend v2 statuses: 0 = admin-active,
 *      1 = active (what `update_status` lands on here, as in BlendFixture), 2+ = on-ice/frozen/setup.
 *   6. Make the XLM reserve behave like a live one (see below).
 *
 * A pool nobody borrows from has a `b_rate` of exactly 1.0 forever, so every share ↔ underlying
 * conversion is exact and no rate moves between a quote and its execution — the conditions under
 * which rate-dependent bugs stay hidden locally and only surface on testnet. Step 6 removes that:
 *
 *   - The oracle is `test-contracts/mock-oracle` (every asset at 1.0, always fresh), so the pool can
 *     price a borrow. A USDC reserve (index 1) is added as collateral.
 *   - A freshly funded lender (`ppv2-blend-lender`) supplies {@link LENDER_SUPPLY} XLM, and the
 *     deployer posts USDC collateral (it issues USDC, so this mints) and borrows
 *     {@link BORROW} XLM against it: ~90% utilisation, above the 75% target, so interest accrues
 *     every ledger (≈ +1e-8 on `b_rate` per second at deploy) and the rate modifier keeps climbing.
 *   - The deployer also borrows {@link USDC_BORROW} USDC against the same collateral, so the USDC
 *     reserve — the e2e suite's non-native yield underlying — accrues interest too (~10% utilisation).
 *
 * The rate stays close to 1.0 — it is fractional and moving, not large. It cannot be jumped: in this
 * Blend version `gulp` credits a donation to the backstop (`backstop_credit`), not to suppliers, so
 * only interest raises `b_rate`, and the local ledger clock runs in real time. Rounding at live
 * rates far from 1.0 (up to ~4.6) is covered by `yield-blend-adapter`'s Rust tests, which can warp time.
 *
 * Writes `scripts/deployments/local.blend.json`. Idempotent: an existing file whose pool still
 * answers `get_config` is reused; `--force` redeploys.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const OUT_PATH = join(ROOT_DIR, "scripts/deployments/local.blend.json");
const NETWORK = "local";

/** 7-decimal fixed point, Blend's scalar for rates and factors. */
const SCALAR_7 = 10_000_000n;

/** XLM the lender supplies to the XLM reserve. */
const LENDER_SUPPLY = 5_000n * SCALAR_7;
/** USDC the deployer posts as collateral (price 1.0, c_factor 0.9 → 9,000 of borrowing power). */
const COLLATERAL = 10_000n * SCALAR_7;
/** XLM the deployer borrows: 90% of {@link LENDER_SUPPLY}, under the reserve's 95% max utilisation. */
const BORROW = 4_500n * SCALAR_7;
/** USDC the deployer borrows from the USDC reserve (its own collateral is the liquidity). Kept small:
 * with the XLM borrow it leaves the position comfortably healthy while both debts accrue. */
const USDC_BORROW = 1_000n * SCALAR_7;
/** Blend's 12-decimal fixed point, `b_rate`'s scale. */
const SCALAR_12 = 1_000_000_000_000n;
const LENDER_ALIAS = "ppv2-blend-lender";

const { values: args } = parseArgs({
    options: {
        source: { type: "string", default: "ppv2-deployer" },
        force: { type: "boolean", default: false },
    },
});
const source = args.source as string;

export interface LocalBlendDeployment {
    network: "local";
    blnd: string;
    usdc: string;
    comet: string;
    emitter: string;
    backstop: string;
    poolFactory: string;
    /** The Blend lending pool the yield adapter supplies into. */
    blendPool: string;
    /** The reserve's asset — the native XLM SAC. */
    underlying: string;
    underlyingDecimals: number;
    poolWasmHash: string;
    /** The pool's SEP-40 oracle (`test-contracts/mock-oracle`). */
    oracle: string;
    /** Supplies the XLM reserve and donated to it. */
    lender: string;
    /** Borrows XLM against USDC collateral (the deployer). */
    borrower: string;
    /** The XLM reserve's `b_rate` (12 decimals) right after deploy; it keeps growing from here. */
    initialBRate: string;
}

function stellar(args: string[]): string {
    return execFileSync("stellar", args, { encoding: "utf-8", cwd: ROOT_DIR, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function invoke(id: string, fn: string, fnArgs: string[], opts: { send?: boolean; as?: string } = {}): string {
    return stellar([
        "contract",
        "invoke",
        "--id",
        id,
        "--source-account",
        opts.as ?? source,
        "--network",
        NETWORK,
        ...(opts.send === false ? ["--send=no"] : []),
        "--",
        fn,
        ...fnArgs,
    ]);
}

/** Locate the WASM the pinned `blend-contract-sdk` ships (version read from yield-blend-adapter's Cargo.toml). */
function blendWasmDir(): string {
    if (process.env.BLEND_SDK_WASM_DIR) return process.env.BLEND_SDK_WASM_DIR;
    const toml = readFileSync(join(ROOT_DIR, "contracts/yield-blend-adapter/Cargo.toml"), "utf-8");
    const version = toml.match(/blend-contract-sdk\s*=\s*"=?([0-9.]+)"/)?.[1];
    if (!version) throw new Error("could not read the blend-contract-sdk version from yield-blend-adapter/Cargo.toml");
    const registry = join(homedir(), ".cargo", "registry", "src");
    for (const index of existsSync(registry) ? readdirSync(registry) : []) {
        const candidate = join(registry, index, `blend-contract-sdk-${version}`, "wasm");
        if (existsSync(candidate)) return candidate;
    }
    throw new Error(
        `blend-contract-sdk ${version} not found under ${registry} — run \`cargo fetch\` in packages/contracts-stellar, or set BLEND_SDK_WASM_DIR`,
    );
}

function classicSac(code: string, issuer: string): string {
    try {
        stellar(["contract", "asset", "deploy", "--asset", `${code}:${issuer}`, "--source-account", source, "--network", NETWORK]);
    } catch (err) {
        if (!String((err as { stderr?: string }).stderr ?? err).match(/ExistingValue|already exists/)) throw err;
    }
    return stellar(["contract", "id", "asset", "--asset", `${code}:${issuer}`, "--network", NETWORK]);
}

function nativeSac(): string {
    try {
        stellar(["contract", "asset", "deploy", "--asset", "native", "--source-account", source, "--network", NETWORK]);
    } catch (err) {
        if (!String((err as { stderr?: string }).stderr ?? err).match(/ExistingValue|already exists/)) throw err;
    }
    return stellar(["contract", "id", "asset", "--asset", "native", "--network", NETWORK]);
}

function deploy(wasm: string, ctorArgs: string[] = [], salt?: string): string {
    const out = stellar([
        "contract",
        "deploy",
        "--wasm",
        wasm,
        "--source-account",
        source,
        "--network",
        NETWORK,
        ...(salt ? ["--salt", salt] : []),
        ...(ctorArgs.length ? ["--", ...ctorArgs] : []),
    ]);
    const id = out.match(/C[A-Z0-9]{55}/)?.[0];
    if (!id) throw new Error(`could not parse a contract id from deploy output:\n${out}`);
    return id;
}

/** Builds `test-contracts/mock-oracle` and returns its WASM path. */
function mockOracleWasm(): string {
    stellar(["contract", "build", "--package", "mock-oracle"]);
    return join(ROOT_DIR, "target/wasm32v1-none/release/mock_oracle.wasm");
}

/** A Blend `submit` request list, as the CLI takes it. Types: 0 supply, 2 supply collateral, 4 borrow. */
function requests(...items: { type: number; asset: string; amount: bigint }[]): string {
    return JSON.stringify(items.map((r) => ({ request_type: r.type, address: r.asset, amount: String(r.amount) })));
}

function bRate(blendPool: string, asset: string): bigint {
    const reserve = JSON.parse(invoke(blendPool, "get_reserve", ["--asset", asset], { send: false })) as {
        data: { b_rate: string | number };
    };
    return BigInt(reserve.data.b_rate);
}

function reusable(): LocalBlendDeployment | null {
    if (args.force || !existsSync(OUT_PATH)) return null;
    const prev = JSON.parse(readFileSync(OUT_PATH, "utf-8")) as LocalBlendDeployment;
    // A pool from before the borrower existed has a frozen 1.0 rate: never reuse it.
    if (!prev.oracle) return null;
    try {
        invoke(prev.blendPool, "get_config", [], { send: false });
        return prev;
    } catch {
        return null;
    }
}

function main(): void {
    const existing = reusable();
    if (existing) {
        console.log(`Local Blend already deployed (pool ${existing.blendPool}) — reusing ${OUT_PATH}`);
        return;
    }

    const wasmDir = blendWasmDir();
    const wasm = (name: string) => join(wasmDir, `${name}.wasm`);
    const deployer = stellar(["keys", "address", source]);
    console.log(`=== Local Blend v2 — deployer ${deployer} ===`);

    console.log("  tokens");
    // BLND's SAC admin is handed to the emitter below and can never come back, so a redeploy needs
    // a fresh BLND: the code carries a random suffix (the protocol never reads the code).
    const blnd = classicSac(`BLND${randomBytes(3).toString("hex").toUpperCase()}`, deployer);
    const usdc = classicSac("USDC", deployer);
    const underlying = nativeSac();

    console.log("  oracle");
    const oracle = deploy(mockOracleWasm());

    // BlendFixture's comet: 80/20 BLND:USDC at 1000 BLND : 25 USDC, then join to 200k LP.
    console.log("  comet (backstop LP)");
    const comet = deploy(wasm("comet"));
    invoke(comet, "init", [
        "--controller",
        deployer,
        "--tokens",
        JSON.stringify([blnd, usdc]),
        "--weights",
        JSON.stringify(["8000000", "2000000"]),
        "--balances",
        JSON.stringify([String(1_000n * SCALAR_7), String(25n * SCALAR_7)]),
        "--swap_fee",
        "30000",
    ]);
    invoke(comet, "join_pool", [
        "--pool_amount_out",
        String(199_900n * SCALAR_7),
        "--max_amounts_in",
        JSON.stringify([String(1_000n * SCALAR_7 * 2000n), String(25n * SCALAR_7 * 2000n)]),
        "--user",
        deployer,
    ]);

    // The backstop and pool factory name each other in their constructors: pre-compute both ids.
    const backstopSalt = randomBytes(32).toString("hex");
    const factorySalt = randomBytes(32).toString("hex");
    const backstop = stellar(["contract", "id", "wasm", "--salt", backstopSalt, "--source-account", source, "--network", NETWORK]);
    const poolFactory = stellar(["contract", "id", "wasm", "--salt", factorySalt, "--source-account", source, "--network", NETWORK]);

    console.log("  emitter");
    const emitter = deploy(wasm("emitter"));
    invoke(blnd, "set_admin", ["--new_admin", emitter]);
    invoke(emitter, "initialize", ["--blnd_token", blnd, "--backstop", backstop, "--backstop_token", comet]);

    console.log("  backstop");
    const deployedBackstop = deploy(
        wasm("backstop"),
        [
            "--backstop_token",
            comet,
            "--emitter",
            emitter,
            "--blnd_token",
            blnd,
            "--usdc_token",
            usdc,
            "--pool_factory",
            poolFactory,
            "--drop_list",
            "[]",
        ],
        backstopSalt,
    );
    if (deployedBackstop !== backstop) throw new Error(`backstop landed at ${deployedBackstop}, expected ${backstop}`);

    console.log("  pool factory");
    const poolWasmHash = stellar(["contract", "upload", "--wasm", wasm("pool"), "--source-account", source, "--network", NETWORK])
        .match(/[0-9a-f]{64}/)?.[0];
    if (!poolWasmHash) throw new Error("could not parse the uploaded pool wasm hash");
    const deployedFactory = deploy(
        wasm("pool_factory"),
        ["--pool_init_meta", JSON.stringify({ backstop, blnd_id: blnd, pool_hash: poolWasmHash })],
        factorySalt,
    );
    if (deployedFactory !== poolFactory) throw new Error(`pool factory landed at ${deployedFactory}, expected ${poolFactory}`);

    console.log("  lending pool");
    const blendPool = JSON.parse(
        invoke(poolFactory, "deploy", [
            "--admin",
            deployer,
            "--name",
            "ppv2-local",
            "--salt",
            randomBytes(32).toString("hex"),
            "--oracle",
            oracle,
            "--backstop_take_rate",
            "1000000",
            "--max_positions",
            "4",
            "--min_collateral",
            String(SCALAR_7),
        ]),
    ) as string;

    // `default_reserve_config()` from blend-contract-sdk's testutils, index 0.
    const reserveConfig = {
        decimals: 7,
        c_factor: 7_500_000,
        l_factor: 7_500_000,
        util: 7_500_000,
        max_util: 9_500_000,
        r_base: 100_000,
        r_one: 500_000,
        r_two: 5_000_000,
        r_three: 15_000_000,
        reactivity: 20,
        index: 0,
        supply_cap: String(100_000_000n * SCALAR_7),
        enabled: true,
    };
    invoke(blendPool, "queue_set_reserve", ["--asset", underlying, "--metadata", JSON.stringify(reserveConfig)]);
    invoke(blendPool, "set_reserve", ["--asset", underlying]);
    // USDC is only ever collateral here: a high c_factor so the borrow below stays healthy while
    // interest accrues on it.
    const collateralConfig = { ...reserveConfig, c_factor: 9_000_000, l_factor: 9_000_000, index: 1 };
    invoke(blendPool, "queue_set_reserve", ["--asset", usdc, "--metadata", JSON.stringify(collateralConfig)]);
    invoke(blendPool, "set_reserve", ["--asset", usdc]);

    console.log("  backstop deposit + activation");
    invoke(backstop, "deposit", ["--from", deployer, "--pool_address", blendPool, "--amount", String(50_000n * SCALAR_7)]);
    invoke(blendPool, "set_status", ["--pool_status", "3"]);
    invoke(blendPool, "update_status", []);
    const status = (JSON.parse(invoke(blendPool, "get_config", [], { send: false })) as { status: number }).status;
    if (status > 1) throw new Error(`Blend pool status is ${status} after activation, expected 0 or 1 (active)`);

    console.log("  lender and borrower (a live-like XLM reserve)");
    stellar(["keys", "generate", LENDER_ALIAS, "--network", NETWORK, "--fund", "--overwrite"]);
    const lender = stellar(["keys", "address", LENDER_ALIAS]);
    const submit = (who: string, alias: string, reqs: string) =>
        invoke(blendPool, "submit", ["--from", who, "--spender", who, "--to", who, "--requests", reqs], { as: alias });
    submit(lender, LENDER_ALIAS, requests({ type: 0, asset: underlying, amount: LENDER_SUPPLY }));
    submit(
        deployer,
        source,
        requests(
            { type: 2, asset: usdc, amount: COLLATERAL },
            { type: 4, asset: underlying, amount: BORROW },
            // Borrowed USDC returns to its issuer, i.e. is burned — only the reserve's utilisation matters.
            { type: 4, asset: usdc, amount: USDC_BORROW },
        ),
    );
    // Interest accrues on read from the reserve's last update: once a ledger has closed since the
    // borrow, the rate must be above 1.0.
    let initialBRate = bRate(blendPool, underlying);
    for (let i = 0; initialBRate <= SCALAR_12 && i < 30; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000);
        initialBRate = bRate(blendPool, underlying);
    }
    if (initialBRate <= SCALAR_12) {
        throw new Error(`XLM reserve b_rate is still ${initialBRate} 30s after the borrow — interest is not accruing`);
    }

    const out: LocalBlendDeployment = {
        network: "local",
        blnd,
        usdc,
        comet,
        emitter,
        backstop,
        poolFactory,
        blendPool,
        underlying,
        underlyingDecimals: 7,
        poolWasmHash,
        oracle,
        lender,
        borrower: deployer,
        initialBRate: String(initialBRate),
    };
    writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
    console.log(`=== Local Blend active: pool ${blendPool}, XLM b_rate ${initialBRate} — wrote ${OUT_PATH} ===`);
}

try {
    main();
} catch (err) {
    const e = err as { stderr?: string; message: string };
    console.error("\nLocal Blend deployment failed:", e.stderr?.toString() || e.message);
    process.exit(1);
}
