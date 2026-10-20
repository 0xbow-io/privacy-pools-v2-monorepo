import { describe, expect, it } from "vitest";

// Deliberate exception to the "all imports via internal.js" rule (this package's own CLAUDE.md
// §1): the whole purpose of this file is to assert what the PUBLIC barrel exposes, so it must
// import from `external.js` — going through `internal.js` would test the wrong thing and pass
// regardless.
import {
    ContractInteractorConfigSchema,
    createEvmPoolSession,
    DEPLOYMENTS,
    EvmNoteDiscoveryService,
    EvmSwapChainAdapter,
    InvalidBuilderConfig,
    PP_ROUTER_WITHDRAW_ABI,
} from "../../src/external.js";

/**
 * `external.ts` re-exports core-sdk's full public surface via `export * from
 * "@privacy-pools-v2/core-sdk"` — a real ESM/CJS star re-export that forwards runtime values
 * correctly (unlike core-sdk's own `export type * from "./internal.js"` catch-all, which is
 * type-only-by-default; see core-sdk's own `publicBarrel.test.ts` for that class of bug). This
 * suite instead guards this package's OWN named exports below the star re-export — a symbol
 * added to the `export { ... } from "./internal.js"` block here always has been a real value
 * export by construction, but a future refactor that moves one behind a `type` keyword, or a
 * copy-paste into the wrong block, would still slip past `tsc` the same way. One per category.
 */
describe("public barrel runtime exports", () => {
    it("expose a chain adapter factory function", () => {
        expect(typeof createEvmPoolSession).toBe("function");
    });

    it("expose a concrete swap-chain-adapter class", () => {
        expect(typeof EvmSwapChainAdapter).toBe("function");
    });

    it("expose the stealth-aware NoteDiscoveryService subclass", () => {
        expect(typeof EvmNoteDiscoveryService).toBe("function");
    });

    it("expose a deployments constant map", () => {
        expect(typeof DEPLOYMENTS).toBe("object");
    });

    it("expose a contract ABI constant", () => {
        expect(Array.isArray(PP_ROUTER_WITHDRAW_ABI)).toBe(true);
        expect(PP_ROUTER_WITHDRAW_ABI.length).toBeGreaterThan(0);
    });

    it("expose a zod schema instance", () => {
        expect(typeof ContractInteractorConfigSchema.parse).toBe("function");
    });

    it("expose an error class re-exported through the core-sdk star re-export", () => {
        expect(typeof InvalidBuilderConfig).toBe("function");
        const error = new InvalidBuilderConfig("test");
        expect(error).toBeInstanceOf(InvalidBuilderConfig);
        expect(error).toBeInstanceOf(Error);
    });
});
