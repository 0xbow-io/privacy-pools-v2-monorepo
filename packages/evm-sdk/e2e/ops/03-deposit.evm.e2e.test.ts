import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex } from "../../src/internal.js";
import { bigintToHex, NoteStatus, UnexpectedTransactionTarget } from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, MOCK_ERC20_ABI, mintErc20, walletFor } from "../harness/actors.js";
import { erc20Allowance } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import type { Session } from "../harness/sessions.js";
import { selfSubmitSession } from "../harness/sessions.js";

const ERC20_VALUE = bigintToHex(3_000_000_000_000_000_000n); // 3 mUSD (18dp)

/**
 * The ERC-20 mechanics of the deposit ladder: allowances, approval transactions and prepared-transaction
 * integrity. They are EVM-specific (other chains' tokens need no approval step), so they live with the
 * EVM SDK; the chain-agnostic rest is in `@privacy-pools-v2/e2e-suite`'s `deposit` suite.
 */
describe.skipIf(!EVM_E2E)("deposit", () => {
    let ctx: E2EContext;
    let erc20: Address;

    beforeAll(() => {
        ctx = e2eContext();
        erc20 = ctx.network.mockErc20Address;
    });

    describe("ERC-20 deposit: funds", () => {
        it("prepare an ERC-20 deposit that includes an approval", async () => {
            // Has gas, but no tokens: preparing needs neither.
            const carol = await createActor("carol-approval");
            const session = await selfSubmitSession(ctx, carol);

            const prepared = await session.prepareDeposit({ tokenId: erc20, value: ERC20_VALUE });

            expect(prepared.approvalTx).not.toBeNull();
        });
    });

    describe("ERC-20 deposit: approval and prepared-transaction integrity", () => {
        let alice: Actor;
        let session: Session;
        let prepared: Awaited<ReturnType<Session["prepareDeposit"]>>;
        const allowance = () => erc20Allowance(ctx, erc20, alice.address, ctx.network.entrypointAddress);
        const exportedNote = async (s: Session, commitment: Hex) =>
            (await s.exportAccount()).notes.find((n) => n.commitment === commitment);

        beforeAll(async () => {
            alice = await createActor("alice-erc20");
            await mintErc20(ctx, alice, erc20, BigInt(ERC20_VALUE) * 2n);
            session = await selfSubmitSession(ctx, alice);
            prepared = await session.prepareDeposit({ tokenId: erc20, value: ERC20_VALUE });
        });

        it("hand back an approval and start with no allowance", async () => {
            expect(prepared.approvalTx).not.toBeNull();
            expect(await allowance()).toBe(0n);
        });

        it("refuse an approval transaction aimed at a different contract before submitting anything", async () => {
            const tampered = { ...prepared, approvalTx: { ...prepared.approvalTx!, to: ctx.network.mockRouterAddress } };

            await expect(session.executeDeposit(tampered)).rejects.toThrow(UnexpectedTransactionTarget);
            expect(await allowance()).toBe(0n);
        });

        it("revert when the deposit is submitted without its approval", async () => {
            // Bypass the SDK's own approval step: send only depositTx from the raw wallet.
            await expect(
                walletFor(ctx, alice).sendTransaction({
                    to: prepared.depositTx.to as Address,
                    data: prepared.depositTx.data as Hex,
                    value: BigInt(prepared.depositTx.value),
                    chain: null,
                }),
            ).rejects.toThrow();
        });

        it("refuse a deposit transaction aimed at a different contract", async () => {
            const tampered = { ...prepared, depositTx: { ...prepared.depositTx, to: ctx.network.mockRouterAddress } };

            await expect(session.executeDeposit(tampered)).rejects.toThrow(UnexpectedTransactionTarget);
        });

        it("leave no allowance behind when a tampered deposit is refused", async () => {
            // Everything is verified before anything is signed, so the genuine approval is never mined
            // ahead of a deposit transaction that is then refused.
            expect(await allowance()).toBe(0n);
        });

        it("deposit once the SDK submits the approval first", async () => {
            const receipt = await session.executeDeposit(prepared);

            expect(receipt.status).toBe(true);
            expect((await exportedNote(session, prepared.pendingNote.commitment))?.status).toBe(NoteStatus.PENDING);
        });

        it("skip the approval when the allowance already covers the deposit", async () => {
            const hash = await walletFor(ctx, alice).writeContract({
                address: erc20,
                abi: MOCK_ERC20_ABI,
                functionName: "approve",
                args: [ctx.network.entrypointAddress, BigInt(ERC20_VALUE) * 10n],
            });
            await ctx.publicClient.waitForTransactionReceipt({ hash });

            const second = await session.prepareDeposit({ tokenId: erc20, value: ERC20_VALUE });
            const receipt = await session.executeDeposit(second);

            expect(second.approvalTx).toBeNull();
            expect(receipt.status).toBe(true);
        });
    });
});
