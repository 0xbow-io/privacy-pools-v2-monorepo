import { BadRequestException } from "@nestjs/common";

import { calculateBpsFee, calculateFlatFee, nativeToToken } from "./fee.calculations";
import { BPS, Wei } from "./unit.types";

// A native quote that makes nativeToToken an identity at 18 decimals:
// relayCost = relayPrice * den * 10^18 / num, with num = 10^18, den = 1 → relayCost = relayPrice.
const IDENTITY_QUOTE = { num: 10n ** 18n, den: 1n };
const DECIMALS = 18;

describe("capFee — zero sentinel + cost floor (H1 / R-H3)", () => {
    describe("calculateFlatFee", () => {
        it("treat maxRelayFee 0 as uncapped, never flooring the fee to 0", () => {
            // relayCost 10 + flatFee 5 = 15; maxRelayFee 0 = "no maximum" → 15, not 0.
            expect(calculateFlatFee(Wei(10n), 5n, Wei(0n))).toBe(15n);
        });

        it("cap the fee at a nonzero maxRelayFee above cost", () => {
            expect(calculateFlatFee(Wei(10n), 5n, Wei(12n))).toBe(12n);
        });

        it("return the uncapped fee when maxRelayFee exceeds it", () => {
            expect(calculateFlatFee(Wei(10n), 5n, Wei(100n))).toBe(15n);
        });

        it("throw when a nonzero maxRelayFee is below relayCost", () => {
            expect(() => calculateFlatFee(Wei(10n), 5n, Wei(5n))).toThrow(BadRequestException);
        });
    });

    describe("calculateBpsFee", () => {
        it("treat maxRelayFee 0 as uncapped on the bps path", () => {
            // relayCost 10 + bps(1000 * 1000 / 10000 = 100) = 110; maxRelayFee 0 → 110, not 0.
            expect(
                calculateBpsFee(Wei(1000n), BPS(1000n), IDENTITY_QUOTE, Wei(10n), Wei(0n), DECIMALS),
            ).toBe(110n);
        });

        it("throw when a nonzero maxRelayFee is below relayCost", () => {
            expect(() =>
                calculateBpsFee(Wei(1000n), BPS(1000n), IDENTITY_QUOTE, Wei(10n), Wei(5n), DECIMALS),
            ).toThrow(BadRequestException);
        });
    });
});

describe("nativeToToken — provider quote convention (num/den = whole-out per whole-in x1e18)", () => {
    // 1 ETH = 2500 USDT, USDT has 6 decimals. A relay costing 0.0002 ETH (2e14 wei)
    // is worth 0.5 USDT = 500_000 base units.
    const ETH_USD = 2500n;
    const RELAY_PRICE = Wei(2n * 10n ** 14n);
    const USDT_DECIMALS = 6;
    const EXPECTED_FEE = 500_000n;

    it("converts via a Curve-shaped quote (num = aggregated 1e18 rate, den = 1)", () => {
        const curveQuote = { num: 10n ** 18n / ETH_USD, den: 1n };
        expect(nativeToToken(RELAY_PRICE, curveQuote, USDT_DECIMALS)).toBe(EXPECTED_FEE);
    });

    it("converts identically via a CowSwap-shaped quote (normalized raw trade amounts)", () => {
        // Selling 100 whole USDT (100e6 base units) buys 0.04 ETH (4e16 wei) at $2500,
        // normalized as in cowswap/quote_obtention.ts:
        // num = buyAmount * 10^inputDecimals * 1e18, den = sellAmount * 10^outputDecimals.
        const sellAmount = 100n * 10n ** 6n;
        const buyAmount = (100n * 10n ** 18n) / ETH_USD;
        const cowQuote = {
            num: buyAmount * 10n ** BigInt(USDT_DECIMALS) * 10n ** 18n,
            den: sellAmount * 10n ** 18n,
        };
        expect(nativeToToken(RELAY_PRICE, cowQuote, USDT_DECIMALS)).toBe(EXPECTED_FEE);
    });

    it("regression: a raw (un-normalized) CowSwap quote overcharged 6-decimal assets by 1e6", () => {
        const sellAmount = 100n * 10n ** 6n;
        const buyAmount = (100n * 10n ** 18n) / ETH_USD;
        const rawQuote = { num: buyAmount, den: sellAmount };
        expect(nativeToToken(RELAY_PRICE, rawQuote, USDT_DECIMALS)).toBe(EXPECTED_FEE * 10n ** 6n);
    });
});
