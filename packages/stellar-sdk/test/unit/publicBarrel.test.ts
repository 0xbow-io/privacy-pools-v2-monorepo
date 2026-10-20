import { describe, expect, it } from "vitest";

// Deliberate exception to the "all imports via internal.js" rule (this package's own CLAUDE.md
// §1): the whole purpose of this file is to assert what the PUBLIC barrel exposes, so it must
// import from `external.js` — going through `internal.js` would test the wrong thing and pass
// regardless.
import {
    createStellarPoolSession,
    InvalidBuilderConfig,
    STELLAR_EMPTY_ADDRESS,
    StellarAddressSchema,
    StellarPoolSessionBuilder,
} from "../../src/external.js";

/**
 * `external.ts` re-exports core-sdk's full public surface via `export * from
 * "@privacy-pools-v2/core-sdk"` — a real ESM/CJS star re-export that forwards runtime values
 * correctly (unlike core-sdk's own `export type * from "./internal.js"` catch-all, which is
 * type-only-by-default; see core-sdk's own `publicBarrel.test.ts` for that class of bug). This
 * suite instead guards this package's OWN named exports below the star re-export, plus the
 * `STELLAR_EMPTY_ADDRESS`/`StellarAddressSchema` split out of core-sdk's own `common.ts` (see
 * `src/constant/common.ts`'s own doc) — the two most likely to regress silently, since nothing
 * else in this package's own source imports them the way `createStellarPoolSession` is imported
 * by every real caller.
 */
describe("public barrel runtime exports", () => {
    it("expose the session factory function", () => {
        expect(typeof createStellarPoolSession).toBe("function");
    });

    it("expose the fluent session builder class", () => {
        expect(typeof StellarPoolSessionBuilder).toBe("function");
    });

    it("expose the Stellar 'no address' sentinel constant", () => {
        expect(typeof STELLAR_EMPTY_ADDRESS).toBe("string");
        expect(STELLAR_EMPTY_ADDRESS.length).toBeGreaterThan(0);
    });

    it("expose the Stellar StrKey address schema", () => {
        expect(typeof StellarAddressSchema.parse).toBe("function");
    });

    it("expose an error class re-exported through the core-sdk star re-export", () => {
        expect(typeof InvalidBuilderConfig).toBe("function");
        const error = new InvalidBuilderConfig("test");
        expect(error).toBeInstanceOf(InvalidBuilderConfig);
        expect(error).toBeInstanceOf(Error);
    });
});
