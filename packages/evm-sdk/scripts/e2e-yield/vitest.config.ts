import { defineConfig } from "vitest/config";

// Dedicated config for the live yield E2E so vitest picks up the test under
// scripts/ (the package vitest.config.ts only includes test/**).
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["scripts/e2e-yield/**/*.test.ts"],
        pool: "forks",
        testTimeout: 600_000,
        hookTimeout: 120_000,
    },
});
