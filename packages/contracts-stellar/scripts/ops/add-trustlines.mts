#!/usr/bin/env node
/**
 * Open trustlines from one Stellar account to the classic assets a network's privacy pool uses.
 *
 * A classic asset (USDC, wETH, wBTC, …) can only be paid to an account that holds a trustline to it.
 * The relayer is paid its fee in the asset being withdrawn — a yield share's fee in the share's
 * underlying — so its fee-receiver account needs a trustline per classic asset, or every relayed
 * withdrawal of that asset fails at the fee payment. Run this for a new relayer account (or any
 * account that should receive these assets).
 *
 * Usage:
 *   STELLAR_ACCOUNT=<secret key S… | stellar-cli identity alias> \
 *     node scripts/ops/add-trustlines.mts --account G... [--network testnet] [--asset CODE:ISSUER ...]
 *
 *   node scripts/ops/add-trustlines.mts --account G... --build-only   # unsigned XDRs, to sign elsewhere
 *
 * The signer is read from `STELLAR_ACCOUNT` (the stellar CLI's own variable), never from the
 * command line, so a secret does not land in shell history or the process list. A trustline is the
 * holder's own act: the signer must be `--account` itself.
 *
 * Assets default to every classic asset the network uses: the tokens in its asset config
 * (`scripts/config/assets.<network>.json`, else `assets.json`) and the underlyings of its yield
 * modules (`scripts/deployments/<network>.json`). Native XLM needs no trustline and is skipped.
 * Trustlines that already exist are left alone; the result is read back from the chain.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");

const { values: args } = parseArgs({
    options: {
        account: { type: "string" },
        network: { type: "string", default: "testnet" },
        asset: { type: "string", multiple: true },
        "build-only": { type: "boolean", default: false },
    },
});
const network = args.network as string;
const account = args.account;
const buildOnly = args["build-only"] as boolean;

/** Runs the stellar CLI. `env` carries the signer so it never appears in argv. */
function stellar(cliArgs: string[], env: NodeJS.ProcessEnv = process.env): string {
    return execFileSync("stellar", cliArgs, { encoding: "utf-8", cwd: ROOT_DIR, env, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** A simulated read against `contract`, sourced from the (public) target account. */
function read(contract: string, fn: string, fnArgs: string[] = []): string {
    return stellar([
        "contract", "invoke", "--id", contract, "--source-account", account as string, "--network", network, "--send=no",
        "--", fn, ...fnArgs,
    ]);
}

/** `CODE:ISSUER` of a Stellar Asset Contract, or `undefined` for native XLM / a non-SAC token. */
function classicAssetOf(sac: string): string | undefined {
    try {
        const name = JSON.parse(read(sac, "name")) as string;
        return name.includes(":") ? name : undefined;
    } catch {
        return undefined;
    }
}

/** Every classic asset the network's pool and yield modules use. */
function networkClassicAssets(): string[] {
    const found = new Set<string>();
    const networkAssets = join(ROOT_DIR, `scripts/config/assets.${network}.json`);
    const assetsPath = existsSync(networkAssets) ? networkAssets : join(ROOT_DIR, "scripts/config/assets.json");
    const { assets } = JSON.parse(readFileSync(assetsPath, "utf-8")) as { assets: { type: string; address?: string }[] };
    for (const a of assets) {
        if (a.type !== "token" || !a.address) continue;
        const classic = classicAssetOf(a.address);
        if (classic) found.add(classic);
    }
    const deploymentPath = join(ROOT_DIR, `scripts/deployments/${network}.json`);
    if (existsSync(deploymentPath)) {
        const d = JSON.parse(readFileSync(deploymentPath, "utf-8")) as {
            yields?: { classicAsset?: string }[];
            yield?: { classicAsset?: string };
        };
        for (const y of d.yields ?? (d.yield ? [d.yield] : [])) {
            if (y.classicAsset) found.add(y.classicAsset);
        }
    }
    return [...found];
}

/** Whether `account` already holds a trustline to `classic` (its SAC answers `balance`). */
function hasTrustline(classic: string): boolean {
    const sac = stellar(["contract", "id", "asset", "--asset", classic, "--network", network]);
    try {
        read(sac, "balance", ["--id", account as string]);
        return true;
    } catch {
        return false;
    }
}

function main(): void {
    if (!account || !/^G[A-Z2-7]{55}$/.test(account)) {
        throw new Error("--account G... is required: the account to open the trustlines for");
    }
    if (!buildOnly && !process.env.STELLAR_ACCOUNT) {
        throw new Error(
            "set STELLAR_ACCOUNT to the account's secret key (or a stellar-cli identity alias) to sign, " +
                "or pass --build-only to print unsigned transactions",
        );
    }

    const assets = args.asset?.length ? args.asset : networkClassicAssets();
    if (!assets.length) {
        console.log(`No classic assets configured for "${network}" — nothing to do.`);
        return;
    }
    console.log(`=== Trustlines for ${account} on ${network} ===`);

    let failed = 0;
    for (const classic of assets) {
        if (!/^[A-Za-z0-9]{1,12}:G[A-Z2-7]{55}$/.test(classic)) throw new Error(`not a CODE:ISSUER asset: ${classic}`);
        if (hasTrustline(classic)) {
            console.log(`  ok      ${classic} (already trusted)`);
            continue;
        }
        if (buildOnly) {
            // Sourced from the public key: built, not signed.
            const xdr = stellar([
                "tx", "new", "change-trust", "--source-account", account, "--network", network, "--line", classic, "--build-only",
            ]);
            console.log(`  unsigned ${classic}:\n${xdr}`);
            continue;
        }
        try {
            stellar(["tx", "new", "change-trust", "--network", network, "--line", classic]);
        } catch (err) {
            failed++;
            console.error(`  FAIL    ${classic}: ${String((err as { stderr?: string }).stderr ?? err).trim()}`);
            continue;
        }
        // Read back: a signer other than `--account` would have opened the trustline on ITS account.
        if (hasTrustline(classic)) {
            console.log(`  added   ${classic}`);
        } else {
            failed++;
            console.error(`  FAIL    ${classic}: submitted, but ${account} still has no trustline — is STELLAR_ACCOUNT this account's key?`);
        }
    }
    if (failed) throw new Error(`${failed} trustline(s) not opened`);
}

try {
    main();
} catch (err) {
    console.error(`\nadd-trustlines failed: ${(err as Error).message}`);
    process.exit(1);
}
