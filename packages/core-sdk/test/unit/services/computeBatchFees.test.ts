import { describe, expect, it } from "vitest";

import {
    AssetNotRelayable,
    computeBatchFees,
    computeBatchItemFee,
    InfeasibleBatchFee,
} from "../../../src/internal.js";

describe("computeBatchItemFee", () => {
    it("charge relayCost plus a proportional bps fee on the item amount", () => {
        // feeBps 1000 (10%): fee = 10 + (100 * 1000 / 10000) = 10 + 10 = 20.
        const fee = computeBatchItemFee({
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
            amountOut: 100n,
            maxRelayFee: 1000n,
        });
        expect(fee).toBe(20n);
    });

    it("floor the bps fee like applyBPS", () => {
        // (55 * 1000) / 10000 = 5.5 -> floors to 5; fee = 10 + 5 = 15.
        const fee = computeBatchItemFee({
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
            amountOut: 55n,
            maxRelayFee: 1000n,
        });
        expect(fee).toBe(15n);
    });

    it("charge relayCost plus a flat fee when feeBps is zero", () => {
        // flat model: fee = relayCost 10 + flatFee 5 = 15, independent of amountOut.
        const fee = computeBatchItemFee({
            relayCost: 10n,
            feeBps: 0n,
            flatFee: 5n,
            amountOut: 100n,
            maxRelayFee: 1000n,
        });
        expect(fee).toBe(15n);
    });

    it("cap the fee at maxRelayFee", () => {
        // raw = 10 + (1000 * 5000 / 10000) = 10 + 500 = 510, capped to maxRelayFee 100.
        const fee = computeBatchItemFee({
            relayCost: 10n,
            feeBps: 5000n,
            flatFee: 0n,
            amountOut: 1000n,
            maxRelayFee: 100n,
        });
        expect(fee).toBe(100n);
    });

    it("throw InfeasibleBatchFee when the item fee exceeds its own amountOut", () => {
        // fee = 10 + (5 * 1000 / 10000)=10+0 = 10 > amountOut 5.
        expect(() =>
            computeBatchItemFee({
                relayCost: 10n,
                feeBps: 1000n,
                flatFee: 0n,
                amountOut: 5n,
                maxRelayFee: 1000n,
            }),
        ).toThrow(InfeasibleBatchFee);
    });

    it("treat maxRelayFee 0 as uncapped, never flooring the fee to 0", () => {
        // maxRelayFee 0 = "no maximum": fee stays at relayCost + bps, not 0.
        const fee = computeBatchItemFee({
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
            amountOut: 100n,
            maxRelayFee: 0n,
        });
        expect(fee).toBe(20n);
    });

    it("throw AssetNotRelayable when a nonzero maxRelayFee is below relayCost", () => {
        expect(() =>
            computeBatchItemFee({
                relayCost: 10n,
                feeBps: 1000n,
                flatFee: 0n,
                amountOut: 100n,
                maxRelayFee: 5n,
            }),
        ).toThrow(AssetNotRelayable);
    });
});

describe("computeBatchFees", () => {
    it("compute a per-item bps fee for every amount in order", () => {
        // relayCost 10, feeBps 1000 (10%): [100 -> 20, 200 -> 30, 50 -> 15].
        const fees = computeBatchFees({
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
            amountOuts: [100n, 200n, 50n],
            maxRelayFee: 1000n,
        });
        expect(fees).toEqual([20n, 30n, 15n]);
    });

    it("charge the same flat fee to every item under the flat model", () => {
        const fees = computeBatchFees({
            relayCost: 10n,
            feeBps: 0n,
            flatFee: 5n,
            amountOuts: [100n, 200n, 50n],
            maxRelayFee: 1000n,
        });
        expect(fees).toEqual([15n, 15n, 15n]);
    });

    it("cap each item independently at maxRelayFee", () => {
        // raw per item = 10 + amount*5000/10000; cap 100. [1000 -> 510 cap 100, 100 -> 60].
        const fees = computeBatchFees({
            relayCost: 10n,
            feeBps: 5000n,
            flatFee: 0n,
            amountOuts: [1000n, 100n],
            maxRelayFee: 100n,
        });
        expect(fees).toEqual([100n, 60n]);
    });

    it("throw InfeasibleBatchFee when any item cannot cover its own fee", () => {
        // Second item: fee = 10 + 0 = 10 > amountOut 5.
        expect(() =>
            computeBatchFees({
                relayCost: 10n,
                feeBps: 1000n,
                flatFee: 0n,
                amountOuts: [100n, 5n],
                maxRelayFee: 1000n,
            }),
        ).toThrow(InfeasibleBatchFee);
    });

    it("handle a single-item batch", () => {
        const fees = computeBatchFees({
            relayCost: 10n,
            feeBps: 1000n,
            flatFee: 0n,
            amountOuts: [100n],
            maxRelayFee: 1000n,
        });
        expect(fees).toEqual([20n]);
    });
});
