import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/batchFee.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // multiformats ships ESM-only (no "require" export condition) — tsup's default
  // externalizes runtime deps, which left a raw `require("multiformats/cid")` in the
  // CJS build that can never resolve for any CJS consumer (e.g. the relayer's Nest app,
  // built as CommonJS). Bundling it here instead lets esbuild convert it during the
  // build rather than deferring to a runtime require that's fundamentally unsatisfiable.
  noExternal: ["multiformats"],
});
