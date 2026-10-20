import { zEvmAssetConfig } from "./evm.config.schemas";
import { RateProvider } from "../../rate_provider/rate_types";

describe("zEvmAssetConfig — required token decimals (R-C2)", () => {
    const base = {
        address: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
        ticker: "USDC",
        quoter: RateProvider.CURVE,
    };

    it("fails loudly when decimals is missing (no silent default)", () => {
        expect(() => zEvmAssetConfig.parse(base)).toThrow();
    });

    it("coerces a string decimals to a number", () => {
        const parsed = zEvmAssetConfig.parse({ ...base, decimals: "6" });
        expect(parsed.decimals).toBe(6);
    });

    it("accepts a numeric decimals", () => {
        const parsed = zEvmAssetConfig.parse({ ...base, decimals: 18 });
        expect(parsed.decimals).toBe(18);
    });

    it("rejects an empty string instead of coercing it to 0", () => {
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: "" })).toThrow();
    });

    it("rejects a non-decimal string (hex / scientific / whitespace)", () => {
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: "0x10" })).toThrow();
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: "1e3" })).toThrow();
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: "  " })).toThrow();
    });

    it("rejects decimals above the ERC-20 uint8 range", () => {
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: 256 })).toThrow();
        expect(() => zEvmAssetConfig.parse({ ...base, decimals: "256" })).toThrow();
    });
});
