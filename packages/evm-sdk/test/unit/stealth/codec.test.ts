import { describe, expect, it } from "vitest";

import type { Hex } from "../../../src/stealth/index.js";
import { StealthAddressDeriveError } from "../../../src/stealth/errors.js";
import {
    asCompressedPubKey,
    asEvmAddress,
    asScalar32,
    asUncompressedPubKey,
    bigIntToBytes,
    bytesToBigInt,
    bytesToHex,
    hexToBytes,
} from "../../../src/stealth/internal/codec.js";

describe("internal/codec.ts: strict hex decoder + typed brand casts", () => {
    it("CODEC-02 regression: hexToBytes rejects invalid characters even when parseInt would coerce", () => {
        // Number.parseInt('1g', 16) returns 1, not NaN - this is what the
        // v2 audit caught. The v3 regex pre-validates before parseInt.
        expect(() => hexToBytes("0x1g")).toThrow(StealthAddressDeriveError);
        expect(() => hexToBytes("0xzz")).toThrow(StealthAddressDeriveError);
        expect(() => hexToBytes("0x1!")).toThrow(StealthAddressDeriveError);
    });

    it("hexToBytes rejects odd-length, empty, and non-string inputs", () => {
        expect(() => hexToBytes("0x1")).toThrow(StealthAddressDeriveError);
        expect(() => hexToBytes("0x")).toThrow(StealthAddressDeriveError);
        expect(() => hexToBytes("")).toThrow(StealthAddressDeriveError);
        // @ts-expect-error testing runtime guard
        expect(() => hexToBytes(null)).toThrow(StealthAddressDeriveError);
    });

    it("hexToBytes accepts valid hex with and without 0x prefix", () => {
        expect(hexToBytes("0xab")).toEqual(new Uint8Array([0xab]));
        expect(hexToBytes("ab")).toEqual(new Uint8Array([0xab]));
        expect(hexToBytes("0xAB")).toEqual(new Uint8Array([0xab]));
    });

    it("bytesToHex round-trips with hexToBytes", () => {
        const bytes = new Uint8Array([0x01, 0xff, 0xab, 0x00, 0xde, 0xad, 0xbe, 0xef]);
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes);
    });

    it("bytesToBigInt + bigIntToBytes round-trip", () => {
        const big = (1n << 200n) | 0xdeadbeefn;
        const bytes = bigIntToBytes(big, 32);
        expect(bytes.length).toBe(32);
        expect(bytesToBigInt(bytes)).toBe(big);
    });

    it("bigIntToBytes refuses overflow", () => {
        expect(() => bigIntToBytes(1n << 256n, 32)).toThrow(StealthAddressDeriveError);
    });

    it("asScalar32 enforces 32-byte width", () => {
        const valid = ("0x" + "aa".repeat(32)) as Hex;
        expect(asScalar32(valid).length).toBe(66);
        const tooShort = ("0x" + "aa".repeat(31)) as Hex;
        expect(() => asScalar32(tooShort)).toThrow(StealthAddressDeriveError);
    });

    it("asEvmAddress enforces 20-byte width and lowercases", () => {
        const upper = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12" as Hex;
        const addr = asEvmAddress(upper);
        expect(addr).toBe("0xabcdef1234567890abcdef1234567890abcdef12");
        expect(() => asEvmAddress("0xab" as Hex)).toThrow(StealthAddressDeriveError);
    });

    it("asCompressedPubKey enforces 33 bytes and 0x02/0x03 prefix", () => {
        const ok = ("0x02" + "aa".repeat(32)) as Hex;
        expect(asCompressedPubKey(ok).length).toBe(68);
        const wrongPrefix = ("0x04" + "aa".repeat(32)) as Hex;
        expect(() => asCompressedPubKey(wrongPrefix)).toThrow(StealthAddressDeriveError);
        const wrongLength = ("0x02" + "aa".repeat(31)) as Hex;
        expect(() => asCompressedPubKey(wrongLength)).toThrow(StealthAddressDeriveError);
    });

    it("asUncompressedPubKey enforces 65 bytes and 0x04 prefix", () => {
        const ok = ("0x04" + "aa".repeat(64)) as Hex;
        expect(asUncompressedPubKey(ok).length).toBe(132);
        const wrongPrefix = ("0x02" + "aa".repeat(64)) as Hex;
        expect(() => asUncompressedPubKey(wrongPrefix)).toThrow(StealthAddressDeriveError);
        const wrongLength = ("0x04" + "aa".repeat(63)) as Hex;
        expect(() => asUncompressedPubKey(wrongLength)).toThrow(StealthAddressDeriveError);
    });

    it("CODEC-03 regression: brand validators reject non-hex body chars", () => {
        // v3 validators only checked width + prefix; an input like
        // `0x04` + 'zz'.repeat(64) was accepted and garbage flowed downstream.
        // v4 validators now check the body is hex.
        expect(() => asUncompressedPubKey(("0x04" + "zz".repeat(64)) as Hex)).toThrow(
            StealthAddressDeriveError,
        );
        expect(() => asScalar32(("0x" + "gg".repeat(32)) as Hex)).toThrow(
            StealthAddressDeriveError,
        );
        expect(() => asEvmAddress(("0x" + "!!".repeat(20)) as Hex)).toThrow(
            StealthAddressDeriveError,
        );
        expect(() => asCompressedPubKey(("0x02" + "qq".repeat(32)) as Hex)).toThrow(
            StealthAddressDeriveError,
        );
    });

    it("CODEC-04 regression: brand validators reject unprefixed hex", () => {
        // v3 validators accepted unprefixed input; the brands' JSDoc said
        // "0x-prefixed lowercase hex" but the runtime never enforced it.
        const noPrefix32 = "aa".repeat(32) as Hex;
        expect(() => asScalar32(noPrefix32)).toThrow(StealthAddressDeriveError);
        const noPrefix20 = "aa".repeat(20) as Hex;
        expect(() => asEvmAddress(noPrefix20)).toThrow(StealthAddressDeriveError);
        const noPrefix33 = ("02" + "aa".repeat(32)) as Hex;
        expect(() => asCompressedPubKey(noPrefix33)).toThrow(StealthAddressDeriveError);
        const noPrefix65 = ("04" + "aa".repeat(64)) as Hex;
        expect(() => asUncompressedPubKey(noPrefix65)).toThrow(StealthAddressDeriveError);
    });

    it("asScalar32 lowercases the brand value", () => {
        // v4: all validators canonicalize to lowercase so downstream byte-equal
        // comparisons cannot accidentally fail on a checksummed input.
        const mixed = ("0xAABBccDDee" + "00".repeat(27)) as Hex;
        const s = asScalar32(mixed);
        expect(s as unknown as string).toBe(mixed.toLowerCase());
    });
});
