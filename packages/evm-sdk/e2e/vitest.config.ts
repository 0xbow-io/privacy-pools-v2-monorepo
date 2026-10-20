import { defineChainVitestConfig } from "@privacy-pools-v2/e2e-suite/vitest";

import { laneCount } from "./lanes.js";

// The shared suites (one built entry per operation, from `@privacy-pools-v2/e2e-suite`) plus the EVM-only files in
// e2e/ops. Infra is started once by `globalSetup`: a lane (anvil with the contracts, relayer, mock ASP) per worker,
// so files run in parallel without sharing a chain (see `lanes.ts`; `EVM_E2E_WORKERS` sets the count).
export default defineChainVitestConfig({
    chain: "e2e/chain.ts",
    globalSetup: "e2e/setup/global-setup.ts",
    include: ["e2e/ops/**/*.e2e.test.ts"],
    workers: laneCount(),
});
