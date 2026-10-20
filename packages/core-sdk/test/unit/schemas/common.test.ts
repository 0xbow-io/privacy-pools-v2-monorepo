import { describe, expect, it } from "vitest";

import { DecimalRepresentationToHexSchema } from "../../../src/internal.js";

describe("DecimalRepresentationToHexSchema", () => {
    it("convert decimal string '0' to 64-char-padded zero hex", () => {
        const result = DecimalRepresentationToHexSchema.parse("0");
        expect(result).toBe(`0x${"0".repeat(64)}`);
    });

    it("convert decimal string '12345' to padded hex", () => {
        const result = DecimalRepresentationToHexSchema.parse("12345");
        expect(result).toBe(`0x${"0".repeat(60)}3039`);
    });

    it("preserve precision for decimals larger than 2^53", () => {
        const decimal = "10000000000000000000000000000000000";
        const expected = `0x${BigInt(decimal).toString(16).padStart(64, "0")}`;
        expect(DecimalRepresentationToHexSchema.parse(decimal)).toBe(expected);
    });

    it("accept already-hex strings and re-pad to 64 chars", () => {
        expect(DecimalRepresentationToHexSchema.parse("0x123")).toBe(`0x${"0".repeat(61)}123`);
    });

    it("accept plain numbers", () => {
        expect(DecimalRepresentationToHexSchema.parse(12345)).toBe(`0x${"0".repeat(60)}3039`);
    });

    it("reject numbers beyond the safe-integer range (precision already lost)", () => {
        // A 256-bit field arriving as a JSON number > 2^53 has already been rounded by the JSON
        // parser, so accepting it would produce a wrong commitment that never matches local state.
        expect(() => DecimalRepresentationToHexSchema.parse(2 ** 53)).toThrow();
        expect(() => DecimalRepresentationToHexSchema.parse(1e30)).toThrow();
    });

    it("still accept the largest safe integer", () => {
        expect(() => DecimalRepresentationToHexSchema.parse(Number.MAX_SAFE_INTEGER)).not.toThrow();
    });

    it("reject negative numbers", () => {
        expect(() => DecimalRepresentationToHexSchema.parse(-1)).toThrow();
    });

    it("reject negative decimal strings", () => {
        expect(() => DecimalRepresentationToHexSchema.parse("-5")).toThrow();
    });

    it("reject non-numeric strings", () => {
        expect(() => DecimalRepresentationToHexSchema.parse("abc")).toThrow();
    });

    it("reject empty string", () => {
        expect(() => DecimalRepresentationToHexSchema.parse("")).toThrow();
    });

    it("reject null", () => {
        expect(() => DecimalRepresentationToHexSchema.parse(null)).toThrow();
    });
});
