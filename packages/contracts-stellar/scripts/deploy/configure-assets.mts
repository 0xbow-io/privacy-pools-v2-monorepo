#!/usr/bin/env node
/**
 * Configure assets on the deployed Privacy Pool.
 *
 * Usage: node scripts/deploy/configure-assets.mts [--network testnet] [--source ppv2-deployer]
 *
 * Steps:
 *   1. Resolve the native XLM token contract address
 *   2. Call pool.set_asset_config(admin, xlm_address, enabled=true, min_deposit=10000000, vetting_fee_bps=100)
 *
 * Asset configuration can be customized via scripts/config/assets.json.
 */

import { parseArgs } from "node:util";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { checkStellarCLI, loadDeployment, saveDeployment, invokeContract, run, step, success, warn } from "./utils.mts";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
    },
});

const network = args.network as string;
const source = args.source as string;

interface AssetConfig {
    name: string;
    type: "native" | "token";
    enabled: boolean;
    minDepositAmount: string;
    vettingFeeBps: number;
    maxRelayFee?: string;
    /** Only for `type: "token"` — a pre-existing contract address. */
    address?: string;
    /**
     * Only for `type: "token"` without `address` — wraps a classic asset `code` issued by the
     * deploy admin identity (`issuer: "deployer"`) into a fresh SAC instead of pointing at a
     * pre-existing one. The admin identity is stable across local redeploys (`ensureIdentity`
     * persists it in the Stellar CLI's own keystore), so the resulting SAC address is
     * deterministic too — same as `native`'s own resolution below.
     */
    code?: string;
    issuer?: "deployer";
}

interface AssetsConfigFile {
    assets: AssetConfig[];
}

/**
 * A second, non-native asset for the stellar-sdk e2e suite's `token` capability (a mintable
 * SAC-wrapped classic asset, mirroring evm-sdk e2e's mock ERC-20) — local only. `assets.json`
 * intentionally stays native-XLM-only: it also governs real testnet/mainnet deploys, which have
 * no business advertising a throwaway "MOCK" asset the deploy admin can mint at will.
 *
 * `vettingFeeBps: 0` (unlike native's 100) — the shared suite's `token`-gated deposit tests mint
 * an actor EXACTLY the value under test (`tokens.mint(carol, token, BigInt(tokenValue()))`, no
 * fee headroom, mirroring evm-sdk e2e's mock ERC-20 mint), so any nonzero vetting fee would make
 * even a correctly-funded deposit fail on `InsufficientTransactValue` — native gets away with a
 * real fee only because friendbot funds it far beyond any single test's amount.
 */
const LOCAL_MOCK_TOKEN: AssetConfig = {
    name: "Mock Token",
    type: "token",
    code: "MOCK",
    issuer: "deployer",
    enabled: true,
    minDepositAmount: "100000",
    vettingFeeBps: 0,
    maxRelayFee: "1000000",
};

/**
 * Load asset configuration from config file, falling back to defaults.
 */
function loadAssetConfig(networkName: string): AssetsConfigFile {
    // A network-specific file wins: a network's own assets (testnet's Blend-faucet tokens, say) are
    // addresses that exist only there, so they cannot live in the shared `assets.json`.
    const networkPath = join(__dirname, `../config/assets.${networkName}.json`);
    const configPath = existsSync(networkPath) ? networkPath : join(__dirname, "../config/assets.json");
    const base: AssetsConfigFile = existsSync(configPath)
        ? (JSON.parse(readFileSync(configPath, "utf-8")) as AssetsConfigFile)
        : {
              // Default: native XLM only
              assets: [
                  {
                      name: "Native XLM",
                      type: "native",
                      enabled: true,
                      minDepositAmount: "10000000",
                      vettingFeeBps: 100,
                      maxRelayFee: "0",
                  },
              ],
          };
    return networkName === "local" ? { assets: [...base.assets, LOCAL_MOCK_TOKEN] } : base;
}

/**
 * Resolve a token contract address, deploying the underlying Soroban Asset Contract first if it
 * doesn't exist yet.
 *
 * `stellar contract id asset` only *computes* the SAC's deterministic address — it does not
 * deploy it. A real local-network deposit surfaced this: `set_asset_config` happily stores the
 * computed address, but the first `token.transfer` against it then fails with `Contract not
 * found`, since nothing actually instantiated the contract on-chain. `stellar contract asset
 * deploy` does that; it's idempotent here via the `ExistingValue`/"contract already exists"
 * error, tolerated the same way `register-vks.mts` tolerates `VkAlreadyRegistered`.
 */
function resolveTokenAddress(
    asset: AssetConfig,
    deployerSource: string,
    deployerAddress: string,
    networkName: string,
): string {
    if (asset.type === "native") {
        try {
            run(`stellar contract asset deploy --asset native --source-account "${deployerSource}" --network ${networkName}`, {
                silent: true,
            });
        } catch (err) {
            if (!(err instanceof Error) || !err.message.includes("ExistingValue")) throw err;
        }
        return run(`stellar contract id asset --asset native --network ${networkName}`, { silent: true });
    }
    if (asset.code && asset.issuer === "deployer") {
        // Wrapping a classic asset into a SAC needs no authorization from its issuer — only
        // *minting* it (a later, harness-side classic Payment) does, via the admin secret
        // `ensureDeployed.mts` already extracts.
        const assetCode = `${asset.code}:${deployerAddress}`;
        try {
            run(`stellar contract asset deploy --asset "${assetCode}" --source-account "${deployerSource}" --network ${networkName}`, {
                silent: true,
            });
        } catch (err) {
            if (!(err instanceof Error) || !err.message.includes("ExistingValue")) throw err;
        }
        return run(`stellar contract id asset --asset "${assetCode}" --network ${networkName}`, { silent: true });
    }
    if (asset.address) {
        return asset.address;
    }
    throw new Error(`Cannot resolve address for asset: ${JSON.stringify(asset)}`);
}

async function main(): Promise<void> {
    console.log("=== Privacy Pools V2 — Asset Configuration ===");

    checkStellarCLI();

    const deployment = loadDeployment(network);
    if (!deployment) {
        throw new Error(`No deployment found for network "${network}". Run deploy.mts first.`);
    }
    if (!deployment.initialized) {
        throw new Error("Contracts not initialized. Run initialize.mts first.");
    }

    const { pool, deployer } = deployment;
    console.log(`  Pool: ${pool}`);

    const config = loadAssetConfig(network);
    console.log(`  Assets to configure: ${config.assets.length}`);

    for (const asset of config.assets) {
        step(`Configuring asset: ${asset.name}`);

        const tokenAddress = resolveTokenAddress(asset, source, deployer, network);
        console.log(`  Token address: ${tokenAddress}`);

        try {
            invokeContract(
                pool,
                "set_asset_config",
                [
                    "--caller",
                    deployer,
                    "--asset",
                    tokenAddress,
                    "--enabled",
                    String(asset.enabled),
                    "--min_deposit_amount",
                    String(asset.minDepositAmount),
                    "--vetting_fee_bps",
                    String(asset.vettingFeeBps),
                    "--max_relay_fee",
                    String(asset.maxRelayFee ?? "0"),
                ],
                // Sign with the CLI identity ALIAS (source), not `deployer` (the raw address) — the
                // CLI's local keystore is indexed by alias, so a bare address fails with "No sign with
                // key provided". `--caller` above still correctly takes the on-chain address.
                source,
                network,
            );
            success(`${asset.name} configured`);
        } catch (err) {
            warn(`${asset.name}: ${(err as Error).message}`);
        }
    }

    // Update deployment state
    deployment.assetsConfigured = true;
    deployment.assets = config.assets.map((a) => a.name);
    saveDeployment(network, deployment);

    console.log("\n=== Asset Configuration Complete ===");
    console.log(`\nNext: node scripts/deploy/verify-deployment.mts --network ${network}`);
}

main().catch((err: Error) => {
    console.error("\nAsset configuration failed:", err.message);
    process.exit(1);
});
