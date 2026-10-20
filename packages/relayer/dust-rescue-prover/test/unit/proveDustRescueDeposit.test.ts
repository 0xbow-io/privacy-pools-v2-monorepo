import { describe, expect, it } from "vitest";
import { computeRescueNoteValue } from "../../src/proveDustRescueDeposit.js";

// Pins finding #8's fix: the note must be sized so that adding the destination
// Entrypoint's live vetting fee back on top never exceeds what the rescue wallet
// actually holds (sweptAmount). Before this fix the note was sized at sweptAmount
// itself, leaving every fee-bearing deposit short by exactly the fee.

describe("computeRescueNoteValue", () => {
    it("returns the swept amount unchanged when the vetting fee is zero", () => {
        expect(computeRescueNoteValue(10_000_000n, 0n, 1n)).toBe(10_000_000n);
    });

    it("nets out a 100bps (1%) vetting fee, matching the live Arbitrum/Base USDC/USDT rate", () => {
        // 10 USDC (6dp) swept, 100bps fee — hand-verified: floor(10_000_000*10000/10100).
        const noteValue = computeRescueNoteValue(10_000_000n, 100n, 1n);
        expect(noteValue).toBe(9_900_990n);
    });

    it("never lets noteValue + fee exceed the swept amount, across a range of fees and amounts", () => {
        const sweptAmounts = [1n, 999n, 10_000_000n, 123_456_789_012_345n];
        const feesBps = [0n, 1n, 50n, 100n, 250n, 9_999n];
        for (const sweptAmount of sweptAmounts) {
            for (const bps of feesBps) {
                const noteValue = computeRescueNoteValue(sweptAmount, bps, 0n);
                const fee = (noteValue * bps) / 10_000n;
                expect(noteValue + fee).toBeLessThanOrEqual(sweptAmount);
            }
        }
    });

    it("throws when the inverted note value falls below the Entrypoint's minAmount", () => {
        // sweptAmount nets to 9_900_990 at 100bps; a minAmount just above that must reject.
        expect(() => computeRescueNoteValue(10_000_000n, 100n, 9_900_991n)).toThrow(
            /below the Entrypoint's minimum deposit/
        );
    });

    it("does not throw when the inverted note value exactly meets minAmount", () => {
        expect(computeRescueNoteValue(10_000_000n, 100n, 9_900_990n)).toBe(9_900_990n);
    });
});
