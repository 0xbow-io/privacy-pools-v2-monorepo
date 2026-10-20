#!/usr/bin/env node
/**
 * Initialize deployed Privacy Pools V2 contracts.
 *
 * Usage: node scripts/deploy/initialize.mts [--network testnet] [--source ppv2-deployer]
 *
 * Steps:
 *   1. ASP Registry: initialize(admin, postman)
 *   2. Keystore: initialize(admin, keystore_root_liveness=3600, max_keystore_tree_size=2^18)
 *   3. Pool: initialize(admin, keystore, asp_registry, root_history_size=64, max_state_tree_size=2^22)
 *   4. Pool: set_roles(admin, pauser, unpauser, asset_manager, upgrader)
 *   5. Relay: initialize(pool, entrypoint) — on Stellar, entrypoint === pool (no separate
 *      entrypoint contract exists; Pool and Entrypoint are collapsed into one contract)
 */

import { parseArgs } from "node:util";
import { checkStellarCLI, loadDeployment, saveDeployment, invokeContract, step, success, warn } from "./utils.mts";

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
        "root-history-size": { type: "string", default: "64" },
        "keystore-root-liveness": { type: "string", default: "3600" },
        "max-state-tree-size": { type: "string", default: "4194304" }, // 2^22
        "max-keystore-tree-size": { type: "string", default: "262144" }, // 2^18
    },
});

const network = args.network as string;
const source = args.source as string;
const rootHistorySize = parseInt(args["root-history-size"] as string, 10);
const keystoreRootLiveness = parseInt(args["keystore-root-liveness"] as string, 10);
const maxStateTreeSize = parseInt(args["max-state-tree-size"] as string, 10);
const maxKeystoreTreeSize = parseInt(args["max-keystore-tree-size"] as string, 10);

async function main(): Promise<void> {
    console.log("=== Privacy Pools V2 — Contract Initialization ===");

    checkStellarCLI();

    const deployment = loadDeployment(network);
    if (!deployment) {
        throw new Error(`No deployment found for network "${network}". Run deploy.mts first.`);
    }

    if (deployment.initialized) {
        console.log("Contracts already initialized. Skipping.");
        return;
    }

    const { aspRegistry, keystore, pool, relay, deployer } = deployment;
    console.log(`  ASP Registry: ${aspRegistry}`);
    console.log(`  Keystore:     ${keystore}`);
    console.log(`  Pool:         ${pool}`);
    console.log(`  Relay:        ${relay}`);
    console.log(`  Admin:        ${deployer}`);

    // 1. Initialize ASP Registry
    step("Initializing ASP Registry");
    try {
        invokeContract(aspRegistry, "initialize", ["--admin", deployer, "--postman", deployer], source, network);
        success("ASP Registry initialized");
    } catch (err) {
        if (err instanceof Error && err.message.includes("AlreadyInitialized")) {
            warn("ASP Registry already initialized, skipping");
        } else {
            throw err;
        }
    }

    // 2. Initialize Keystore
    step("Initializing Keystore");
    try {
        invokeContract(
            keystore,
            "initialize",
            [
                "--admin",
                deployer,
                "--keystore_root_liveness",
                String(keystoreRootLiveness),
                "--max_keystore_tree_size",
                String(maxKeystoreTreeSize),
            ],
            source,
            network,
        );
        success("Keystore initialized");
    } catch (err) {
        if (err instanceof Error && err.message.includes("AlreadyInitialized")) {
            warn("Keystore already initialized, skipping");
        } else {
            throw err;
        }
    }

    // 3. Initialize Pool
    step("Initializing Pool");
    try {
        invokeContract(
            pool,
            "initialize",
            [
                "--admin",
                deployer,
                "--keystore",
                keystore,
                "--asp_registry",
                aspRegistry,
                "--root_history_size",
                String(rootHistorySize),
                "--max_state_tree_size",
                String(maxStateTreeSize),
            ],
            source,
            network,
        );
        success("Pool initialized");
    } catch (err) {
        if (err instanceof Error && err.message.includes("AlreadyInitialized")) {
            warn("Pool already initialized, skipping");
        } else {
            throw err;
        }
    }

    // 4. Set Pool roles (admin = pauser = unpauser = asset_manager for testnet)
    step("Setting Pool roles");
    try {
        invokeContract(
            pool,
            "set_roles",
            [
                "--admin",
                deployer,
                "--pauser",
                deployer,
                "--unpauser",
                deployer,
                "--asset_manager",
                deployer,
                "--upgrader",
                deployer,
            ],
            source,
            network,
        );
        success("Pool roles set");
    } catch (err) {
        // set_roles may fail if already set — not necessarily idempotent but try anyway
        warn(`set_roles: ${(err as Error).message}`);
    }

    // 5. Initialize Relay — entrypoint === pool on Stellar (no separate entrypoint contract)
    step("Initializing Relay");
    try {
        invokeContract(relay, "initialize", ["--pool", pool, "--entrypoint", pool], source, network);
        success("Relay initialized");
    } catch (err) {
        if (err instanceof Error && err.message.includes("AlreadyInitialized")) {
            warn("Relay already initialized, skipping");
        } else {
            throw err;
        }
    }

    // Update deployment state
    deployment.initialized = true;
    deployment.rootHistorySize = rootHistorySize;
    deployment.keystoreRootLiveness = keystoreRootLiveness;
    deployment.maxStateTreeSize = maxStateTreeSize;
    deployment.maxKeystoreTreeSize = maxKeystoreTreeSize;
    saveDeployment(network, deployment);

    console.log("\n=== Initialization Complete ===");
    console.log(`\nNext: node scripts/deploy/register-vks.mts --network ${network}`);
}

main().catch((err: Error) => {
    console.error("\nInitialization failed:", err.message);
    process.exit(1);
});
