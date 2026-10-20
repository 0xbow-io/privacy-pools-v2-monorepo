import { inject } from "vitest";

/**
 * Worker side of `defineChainGlobalSetup`: the handle the chain's setup provided. Lives apart from the
 * setup helper because `globalSetup` modules must not import vitest's runtime.
 */
export function injectHandle<THandle>(id: string): THandle {
    return (inject as (key: string) => unknown)(id) as THandle;
}
