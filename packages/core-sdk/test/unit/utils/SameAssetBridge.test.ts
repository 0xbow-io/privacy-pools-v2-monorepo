import { describe, expect, it } from "vitest";

import { capBridgeOutputToInput, isSameAssetBridgeQuote } from "../../../src/internal.js";

describe("isSameAssetBridgeQuote", () => {
    it("recognise the same asset on two chains, case-insensitively", () => {
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "usdc",
                fromTokenDecimals: 6,
                toTokenDecimals: 6,
            }),
        ).toBe(true);
    });

    it("reject different assets even when the decimals match", () => {
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "USDT",
                fromTokenDecimals: 6,
                toTokenDecimals: 6,
            }),
        ).toBe(false);
    });

    it("reject the same symbol with different decimals", () => {
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "USDC",
                fromTokenDecimals: 6,
                toTokenDecimals: 18,
            }),
        ).toBe(false);
    });

    it("report unproven as false when the provider reports no metadata", () => {
        expect(isSameAssetBridgeQuote({})).toBe(false);
        expect(isSameAssetBridgeQuote({ fromTokenSymbol: "USDC", toTokenSymbol: "USDC" })).toBe(
            false,
        );
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "USDC",
                fromTokenDecimals: 6,
            }),
        ).toBe(false);
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "",
                toTokenSymbol: "",
                fromTokenDecimals: 6,
                toTokenDecimals: 6,
            }),
        ).toBe(false);
    });

    it("reject non-integer decimals", () => {
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "USDC",
                fromTokenDecimals: 6.5,
                toTokenDecimals: 6.5,
            }),
        ).toBe(false);
        expect(
            isSameAssetBridgeQuote({
                fromTokenSymbol: "USDC",
                toTokenSymbol: "USDC",
                fromTokenDecimals: Number.NaN,
                toTokenDecimals: Number.NaN,
            }),
        ).toBe(false);
    });
});

const SAME_ASSET = {
    fromTokenSymbol: "USDC",
    toTokenSymbol: "USDC",
    fromTokenDecimals: 6,
    toTokenDecimals: 6,
};
const CROSS_ASSET = {
    fromTokenSymbol: "USDC",
    toTokenSymbol: "ETH",
    fromTokenDecimals: 6,
    toTokenDecimals: 18,
};

describe("capBridgeOutputToInput", () => {
    it("bound an incentivised same-asset bridge to the input", () => {
        // 1.000000 USDC in, a bridge quoting 1.030000 USDC out.
        expect(capBridgeOutputToInput(1_030_000n, 1_000_000n, SAME_ASSET)).toBe(1_000_000n);
    });

    it("leave an ordinary same-asset bridge alone", () => {
        expect(capBridgeOutputToInput(999_000n, 1_000_000n, SAME_ASSET)).toBe(999_000n);
    });

    it("never compare across assets (the unit-mixing regression)", () => {
        // 19.976730 USDC (6dp) in, 0.00788 ETH (18dp) out. The old unconditional
        // min() returned 19_976_730 wei — about 2e-11 ETH — and collapsed the
        // deposit to dust.
        const minOutputWei = 7_880_000_000_000_000n;
        expect(capBridgeOutputToInput(minOutputWei, 19_976_730n, CROSS_ASSET)).toBe(minOutputWei);
    });

    it("leave the output alone when the metadata does not prove a same-asset bridge", () => {
        // Unproven must never be read as "same asset": no ceiling is licensed.
        expect(capBridgeOutputToInput(1_030_000n, 1_000_000n, {})).toBe(1_030_000n);
    });

    it("bound an exactly-equal same-asset quote to itself", () => {
        expect(capBridgeOutputToInput(1_000_000n, 1_000_000n, SAME_ASSET)).toBe(1_000_000n);
    });
});
