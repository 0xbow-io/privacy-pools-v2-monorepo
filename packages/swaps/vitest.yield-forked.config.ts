import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Runner for the RelaySwaps yield-unwrap forked e2e sketch (same shape as
// vitest.b2-forked.config.ts).
//
//   YIELD_FORKED_CONFIRM=yes npx vitest run --config vitest.yield-forked.config.ts \
//     test/live-relayer-mainnet-yield-unwrap-forked.integration.test.sketch.ts
//
// See the sketch header for the env it needs (defaults exist for everything except
// the confirmation flag).
export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    testTimeout: 20 * 60_000,
    hookTimeout: 10 * 60_000,
    include: ["test/live-relayer-mainnet-yield-unwrap-forked.integration.test.sketch.ts"],
  },
  plugins: [swc.vite()],
});
