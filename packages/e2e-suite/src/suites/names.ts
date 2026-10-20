/**
 * Every shared suite, by name — the single source of truth. The `suites` registry is typed against it, the
 * build emits one test entry per name (`dist/entries/<name>.js`), and `defineChainVitestConfig` puts those
 * entries into a chain's vitest `include`. Adding a suite = its file + one name here.
 *
 * Kept free of any vitest import: `tsup.config.ts` and the vitest config helper load it outside a test worker.
 */
export const SUITE_NAMES = [
    "aspHttp",
    "aspApproval",
    "keystore",
    "deposit",
    "withdraw",
    "batchWithdraw",
    "transfer",
    "discovery",
    "ragequit",
    "paymentRequests",
    "relayerFaults",
    "yield",
] as const;

export type SuiteName = (typeof SUITE_NAMES)[number];
