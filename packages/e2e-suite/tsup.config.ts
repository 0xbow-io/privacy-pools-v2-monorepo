import { defineConfig } from "tsup";

import { SUITE_NAMES } from "./src/suites/names.ts";

// `build` wipes dist first (`rm -rf dist && tsup`): the configs below run in parallel, so none may `clean`.
export default defineConfig([
  {
    entry: ["src/index.ts", "src/setup.ts"],
    format: ["cjs", "esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    treeshake: true,
  },
  {
    // Loaded by a chain's vitest config, which is ESM; it locates the built entries via `import.meta.url`.
    entry: ["src/vitest.ts"],
    format: ["esm"],
    dts: true,
    splitting: false,
    sourcemap: true,
    treeshake: true,
  },
  // One test entry per suite: the same `src/entry.ts`, with the suite name baked in.
  ...SUITE_NAMES.map((name) => ({
    entry: { [`entries/${name}`]: "src/entry.ts" },
    format: ["esm" as const],
    dts: false,
    splitting: false,
    sourcemap: true,
    treeshake: true,
    define: { __E2E_SUITE__: JSON.stringify(name) },
    // Injected by the chain's vitest config alias.
    external: ["@e2e/chain"],
  })),
]);
