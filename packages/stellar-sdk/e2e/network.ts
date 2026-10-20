/**
 * Idempotent bootstrap for the stellar-sdk e2e suite: starts the local Stellar standalone network
 * if it isn't already running, deploys+initializes+registers VKs+configures assets (including the
 * `relay` contract) if that hasn't happened yet for this network, and returns everything the test
 * needs to build a `StellarPoolSessionBuilder` session against it.
 *
 * Delegates both steps to `packages/contracts-stellar/scripts/deploy/ensureDeployed.ts` — unlike
 * EVM, which has no equivalent contracts-side deploy-automation package to call into, Stellar's
 * deploy pipeline already lives in a sibling package. Ported from the retired
 * `packages/stellar-sdk/scripts/e2e-stellar/network.ts`.
 *
 * `STELLAR_E2E_NETWORK=testnet` (default: local) points the whole harness at the already-deployed
 * `scripts/deployments/testnet.json` instead — read-only, never deploys — and at testnet's own
 * friendbot. A one-off manual mode, not a general multi-network harness: `chain.ts` additionally
 * marks `token` unsupported in this mode, since testnet has no second test asset provisioned.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { rpc } from "@stellar/stellar-sdk";

import type {
    DeploymentFile,
    StellarYieldDeploymentInfo,
} from "../../contracts-stellar/scripts/deploy/ensureDeployed.mjs";
import {
    ensureDeployed as ensureDeployedContracts,
    toYieldInfos,
} from "../../contracts-stellar/scripts/deploy/ensureDeployed.mjs";

export interface StellarE2ENetwork {
    rpcUrl: string;
    networkPassphrase: string;
    poolId: string;
    keystoreId: string;
    aspRegistryId: string;
    relayId: string;
    /** Raw StrKey secret seed ("S...") for the deploy admin / asp-registry postman identity. */
    adminSecret: string;
    nativeAssetAddress: string;
    /** SAC address of the local-only "MOCK" classic asset, issued by the deploy admin — the e2e
     * suite's second, non-native test asset (`token` capability). Empty in testnet mode. */
    mockTokenAddress: string;
    /** The yield modules deployed on this network (router, share token, underlying), one per underlying. */
    yields: StellarYieldDeploymentInfo[];
}

export const NETWORK_MODE = process.env.STELLAR_E2E_NETWORK === "testnet" ? "testnet" : "local";

/** Never torn down — the local Soroban network is left running between runs, same as before. */
export async function ensureDeployed(): Promise<StellarE2ENetwork> {
    return NETWORK_MODE === "testnet" ? ensureDeployedTestnet() : ensureDeployedContracts();
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TESTNET_DEPLOYMENT_PATH = join(__dirname, "../../contracts-stellar/scripts/deployments/testnet.json");
const TESTNET_RPC_URL = "https://soroban-testnet.stellar.org/";
const TESTNET_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
const TESTNET_ADMIN_ALIAS = "ppv2-deployer";

type TestnetDeploymentFile = DeploymentFile;

/** Reads the already-deployed `testnet.json` — never deploys. Run the deploy pipeline manually first. */
function ensureDeployedTestnet(): StellarE2ENetwork {
    if (!existsSync(TESTNET_DEPLOYMENT_PATH)) {
        throw new Error(
            `No testnet deployment at ${TESTNET_DEPLOYMENT_PATH} — run ` +
                `\`node scripts/deploy/deploy-all.mts --network testnet\` in packages/contracts-stellar first.`,
        );
    }
    const deployment = JSON.parse(readFileSync(TESTNET_DEPLOYMENT_PATH, "utf-8")) as TestnetDeploymentFile;
    if (!(deployment.initialized && deployment.vksRegistered && deployment.assetsConfigured && deployment.relay)) {
        throw new Error(`Testnet deployment at ${TESTNET_DEPLOYMENT_PATH} is incomplete.`);
    }
    const adminSecret = execFileSync("stellar", ["keys", "show", TESTNET_ADMIN_ALIAS], { encoding: "utf-8" }).trim();
    const nativeAssetAddress = execFileSync(
        "stellar",
        ["contract", "id", "asset", "--asset", "native", "--network", "testnet"],
        { encoding: "utf-8" },
    ).trim();
    return {
        rpcUrl: TESTNET_RPC_URL,
        networkPassphrase: TESTNET_NETWORK_PASSPHRASE,
        poolId: deployment.pool,
        keystoreId: deployment.keystore,
        aspRegistryId: deployment.aspRegistry,
        relayId: deployment.relay,
        adminSecret,
        nativeAssetAddress,
        mockTokenAddress: "",
        yields: toYieldInfos(deployment),
    };
}

/**
 * Which yield underlyings the active network's deployment file records — read at test-file import time
 * (`chain.ts`'s capability list), after `globalSetup` has deployed. A record with a `classicAsset` is a
 * token underlying (it needs a trustline); one without is native XLM.
 */
export function e2eYieldKinds(): { native: boolean; token: boolean } {
    const path = join(__dirname, `../../contracts-stellar/scripts/deployments/${NETWORK_MODE}.json`);
    if (!existsSync(path)) return { native: false, token: false };
    const yields = toYieldInfos(JSON.parse(readFileSync(path, "utf-8")) as DeploymentFile);
    return { native: yields.some((y) => !y.classicAsset), token: yields.some((y) => y.classicAsset) };
}

const FRIENDBOT_URL =
    NETWORK_MODE === "testnet" ? "https://friendbot.stellar.org" : "http://localhost:8000/friendbot";

const FUNDING_RPC_URL = NETWORK_MODE === "testnet" ? TESTNET_RPC_URL : "http://localhost:8000/rpc";

/**
 * Funds `publicKey` via the active network's friendbot; tolerates an already-funded account. Friendbot
 * answers 400 both for an already-funded account and when its own funding transaction failed, so only
 * the former counts as funded; anything else is retried. Then waits until the RPC sees the account:
 * friendbot confirms through its own ingestion, which can be a ledger ahead of the RPC's.
 */
export async function fundViaFriendbot(publicKey: string): Promise<void> {
    let lastError = "";
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await fetch(`${FRIENDBOT_URL}?addr=${publicKey}`);
        if (response.ok) break;
        const body = await response.text();
        if (response.status === 400 && body.includes("already funded")) break;
        lastError = `${response.status} ${body}`;
        if (attempt === 4) throw new Error(`Friendbot funding failed for ${publicKey}: ${lastError}`);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const server = new rpc.Server(FUNDING_RPC_URL, { allowHttp: FUNDING_RPC_URL.startsWith("http://") });
    const deadline = Date.now() + 15_000;
    for (;;) {
        try {
            await server.getAccount(publicKey);
            return;
        } catch (error) {
            if (Date.now() > deadline) throw new Error(`${publicKey} still not visible to the RPC after funding: ${String(error)}`);
            await new Promise((resolve) => setTimeout(resolve, 250));
        }
    }
}
