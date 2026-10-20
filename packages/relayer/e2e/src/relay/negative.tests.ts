import { it, expect } from "vitest";
import { WITHDRAWAL_RECIPIENTS } from "../test-addresses";
import type { RelayContext } from "./context";

const AMOUNT_6X1 = "5000000000000000"; // 0.005 ETH

export function negativeTests(ctx: RelayContext) {
    it("6x1 withdrawal - no circuit available", async () => {
        await expect(
            ctx.proofService.generateWithdrawalProof({
                accountStates: [
                    ctx.accounts[0],
                    ctx.accounts[1],
                    ctx.accounts[2],
                    ctx.accounts[3],
                    ctx.accounts[4],
                    ctx.accounts[5],
                ],
                amountOut: AMOUNT_6X1,
                recipient: WITHDRAWAL_RECIPIENTS[0],
                relayerUrl: ctx.baseUrl,
                chainId: ctx.chainId,
                aspLeaves: ctx.aspLeaves,
            })
        ).rejects.toThrow();
    }, 120_000);
}
