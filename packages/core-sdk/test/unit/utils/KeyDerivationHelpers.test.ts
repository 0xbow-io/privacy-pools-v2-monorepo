import { describe, expect, it } from "vitest";

import {
    BN254_SCALAR_MODULUS,
    bytesToBigIntBE,
    clampToCurve25519,
    CryptoServiceBaseError,
    reduceToBN254Scalar,
    u64beCounter,
} from "../../../src/internal.js";

describe("KeyDerivationHelpers", () => {
    describe("bytesToBigIntBE", () => {
        it("return 0n for an all-zero byte array", () => {
            expect(bytesToBigIntBE(new Uint8Array(4))).toBe(0n);
        });

        it("interpret bytes as big-endian unsigned integer", () => {
            // [0x01, 0x00] = 256
            expect(bytesToBigIntBE(new Uint8Array([0x01, 0x00]))).toBe(256n);
        });

        it("return 255n for a single byte 0xff", () => {
            expect(bytesToBigIntBE(new Uint8Array([0xff]))).toBe(255n);
        });

        it("return 0n for an empty array", () => {
            expect(bytesToBigIntBE(new Uint8Array(0))).toBe(0n);
        });
    });

    describe("u64beCounter", () => {
        it("encode 0n as 8 zero bytes", () => {
            expect(u64beCounter(0n)).toEqual(new Uint8Array(8));
        });

        it("encode 1n with LSB in last byte", () => {
            const result = u64beCounter(1n);
            expect(result[7]).toBe(1);
            expect(result.slice(0, 7)).toEqual(new Uint8Array(7));
        });

        it("encode 256n with 0x01 in second-to-last byte", () => {
            const result = u64beCounter(256n);
            expect(result[6]).toBe(1);
            expect(result[7]).toBe(0);
        });

        it("produce 8-byte output for any input", () => {
            expect(u64beCounter(0n)).toHaveLength(8);
            expect(u64beCounter(0xdeadbeefn)).toHaveLength(8);
        });
    });

    describe("bytesToBigIntBE / u64beCounter round-trip", () => {
        it("round-trip 0n", () => {
            expect(bytesToBigIntBE(u64beCounter(0n))).toBe(0n);
        });

        it("round-trip 1n", () => {
            expect(bytesToBigIntBE(u64beCounter(1n))).toBe(1n);
        });

        it("round-trip large value", () => {
            const n = 0xdeadbeefcafebaben;
            expect(bytesToBigIntBE(u64beCounter(n))).toBe(n);
        });
    });

    describe("reduceToBN254Scalar", () => {
        it("return 0x-prefixed 32-byte hex string", () => {
            const result = reduceToBN254Scalar(new Uint8Array(48));
            expect(result).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("accept zero result (all-zero input reduces to 0 mod p)", () => {
            const result = reduceToBN254Scalar(new Uint8Array(48));
            expect(result).toBe("0x" + "00".repeat(32));
        });

        it("reduce value equal to modulus to zero", () => {
            const bytes = new Uint8Array(48);
            let val = BN254_SCALAR_MODULUS;
            for (let i = 47; i >= 0; i--) {
                bytes[i] = Number(val & 0xffn);
                val >>= 8n;
            }
            const result = reduceToBN254Scalar(bytes);
            expect(result).toBe("0x" + "00".repeat(32));
        });

        it("reduce value of modulus+1 to 1", () => {
            const bytes = new Uint8Array(48);
            let val = BN254_SCALAR_MODULUS + 1n;
            for (let i = 47; i >= 0; i--) {
                bytes[i] = Number(val & 0xffn);
                val >>= 8n;
            }
            const result = reduceToBN254Scalar(bytes);
            expect(result).toBe("0x" + "00".repeat(31) + "01");
        });
    });

    describe("clampToCurve25519", () => {
        const clampedBytes = (input: Uint8Array): Uint8Array => {
            const hex = clampToCurve25519(input).slice(2);
            const out = new Uint8Array(32);
            for (let i = 0; i < 32; i++) {
                out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
            }
            return out;
        };

        it("return 0x-prefixed 32-byte hex string", () => {
            const result = clampToCurve25519(new Uint8Array(32).fill(0xff));
            expect(result).toMatch(/^0x[0-9a-f]{64}$/);
        });

        it("clear the three lowest bits of byte 0 (cofactor multiple)", () => {
            const out = clampedBytes(new Uint8Array(32).fill(0xff));
            expect(out[0] & 0x07).toBe(0);
        });

        it("clear the highest bit of byte 31 (scalar < 2^255)", () => {
            const out = clampedBytes(new Uint8Array(32).fill(0xff));
            expect(out[31] & 0x80).toBe(0);
        });

        it("set the second-highest bit of byte 31 (scalar >= 2^254)", () => {
            const out = clampedBytes(new Uint8Array(32));
            expect(out[31] & 0x40).toBe(0x40);
        });

        it("produce non-zero scalar even for zero input (high bit guarantee)", () => {
            const result = clampToCurve25519(new Uint8Array(32));
            expect(BigInt(result)).toBeGreaterThan(0n);
        });

        it("be idempotent (clamping a clamped value yields the same bytes)", () => {
            const once = clampedBytes(new Uint8Array(32).fill(0x5a));
            const twice = clampedBytes(once);
            expect(twice).toEqual(once);
        });

        it("not mutate the input buffer", () => {
            const input = new Uint8Array(32).fill(0xff);
            const snapshot = new Uint8Array(input);
            clampToCurve25519(input);
            expect(input).toEqual(snapshot);
        });

        it("throw CryptoServiceBaseError when input is not 32 bytes", () => {
            expect(() => clampToCurve25519(new Uint8Array(31))).toThrow(CryptoServiceBaseError);
            expect(() => clampToCurve25519(new Uint8Array(33))).toThrow(CryptoServiceBaseError);
        });
    });
});
