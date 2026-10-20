import { beforeEach, onTestFailed } from "vitest";

/**
 * Tracks sequential test dependencies within a describe block.
 * If any test fails, all subsequent tests in the same suite are automatically skipped.
 * Call once at the top level of each describe block.
 */
export function useSequentialDeps(): void {
    let failed = false;

    beforeEach((context) => {
        if (failed) {
            context.skip();
            return;
        }
        onTestFailed(() => {
            failed = true;
        });
    });
}
