import { defineConfig } from "vitest/config";

// Pick which top-level e2e entry to run. `TEST_SUITE=full` switches to the
// full suite; anything else (or unset) runs the fast `base` suite.
const suite = process.env.TEST_SUITE === "full" ? "full" : "base";

export default defineConfig({
    test: {
        root: "./src",
        include: [`**/${suite}.e2e.ts`],
        fileParallelism: true,
        env: {
            RELAYER_URL: process.env.RELAYER_URL ?? "http://localhost:3000",
            TEST_CHAIN_ID: "11155111",
            TEST_CHAIN_TYPE: "evm",
            API_VERSION: "v1",
            CIRCUIT_ARTIFACTS_DIR: process.env.CIRCUIT_ARTIFACTS_DIR ?? "./circuit-artifacts",
            RPC_URL: process.env.RPC_URL ?? "http://localhost:8545",
        },
    },
});
