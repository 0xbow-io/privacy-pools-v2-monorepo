import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex, ISwapQuoteProvider } from "../../src/internal.js";
import {
    bigintToHex,
    InvalidSwapAndDepositParams,
    NoteStatus,
    PoolSessionSwapDepositBaseError,
    SwapQuoteFailed,
    UnallowedLiFiAddress,
    WalletSendTransactionFailed,
} from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, mintErc20 } from "../harness/actors.js";
import {
    captureFromBlock,
    discoverNotesWithRetry,
    erc20Balance,
    FEE_CEILING,
    nativeBalance,
    NATIVE_ASSET,
} from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import type { Session } from "../harness/sessions.js";
import { relayedSession, selfSubmitSession } from "../harness/sessions.js";
import {
    createFakeExecutorSwapQuoteProvider,
    createFakeSwapAndDepositQuoteProvider,
} from "../fakeSwapQuoteProviders.js";

const AMOUNT = bigintToHex(15_000_000_000_000_000n); // 0.015 ETH-equivalent, paid for in MockERC20

/**
 * Swap-and-deposit ladders (matrix §4c): pay in one token, deposit another, in one transaction. A
 * native deposit is composed by the session as one swap-executor transaction (the e2e's
 * `MockLiFiExecutor`, standing in for LiFi's Executor): pull the input through the executor's
 * ERC20Proxy, swap it into ETH paid to the executor, then `Entrypoint.deposit` the exact cost and
 * refund the surplus. Real LiFi has no liquidity locally, so the swap quote comes from a fake provider
 * aimed at `MockRouter`; that lets each rung break the quote in one specific way.
 */
describe.skipIf(!EVM_E2E)("swap and deposit", () => {
    let ctx: E2EContext;
    let fromBlock: Hex;
    let erc20: Address;
    let alice: Actor;

    const request = (overrides: Record<string, unknown> = {}) => ({
        fromChainId: ctx.network.chainId,
        inputToken: erc20,
        depositToken: NATIVE_ASSET,
        depositAmount: AMOUNT,
        ...overrides,
    });

    /** The quote providers a swap-and-deposit session needs; `swapQuoteProvider` prices the native leg. */
    const providers = (swapQuoteProvider: ISwapQuoteProvider = createFakeExecutorSwapQuoteProvider(ctx.network)) => ({
        swapAndDepositQuoteProvider: createFakeSwapAndDepositQuoteProvider(ctx.network),
        swapQuoteProvider,
    });

    /** A swap quote provider that behaves like the fake one except for one field the test tampers with. */
    const tamperedSwapProvider = (change: (quote: Awaited<ReturnType<ISwapQuoteProvider["getSwapQuote"]>>) => object) => {
        const honest = createFakeExecutorSwapQuoteProvider(ctx.network);
        return {
            ...honest,
            getSwapQuote: async (params: Parameters<typeof honest.getSwapQuote>[0]) => {
                const quote = await honest.getSwapQuote(params);
                return { ...quote, ...change(quote) };
            },
        } as ISwapQuoteProvider;
    };

    beforeAll(async () => {
        ctx = e2eContext();
        erc20 = ctx.network.mockErc20Address;
        fromBlock = await captureFromBlock(ctx);
        alice = await createActor("alice");
    });

    describe("configuration and quotes", () => {
        it("refuse to prepare on a session with no swap provider with PoolSessionSwapDepositBaseError", async () => {
            const session = await selfSubmitSession(ctx, alice);

            // Pinned as-is: this Promise-returning method throws SYNCHRONOUSLY when the delegate is not
            // configured, so `.catch()` on the returned value never sees it — callers need try/catch.
            expect(() => session.prepareSwapAndDeposit(request())).toThrow(PoolSessionSwapDepositBaseError);
        });

        it("refuse a zero fallback address, since bridged funds sent there would be unrecoverable", async () => {
            const session = await relayedSession(ctx, alice, {
                swapAndDepositQuoteProvider: createFakeSwapAndDepositQuoteProvider(ctx.network),
            });

            await expect(
                session.prepareSwapAndDeposit(request({ fallbackAddress: "0x0000000000000000000000000000000000000000" })),
            ).rejects.toThrow(InvalidSwapAndDepositParams);
        });

        it("refuse a cross-chain request when no source chain is configured", async () => {
            const session = await relayedSession(ctx, alice, {
                swapAndDepositQuoteProvider: createFakeSwapAndDepositQuoteProvider(ctx.network),
            });

            await expect(session.prepareSwapAndDeposit(request({ fromChainId: 1 }))).rejects.toThrow(
                InvalidSwapAndDepositParams,
            );
        });

        it("propagate the swap quote provider's own SwapQuoteFailed unchanged", async () => {
            // The session does not wrap provider failures; a native deposit is priced by the swap quote
            // provider, and whatever it throws reaches the caller as-is.
            const failing: ISwapQuoteProvider = {
                getSwapQuote: async () => {
                    throw new SwapQuoteFailed("no route");
                },
                getSwapStatus: async () => ({ status: "DONE" }),
            };
            const session = await relayedSession(ctx, alice, providers(failing));

            await expect(session.prepareSwapAndDeposit(request())).rejects.toThrow(SwapQuoteFailed);
        });

        it("refuse a swap that would run through a contract the chain has not allow-listed", async () => {
            const session = await relayedSession(
                ctx,
                alice,
                providers(
                    tamperedSwapProvider(() => ({
                        transactionTo: alice.address,
                        approvalAddress: alice.address,
                    })),
                ),
            );

            await expect(
                (async () => session.executeSwapAndDeposit(await session.prepareSwapAndDeposit(request())))(),
            ).rejects.toThrow(UnallowedLiFiAddress);
        });
    });

    describe("paying for the swap", () => {
        let session: Session;
        let prepared: Awaited<ReturnType<Session["prepareSwapAndDeposit"]>>;

        beforeAll(async () => {
            session = await relayedSession(ctx, alice, providers());
        });

        it("prepare the swap and deposit for an account that holds none of the input token", async () => {
            prepared = await session.prepareSwapAndDeposit(request());

            expect(prepared.pendingNote.value).toBe(AMOUNT);
            // One executor transaction, with the input approved to its proxy, never to the executor.
            expect(prepared.transactionTo.toLowerCase()).toBe(ctx.network.mockExecutorAddress.toLowerCase());
            expect(prepared.approvalAddress.toLowerCase()).toBe(ctx.network.mockErc20ProxyAddress.toLowerCase());
            // The swap targets the cost plus a slippage margin, so it pulls more than the deposit.
            expect(BigInt(prepared.estimatedInputAmount)).toBeGreaterThan(BigInt(AMOUNT));
        });

        it("fail to execute without the input token and persist no note", async () => {
            expect(await erc20Balance(ctx, erc20, alice.address)).toBe(0n);

            await expect(session.executeSwapAndDeposit(prepared)).rejects.toThrow(WalletSendTransactionFailed);

            const notes = (await session.exportAccount()).notes;
            expect(notes.find((n) => n.commitment === prepared.pendingNote.commitment)).toBeUndefined();
        });

        it("swap the input token into the deposit once the account holds it", async () => {
            const input = BigInt(prepared.estimatedInputAmount);
            const surplus = input - BigInt(AMOUNT);
            await mintErc20(ctx, alice, erc20, input);
            const nativeBefore = await nativeBalance(ctx, alice.address);
            const routerBefore = await nativeBalance(ctx, ctx.network.mockRouterAddress);

            const receipt = await session.executeSwapAndDeposit(prepared);

            expect(receipt.status).toBe(true);
            // Alice paid in MockERC20: all of it went into the swap...
            expect(await erc20Balance(ctx, erc20, alice.address)).toBe(0n);
            // ...the router's reserve paid out the swapped ETH (1:1)...
            expect(routerBefore - (await nativeBalance(ctx, ctx.network.mockRouterAddress))).toBe(input);
            // ...and the ETH above the deposit cost came back to her, less gas.
            const nativeGain = (await nativeBalance(ctx, alice.address)) - nativeBefore;
            expect(nativeGain).toBeLessThanOrEqual(surplus);
            expect(nativeGain).toBeGreaterThan(surplus - FEE_CEILING);
            // The executor keeps nothing.
            expect(await nativeBalance(ctx, ctx.network.mockExecutorAddress)).toBe(0n);
            expect(await erc20Balance(ctx, erc20, ctx.network.mockExecutorAddress)).toBe(0n);
        });

        it("record the deposit as a PENDING note of the swapped amount, discoverable from a fresh session", async () => {
            const fresh = await selfSubmitSession(ctx, alice);

            const discovered = await discoverNotesWithRetry(ctx, fresh, fromBlock);

            const note = discovered.find((n) => n.commitment === prepared.pendingNote.commitment);
            expect(note?.value).toBe(AMOUNT);
            expect(note?.status).toBe(NoteStatus.PENDING);
        });
    });
});
