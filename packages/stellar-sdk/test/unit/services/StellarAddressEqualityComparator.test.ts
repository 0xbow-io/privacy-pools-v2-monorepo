import { describe, expect, it } from "vitest";

import { StellarAddressEqualityComparator } from "../../../src/internal.js";

const comparator = new StellarAddressEqualityComparator();

describe("StellarAddressEqualityComparator", () => {
    describe("equals", () => {
        it("return true for identical StrKey addresses", () => {
            const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
            expect(comparator.equals(address, address)).toBe(true);
        });

        it("return false for different StrKey addresses", () => {
            expect(
                comparator.equals(
                    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
                    "GCKFBEIYTKP74Q7WQL5D7Y5FYCM6PFMTM3JOKGKQXXTVJNW2WKQ5MKJH",
                ),
            ).toBe(false);
        });

        it("treat case as significant, unlike EVM's checksum-insensitive comparison", () => {
            const address = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
            expect(comparator.equals(address, address.toLowerCase())).toBe(false);
        });
    });
});
