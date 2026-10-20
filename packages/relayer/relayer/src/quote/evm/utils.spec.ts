import { getAddressFromBigInt } from "./utils";

describe("getAddressFromBigInt", () => {
    it("converts a bigint to a checksummed address", () => {
        const address = BigInt("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
        expect(getAddressFromBigInt(address)).toBe("0xaf88d065e77c8cC2239327C5EDb3A432268e5831");
    });

    it("pads addresses with leading zero bytes to 20 bytes (regression: Optimism USDC)", () => {
        // 0x0b... — toString(16) yields 39 hex chars; without padStart viem's
        // getAddress rejects it as a 19.5-byte value.
        const opUsdc = BigInt("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
        expect(getAddressFromBigInt(opUsdc)).toBe("0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85");
    });

    it("pads the zero address", () => {
        expect(getAddressFromBigInt(0n)).toBe("0x0000000000000000000000000000000000000000");
    });
});
