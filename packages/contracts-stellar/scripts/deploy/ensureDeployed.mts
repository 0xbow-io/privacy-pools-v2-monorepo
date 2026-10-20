/**
 * Idempotent entry point for the SDK's Stellar e2e test: starts the local standalone network if
 * it isn't already running, deploys+initializes+registers VKs+configures the native asset if
 * that hasn't happened yet for this network, and returns everything the test needs to build a
 * `StellarPoolSessionBuilder` session against it.
 *
 * Deliberately dependency-free (only Node built-ins) — `packages/contracts-stellar` isn't part
 * of the pnpm workspace, so it has no `node_modules` of its own; returning a raw secret string
 * instead of a `@stellar/stellar-sdk` `Keypair` lets the caller (packages/stellar-sdk, which already
 * depends on that package) do the `Keypair.fromSecret(...)` conversion itself.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "../..");
const DEPLOYMENTS_DIR = join(__dirname, "../deployments");
const HEALTH_URL = "http://localhost:8000/health";
const NETWORK_NAME = "local";
const ADMIN_ALIAS = "ppv2-deployer";
const RPC_URL = "http://localhost:8000/rpc";
const NETWORK_PASSPHRASE = "Standalone Network ; February 2017";

export type StellarDeployment = {
    rpcUrl: string;
    networkPassphrase: string;
    poolId: string;
    keystoreId: string;
    aspRegistryId: string;
    relayId: string;
    /** Raw StrKey secret seed ("S...") for the deploy admin/asp-registry postman identity. */
    adminSecret: string;
    nativeAssetAddress: string;
    /** SAC address of the local-only "MOCK" classic asset `configure-assets.mts` deploys, issued
     * by the deploy admin — the e2e suite's second, non-native test asset. */
    mockTokenAddress: string;
    /** The yield modules over the local Blend pool (native XLM and USDC), once `deploy-yield.mts` has run. */
    yields: StellarYieldDeploymentInfo[];
};

/** The yield module as SDK sessions take it (`YieldDeploymentConfig<StellarAddress>`), plus its venue. */
export type StellarYieldDeploymentInfo = {
    router: string;
    shareToken: string;
    shareDecimals: number;
    underlying: string;
    underlyingDecimals: number;
    underlyingSymbol: string;
    /** `CODE:ISSUER` for a classic underlying other than XLM (needs a trustline); absent for XLM. */
    classicAsset?: string;
    blendPool: string;
};

/** One yield module as the deployment file records it. */
type YieldRecord = {
    router: string;
    token: string;
    shareDecimals: number;
    underlying: string;
    underlyingDecimals: number;
    underlyingSymbol: string;
    classicAsset?: string;
    blendPool: string;
};

export type DeploymentFile = {
    deployer: string;
    pool: string;
    keystore: string;
    aspRegistry: string;
    relay: string;
    initialized: boolean;
    vksRegistered: boolean;
    assetsConfigured: boolean;
    yields?: YieldRecord[];
    /** Legacy single-module record, from before `yields`. */
    yield?: YieldRecord;
};

export async function ensureDeployed(): Promise<StellarDeployment> {
    await startLocalNetwork();
    const deployment = deployIfNeeded();

    const adminSecret = execFileSync("stellar", ["keys", "show", ADMIN_ALIAS], {
        encoding: "utf-8",
    }).trim();
    const nativeAssetAddress = execFileSync(
        "stellar",
        ["contract", "id", "asset", "--asset", "native", "--network", NETWORK_NAME],
        { encoding: "utf-8" },
    ).trim();
    const mockTokenAddress = execFileSync(
        "stellar",
        ["contract", "id", "asset", "--asset", `MOCK:${deployment.deployer}`, "--network", NETWORK_NAME],
        { encoding: "utf-8" },
    ).trim();

    return {
        rpcUrl: RPC_URL,
        networkPassphrase: NETWORK_PASSPHRASE,
        poolId: deployment.pool,
        keystoreId: deployment.keystore,
        aspRegistryId: deployment.aspRegistry,
        relayId: deployment.relay,
        adminSecret,
        nativeAssetAddress,
        mockTokenAddress,
        yields: toYieldInfos(deployment),
    };
}

/** Maps the deployment file's yield records (`yields`, or the legacy `yield`) onto the shape sessions take. */
export function toYieldInfos(deployment: Pick<DeploymentFile, "yields" | "yield">): StellarYieldDeploymentInfo[] {
    const records = deployment.yields ?? (deployment.yield ? [deployment.yield] : []);
    return records.map((y) => ({
        router: y.router,
        shareToken: y.token,
        shareDecimals: y.shareDecimals,
        underlying: y.underlying,
        underlyingDecimals: y.underlyingDecimals,
        underlyingSymbol: y.underlyingSymbol,
        ...(y.classicAsset ? { classicAsset: y.classicAsset } : {}),
        blendPool: y.blendPool,
    }));
}

async function startLocalNetwork(): Promise<void> {
    if (await isHealthy()) return;
    execFileSync("bash", [join(ROOT_DIR, "scripts/local-stellar.sh"), "start"], {
        stdio: "inherit",
        cwd: ROOT_DIR,
    });
}

async function isHealthy(): Promise<boolean> {
    try {
        const response = await fetch(HEALTH_URL);
        const body = (await response.json()) as { core_synced?: boolean };
        return body.core_synced === true;
    } catch {
        return false;
    }
}

function deployIfNeeded(): DeploymentFile {
    const deploymentPath = join(DEPLOYMENTS_DIR, `${NETWORK_NAME}.json`);
    if (!existsSync(deploymentPath)) {
        execFileSync(
            "node",
            [
                join(ROOT_DIR, "scripts/deploy/deploy-all.mts"),
                "--network",
                NETWORK_NAME,
                "--source",
                ADMIN_ALIAS,
            ],
            { stdio: "inherit", cwd: ROOT_DIR },
        );
    }

    const deployment = JSON.parse(readFileSync(deploymentPath, "utf-8")) as DeploymentFile;
    if (!(deployment.initialized && deployment.vksRegistered && deployment.assetsConfigured && deployment.relay)) {
        throw new Error(
            `Deployment at ${deploymentPath} is incomplete (initialized=${deployment.initialized}, ` +
                `vksRegistered=${deployment.vksRegistered}, assetsConfigured=${deployment.assetsConfigured}, ` +
                `relay=${deployment.relay}) — delete the file and re-run to redeploy from scratch.`,
        );
    }
    // A deployment from before the USDC yield module existed is completed in place rather than
    // redeployed: `deploy-yield.mts` is incremental (it re-verifies what is recorded and deploys only
    // the missing underlying), and `deploy-local-blend.mts` reuses the live Blend pool.
    if (!toYieldInfos(deployment).some((y) => y.classicAsset)) {
        const run = (script: string, args: string[]) =>
            execFileSync("node", [join(ROOT_DIR, script), ...args, "--source", ADMIN_ALIAS], { stdio: "inherit", cwd: ROOT_DIR });
        run("scripts/blend/deploy-local-blend.mts", []);
        run("scripts/deploy/deploy-yield.mts", ["--network", NETWORK_NAME]);
        return JSON.parse(readFileSync(deploymentPath, "utf-8")) as DeploymentFile;
    }
    return deployment;
}
