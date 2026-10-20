import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Hits a real, possibly production endpoint -- keep requests sequential
        // rather than hammering it with parallel requests.
        fileParallelism: false,
        // Unofficial (no ctrf-io reporter exists for vitest yet, unlike jest-ctrf-json-reporter
        // used in packages/relayer/relayer), but matches that same convention: a machine-readable
        // report alongside normal console output. Writes to vitest-ctrf/report.json by default.
        reporters: ["default", "vitest-ctrf-json-reporter"],
    },
});
