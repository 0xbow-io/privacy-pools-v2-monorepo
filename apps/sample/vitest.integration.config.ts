import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        globals: true,
        environment: "node",
        include: ["tests/integration/scenarios/**/*.test.ts"],
        globalSetup: ["./tests/integration/setup/global-setup.ts"],
        testTimeout: 600_000,
        hookTimeout: 300_000,
        fileParallelism: false,
        pool: "forks",
        sequence: {
            concurrent: false,
        },
        reporters: [
            "default",
            "./tests/integration/reporters/failure-logger.ts",
        ],
    },
});
