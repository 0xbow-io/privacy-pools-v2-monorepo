import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// One-off runner for the B2 step-13.3 forked e2e sketch (same shape as
// vitest.sketch-run.config.ts — the base config's `include` only matches
// *.test.ts / *.spec.ts, and an explicit CLI path is still filtered against it).
//
//   . ./.env && B2_FORKED_CONFIRM=yes OP_USDC_WHALE=0x... RELAYER_SIGNER_ADDRESS_10=0x... \
//     npx vitest run --config vitest.b2-forked.config.ts \
//     test/live-relayer-optimism-to-mainnet-b2-forked.integration.test.sketch.ts
//
// Delete after B2 rollout — not meant to persist.
export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    testTimeout: 15 * 60_000,
    hookTimeout: 3 * 60_000,
    include: [
      "test/live-relayer-optimism-to-mainnet-b2-forked.integration.test.sketch.ts",
    ],
  },
  plugins: [swc.vite()],
});
