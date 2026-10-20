import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    exclude: ["contracts/**", "node_modules/**", "test/mainnet-*", "test/withdraw-and-swap.*", "test/relay-withdraw-and-swap.*", "test/sdk-*", "test/lifi-*"],
  },
  plugins: [swc.vite()],
});
