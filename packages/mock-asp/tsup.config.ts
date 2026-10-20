import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/evm.ts", "src/stellar.ts"],
  format: ["cjs", "esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
