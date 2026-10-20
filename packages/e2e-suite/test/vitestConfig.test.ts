import { basename, isAbsolute, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { suites } from "../src/suites/index.js";
import { SUITE_NAMES } from "../src/suites/names.js";
import { defineChainVitestConfig, suiteEntryPaths } from "../src/vitest.js";

const base = { chain: "e2e/chain.ts", globalSetup: "e2e/setup/global-setup.ts", root: "/repo/packages/x" };

describe("SUITE_NAMES", () => {
    it("name exactly the registered suites, each once", () => {
        expect([...SUITE_NAMES].sort()).toEqual(Object.keys(suites).sort());
        expect(new Set(SUITE_NAMES).size).toBe(SUITE_NAMES.length);
    });
});

describe("suiteEntryPaths", () => {
    it("list one absolute built entry per suite, named after it", () => {
        const paths = suiteEntryPaths();

        expect(paths.every(isAbsolute)).toBe(true);
        expect(paths.map((p) => basename(p, ".js"))).toEqual([...SUITE_NAMES]);
    });
});

describe("defineChainVitestConfig", () => {
    it("run every shared suite entry and the chain's extra files", () => {
        const { test } = defineChainVitestConfig({ ...base, include: ["e2e/ops/**/*.e2e.test.ts"] });

        expect(test?.include).toEqual([...suiteEntryPaths(), "e2e/ops/**/*.e2e.test.ts"]);
    });

    it("alias @e2e/chain to the chain module and resolve globalSetup against the root", () => {
        const config = defineChainVitestConfig(base);

        expect(config.resolve?.alias).toEqual({ "@e2e/chain": resolve(base.root, "e2e/chain.ts") });
        expect(config.test?.globalSetup).toEqual([resolve(base.root, "e2e/setup/global-setup.ts")]);
    });

    it("keep dist searchable, since the built entries live there, but still skip node_modules", () => {
        const exclude = defineChainVitestConfig(base).test?.exclude ?? [];

        expect(exclude).not.toContain("**/dist/**");
        expect(exclude).toContain("**/node_modules/**");
    });

    it("run files one after another in a single worker", () => {
        const { test } = defineChainVitestConfig(base);

        expect(test?.fileParallelism).toBe(false);
        expect(test?.maxWorkers).toBe(1);
        expect(test?.sequence?.concurrent).toBe(false);
    });

    it("let the chain override the timeouts", () => {
        const { test } = defineChainVitestConfig({ ...base, testTimeout: 1, hookTimeout: 2 });

        expect([test?.testTimeout, test?.hookTimeout]).toEqual([1, 2]);
    });
});
