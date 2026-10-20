import { describe, expect, it } from "vitest";

import {
    computeViewTag,
    encodeViewTagAsMetadata,
    StealthAddressDeriveError,
    VIEW_TAG_BYTES,
} from "../../../src/stealth/index.js";

describe("viewTag (STLTH-09, STLTH-12)", () => {
    it("STLTH-09: VIEW_TAG_BYTES is exactly 1", () => {
        expect(VIEW_TAG_BYTES).toBe(1);
    });

    it("NEGATIVE-09: computeViewTag rejects inputs that are not 32 bytes", () => {
        expect(() => computeViewTag(new Uint8Array(31))).toThrow(StealthAddressDeriveError);
        expect(() => computeViewTag(new Uint8Array(33))).toThrow(StealthAddressDeriveError);
        expect(() => computeViewTag(new Uint8Array(0))).toThrow(StealthAddressDeriveError);
        expect(() => computeViewTag(new Uint8Array(64))).toThrow(StealthAddressDeriveError);
    });

    it("computeViewTag returns the FIRST byte of the input (STLTH-09 first-byte convention)", () => {
        const buf = new Uint8Array(32);
        buf[0] = 0xab;
        buf[1] = 0xcd;
        expect(computeViewTag(buf)).toBe(0xab);
    });

    it('encodeViewTagAsMetadata: 1 byte = exactly 4 chars ("0x" + 2 hex)', () => {
        expect(encodeViewTagAsMetadata(0).length).toBe(4);
        expect(encodeViewTagAsMetadata(0xff).length).toBe(4);
        expect(encodeViewTagAsMetadata(0)).toBe("0x00");
        expect(encodeViewTagAsMetadata(0xab)).toBe("0xab");
        expect(encodeViewTagAsMetadata(0xff)).toBe("0xff");
    });

    it("NEGATIVE-09: encodeViewTagAsMetadata rejects out-of-range values", () => {
        expect(() => encodeViewTagAsMetadata(-1)).toThrow(StealthAddressDeriveError);
        expect(() => encodeViewTagAsMetadata(256)).toThrow(StealthAddressDeriveError);
        expect(() => encodeViewTagAsMetadata(1.5)).toThrow(StealthAddressDeriveError);
        expect(() => encodeViewTagAsMetadata(Number.NaN)).toThrow(StealthAddressDeriveError);
    });
});
