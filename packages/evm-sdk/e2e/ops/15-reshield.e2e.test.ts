import { encodeFunctionData } from "viem";
import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex, ISwapAndDepositQuoteProvider } from "../../src/internal.js";
import {
    bigintToHex,
    DepositTargetMismatch,
    LiFiDepositCalldataNotFound,
    NoteStatus,
    SwapQuoteMismatch,
} from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, mintErc20 } from "../harness/actors.js";
import { captureFromBlock, nativeBalance, NATIVE_ASSET, settleFinality } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { createFakeSwapAndDepositQuoteProvider, createFakeSwapQuoteProvider, MOCK_ROUTER_ABI } from "../fakeSwapQuoteProviders.js";
import type { Session } from "../harness/sessions.js";
import { localRelayerInfo, relayedSession, selfSubmitSession } from "../harness/sessions.js";

const SOURCE = bigintToHex(5_000_000_000_000_000_000n); // 5 mUSD, the note that gets reshielded
// The relayer's fee and the swap both come out of the note, so the request asks for less than its value;
// what is left over comes back as a change note.
const HEADROOM = 2_000_000_000_000_000n;

/**
 * Same-chain reshield ladders (matrix §11b): withdraw a note, swap it, and deposit the proceeds back
 * into the pool as a NEW note, in one relayed transaction. Both quotes come from an outside aggregator
 * and the SDK re-checks them before proof-binding anything, so each rung feeds it one quote that lies.
 * The input must be an ERC-20 note and the output native ETH: `MockRouter` only funds the embedded
 * deposit from its own native reserve.
 */
describe.skipIf(!EVM_E2E)("reshield", () => {
    let ctx: E2EContext;
    let fromBlock: Hex;
    let erc20: Address;
    let alice: Actor;
    let session: Session;
    let note: Awaited<ReturnType<Session["prepareDeposit"]>>["pendingNote"];
    let amount: Hex;
    let estimate: Awaited<ReturnType<Session["estimateReshieldAmount"]>>;
    let destDeposit: Awaited<ReturnType<Session["prepareDeposit"]>>;
    let reshieldLabel: Hex;

    const relayerInfo = () => ({ ...localRelayerInfo(ctx), processorAddress: ctx.network.relaySwapsAddress });
    const quoteParams = (depositResult = destDeposit) => ({
        relayerInfo: relayerInfo(),
        amount,
        tokenId: erc20,
        outputToken: NATIVE_ASSET,
        depositResult,
        totalDepositCost: estimate.totalDepositCost,
    });
    /** A session identical to Alice's except for the swap-and-deposit quote provider. */
    const sessionWithProvider = (provider: ISwapAndDepositQuoteProvider) =>
        relayedSession(ctx, alice, {
            swapQuoteProvider: createFakeSwapQuoteProvider(ctx.network),
            swapAndDepositQuoteProvider: provider,
        });
    const honest = () => createFakeSwapAndDepositQuoteProvider(ctx.network);

    beforeAll(async () => {
        ctx = e2eContext();
        erc20 = ctx.network.mockErc20Address;
        fromBlock = await captureFromBlock(ctx);
        alice = await createActor("alice");
        session = await sessionWithProvider(honest());
        await session.registerKeystore();
        await mintErc20(ctx, alice, erc20, BigInt(SOURCE));
        const deposit = await session.prepareDeposit({ tokenId: erc20, value: SOURCE });
        await session.executeDeposit(deposit);
        note = deposit.pendingNote;
        await ctx.asp.approveLabel(note.label);
        await settleFinality(ctx);
        await session.discoverNotes({ fromBlock });
        amount = bigintToHex(BigInt(SOURCE) - HEADROOM);
    });

    it("estimate the value of the note the reshield will create", async () => {
        estimate = await session.estimateReshieldAmount({
            relayerInfo: relayerInfo(),
            amount,
            tokenId: erc20,
            outputToken: NATIVE_ASSET,
        });

        expect(BigInt(estimate.noteValue)).toBeGreaterThan(0n);
        expect(BigInt(estimate.noteValue)).toBeLessThan(BigInt(amount));
    });

    it("prepare the destination deposit the swap will fund", async () => {
        destDeposit = await session.prepareDeposit({ tokenId: NATIVE_ASSET, value: estimate.noteValue });

        expect(destDeposit.pendingNote.value).toBe(estimate.noteValue);
    });

    describe("quotes that lie", () => {
        it("refuse a deposit transaction that does not target the session's Entrypoint with DepositTargetMismatch", async () => {
            const tampered = { ...destDeposit, depositTx: { ...destDeposit.depositTx, to: alice.address } };

            await expect(session.prepareReshieldQuote(quoteParams(tampered))).rejects.toThrow(DepositTargetMismatch);
        });

        it("refuse a quote whose calldata does not carry the deposit proof with LiFiDepositCalldataNotFound", async () => {
            const stripped: ISwapAndDepositQuoteProvider = {
                ...honest(),
                getSwapAndDepositQuote: async (params) => {
                    const quote = await honest().getSwapAndDepositQuote(params);
                    return {
                        ...quote,
                        transactionData: encodeFunctionData({
                            abi: MOCK_ROUTER_ABI,
                            functionName: "swapAndCall",
                            args: [params.fromToken, BigInt(params.depositAmount), params.poolAddress, BigInt(params.depositAmount), "0x"],
                        }),
                    };
                },
            };
            const lying = await sessionWithProvider(stripped);

            await expect(lying.prepareReshieldQuote(quoteParams())).rejects.toThrow(LiFiDepositCalldataNotFound);
        });

        it("refuse a quote that swaps into a different token than requested with SwapQuoteMismatch", async () => {
            const wrongToken: ISwapAndDepositQuoteProvider = {
                ...honest(),
                getSwapAndDepositQuote: async (params) => ({
                    ...(await honest().getSwapAndDepositQuote(params)),
                    toTokenAddress: alice.address,
                }),
            };
            const lying = await sessionWithProvider(wrongToken);

            await expect(lying.prepareReshieldQuote(quoteParams())).rejects.toThrow(SwapQuoteMismatch);
        });
    });

    describe("reshielding the note", () => {
        it("withdraw, swap, and re-deposit in one relayed transaction that leaves nothing in RelaySwaps", async () => {
            const prepared = await session.prepareReshieldQuote(quoteParams());
            const relaySwapsBefore = await nativeBalance(ctx, ctx.network.relaySwapsAddress);

            const receipt = await session.relayReshield({
                inputCommitments: [note.commitment],
                amount: prepared.netAmount,
                tokenId: erc20,
                outputToken: NATIVE_ASSET,
                swapCalldata: prepared.swapCalldata,
                selectedQuote: prepared.selectedQuote,
                dustRecipient: prepared.dustRecipient,
                swapTarget: prepared.swapTarget,
                approvalAddress: prepared.approvalAddress,
                depositNote: prepared.depositNote,
                executorCall: prepared.executorCall,
            });

            expect(receipt.status).toBe(true);
            // Delta-only invariant: RelaySwaps never retains ETH across a call.
            expect(await nativeBalance(ctx, ctx.network.relaySwapsAddress)).toBe(relaySwapsBefore);
            reshieldLabel = prepared.depositNote.label;
        });

        it("settle the source note as SPENT, keep the headroom as an ACTIVE change note, and create the new note PENDING", async () => {
            await settleFinality(ctx);
            const fresh = await selfSubmitSession(ctx, alice);
            const discovered = await fresh.discoverNotes({ fromBlock });
            const byToken = (token: Address) => discovered.filter((n) => n.tokenId.toLowerCase() === token.toLowerCase());

            expect(byToken(erc20).find((n) => n.commitment === note.commitment)?.status).toBe(NoteStatus.SPENT);
            expect(byToken(erc20).find((n) => n.status === NoteStatus.ACTIVE)?.value).toBe(bigintToHex(HEADROOM));
            const reshielded = byToken(NATIVE_ASSET).find((n) => n.value === estimate.noteValue);
            // A brand-new deposit is unapproved until the ASP says otherwise, like any other.
            expect(reshielded?.status).toBe(NoteStatus.PENDING);
        });

        it("turn the new note ACTIVE once the ASP approves its label", async () => {
            await ctx.asp.approveLabel(reshieldLabel);
            await settleFinality(ctx);
            const fresh = await selfSubmitSession(ctx, alice);

            const discovered = await fresh.discoverNotes({ fromBlock });

            expect(discovered.find((n) => n.value === estimate.noteValue)?.status).toBe(NoteStatus.ACTIVE);
        });
    });
});
