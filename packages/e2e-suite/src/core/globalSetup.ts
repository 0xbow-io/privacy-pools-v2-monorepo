import type { GlobalSetupContext } from "vitest/node";

export interface ChainGlobalSetupConfig<THandle> {
    /** The `provide` key the workers `inject`. Unique per chain (`"evm-e2e"`). */
    id: string;
    /** The chain's opt-in switch; when false the setup is inert (a bare `vitest run` starts nothing). */
    enabled: boolean;
    /**
     * Starts (or reuses) the shared infrastructure — node + deployed contracts, relayer, mock ASP — and
     * returns a serializable handle for the workers plus an optional teardown. Only tear down what this
     * run started.
     */
    start(): Promise<{ handle: THandle; stop?: () => Promise<void> }>;
}

/**
 * Builds a vitest `globalSetup` module's default export. `globalSetup` runs once, in the main process,
 * and `provide` accepts serializable values only — so the chain contributes infra + a handle here, and
 * builds its in-process driver from that handle (`injectHandle`) inside each test file.
 */
export function defineChainGlobalSetup<THandle>(
    config: ChainGlobalSetupConfig<THandle>,
): (context: GlobalSetupContext) => Promise<(() => Promise<void>) | undefined> {
    return async ({ provide }) => {
        if (!config.enabled) return undefined;
        const { handle, stop } = await config.start();
        (provide as (key: string, value: unknown) => void)(config.id, handle);
        return async () => {
            await stop?.();
        };
    };
}
