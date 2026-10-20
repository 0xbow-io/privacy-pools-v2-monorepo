import { describe, expect, it } from "vitest";

import {
    canonicalTokenAddress,
    EMPTY_ADDRESS,
    isSameToken,
    LIFI_NATIVE_TOKEN_ADDRESS,
    NATIVE_ASSET_ADDRESS,
} from "../../../src/internal.js";

const USDC = "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85";
const USDT = "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58";

describe("isSameToken", () => {
    it("treats Privacy Pools' native sentinel and LiFi's zero address as one token", () => {
        // The exact shape of the field failure: request said 0xEeee…, LiFi echoed 0x0000….
        expect(isSameToken(NATIVE_ASSET_ADDRESS, LIFI_NATIVE_TOKEN_ADDRESS)).toBe(true);
        expect(isSameToken(LIFI_NATIVE_TOKEN_ADDRESS, NATIVE_ASSET_ADDRESS)).toBe(true);
        expect(LIFI_NATIVE_TOKEN_ADDRESS).toBe(EMPTY_ADDRESS);
    });

    it("is case-insensitive", () => {
        expect(isSameToken(USDC.toLowerCase(), USDC.toUpperCase().replace("0X", "0x"))).toBe(true);
        expect(isSameToken(NATIVE_ASSET_ADDRESS.toLowerCase(), NATIVE_ASSET_ADDRESS)).toBe(true);
    });

    it("keeps a real ERC20 answered with the zero address a mismatch", () => {
        expect(isSameToken(USDC, EMPTY_ADDRESS)).toBe(false);
        expect(isSameToken(EMPTY_ADDRESS, USDC)).toBe(false);
    });

    it("keeps native answered with some other token a mismatch", () => {
        expect(isSameToken(NATIVE_ASSET_ADDRESS, USDT)).toBe(false);
    });

    it("keeps two different ERC20s a mismatch", () => {
        expect(isSameToken(USDC, USDT)).toBe(false);
    });
});

describe("canonicalTokenAddress", () => {
    it("rewrites LiFi's zero-address spelling of native to NATIVE_ASSET_ADDRESS", () => {
        expect(canonicalTokenAddress(LIFI_NATIVE_TOKEN_ADDRESS)).toBe(NATIVE_ASSET_ADDRESS);
        expect(canonicalTokenAddress(EMPTY_ADDRESS)).toBe(NATIVE_ASSET_ADDRESS);
    });

    it("leaves NATIVE_ASSET_ADDRESS as-is (any case)", () => {
        expect(canonicalTokenAddress(NATIVE_ASSET_ADDRESS)).toBe(NATIVE_ASSET_ADDRESS);
        expect(canonicalTokenAddress(NATIVE_ASSET_ADDRESS.toLowerCase())).toBe(
            NATIVE_ASSET_ADDRESS,
        );
    });

    it("passes a real ERC20 through unchanged", () => {
        expect(canonicalTokenAddress(USDC)).toBe(USDC);
        expect(canonicalTokenAddress(USDT)).toBe(USDT);
    });
});
