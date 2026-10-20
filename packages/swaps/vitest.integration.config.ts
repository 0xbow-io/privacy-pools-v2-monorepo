import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
    pool: "forks",
    include: ["test/withdraw-and-swap.*", "test/relay-withdraw-and-swap.*", "test/sdk-*", "test/lifi-*"],
    exclude: ["contracts/**", "node_modules/**"],
  },
  plugins: [swc.vite()],
});
