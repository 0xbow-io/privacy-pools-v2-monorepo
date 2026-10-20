import { describe, expect, it } from "vitest";

import type { Address, ErrorAmounts, Hex, YieldSwapWrapper } from "../../../src/internal.js";
import {
    assertLifiBudget,
    AssetNotRelayable,
    DepositBelowMinimum,
    hasErrorAmounts,
    InfeasibleBatchFee,
    InsufficientChangeValueForFee,
    InsufficientTransactValue,
    InvalidTransactParams,
    InvalidYieldAmount,
    previewRedeemNet,
    RelayFeeExceedsMax,
} from "../../../src/internal.js";

/**
 * The structured `amounts` are additive: an embedder that ignores them must keep seeing the
 * exact sentence it saw before. So every case here pins the message BYTE-FOR-BYTE next to the
 * payload — a test that only checked the payload would let a reworded message through, and
 * rewording is precisely what breaks the consumers that regex these strings today.
 *
 * `side` is asserted too. It is not recoverable from the numbers, and a wrong one prints a
 * correct figure under the wrong ticker (a relay fee under the swap's OUTPUT token, say),
 * which reads as a real balance to the user and is worse than showing raw base units.
 */

/** The payload, insisting the error actually carries one. */
function amountsOf(error: unknown): ErrorAmounts {
    expect(hasErrorAmounts(error)).toBe(true);
    return (error as Error & { amounts: ErrorAmounts }).amounts;
}

/** The error a rejected promise settles with, so both message and payload can be checked. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        () => expect.fail("expected the promise to reject"),
        (error: unknown) => error,
    );
}

describe("hasErrorAmounts", () => {
    it("reject non-errors and errors without a payload", () => {
        expect(hasErrorAmounts(undefined)).toBe(false);
        expect(hasErrorAmounts("Deposit value 1 is below the Entrypoint minimum 2")).toBe(false);
        expect(hasErrorAmounts(new Error("plain"))).toBe(false);
        // A generic reason carries no figures, so the field stays absent rather than empty.
        expect(hasErrorAmounts(new InvalidTransactParams("recipient is the zero address"))).toBe(
            false,
        );
        expect(hasErrorAmounts(new InvalidYieldAmount("value must be > 0, got 0"))).toBe(false);
    });

    it("reject a payload whose side is not one of the two denominations", () => {
        const error = Object.assign(new Error("hand-rolled"), {
            amounts: { code: "depositBelowMinimum", side: "output", values: {} },
        });
        expect(hasErrorAmounts(error)).toBe(false);
    });

    it("narrow a real SDK error", () => {
        const error: unknown = new DepositBelowMinimum("1", "2");
        expect(hasErrorAmounts(error)).toBe(true);
        if (hasErrorAmounts(error)) expect(error.amounts.values.value).toBe(1n);
    });
});

describe("error classes carrying amounts", () => {
    it("DepositBelowMinimum reports the destination pool's token", () => {
        const error = new DepositBelowMinimum("4765396938345822042", "10000000000000000000");
        expect(error.message).toBe(
            "Deposit value 4765396938345822042 is below the Entrypoint minimum 10000000000000000000",
        );
        expect(error.amounts).toEqual({
            code: "depositBelowMinimum",
            side: "received",
            values: { value: 4765396938345822042n, minimum: 10000000000000000000n },
        });
    });

    it("InsufficientTransactValue reports the notes being spent", () => {
        const error = new InsufficientTransactValue("500", "900");
        expect(error.message).toBe("Insufficient value for transact: available=500, requested=900");
        expect(error.amounts).toEqual({
            code: "insufficientTransactValue",
            side: "spent",
            values: { available: 500n, requested: 900n },
        });
    });

    it("InsufficientChangeValueForFee reports the change and the fee", () => {
        const error = new InsufficientChangeValueForFee("10", "25");
        expect(error.message).toBe(
            "Insufficient change value to cover fee: totalChange=10, fee=25",
        );
        expect(error.amounts).toEqual({
            code: "insufficientChangeForFee",
            side: "spent",
            values: { totalChange: 10n, fee: 25n },
        });
    });

    it("RelayFeeExceedsMax reports the withdrawn asset, not a swap output", () => {
        const error = new RelayFeeExceedsMax("2100", "2000");
        expect(error.message).toBe(
            "Relayer fee 2100 exceeds the Entrypoint maxRelayFee 2000 — execution would revert",
        );
        expect(error.amounts).toEqual({
            code: "relayFeeExceedsMax",
            side: "spent",
            values: { fee: 2100n, maxRelayFee: 2000n },
        });
    });

    it("InfeasibleBatchFee reports the item's own fee and amount", () => {
        const error = new InfeasibleBatchFee("300", "250");
        expect(error.message).toBe("Item fee 300 exceeds its withdrawn amount 250");
        expect(error.amounts).toEqual({
            code: "infeasibleBatchFee",
            side: "spent",
            values: { fee: 300n, amountOut: 250n },
        });
    });

    it("AssetNotRelayable reports the cap and the relay cost", () => {
        const error = new AssetNotRelayable("100", "180");
        expect(error.message).toBe(
            "Asset not relayable: maxRelayFee 100 is below the relay cost 180",
        );
        expect(error.amounts).toEqual({
            code: "assetNotRelayable",
            side: "spent",
            values: { maxRelayFee: 100n, relayCost: 180n },
        });
    });
});

describe("generic errors keep their existing single-argument behaviour", () => {
    it("build the same message with and without a payload", () => {
        const reason = "LiFi needs 10 input but only 9 available after fee.";
        const withAmounts = new InvalidTransactParams(reason, {
            code: "lifiInputExceedsNet",
            side: "spent",
            values: { required: 10n, available: 9n },
        });
        expect(new InvalidTransactParams(reason).message).toBe(withAmounts.message);
        expect(new InvalidTransactParams(reason).amounts).toBeUndefined();
        expect(withAmounts.amounts?.code).toBe("lifiInputExceedsNet");

        const yieldReason = "budget 3 buys no shares at the current rate";
        const yieldWith = new InvalidYieldAmount(yieldReason, {
            code: "invalidYieldAmount",
            side: "spent",
            values: { quote: 4n, budget: 3n },
        });
        expect(new InvalidYieldAmount(yieldReason).message).toBe(yieldWith.message);
        expect(new InvalidYieldAmount(yieldReason).amounts).toBeUndefined();
    });
});

describe("assertLifiBudget", () => {
    // amount = 100000, fee = 100 → net = 99900, maxDust = net * 300 / 10000 = 2997.
    const AMOUNT = "0x186a0" as Hex;
    const FEE = "100";

    it("carry the required and available swap input when the input exceeds the net", () => {
        let thrown: unknown;
        try {
            assertLifiBudget("99901", AMOUNT, FEE);
        } catch (error) {
            thrown = error;
        }
        expect((thrown as Error).message).toBe(
            "Invalid transact params: LiFi needs 99901 input but only 99900 available after fee. Reduce the amount or retry.",
        );
        expect(amountsOf(thrown)).toEqual({
            code: "lifiInputExceedsNet",
            side: "spent",
            values: { required: 99901n, available: 99900n },
        });
    });

    it("carry the dust, the net, the input and the cap when the dust is over tolerance", () => {
        let thrown: unknown;
        try {
            assertLifiBudget("96000", AMOUNT, FEE);
        } catch (error) {
            thrown = error;
        }
        // dust = 99900 − 96000 = 3900, over the 2997 cap.
        expect((thrown as Error).message).toContain("Swap input dust 3900 (net 99900 −");
        expect(amountsOf(thrown)).toEqual({
            code: "swapInputDust",
            side: "spent",
            values: { dust: 3900n, net: 99900n, swapInput: 96000n, maxDust: 2997n },
        });
    });
});

describe("previewRedeemNet", () => {
    const SHARE = "0x1111111111111111111111111111111111111111" as Address;
    const UNDERLYING = "0x2222222222222222222222222222222222222222" as Address;

    it("carry only the share figure, the underlying being zero by construction", async () => {
        const wrapper: YieldSwapWrapper = {
            shareToken: SHARE,
            underlying: UNDERLYING,
            previewRedeem: async () => 0n,
        } as YieldSwapWrapper;

        const thrown = await rejection(previewRedeemNet(wrapper, 7n));
        expect((thrown as Error).message).toBe(
            `Invalid transact params: 7 shares of ${SHARE} redeem to 0 ${UNDERLYING} — withdraw a larger amount`,
        );
        expect(amountsOf(thrown)).toEqual({
            code: "yieldRedeemsToNothing",
            side: "spent",
            values: { shares: 7n },
        });
    });
});
