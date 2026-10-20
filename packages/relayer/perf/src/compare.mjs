#!/usr/bin/env node
/**
 * Baseline management for perf results.
 *
 *   node src/compare.mjs save --label pre-optimization
 *     Folds results/ (bench.json + per-scenario test recordings) into a dated,
 *     git-stamped snapshot: baselines/<YYYY-MM-DD>_<label>_<shortsha>.json.
 *     Baselines are meant to be committed.
 *
 *   node src/compare.mjs compare [--baseline <file>]
 *     Diffs the current results/ against the newest baseline (or the given
 *     one). RPC counts diff exactly; latencies as percentages. Exits 1 if RPC
 *     counts regressed (more calls than baseline).
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, "..", "results");
const BASELINES_DIR = join(HERE, "..", "baselines");

function arg(name, fallback) {
    const i = process.argv.indexOf(`--${name}`);
    return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

function loadResults() {
    if (!existsSync(RESULTS_DIR)) {
        console.error("No results/ directory. Run `pnpm test` and/or `pnpm bench` first.");
        process.exit(1);
    }
    const out = { scenarios: {} };
    for (const f of readdirSync(RESULTS_DIR).filter((f) => f.endsWith(".json"))) {
        const data = JSON.parse(readFileSync(join(RESULTS_DIR, f), "utf8"));
        if (f === "bench.json") out.bench = data;
        else out.scenarios[data.scenario ?? f.replace(/\.json$/, "")] = data;
    }
    return out;
}

function newestBaseline() {
    if (!existsSync(BASELINES_DIR)) return null;
    const files = readdirSync(BASELINES_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort();
    return files.length > 0 ? join(BASELINES_DIR, files[files.length - 1]) : null;
}

const command = process.argv[2];

if (command === "save") {
    const label = arg("label", "baseline").replace(/[^a-zA-Z0-9-]/g, "-");
    let sha = "unknown";
    let branch = "unknown";
    try {
        sha = execSync("git rev-parse --short HEAD", { cwd: HERE }).toString().trim();
        branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: HERE }).toString().trim();
    } catch {
        // outside a git checkout (e.g. in-container) — keep "unknown"
    }
    const date = new Date().toISOString().slice(0, 10);
    const results = loadResults();
    const snapshot = {
        date: new Date().toISOString(),
        label,
        gitCommit: sha,
        branch,
        node: process.version,
        ...results,
    };
    mkdirSync(BASELINES_DIR, { recursive: true });
    const file = join(BASELINES_DIR, `${date}_${label}_${sha}.json`);
    writeFileSync(file, JSON.stringify(snapshot, null, 4));
    console.log(`baseline saved: ${file}`);
    process.exit(0);
}

if (command === "compare") {
    const baselineFile = arg("baseline", newestBaseline());
    if (!baselineFile || !existsSync(baselineFile)) {
        console.error("No baseline found. Save one first: pnpm bench:save -- --label <label>");
        process.exit(1);
    }
    const baseline = JSON.parse(readFileSync(baselineFile, "utf8"));
    const current = loadResults();
    console.log(`Comparing against: ${baselineFile}`);
    console.log(`  baseline: ${baseline.date} @ ${baseline.gitCommit} (${baseline.branch})\n`);

    let rpcRegressed = false;

    // --- RPC counts: exact diffs -------------------------------------------
    const scenarioNames = new Set([
        ...Object.keys(baseline.scenarios ?? {}),
        ...Object.keys(current.scenarios ?? {}),
    ]);
    console.log("RPC counts (exact):");
    for (const name of [...scenarioNames].sort()) {
        const b = baseline.scenarios?.[name];
        const c = current.scenarios?.[name];
        if (b?.totalRpcCalls === undefined && c?.totalRpcCalls === undefined) continue;
        const bv = b?.totalRpcCalls ?? "—";
        const cv = c?.totalRpcCalls ?? "—";
        let marker = "";
        if (typeof bv === "number" && typeof cv === "number") {
            if (cv > bv) {
                marker = "  <-- REGRESSION";
                rpcRegressed = true;
            } else if (cv < bv) {
                marker = "  (improved)";
            }
        }
        console.log(`  ${name}: ${bv} -> ${cv}${marker}`);
    }

    // --- Fault response times ----------------------------------------------
    console.log("\nFault-injection response times (ms):");
    for (const name of [...scenarioNames].sort().filter((n) => n.startsWith("fault-"))) {
        const b = baseline.scenarios?.[name]?.responseMs;
        const c = current.scenarios?.[name]?.responseMs;
        if (b === undefined && c === undefined) continue;
        console.log(`  ${name}: ${b ?? "—"} -> ${c ?? "—"}`);
    }

    // --- Latency: percentage deltas ----------------------------------------
    const bLat = baseline.bench?.warm?.latencyMs;
    const cLat = current.bench?.warm?.latencyMs;
    if (bLat && cLat) {
        console.log("\nWarm latency (same-machine comparison only):");
        for (const key of ["min", "p50", "p90", "p95", "max", "mean"]) {
            const delta = ((cLat[key] - bLat[key]) / bLat[key]) * 100;
            const sign = delta >= 0 ? "+" : "";
            console.log(`  ${key}: ${bLat[key]} -> ${cLat[key]} ms (${sign}${delta.toFixed(1)}%)`);
        }
        const bRpc = baseline.bench?.rpc?.rpcCallsPerQuote;
        const cRpc = current.bench?.rpc?.rpcCallsPerQuote;
        if (bRpc !== undefined && cRpc !== undefined) {
            console.log(`  rpcCallsPerQuote: ${bRpc} -> ${cRpc}`);
        }
    } else {
        console.log("\n(no bench.json on one side — run `pnpm bench` for latency comparison)");
    }

    if (rpcRegressed) {
        console.error("\nFAIL: RPC call counts regressed vs baseline.");
        process.exit(1);
    }
    console.log("\nOK");
    process.exit(0);
}

console.error("Usage: node src/compare.mjs <save|compare> [--label X] [--baseline file]");
process.exit(1);
