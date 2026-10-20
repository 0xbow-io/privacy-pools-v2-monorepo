import { decodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import type { Address, IRPCInteractor } from "../../src/internal.js";
import {
    PP_YIELD_TOKEN_REDEEM_ABI,
    PPYieldTokenInteractor,
    ViemRPCInteractor,
} from "../../src/internal.js";

/**
 * LOCAL wrapper e2e — runs the real `PPYieldTokenInteractor` against a real `PPYieldToken` deployed
 * over a MOCK Aave pool on a local anvil node. **No Sepolia fork or RPC key required.**
 *
 * Gated on `YIELD_LOCAL_PPUSDC` (the deployed wrapper address); skips otherwise. To run it, use the
 * one-shot runner `packages/evm-sdk/scripts/yield-e2e/run-wrapper-local.sh`, which starts anvil, deploys
 * the wrapper (DeployLocalYield.s.sol), and invokes vitest with the address wired in.
 */

const PPUSDC = process.env.YIELD_LOCAL_PPUSDC as Address | undefined;
const RPC_URL = process.env.RPC_URL ?? "http://localhost:8545";

describe.skipIf(!PPUSDC)("PPYieldTokenInteractor (local deployed wrapper)", () => {
    let token: PPYieldTokenInteractor;

    beforeAll(() => {
        const rpc: IRPCInteractor = ViemRPCInteractor.create({ rpcUrl: RPC_URL });
        token = new PPYieldTokenInteractor({ rpcInteractor: rpc, contractAddress: PPUSDC! });
    });

    it("reads a live, positive exchange rate", async () => {
        expect(await token.exchangeRate()).toBeGreaterThan(0n);
    });

    it("previews a deposit (underlying -> shares)", async () => {
        const shares = await token.previewDeposit(1_000_000n); // 1 USDC (6dp)
        expect(shares).toBeGreaterThan(0n);
    });

    it("previews a redeem (shares -> underlying)", async () => {
        const assets = await token.previewRedeem(1_000_000_000_000_000_000n); // 1 ppUSDC (18dp)
        expect(assets).toBeGreaterThan(0n);
    });

    it("round-trips previewDeposit -> previewRedeem near 1:1 for the seeded wrapper", async () => {
        const shares = await token.previewDeposit(1_000_000n);
        const back = await token.previewRedeem(shares);
        // Fee-exclusive previews on a freshly-seeded vault: exact round-trip.
        expect(back).toBe(1_000_000n);
    });

    it("encodes a redeem targeting the deployed wrapper", () => {
        const acct = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as Address; // anvil acct 1
        const tx = token.encodeRedeem(1_000_000_000_000_000_000n, acct, acct);
        expect(tx.to).toBe(PPUSDC);
        const decoded = decodeFunctionData({ abi: PP_YIELD_TOKEN_REDEEM_ABI, data: tx.data });
        expect(decoded.functionName).toBe("redeem");
    });
});
