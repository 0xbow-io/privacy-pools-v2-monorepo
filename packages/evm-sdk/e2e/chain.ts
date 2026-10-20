import { defineChainE2E } from "@privacy-pools-v2/e2e-suite";

import { EVM_E2E } from "./harness/context.js";
import { EvmDriver } from "./driver/EvmDriver.js";

/**
 * The EVM chain as the shared conformance suite sees it. EVM supports every capability, so nothing is
 * opted out. `e2e/vitest.config.ts` runs the shared suites against it (`defineChainVitestConfig`).
 */
export const evmE2E = defineChainE2E({
    name: "evm",
    enabled: EVM_E2E,
    unsupported: {},
    createDriver: () => EvmDriver.fromInjected(),
});

// The suite entries import the chain through the `@e2e/chain` alias `defineChainVitestConfig` sets up.
export default evmE2E;
