import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/batchFee.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  noExternal: ["@privacy-pools-v2/circuits"],
});
