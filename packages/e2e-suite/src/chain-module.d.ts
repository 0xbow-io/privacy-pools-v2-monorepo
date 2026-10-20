// `@e2e/chain` is aliased by the chain's vitest config (see `defineChainVitestConfig`); this types it for `entry.ts`.
declare module "@e2e/chain" {
    import type { ChainE2E } from "./core/index.js";
    const chain: ChainE2E;
    export default chain;
}
