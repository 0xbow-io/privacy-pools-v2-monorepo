import { describe, expect, it } from "vitest";

import { CROSS_CHAIN_DESTINATION_GAS_LIMIT } from "../../../src/internal.js";

describe("CROSS_CHAIN_DESTINATION_GAS_LIMIT", () => {
    it("gives every cross-chain destination call the flat 2M budget", () => {
        expect(CROSS_CHAIN_DESTINATION_GAS_LIMIT).toBe("2000000");
    });
});
