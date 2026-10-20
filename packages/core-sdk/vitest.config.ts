import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    passWithNoTests: true,
    pool: "forks",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
