import { describe, expect, it } from "vitest";

import type { Address, YieldDeployment } from "../../../src/internal.js";
import {
    getYieldDeployment,
    isPpUsdcSymbol,
    isYieldToken,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    YIELD_DEPLOYMENTS,
} from "../../../src/internal.js";

const CHAIN = 11155111;
const FORK_MAP: Record<number, YieldDeployment> = { [CHAIN]: LOCAL_FORK_YIELD_DEPLOYMENT };

describe("Yield constants", () => {
    describe("YIELD_DEPLOYMENTS", () => {
        it("is empty by default (no public yield deployment yet)", () => {
            expect(Object.keys(YIELD_DEPLOYMENTS)).toHaveLength(0);
        });

        it("is frozen", () => {
            expect(Object.isFrozen(YIELD_DEPLOYMENTS)).toBe(true);
        });
    });

    describe("getYieldDeployment", () => {
        it("returns undefined for a chain with no deployment in the default map", () => {
            expect(getYieldDeployment(CHAIN)).toBeUndefined();
        });

        it("returns the deployment from a supplied map", () => {
            expect(getYieldDeployment(CHAIN, FORK_MAP)).toBe(LOCAL_FORK_YIELD_DEPLOYMENT);
        });

        it("returns undefined for an unknown chain in a supplied map", () => {
            expect(getYieldDeployment(1, FORK_MAP)).toBeUndefined();
        });
    });

    describe("isYieldToken", () => {
        it("matches the ppUSDC share token case-insensitively", () => {
            expect(isYieldToken(CHAIN, LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC, FORK_MAP)).toBe(true);
            expect(
                isYieldToken(CHAIN, LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC.toUpperCase(), FORK_MAP),
            ).toBe(true);
        });

        it("returns false for the underlying token", () => {
            expect(isYieldToken(CHAIN, LOCAL_FORK_YIELD_DEPLOYMENT.underlying, FORK_MAP)).toBe(
                false,
            );
        });

        it("returns false for an arbitrary address", () => {
            expect(
                isYieldToken(
                    CHAIN,
                    "0x0000000000000000000000000000000000000001" as Address,
                    FORK_MAP,
                ),
            ).toBe(false);
        });

        it("returns false when the chain has no deployment", () => {
            expect(isYieldToken(1, LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDC, FORK_MAP)).toBe(false);
        });
    });

    describe("isPpUsdcSymbol", () => {
        it("recognizes the share symbol case-insensitively", () => {
            expect(isPpUsdcSymbol("ppUSDC")).toBe(true);
            expect(isPpUsdcSymbol("PPUSDC")).toBe(true);
        });

        it("rejects other symbols", () => {
            expect(isPpUsdcSymbol("USDC")).toBe(false);
            expect(isPpUsdcSymbol("")).toBe(false);
        });
    });

    describe("LOCAL_FORK_YIELD_DEPLOYMENT", () => {
        it("has 18-decimal shares and 6-decimal USDC underlying", () => {
            expect(LOCAL_FORK_YIELD_DEPLOYMENT.ppUSDCDecimals).toBe(18);
            expect(LOCAL_FORK_YIELD_DEPLOYMENT.underlyingDecimals).toBe(6);
            expect(LOCAL_FORK_YIELD_DEPLOYMENT.underlyingSymbol).toBe("USDC");
        });
    });
});
