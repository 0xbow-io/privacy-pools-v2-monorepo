import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/stealth.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Bundles core-sdk too (not just contracts) so this tarball is installable standalone,
  // without also needing core-sdk's own pre-release tarball resolved via the workspace.
  noExternal: ["@privacy-pools-v2/contracts", "@privacy-pools-v2/core-sdk"],
});
