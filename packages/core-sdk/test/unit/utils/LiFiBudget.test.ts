import { describe, expect, it } from "vitest";

import type { Hex } from "../../../src/internal.js";
import {
    assertLifiBudget,
    InvalidTransactParams,
    SWAP_DUST_TOLERANCE_BPS,
} from "../../../src/internal.js";

// amount = 100000, fee = 100  →  net = 99900,  maxDust = net * 300 / 10000 = 2997.
const AMOUNT = "0x186a0" as Hex; // 100000
const FEE = "100";
const NET = 99900n;
const MAX_DUST = 2997n;

describe("assertLifiBudget", () => {
    it("expose a 300 bps dust tolerance", () => {
        expect(SWAP_DUST_TOLERANCE_BPS).toBe(300n);
    });

    it("pass a quote whose input sits below the net with dust within tolerance", () => {
        // lifiFrom 98000 → dust 1900 < 2997.
        expect(() => assertLifiBudget("98000", AMOUNT, FEE)).not.toThrow();
    });

    it("pass at the budget boundary where the input exactly equals the net (dust zero)", () => {
        // lifiFrom == net → dust 0; the check is `>` so equality must pass.
        expect(() => assertLifiBudget(NET.toString(), AMOUNT, FEE)).not.toThrow();
    });

    it("throw when the input exceeds the net by one (budget)", () => {
        expect(() => assertLifiBudget((NET + 1n).toString(), AMOUNT, FEE)).toThrow(
            InvalidTransactParams,
        );
        expect(() => assertLifiBudget((NET + 1n).toString(), AMOUNT, FEE)).toThrow("LiFi needs");
    });

    it("pass at the dust boundary where the dust exactly equals the tolerance", () => {
        // lifiFrom = net − maxDust → dust == maxDust; the check is `>` so equality must pass.
        const lifiFrom = NET - MAX_DUST; // 96903
        expect(() => assertLifiBudget(lifiFrom.toString(), AMOUNT, FEE)).not.toThrow();
    });

    it("throw when the dust exceeds the tolerance by one", () => {
        // lifiFrom = net − maxDust − 1 → dust == maxDust + 1.
        const lifiFrom = NET - MAX_DUST - 1n; // 96902
        expect(() => assertLifiBudget(lifiFrom.toString(), AMOUNT, FEE)).toThrow(
            InvalidTransactParams,
        );
        expect(() => assertLifiBudget(lifiFrom.toString(), AMOUNT, FEE)).toThrow("tolerance");
    });
});
