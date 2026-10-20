import { describe, expect, it } from "vitest";

import { validateFaultSpec } from "../../src/internal.js";

describe("validateFaultSpec", () => {
    it("accept a generic mode on the wildcard endpoint by default", () => {
        expect(validateFaultSpec({ mode: "http500" })).toBeNull();
    });

    it("accept a generic mode on a specific endpoint with a count", () => {
        expect(validateFaultSpec({ endpoint: "leaves", mode: "down", count: 2 })).toBeNull();
    });

    it("reject a non-object spec", () => {
        expect(validateFaultSpec("down")).toMatch(/object/);
    });

    it("reject an unknown mode", () => {
        expect(validateFaultSpec({ mode: "explode" })).toMatch(/mode must be one of/);
    });

    it("reject an unknown endpoint", () => {
        expect(validateFaultSpec({ endpoint: "nope", mode: "down" })).toMatch(/endpoint must be/);
    });

    it("reject a non-positive or fractional count", () => {
        expect(validateFaultSpec({ mode: "down", count: 0 })).toMatch(/count/);
        expect(validateFaultSpec({ mode: "down", count: 1.5 })).toMatch(/count/);
    });

    it("reject a data-shaping mode on the wrong endpoint", () => {
        expect(validateFaultSpec({ endpoint: "leaves", mode: "stale-root" })).toMatch(/only applies to/);
        expect(validateFaultSpec({ mode: "bad-leaves" })).toMatch(/only applies to/);
    });

    it("accept a data-shaping mode on its own endpoint", () => {
        expect(validateFaultSpec({ endpoint: "root", mode: "stale-root" })).toBeNull();
        expect(validateFaultSpec({ endpoint: "note-events", mode: "drop-rows" })).toBeNull();
    });
});
