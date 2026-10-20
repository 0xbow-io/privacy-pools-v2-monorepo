import { defineChainVitestConfig } from "@privacy-pools-v2/e2e-suite/vitest";

// The shared suites (one built entry per operation, from `@privacy-pools-v2/e2e-suite`). Infra
// (local Soroban network + deploy, relayer, mock ASP) is started once by `globalSetup`; files run
// one after another. The suite is bound by ledger closes, but running files in parallel does not work
// against one shared pool: two pool transactions in the same ledger window fail on a stale footprint
// (the Merkle tree's storage keys depend on the leaf index at simulation time). It would need a pool
// deployment per worker.
export default defineChainVitestConfig({
    chain: "e2e/chain.ts",
    globalSetup: "e2e/setup/global-setup.ts",
});
