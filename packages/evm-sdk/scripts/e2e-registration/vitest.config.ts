import { defineConfig } from "vitest/config";

// Dedicated config for the live relayed-registration E2E so vitest picks up the
// test under scripts/ (the package vitest.config.ts only includes test/**).
export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["scripts/e2e-registration/**/*.test.ts"],
        pool: "forks",
        testTimeout: 600_000,
        hookTimeout: 120_000,
        // The two phases share cross-`it` state (Alice's note → Bob's note), so
        // they must run in order within the single file.
        sequence: { concurrent: false },
    },
});
