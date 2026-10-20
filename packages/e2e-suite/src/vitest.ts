// `@privacy-pools-v2/e2e-suite/vitest` — for a chain's `vitest.config.ts` (loaded in vitest's main process).
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";

import { SUITE_NAMES } from "./suites/names.js";

export interface ChainVitestConfig {
    /** The chain's module whose default export is its `defineChainE2E(...)`; aliased as `@e2e/chain`. */
    chain: string;
    /** The chain's `globalSetup` module (built with `defineChainGlobalSetup`). */
    globalSetup: string;
    /** Chain-specific test files that stay in the chain SDK, in addition to the shared suites. */
    include?: string[];
    /** Directory `chain` / `globalSetup` are relative to. Default: the working directory vitest runs in. */
    root?: string;
    /**
     * Test files run at once, one per worker. Default 1: files run one after another. Above 1, every
     * worker must get infrastructure of its own (vitest numbers live workers 1..workers in
     * `VITEST_POOL_ID`), since files sharing a deployment race on its ASP and keystore roots.
     */
    workers?: number;
    /** Real Groth16 proofs; node boot + deploy can stack on a first run. */
    testTimeout?: number;
    hookTimeout?: number;
}

/** Absolute paths of the built entry file of every shared suite (`dist/entries/<name>.js`). */
export function suiteEntryPaths(): string[] {
    const here = dirname(fileURLToPath(import.meta.url));
    return SUITE_NAMES.map((name) => resolve(here, "entries", `${name}.js`));
}

/**
 * The whole vitest config for running a chain's e2e: the shared suites (one file each, so each gets its own
 * worker, its own report and `vitest run <suite>` single runs), the chain's own extra files, the chain's
 * `globalSetup`, and the settings a local node needs — infra is started once, and files run one after another
 * unless the chain gives each of `workers` workers infrastructure of its own.
 */
export function defineChainVitestConfig(config: ChainVitestConfig) {
    const root = config.root ?? process.cwd();
    const workers = config.workers ?? 1;
    return defineConfig({
        resolve: { alias: { "@e2e/chain": resolve(root, config.chain) } },
        test: {
            globals: true,
            environment: "node",
            include: [...suiteEntryPaths(), ...(config.include ?? [])],
            // The default excludes `**/dist/**`, which is exactly where the built suite entries live.
            exclude: configDefaults.exclude.filter((pattern) => pattern !== "**/dist/**"),
            globalSetup: [resolve(root, config.globalSetup)],
            pool: "forks",
            fileParallelism: workers > 1,
            maxWorkers: workers,
            minWorkers: 1,
            sequence: { concurrent: false },
            testTimeout: config.testTimeout ?? 300_000,
            hookTimeout: config.hookTimeout ?? 600_000,
            // The entries are built files outside node_modules; keep them (and the aliased chain) in vite-node.
            server: { deps: { inline: [/e2e-suite/] } },
        },
    });
}
