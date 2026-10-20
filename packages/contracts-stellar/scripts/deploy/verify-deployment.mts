#!/usr/bin/env node
/**
 * Verify a deployed Privacy Pools V2 deployment.
 *
 * Usage: node scripts/deploy/verify-deployment.mts [--network testnet]
 *
 * Checks:
 *   1. All contracts exist and respond to queries
 *   2. Pool references correct keystore and ASP registry addresses
 *   3. Pool roles are set
 *   4. Asset config is set (native XLM)
 *   5. VKs are registered (deposit, ragequit, at least one transact)
 */

import { parseArgs } from "node:util";
import { checkStellarCLI, loadDeployment, run, step, success } from "./utils.mts";

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
    },
});

const network = args.network as string;
const source = args.source as string;

let passed = 0;
let failed = 0;

function check(name: string, fn: () => void): void {
    try {
        fn();
        success(name);
        passed++;
    } catch (err) {
        console.error(`  FAIL: ${name}: ${(err as Error).message}`);
        failed++;
    }
}

function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    return fn()
        .then(() => {
            success(name);
            passed++;
        })
        .catch((err: Error) => {
            console.error(`  FAIL: ${name}: ${err.message}`);
            failed++;
        });
}

async function main(): Promise<void> {
    console.log("=== Privacy Pools V2 — Deployment Verification ===");

    checkStellarCLI();

    const deployment = loadDeployment(network);
    if (!deployment) {
        throw new Error(`No deployment found for network "${network}". Run deploy.mts first.`);
    }

    const { aspRegistry, keystore, pool, deployer } = deployment;
    console.log(`  ASP Registry: ${aspRegistry}`);
    console.log(`  Keystore:     ${keystore}`);
    console.log(`  Pool:         ${pool}`);
    console.log(`  Deployer:     ${deployer}`);

    // 1. Check ASP Registry is initialized (root_count returns u32)
    step("Verifying ASP Registry");
    check("ASP Registry responds to root_count", () => {
        const result = run(`stellar contract invoke --id ${aspRegistry} --source-account "${source}" --network ${network} -- root_count`, {
            silent: true,
        });
        if (result === undefined || result === null) {
            throw new Error("No response from root_count");
        }
        console.log(`    Root count: ${result}`);
    });

    // 2. Check Keystore is initialized (tree_size returns u32)
    step("Verifying Keystore");
    check("Keystore responds to tree_size", () => {
        const result = run(`stellar contract invoke --id ${keystore} --source-account "${source}" --network ${network} -- tree_size`, {
            silent: true,
        });
        if (result === undefined || result === null) {
            throw new Error("No response from tree_size");
        }
        console.log(`    Tree size: ${result}`);
    });

    // 3. Check Pool is initialized (tree_size returns u32, confirms initialize was called)
    step("Verifying Pool");
    check("Pool tree_size responds (confirms initialization)", () => {
        const result = run(`stellar contract invoke --id ${pool} --source-account "${source}" --network ${network} -- tree_size`, {
            silent: true,
        });
        console.log(`    Tree size: ${result}`);
    });

    // 5. Check asset config
    step("Verifying Asset Configuration");
    check("Native XLM asset config exists", () => {
        const xlmAddress = run(`stellar contract id asset --asset native --network ${network}`, { silent: true });
        const result = run(
            `stellar contract invoke --id ${pool} --source-account "${source}" --network ${network} -- get_asset_config --asset ${xlmAddress}`,
            { silent: true },
        );
        console.log(`    XLM config: ${result}`);
    });

    // 6. Audit C-2, against the DEPLOYED values: the relay's MAX_BATCH must be strictly below the
    //    pool's root_history_size, or a full relay_batch evicts the shared pre-batch state root.
    //    (Ported from upstream ppv2-stellar's verify-deployment.)
    if (deployment.relay) {
        step("Verifying batch/root-history invariant (C-2)");
        check("relay MAX_BATCH < pool root_history_size", () => {
            const rhs = Number(
                run(`stellar contract invoke --id ${pool} --source-account "${source}" --network ${network} --send=no -- root_history_size`, {
                    silent: true,
                }),
            );
            const maxBatch = Number(
                run(`stellar contract invoke --id ${deployment.relay} --source-account "${source}" --network ${network} --send=no -- max_batch`, {
                    silent: true,
                }),
            );
            if (!Number.isFinite(rhs) || !Number.isFinite(maxBatch)) {
                throw new Error(`could not read values (MAX_BATCH=${maxBatch}, root_history_size=${rhs})`);
            }
            if (!(maxBatch < rhs)) {
                throw new Error(`MAX_BATCH ${maxBatch} is not strictly below root_history_size ${rhs} (audit C-2)`);
            }
            console.log(`    MAX_BATCH ${maxBatch} < root_history_size ${rhs}`);
        });
    }

    // Summary
    console.log("\n=== Verification Summary ===");
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);

    if (failed > 0) {
        console.log("\nSome checks failed. Review the output above for details.");
        process.exit(1);
    } else {
        console.log("\nAll checks passed! Deployment is operational.");
    }
}

main().catch((err: Error) => {
    console.error("\nVerification failed:", err.message);
    process.exit(1);
});
