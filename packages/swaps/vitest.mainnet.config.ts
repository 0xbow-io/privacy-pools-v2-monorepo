import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    include: ["test/mainnet-*.integration.test.ts"],
    exclude: ["contracts/**", "node_modules/**"],
  },
  plugins: [swc.vite()],
});
