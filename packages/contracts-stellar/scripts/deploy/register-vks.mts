#!/usr/bin/env node
/**
 * Register verification keys for all available circuits.
 *
 * Usage: node scripts/deploy/register-vks.mts [--network testnet] [--source ppv2-deployer]
 *
 * Registers:
 *   - 1 deposit VK:    set_vk(proof_type=0, n=0, m=0, vk)
 *   - 1 ragequit VK:   set_vk(proof_type=2, n=0, m=0, vk)
 *   - 25 transact VKs: set_vk(proof_type=1, n=N, m=M, vk) for N,M in [1,5]
 *
 * ProofType enum: Deposit=0, Transact=1, Ragequit=2
 *
 * VK source: ../../circuits/build/<circuit>/groth16_vkey.json (same-repo sibling package)
 */

import { parseArgs } from "node:util";
import {
    checkStellarCLI,
    loadDeployment,
    saveDeployment,
    invokeContract,
    loadVK,
    convertVK,
    vkToCliJson,
    listAvailableVKs,
    step,
    success,
    warn,
} from "./utils.mts";

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
        circuit: { type: "string", default: "all" },
    },
});

const network = args.network as string;
const source = args.source as string;
const targetCircuit = args.circuit as string;

// ProofType enum values (matches contracts/types/src/lib.rs)
const PROOF_TYPE_DEPOSIT = 0;
const PROOF_TYPE_TRANSACT = 1;
const PROOF_TYPE_RAGEQUIT = 2;

interface ParsedCircuitName {
    proofType: number;
    n: number;
    m: number;
}

/**
 * Parse a circuit name into proof_type, n, m.
 */
function parseCircuitName(name: string): ParsedCircuitName {
    if (name === "deposit") {
        return { proofType: PROOF_TYPE_DEPOSIT, n: 0, m: 0 };
    }
    if (name === "ragequit") {
        return { proofType: PROOF_TYPE_RAGEQUIT, n: 0, m: 0 };
    }
    const match = name.match(/^transact_(\d+)x(\d+)$/);
    if (match) {
        return { proofType: PROOF_TYPE_TRANSACT, n: parseInt(match[1], 10), m: parseInt(match[2], 10) };
    }
    throw new Error(`Unknown circuit name: ${name}`);
}

/**
 * Register a single VK for a circuit.
 *
 * @param poolId - Pool contract ID
 * @param circuitName - Circuit name (e.g. "transact_1x1")
 * @param adminAddress - On-chain admin address (the `--admin` contract param)
 * @param signerAlias - CLI identity alias to sign with (`--source-account`) — must be
 *   the alias `stellar keys generate` created, not the raw address: the CLI's local keystore is
 *   indexed by alias, so passing a bare address here fails with "No sign with key provided".
 * @param networkName - Network name
 */
function registerVK(poolId: string, circuitName: string, adminAddress: string, signerAlias: string, networkName: string): void {
    const { proofType, n, m } = parseCircuitName(circuitName);

    // Load and convert VK
    const vkJson = loadVK(circuitName);
    const vk = convertVK(vkJson);
    const vkCliJson = vkToCliJson(vk);

    // Invoke set_vk on the pool contract
    invokeContract(
        poolId,
        "set_vk",
        ["--admin", adminAddress, "--proof_type", String(proofType), "--n", String(n), "--m", String(m), "--vk", vkCliJson],
        signerAlias,
        networkName,
    );

    success(`${circuitName} (type=${proofType}, n=${n}, m=${m})`);
}

async function main(): Promise<void> {
    console.log("=== Privacy Pools V2 — VK Registration ===");

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

    // List available VKs
    step("Checking available verification keys");
    const available = listAvailableVKs();
    console.log(`  Found ${available.length} VK files`);

    if (available.length === 0) {
        console.log("\nNo VK files found in circuit build directory.");
        console.log("Build circuits first: cd ../circuits && pnpm build");
        process.exit(1);
    }

    // Filter circuits if requested
    let toRegister = available;
    if (targetCircuit !== "all") {
        toRegister = available.filter((c) => c.name === targetCircuit);
        if (toRegister.length === 0) {
            throw new Error(`Circuit "${targetCircuit}" not found. Available: ${available.map((c) => c.name).join(", ")}`);
        }
    }

    console.log(`  Registering ${toRegister.length} VKs...`);

    // Register each VK
    let registered = 0;
    let failed = 0;
    for (const circuit of toRegister) {
        step(`Registering VK: ${circuit.name}`);
        try {
            registerVK(pool, circuit.name, deployer, source, network);
            registered++;
        } catch (err) {
            if (err instanceof Error && err.message.includes("VkAlreadyRegistered")) {
                warn(`${circuit.name}: already registered, skipping`);
                registered++;
            } else {
                console.error(`  FAILED: ${circuit.name}: ${(err as Error).message}`);
                failed++;
            }
        }
    }

    // Update deployment state
    deployment.vksRegistered = true;
    deployment.vkCount = registered;
    saveDeployment(network, deployment);

    console.log(`\n=== VK Registration Complete ===`);
    console.log(`  Registered: ${registered}`);
    if (failed > 0) console.log(`  Failed: ${failed}`);
    console.log(`\nNext: node scripts/deploy/configure-assets.mts --network ${network}`);
}

main().catch((err: Error) => {
    console.error("\nVK registration failed:", err.message);
    process.exit(1);
});
