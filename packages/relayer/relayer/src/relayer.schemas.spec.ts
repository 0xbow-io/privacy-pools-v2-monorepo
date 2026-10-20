import { zNonNegativeBigInt } from "./relayer.schemas";

// Precision-safety contract of the shared bigint schema: a JSON number above
// Number.MAX_SAFE_INTEGER is rounded by the JSON parser before zod sees it, so
// the schema must reject unsafe numbers instead of silently coercing the
// corrupted value; large amounts travel as strings and round-trip exactly.
describe("zNonNegativeBigInt", () => {
    it("parses a decimal string above MAX_SAFE_INTEGER to the exact bigint", () => {
        expect(zNonNegativeBigInt.parse("9007199254740993")).toBe(9007199254740993n);
        expect(zNonNegativeBigInt.parse("123456789012345678901234567890")).toBe(123456789012345678901234567890n);
    });

    it("parses a 0x-hex string to the exact bigint (snarkjs proof wire format)", () => {
        expect(zNonNegativeBigInt.parse("0x11")).toBe(17n);
        expect(zNonNegativeBigInt.parse("0xffffffffffffffffffffffffffffffff")).toBe(
            0xffffffffffffffffffffffffffffffffn
        );
    });

    it("accepts a safe non-negative JS integer", () => {
        expect(zNonNegativeBigInt.parse(0)).toBe(0n);
        expect(zNonNegativeBigInt.parse(Number.MAX_SAFE_INTEGER)).toBe(9007199254740991n);
    });

    it("rejects a JS number above MAX_SAFE_INTEGER (already rounded by JSON.parse)", () => {
        expect(zNonNegativeBigInt.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
        expect(zNonNegativeBigInt.safeParse(2 ** 60).success).toBe(false);
    });

    it("rejects non-integer and negative numbers", () => {
        expect(zNonNegativeBigInt.safeParse(1.5).success).toBe(false);
        expect(zNonNegativeBigInt.safeParse(-1).success).toBe(false);
    });

    it("rejects malformed strings as a validation issue, not an uncaught BigInt RangeError", () => {
        expect(zNonNegativeBigInt.safeParse("abc").success).toBe(false);
        expect(zNonNegativeBigInt.safeParse("1.5").success).toBe(false);
        expect(zNonNegativeBigInt.safeParse("1e18").success).toBe(false);
        expect(zNonNegativeBigInt.safeParse("-5").success).toBe(false);
        expect(zNonNegativeBigInt.safeParse("").success).toBe(false);
    });
});
