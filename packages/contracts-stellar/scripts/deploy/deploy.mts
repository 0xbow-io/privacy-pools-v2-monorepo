#!/usr/bin/env node
/**
 * Deploy Privacy Pools V2 contracts to Stellar testnet.
 *
 * Usage: node scripts/deploy/deploy.mts [--network testnet] [--source ppv2-deployer]
 *
 * Steps:
 *   1. Build all contracts (stellar contract build)
 *   2. Deploy ASP Registry WASM
 *   3. Deploy Keystore WASM
 *   4. Deploy Pool WASM
 *   5. Deploy Relay WASM
 *   6. Save contract IDs to scripts/deployments/<network>.json
 */

import { parseArgs } from "node:util";
import {
    checkStellarCLI,
    ensureIdentity,
    buildContracts,
    getWasmPaths,
    deployWasm,
    loadDeployment,
    saveDeployment,
    step,
    success,
    type DeploymentState,
} from "./utils.mts";

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
        "skip-build": { type: "boolean", default: false },
    },
});

const network = args.network as string;
const source = args.source as string;

async function main(): Promise<DeploymentState> {
    console.log("=== Privacy Pools V2 — Contract Deployment ===");
    console.log(`  Network: ${network}`);
    console.log(`  Source:  ${source}`);

    // Pre-checks
    checkStellarCLI();

    // Check for existing deployment
    const existing = loadDeployment(network);
    if (existing && existing.pool && existing.keystore && existing.aspRegistry && existing.relay) {
        console.log("\nExisting deployment found:");
        console.log(`  Pool:         ${existing.pool}`);
        console.log(`  Keystore:     ${existing.keystore}`);
        console.log(`  ASP Registry: ${existing.aspRegistry}`);
        console.log(`  Relay:        ${existing.relay}`);
        console.log("\nTo redeploy, delete scripts/deployments/" + network + ".json first.");
        return existing;
    }

    // Ensure deployer identity exists and is funded
    step("Preparing deployer identity");
    const deployerAddr = ensureIdentity(source, network);

    // Build contracts
    if (!args["skip-build"]) {
        step("Building contracts");
        buildContracts();
    }

    const wasm = getWasmPaths();

    // Deploy ASP Registry
    step("Deploying ASP Registry");
    const aspRegistryId = deployWasm(wasm.aspRegistry, source, network);
    success(`ASP Registry: ${aspRegistryId}`);

    // Deploy Keystore
    step("Deploying Keystore");
    const keystoreId = deployWasm(wasm.keystore, source, network);
    success(`Keystore: ${keystoreId}`);

    // Deploy Pool
    step("Deploying Pool");
    const poolId = deployWasm(wasm.pool, source, network);
    success(`Pool: ${poolId}`);

    // Deploy Relay
    step("Deploying Relay");
    const relayId = deployWasm(wasm.relay, source, network);
    success(`Relay: ${relayId}`);

    // Save deployment state
    step("Saving deployment state");
    const state: DeploymentState = {
        network,
        deployer: deployerAddr,
        timestamp: new Date().toISOString(),
        aspRegistry: aspRegistryId,
        keystore: keystoreId,
        pool: poolId,
        relay: relayId,
        initialized: false,
        vksRegistered: false,
        assetsConfigured: false,
    };
    saveDeployment(network, state);

    console.log("\n=== Deployment Complete ===");
    console.log(`  ASP Registry: ${aspRegistryId}`);
    console.log(`  Keystore:     ${keystoreId}`);
    console.log(`  Pool:         ${poolId}`);
    console.log(`  Relay:        ${relayId}`);
    console.log(`\nNext: node scripts/deploy/initialize.mts --network ${network}`);

    return state;
}

main().catch((err: Error) => {
    console.error("\nDeployment failed:", err.message);
    process.exit(1);
});
