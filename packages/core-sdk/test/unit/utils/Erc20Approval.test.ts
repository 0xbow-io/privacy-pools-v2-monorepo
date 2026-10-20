import { describe, expect, it } from "vitest";

import type { PreparedTransaction } from "../../../src/types/index.js";
import { planApprovals } from "../../../src/utils/Erc20Approval.js";

const encode = (amount: bigint): PreparedTransaction => ({
    to: "0x00000000000000000000000000000000000000aa",
    data: `0x${amount.toString(16)}` as PreparedTransaction["data"],
    value: "0x0",
});

describe("planApprovals", () => {
    it("needs nothing when the allowance already covers the amount", () => {
        expect(planApprovals(10n, 10n, encode)).toEqual([]);
        expect(planApprovals(11n, 10n, encode)).toEqual([]);
    });

    it("approves once from a zero allowance", () => {
        expect(planApprovals(0n, 10n, encode)).toEqual([encode(10n)]);
    });

    it("resets to zero first on a non-zero residual (Tether-style approve)", () => {
        expect(planApprovals(3n, 10n, encode)).toEqual([encode(0n), encode(10n)]);
    });

    it("needs nothing for a zero amount", () => {
        expect(planApprovals(0n, 0n, encode)).toEqual([]);
        expect(planApprovals(3n, 0n, encode)).toEqual([]);
    });
});
