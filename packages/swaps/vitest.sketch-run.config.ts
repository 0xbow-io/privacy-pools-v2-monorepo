import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Temporary, one-off config to run a .sketch.ts file directly — the base
// vitest.config.ts's default `include` only matches *.test.ts/*.spec.ts, and an
// explicit CLI path is still filtered against `include` (not a bypass), so a
// .sketch.ts file can't be run through the normal config at all. Delete this file
// after use; it isn't meant to persist.
export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    include: ["test/live-relayer-mainnet-to-optimism-eth-dust-rescue.integration.test.sketch.ts"],
  },
  plugins: [swc.vite()],
});
