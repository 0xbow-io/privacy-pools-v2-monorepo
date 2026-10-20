import { describe, expect, it } from "vitest";

import {
    ACROSS_RELAYER_GAS_HEADROOM_BPS,
    acrossFillHeadroomFor,
    acrossFillHeadroomInputFor,
    applyAcrossFillHeadroom,
    hasAcrossDestinationSwap,
    spliceAcrossFillHeadroom,
} from "../../../src/internal.js";
import type { AcrossTxOptions } from "../helpers/acrossTestCalldata.js";
import {
    acrossLegStep,
    acrossTx,
    BRIDGED_TOKEN,
    decodeAcrossTx,
    DEPOSIT_CALLDATA,
    DEST_TOKEN,
    dexSwap,
    ourCall,
    SRC_TOKEN,
    TX_FULL,
    TX_REDUCED,
} from "../helpers/acrossTestCalldata.js";

const E18 = 10n ** 18n;

function defined<T>(value: T | undefined): T {
    if (value === undefined) throw new Error("expected a value");
    return value;
}

describe("acrossFillHeadroomFor", () => {
    it("pay half the quoted relayer gas fee, in destination units at the leg's rate", () => {
        expect(ACROSS_RELAYER_GAS_HEADROOM_BPS).toBe(5_000n);
        // 20_000 gas fee * (990_000 / 1_000_000) * 50%
        expect(acrossFillHeadroomFor([acrossLegStep(1_000_000n, 990_000n, 20_000n)])).toBe(9_900n);
    });

    it("size the input-side headroom against the step's own input", () => {
        // 20_000 * (2_000_000 / 1_000_000) * 50%
        expect(
            acrossFillHeadroomInputFor([acrossLegStep(1_000_000n, 990_000n, 20_000n)], 2_000_000n),
        ).toBe(20_000n);
    });

    it("size nothing without an Across leg, a gas fee, or a fee in the leg's input token", () => {
        expect(acrossFillHeadroomFor(undefined)).toBeUndefined();
        expect(
            acrossFillHeadroomFor([
                acrossLegStep(1_000_000n, 990_000n, 20_000n, BRIDGED_TOKEN, "stargateV2"),
            ]),
        ).toBeUndefined();
        expect(
            acrossFillHeadroomFor([acrossLegStep(1_000_000n, 990_000n, undefined)]),
        ).toBeUndefined();
        expect(
            acrossFillHeadroomFor([acrossLegStep(1_000_000n, 990_000n, 20_000n, SRC_TOKEN)]),
        ).toBeUndefined();
        expect(acrossFillHeadroomFor([acrossLegStep(0n, 990_000n, 20_000n)])).toBeUndefined();
        expect(
            acrossFillHeadroomInputFor([acrossLegStep(1_000_000n, 990_000n, undefined)], 1n),
        ).toBeUndefined();
    });
});

describe("applyAcrossFillHeadroom (bridge then deposit)", () => {
    it("lower the delivery and the deposit budget by the headroom", () => {
        const tx = acrossTx({
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            swaps: [ourCall(990_000n, BRIDGED_TOKEN)],
        });
        const patched = applyAcrossFillHeadroom(tx, DEPOSIT_CALLDATA, 9_900n);
        expect(patched?.destinationCallAmount).toBe(980_100n);
        const d = decodeAcrossTx(defined(patched).transactionData);
        expect(d.functionName).toBe("startBridgeTokensViaAcrossV4");
        expect(d.bridgeData.minAmount).toBe(1_000_000n);
        expect(d.across.outputAmount).toBe(980_100n);
        expect(d.payload.swaps).toHaveLength(1);
        expect(d.payload.swaps[0].fromAmount).toBe(980_100n);
        expect(d.payload.swaps[0].callData).toBe(DEPOSIT_CALLDATA);
    });

    it("scale the multiplier the facet recomputes the delivery from after source swaps", () => {
        const tx = acrossTx({
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            multiplier: (99n * E18) / 100n,
            sourceSwap: true,
            swaps: [ourCall(990_000n, BRIDGED_TOKEN)],
        });
        const patched = defined(applyAcrossFillHeadroom(tx, DEPOSIT_CALLDATA, 9_900n));
        const d = decodeAcrossTx(patched.transactionData);
        expect(d.functionName).toBe("swapAndStartBridgeTokensViaAcrossV4");
        // What the facet computes on chain must equal the encoded delivery.
        expect((d.bridgeData.minAmount * d.across.outputAmountMultiplier) / E18).toBe(
            d.across.outputAmount,
        );
        expect(d.across.outputAmount).toBe(980_100n);
        expect(patched.destinationCallAmount).toBe(980_100n);
        expect(d.payload.swaps[0].fromAmount).toBeLessThanOrEqual(d.across.outputAmount);
    });

    it("never let the deposit budget exceed the reduced delivery", () => {
        const tx = acrossTx({
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            swaps: [ourCall(985_000n, BRIDGED_TOKEN)],
        });
        const patched = defined(applyAcrossFillHeadroom(tx, DEPOSIT_CALLDATA, 9_900n));
        const d = decodeAcrossTx(patched.transactionData);
        expect(patched.destinationCallAmount).toBe(975_100n);
        expect(d.payload.swaps[0].fromAmount).toBeLessThanOrEqual(d.across.outputAmount);
    });

    it("leave the quote alone when it cannot be patched safely", () => {
        const direct = acrossTx({
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            swaps: [ourCall(990_000n, BRIDGED_TOKEN)],
        });
        expect(applyAcrossFillHeadroom(direct, DEPOSIT_CALLDATA, 0n)).toBeUndefined();
        expect(applyAcrossFillHeadroom(direct, DEPOSIT_CALLDATA, 990_000n)).toBeUndefined();
        expect(applyAcrossFillHeadroom("0x12345678", DEPOSIT_CALLDATA, 1n)).toBeUndefined();
        expect(applyAcrossFillHeadroom(direct, "0xfeedface", 1n)).toBeUndefined();
        const withSwap = acrossTx({
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            swaps: [dexSwap(990_000n), ourCall(985_000n)],
        });
        expect(applyAcrossFillHeadroom(withSwap, DEPOSIT_CALLDATA, 9_900n)).toBeUndefined();
        expect(hasAcrossDestinationSwap(withSwap, DEPOSIT_CALLDATA)).toBe(true);
        expect(hasAcrossDestinationSwap(direct, DEPOSIT_CALLDATA)).toBe(false);
        expect(hasAcrossDestinationSwap(withSwap, "0xfeedface")).toBe(false);
    });
});

describe("spliceAcrossFillHeadroom (bridge, destination swap, deposit)", () => {
    const full = (o: Partial<AcrossTxOptions> = {}) =>
        acrossTx({
            txId: TX_FULL,
            minAmount: 1_000_000n,
            outputAmount: 990_000n,
            multiplier: (99n * E18) / 100n,
            swaps: [dexSwap(990_000n), ourCall(985_000n)],
            ...o,
        });
    const reduced = (o: Partial<AcrossTxOptions> = {}) =>
        acrossTx({
            txId: TX_REDUCED,
            minAmount: 980_000n,
            outputAmount: 970_200n,
            multiplier: (99n * E18) / 100n,
            swaps: [dexSwap(970_200n), ourCall(965_000n)],
            ...o,
        });

    it("bridge the full input and deliver what LiFi built the reduced destination for", () => {
        const spliced = defined(spliceAcrossFillHeadroom(full(), reduced(), DEPOSIT_CALLDATA));
        expect(spliced.destinationCallAmount).toBe(965_000n);
        const d = decodeAcrossTx(spliced.transactionData);
        expect(d.bridgeData.minAmount).toBe(1_000_000n);
        expect(d.bridgeData.transactionId).toBe(TX_REDUCED);
        expect(d.payload.txId).toBe(TX_REDUCED);
        expect(d.across.outputAmount).toBe(970_200n);
        expect(d.payload.swaps.map((s) => s.fromAmount)).toEqual([970_200n, 965_000n]);
    });

    it("set the multiplier against the full input, rounded up, when there are source swaps", () => {
        const spliced = defined(
            spliceAcrossFillHeadroom(
                full({ sourceSwap: true }),
                reduced({ sourceSwap: true }),
                DEPOSIT_CALLDATA,
            ),
        );
        const d = decodeAcrossTx(spliced.transactionData);
        expect(d.sourceSwaps).toHaveLength(1);
        expect(d.sourceSwaps?.[0]?.fromAmount).toBe(1_000_000n);
        expect(d.bridgeData.minAmount).toBe(1_000_000n);
        const onChain = (d.bridgeData.minAmount * d.across.outputAmountMultiplier) / E18;
        expect(onChain).toBe(d.across.outputAmount);
        expect(onChain).toBeGreaterThanOrEqual(970_200n);
        expect(onChain).toBeLessThan(990_000n);
    });

    it.each<[string, Partial<AcrossTxOptions>]>([
        ["a different bridged token (BridgeData)", { bridgeSendingAsset: SRC_TOKEN }],
        ["a different Across input token", { acrossSendingAsset: SRC_TOKEN }],
        ["a different Across output token", { acrossReceivingAsset: DEST_TOKEN }],
        ["a different Across receiver", { acrossReceiver: SRC_TOKEN }],
        ["a different refund address", { refund: SRC_TOKEN }],
        ["a different fallback receiver", { payloadReceiver: SRC_TOKEN }],
        ["a different destination chain", { destinationChainId: 1n }],
        ["no destination call", { hasDestinationCall: false }],
        ["a payload id that disagrees with BridgeData", { payloadTxId: TX_FULL }],
        ["no gain for the filler", { outputAmount: 990_000n }],
        [
            "a delivery short of the destination swap",
            { swaps: [dexSwap(975_000n), ourCall(965_000n)] },
        ],
        ["a payload that does not end in our call", { swaps: [dexSwap(970_200n)] }],
    ])("refuse to combine with %s", (_, o) => {
        expect(spliceAcrossFillHeadroom(full(), reduced(o), DEPOSIT_CALLDATA)).toBeUndefined();
    });

    it("refuse when either quote is not an AcrossFacetV4 call", () => {
        expect(spliceAcrossFillHeadroom(full(), "0x12345678", DEPOSIT_CALLDATA)).toBeUndefined();
        expect(spliceAcrossFillHeadroom("0x12345678", reduced(), DEPOSIT_CALLDATA)).toBeUndefined();
    });
});
