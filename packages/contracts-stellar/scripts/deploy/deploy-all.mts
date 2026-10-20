#!/usr/bin/env node
/**
 * Master deployment script — runs all deployment steps in order.
 *
 * Usage: node scripts/deploy/deploy-all.mts [--network testnet] [--source ppv2-deployer]
 *
 * Steps:
 *   1. Deploy contracts (deploy.mts)
 *   2. Initialize contracts (initialize.mts)
 *   3. Register verification keys (register-vks.mts)
 *   4. Configure assets (configure-assets.mts)
 *   5. Verify deployment (verify-deployment.mts)
 *   6. Deploy the yield module (local: stand up Blend first; deploy-yield.mts)
 */

import { execSync } from "child_process";
import { parseArgs } from "node:util";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "testnet" },
        source: { type: "string", default: "ppv2-deployer" },
        "skip-build": { type: "boolean", default: false },
        "skip-vks": { type: "boolean", default: false },
        step: { type: "string", default: "" },
    },
});

const network = args.network as string;
const source = args.source as string;

interface DeployStep {
    name: string;
    script: string;
    desc: string;
}

const steps: DeployStep[] = [
    { name: "deploy", script: "deploy.mts", desc: "Deploying contracts" },
    { name: "initialize", script: "initialize.mts", desc: "Initializing contracts" },
    { name: "register-vks", script: "register-vks.mts", desc: "Registering verification keys" },
    { name: "configure-assets", script: "configure-assets.mts", desc: "Configuring assets" },
    { name: "verify", script: "verify-deployment.mts", desc: "Verifying deployment" },
    { name: "yield", script: "deploy-yield.mts", desc: "Deploying the yield module" },
];

function runStep(script: string, extraArgs: string[] = []): void {
    // Yield needs a lending venue: on local there is none until we deploy Blend ourselves.
    if (script === "deploy-yield.mts" && network === "local") {
        execSync(`node "${join(__dirname, "../blend/deploy-local-blend.mts")}" --source ${source}`, {
            stdio: "inherit",
            cwd: process.cwd(),
        });
    }
    const scriptPath = join(__dirname, script);
    const allArgs = [`--network`, network, `--source`, source, ...extraArgs];
    const cmd = `node "${scriptPath}" ${allArgs.join(" ")}`;
    execSync(cmd, { stdio: "inherit", cwd: process.cwd() });
}

async function main(): Promise<void> {
    console.log("================================================================");
    console.log("  Privacy Pools V2 — Full Deployment Pipeline");
    console.log("================================================================");
    console.log(`  Network: ${network}`);
    console.log(`  Source:  ${source}`);
    console.log("");

    // If --step is specified, run only that step
    if (args.step) {
        const target = steps.find((s) => s.name === args.step);
        if (!target) {
            console.error(`Unknown step: ${args.step}. Available: ${steps.map((s) => s.name).join(", ")}`);
            process.exit(1);
        }
        console.log(`Running single step: ${target.desc}`);
        const extra: string[] = [];
        if (target.name === "deploy" && args["skip-build"]) extra.push("--skip-build");
        runStep(target.script, extra);
        return;
    }

    // Run all steps in order
    for (const s of steps) {
        if (s.name === "register-vks" && args["skip-vks"]) {
            console.log(`\n--- Skipping: ${s.desc} (--skip-vks) ---`);
            continue;
        }

        console.log(`\n--- Step: ${s.desc} ---`);
        const extra: string[] = [];
        if (s.name === "deploy" && args["skip-build"]) extra.push("--skip-build");
        try {
            runStep(s.script, extra);
        } catch {
            console.error(`\nStep "${s.name}" failed. Fix the issue and re-run with:`);
            console.error(`  node scripts/deploy/deploy-all.mts --step ${s.name} --network ${network}`);
            process.exit(1);
        }
    }

    console.log("\n================================================================");
    console.log("  Deployment pipeline complete!");
    console.log("================================================================");
}

main().catch((err: Error) => {
    console.error("\nDeployment pipeline failed:", err.message);
    process.exit(1);
});
