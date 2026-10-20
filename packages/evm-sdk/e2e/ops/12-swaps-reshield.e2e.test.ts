import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex, ISwapQuoteProvider } from "../../src/internal.js";
import {
    AssetNotSupported,
    bigintToHex,
    InvalidTransactParams,
    LiFiRecipientNotFound,
    NoteStatus,
    SwapQuoteMismatch,
} from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor } from "../harness/actors.js";
import { captureFromBlock, erc20Balance, NATIVE_ASSET, settleFinality } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import { MOCK_ROUTER_ABI, createFakeSwapQuoteProvider } from "../fakeSwapQuoteProviders.js";
import type { Session } from "../harness/sessions.js";
import { localRelayerInfo, relayedSession } from "../harness/sessions.js";
import { encodeFunctionData } from "viem";

const NOTE_VALUE = bigintToHex(30_000_000_000_000_000n); // 0.03 ETH
// The relayer's fee comes out of the same note, so the swap must ask for less than the note's value.
const FEE_HEADROOM = 2_000_000_000_000_000n;

/**
 * Withdraw-and-swap and reshield ladders (matrix §11a/§11b). The quote is the trust boundary: it comes
 * from an outside aggregator, so the SDK re-checks that it routes what was asked for before anything is
 * bound into a proof. Each rung hands the SDK one quote that lies in one specific way.
 */
describe.skipIf(!EVM_E2E)("swaps and reshield", () => {
    let ctx: E2EContext;
    let fromBlock: Hex;
    let alice: Actor;
    let erc20: Address;

    /** The relayer's swap entry point is RelaySwaps, not the plain relay contract. */
    const swapRelayer = () => ({ ...localRelayerInfo(ctx), processorAddress: ctx.network.relaySwapsAddress });

    const quoteParams = (recipient: Address) => ({
        relayerInfo: swapRelayer(),
        amount: bigintToHex(BigInt(NOTE_VALUE) - FEE_HEADROOM),
        tokenId: NATIVE_ASSET,
        outputToken: erc20,
        recipientAddress: recipient,
    });

    /** The honest fake with one field of every quote replaced. */
    const lyingProvider = (lie: (quote: Record<string, unknown>) => Record<string, unknown>): ISwapQuoteProvider => {
        const honest = createFakeSwapQuoteProvider(ctx.network);
        return {
            ...honest,
            getSwapQuote: async (params) => {
                const quote = await honest.getSwapQuote(params);
                return { ...quote, ...lie({ ...quote }) };
            },
        };
    };

    beforeAll(async () => {
        ctx = e2eContext();
        erc20 = ctx.network.mockErc20Address;
        fromBlock = await captureFromBlock(ctx);
        alice = await createActor("alice");
    });

    describe("withdraw-and-swap quotes", () => {
        it("refuse to quote on a session with no swap provider with InvalidTransactParams", async () => {
            const session = await relayedSession(ctx, alice);

            await expect(session.prepareSwapQuote(quoteParams(alice.address))).rejects.toThrow(InvalidTransactParams);
        });

        it("refuse a quote that swaps into a different token than requested with SwapQuoteMismatch", async () => {
            const session = await relayedSession(ctx, alice, {
                swapQuoteProvider: lyingProvider(() => ({ toTokenAddress: alice.address })),
            });

            await expect(session.prepareSwapQuote(quoteParams(alice.address))).rejects.toThrow(SwapQuoteMismatch);
        });

        it("refuse a quote for a different source chain with SwapQuoteMismatch", async () => {
            const session = await relayedSession(ctx, alice, {
                swapQuoteProvider: lyingProvider(() => ({ fromChainId: 1 })),
            });

            await expect(session.prepareSwapQuote(quoteParams(alice.address))).rejects.toThrow(SwapQuoteMismatch);
        });

        it("refuse a quote whose calldata pays someone other than the requested recipient", async () => {
            const attacker = (await createActor("attacker")).address;
            const session = await relayedSession(ctx, alice, {
                swapQuoteProvider: lyingProvider(() => ({
                    transactionData: encodeFunctionData({
                        abi: MOCK_ROUTER_ABI,
                        functionName: "swapETHToERC20",
                        args: [erc20, attacker],
                    }),
                })),
            });

            await expect(session.prepareSwapQuote(quoteParams(alice.address))).rejects.toThrow(LiFiRecipientNotFound);
        });
    });

    describe("reshield estimates", () => {
        it("refuse to estimate on a session with no swap provider with InvalidTransactParams", async () => {
            const session = await relayedSession(ctx, alice);

            await expect(
                session.estimateReshieldAmount({
                    relayerInfo: swapRelayer(),
                    amount: NOTE_VALUE,
                    tokenId: NATIVE_ASSET,
                    outputToken: erc20,
                }),
            ).rejects.toThrow(InvalidTransactParams);
        });

        it("refuse to reshield into a token the Entrypoint has not enabled with AssetNotSupported", async () => {
            const session = await relayedSession(ctx, alice, {
                swapQuoteProvider: createFakeSwapQuoteProvider(ctx.network),
            });
            const unlisted = (await createActor("unlisted-token")).address;

            await expect(
                session.estimateReshieldAmount({
                    relayerInfo: swapRelayer(),
                    amount: NOTE_VALUE,
                    tokenId: NATIVE_ASSET,
                    outputToken: unlisted,
                }),
            ).rejects.toThrow(AssetNotSupported);
        });
    });

    describe("withdrawing and swapping a note", () => {
        let session: Session;
        let note: Awaited<ReturnType<Session["prepareDeposit"]>>["pendingNote"];

        beforeAll(async () => {
            session = await relayedSession(ctx, alice, { swapQuoteProvider: createFakeSwapQuoteProvider(ctx.network) });
            await session.registerKeystore();
            const prepared = await session.prepareDeposit({ tokenId: NATIVE_ASSET, value: NOTE_VALUE });
            await session.executeDeposit(prepared);
            note = prepared.pendingNote;
            await ctx.asp.approveLabel(note.label);
            await settleFinality(ctx);
            await session.discoverNotes({ fromBlock });
        });

        it("start with the note ACTIVE", async () => {
            const found = (await session.exportAccount()).notes.find((n) => n.commitment === note.commitment);

            expect(found?.status).toBe(NoteStatus.ACTIVE);
        });

        it("deliver the swapped token to the recipient through the relayer", async () => {
            const dest = await createActor("dest", { funded: false });
            const quote = await session.prepareSwapQuote(quoteParams(dest.address));
            const before = await erc20Balance(ctx, erc20, dest.address);

            const receipt = await session.relayWithdrawAndSwap({
                inputCommitments: [note.commitment],
                amount: quote.netAmount,
                tokenId: NATIVE_ASSET,
                recipientAddress: dest.address,
                outputToken: erc20,
                minOutputAmount: quote.minOutputAmount,
                swapCalldata: quote.swapCalldata,
                selectedQuote: quote.selectedQuote,
                swapTarget: quote.swapTarget,
                approvalAddress: quote.approvalAddress,
            });

            expect(receipt.status).toBe(true);
            // 1:1 mock rate, so the delivered amount is exactly the net swap input.
            expect((await erc20Balance(ctx, erc20, dest.address)) - before).toBe(BigInt(quote.netAmount));
        });

        it("mark the note SPENT", async () => {
            const found = (await session.exportAccount()).notes.find((n) => n.commitment === note.commitment);

            expect(found?.status).toBe(NoteStatus.SPENT);
        });
    });
});
