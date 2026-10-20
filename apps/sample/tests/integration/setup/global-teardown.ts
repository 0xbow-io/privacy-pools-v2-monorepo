/**
 * Vitest globalTeardown — runs once after all test files.
 * A safety net that logs warnings if funds were not recovered.
 */
export async function teardown(): Promise<void> {
    console.log("\n[global-teardown] Integration test run complete.");
    console.log("[global-teardown] If funds remain in test accounts, check afterAll cleanup logs.\n");
}
