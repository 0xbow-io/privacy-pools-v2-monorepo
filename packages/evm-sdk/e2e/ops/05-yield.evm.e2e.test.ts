import { beforeAll, describe, expect, it } from "vitest";

import type { Address, EvmPoolSession, Hex } from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, mintErc20, walletFor } from "../harness/actors.js";
import { erc20Balance } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { e2eYieldDeployment, selfSubmitSession } from "../harness/sessions.js";

const BUDGET = 5_000_000n; // 5 yUSDC (6dp): the underlying the depositor is prepared to spend

/**
 * The ERC-20 mechanics of the yield deposit ladder: the underlying-token approval PPRouter needs before
 * it can pull the underlying. They are EVM-specific, so they live with the EVM SDK; the chain-agnostic
 * rest is in `@privacy-pools-v2/e2e-suite`'s `yield` suite.
 */
describe.skipIf(!EVM_E2E)("yield", () => {
    let ctx: E2EContext;
    let underlying: Address;
    let alice: Actor;
    let prepared: Awaited<ReturnType<NonNullable<EvmPoolSession["yield"]>["deposit"]["prepareYieldDeposit"]>>;

    /** Sends a prepared transaction from the raw wallet, bypassing the SDK's own approval step. */
    const send = (tx: { to: Address; data: Hex; value: string }) =>
        walletFor(ctx, alice).sendTransaction({ to: tx.to, data: tx.data, value: BigInt(tx.value), chain: null });

    beforeAll(async () => {
        ctx = e2eContext();
        underlying = ctx.network.yieldUnderlyingAddress;
        alice = await createActor("alice-yield-approval");
        const session = await selfSubmitSession(ctx, alice, { yieldDeployment: e2eYieldDeployment(ctx) });
        const yieldSession = (session as EvmPoolSession).yield!;
        const sized = await yieldSession.deposit.sizeSharesForBudget(BUDGET);
        prepared = await yieldSession.deposit.prepareYieldDeposit({
            value: sized.shares,
            maxUnderlyingIn: sized.maxUnderlyingIn,
        });
    });

    it("prepare the deposit as one underlying approval followed by the deposit transaction", () => {
        expect(prepared.approvalTxs).toHaveLength(1);
        expect(prepared.approvalTx).toBe(prepared.approvalTxs[0]);
    });

    it("revert when the deposit is submitted without approving the underlying", async () => {
        await expect(send(prepared.depositTx as never)).rejects.toThrow();
    });

    it("still revert once approved, while the account holds none of the underlying", async () => {
        expect(await erc20Balance(ctx, underlying, alice.address)).toBe(0n);
        const approval = await send(prepared.approvalTx as never);
        await ctx.publicClient.waitForTransactionReceipt({ hash: approval });

        await expect(send(prepared.depositTx as never)).rejects.toThrow();
    });

    it("shield the shares once the account holds the underlying", async () => {
        await mintErc20(ctx, alice, underlying, BUDGET);

        const hash = await send(prepared.depositTx as never);
        const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });

        expect(receipt.status).toBe("success");
    });
});
