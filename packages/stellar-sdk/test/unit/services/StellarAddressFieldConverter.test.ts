import { describe, expect, it } from "vitest";

import { StellarAddressFieldConverter, StellarCryptoService } from "../../../src/internal.js";

const converter = new StellarAddressFieldConverter();

describe("StellarAddressFieldConverter", () => {
    describe("toField", () => {
        it("match the on-chain address_to_field computation for a known StrKey address", () => {
            // Same ground-truth vector as StellarCryptoService.stellarAddressToField's own test —
            // computed directly against the reference implementation's addressToField().
            const field = converter.toField(
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            expect(BigInt(field)).toBe(
                2546882737937671087797865303492133949014456605657702609113996756825541318677n,
            );
        });

        it("stay in lockstep with StellarCryptoService.stellarAddressToField", () => {
            const cryptoService = new StellarCryptoService();
            const address = "GCKFBEIYTKP74Q7WQL5D7Y5FYCM6PFMTM3JOKGKQXXTVJNW2WKQ5MKJH";
            expect(converter.toField(address)).toBe(cryptoService.stellarAddressToField(address));
        });

        it("return different field elements for different addresses", () => {
            const a = converter.toField(
                "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            );
            const b = converter.toField(
                "GCKFBEIYTKP74Q7WQL5D7Y5FYCM6PFMTM3JOKGKQXXTVJNW2WKQ5MKJH",
            );
            expect(a).not.toBe(b);
        });
    });
});
