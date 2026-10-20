import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/ciphers/utils.js";
import { encodeFunctionData } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { beforeAll, describe, expect, it } from "vitest";

import type { Address, Hex, ISwapAndDepositQuoteProvider } from "../../src/internal.js";
import {
    AssetNotSupported,
    bigintToHex,
    DestinationChainNotSupported,
    DestinationDepositTargetMismatch,
    DustRescueRecipientConflict,
    LiFiDepositCalldataNotFound,
    NativeDestinationDepositUnsupported,
    SwapQuoteMismatch,
} from "../../src/internal.js";
import type { Actor } from "../harness/actors.js";
import { createActor, mintErc20 } from "../harness/actors.js";
import { captureFromBlock, nativeBalance, NATIVE_ASSET, settleFinality } from "../harness/chain.js";
import type { E2EContext } from "../harness/context.js";
import { e2eContext, EVM_E2E } from "../harness/context.js";
import {
    createFakeReshieldCrosschainQuoteProvider,
    createFakeSwapQuoteProvider,
    MOCK_ROUTER_ABI,
} from "../fakeSwapQuoteProviders.js";
import type { Session } from "../harness/sessions.js";
import { localRelayerInfo, relayedSession, selfSubmitSession } from "../harness/sessions.js";

// A distinct chain id standing in for the destination. There is no second chain in this suite, so its
// RPC url and deployment both point straight back at the same anvil fork: the "cross-chain" deposit is a
// genuine second Entrypoint.deposit() on the SAME chain, reached through RelaySwaps' cross-chain code path.
const DESTINATION_CHAIN_ID = 999_999;
const SOURCE = bigintToHex(5_000_000_000_000_000_000n); // 5 mUSD (18dp)
// The relayer's fee and RelaySwaps' in-contract gas swap both come out of the note.
const HEADROOM = 2_000_000_000_000_000n;

/**
 * Cross-chain reshield ladders (matrix §11b, B2 route): withdraw an ERC-20 note, bridge it, and shield the
 * proceeds on ANOTHER chain in one relayed transaction, RelaySwaps funding the bridge fee itself with an
 * in-contract gas swap. The destination deposit is proven up front against the destination Entrypoint, and
 * the SDK re-checks the bridge quote before binding anything, so each rung hands it one quote that lies.
 */
describe.skipIf(!EVM_E2E)("cross-chain reshield", () => {
    let ctx: E2EContext;
    let fromBlock: Hex;
    let erc20: Address;
    let alice: Actor;
    let session: Session;
    let destSession: Session;
    let note: Awaited<ReturnType<Session["prepareDeposit"]>>["pendingNote"];
    let amount: Hex;
    let estimate: Awaited<ReturnType<Session["estimateReshieldCrosschainAmount"]>>;
    let destDeposit: Awaited<ReturnType<Session["prepareDeposit"]>>;

    const relayerInfo = () => ({ ...localRelayerInfo(ctx), processorAddress: ctx.network.relaySwapsAddress });
    const destination = () => ({
        chainId: DESTINATION_CHAIN_ID,
        rpcUrl: ctx.network.rpcUrl,
        deployment: {
            poolAddress: ctx.network.poolAddress,
            entrypointAddress: ctx.network.entrypointAddress,
            keystoreAddress: ctx.network.keystoreAddress,
            aspRegistryAddress: ctx.network.aspRegistryAddress,
            relaySwapsAddress: ctx.network.relaySwapsAddress,
        },
    });
    const sessionWith = (provider: ISwapAndDepositQuoteProvider) =>
        relayedSession(ctx, alice, {
            swapQuoteProvider: createFakeSwapQuoteProvider(ctx.network),
            swapAndDepositQuoteProvider: provider,
            destination: destination(),
        });
    const honest = () => createFakeReshieldCrosschainQuoteProvider(ctx.network);
    const quoteParams = (overrides: Record<string, unknown> = {}) => ({
        relayerInfo: relayerInfo(),
        amount,
        tokenId: erc20,
        outputToken: erc20,
        toChainId: DESTINATION_CHAIN_ID,
        toChainType: "evm",
        depositResult: destDeposit,
        totalDepositCost: estimate.totalDepositCost,
        ...overrides,
    });

    beforeAll(async () => {
        ctx = e2eContext();
        erc20 = ctx.network.mockErc20Address;
        fromBlock = await captureFromBlock(ctx);
        alice = await createActor("alice");
        session = await sessionWith(honest());
        // Deposits are proven and submitted on the destination chain by an ordinary self-submit session.
        destSession = await selfSubmitSession(ctx, alice);
        await session.registerKeystore();
        // The source note, plus a second balance so the destination deposit can be proven: the
        // destination deposit is paid by the bridge router, but proving it checks the depositor's balance.
        await mintErc20(ctx, alice, erc20, BigInt(SOURCE) * 2n);
        const deposit = await session.prepareDeposit({ tokenId: erc20, value: SOURCE });
        await session.executeDeposit(deposit);
        note = deposit.pendingNote;
        await ctx.asp.approveLabel(note.label);
        await settleFinality(ctx);
        await session.discoverNotes({ fromBlock });
        amount = bigintToHex(BigInt(SOURCE) - HEADROOM);
    });

    describe("estimating", () => {
        it("refuse a destination chain the session is not configured for with DestinationChainNotSupported", async () => {
            await expect(
                session.estimateReshieldCrosschainAmount({
                    relayerInfo: relayerInfo(),
                    amount,
                    tokenId: erc20,
                    outputToken: erc20,
                    toChainId: 424_242,
                    toChainType: "evm",
                }),
            ).rejects.toThrow(DestinationChainNotSupported);
        });

        it("refuse to reshield into a token the destination Entrypoint has not enabled with AssetNotSupported", async () => {
            const unlisted = (await createActor("unlisted-token")).address;

            await expect(
                session.estimateReshieldCrosschainAmount({
                    relayerInfo: relayerInfo(),
                    amount,
                    tokenId: erc20,
                    outputToken: unlisted,
                    toChainId: DESTINATION_CHAIN_ID,
                    toChainType: "evm",
                }),
            ).rejects.toThrow(AssetNotSupported);
        });

        it("estimate the value of the note the bridge will fund", async () => {
            estimate = await session.estimateReshieldCrosschainAmount({
                relayerInfo: relayerInfo(),
                amount,
                tokenId: erc20,
                outputToken: erc20,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: "evm",
            });

            expect(BigInt(estimate.noteValue)).toBeGreaterThan(0n);
        });

        it("prove the destination deposit that the bridged funds will pay for", async () => {
            destDeposit = await destSession.prepareDeposit({ tokenId: erc20, value: estimate.noteValue });

            expect(destDeposit.pendingNote.value).toBe(estimate.noteValue);
        });
    });

    describe("quotes and requests that lie", () => {
        it("refuse a plain native-coin destination deposit with NativeDestinationDepositUnsupported", async () => {
            // The aggregator sends its own guaranteed delivery as msg.value while Entrypoint.deposit{value}
            // needs msg.value == note + fee exactly, so the bridged coin would land at the fallback address.
            await expect(
                session.prepareReshieldCrosschainQuote(
                    quoteParams({
                        outputToken: NATIVE_ASSET,
                        depositResult: await destSession.prepareDeposit({
                            tokenId: NATIVE_ASSET,
                            value: bigintToHex(1_000_000_000_000_000n),
                        }),
                    }),
                ),
            ).rejects.toThrow(NativeDestinationDepositUnsupported);
        });

        it("refuse a deposit that does not target the destination chain's Entrypoint with DestinationDepositTargetMismatch", async () => {
            const tampered = { ...destDeposit, depositTx: { ...destDeposit.depositTx, to: alice.address } };

            await expect(session.prepareReshieldCrosschainQuote(quoteParams({ depositResult: tampered }))).rejects.toThrow(
                DestinationDepositTargetMismatch,
            );
        });

        it("refuse a dust destination that is not the relayer when dust rescue is requested with DustRescueRecipientConflict", async () => {
            const spendingPubKey = ("0x" + bytesToHex(secp256k1.getPublicKey(hexToBytes(generatePrivateKey()), false))) as Hex;
            const elsewhere = (await createActor("elsewhere")).address;

            await expect(
                session.prepareReshieldCrosschainQuote(
                    quoteParams({
                        dustRecipient: elsewhere,
                        dustRescue: { recipientIdentifier: { kind: "raw", spendingPubKey } },
                    }),
                ),
            ).rejects.toThrow(DustRescueRecipientConflict);
        });

        it("refuse a bridge quote whose calldata does not carry the deposit with LiFiDepositCalldataNotFound", async () => {
            const stripped: ISwapAndDepositQuoteProvider = {
                ...honest(),
                getSwapAndDepositQuote: async (params) => ({
                    ...(await honest().getSwapAndDepositQuote(params)),
                    transactionData: encodeFunctionData({
                        abi: MOCK_ROUTER_ABI,
                        functionName: "swapAndCall",
                        args: [params.fromToken, BigInt(params.depositAmount), params.poolAddress, BigInt(params.depositAmount), "0x"],
                    }),
                }),
            };
            const lying = await sessionWith(stripped);

            await expect(lying.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(LiFiDepositCalldataNotFound);
        });

        it("refuse a bridge quote that routes into a different token than requested with SwapQuoteMismatch", async () => {
            const wrongToken: ISwapAndDepositQuoteProvider = {
                ...honest(),
                getSwapAndDepositQuote: async (params) => ({
                    ...(await honest().getSwapAndDepositQuote(params)),
                    toTokenAddress: alice.address,
                }),
            };
            const lying = await sessionWith(wrongToken);

            await expect(lying.prepareReshieldCrosschainQuote(quoteParams())).rejects.toThrow(SwapQuoteMismatch);
        });
    });

    describe("reshielding across chains", () => {
        let prepared: Awaited<ReturnType<Session["prepareReshieldCrosschainQuote"]>>;

        it("size an in-contract gas swap so the note itself pays the bridge fee", async () => {
            prepared = await session.prepareReshieldCrosschainQuote(quoteParams());

            // The B2 trigger: an ERC-20 input whose bridge quote carries a native fee.
            expect(BigInt(prepared.swapValue ?? "0x0")).toBeGreaterThan(0n);
            expect(prepared.gasSwapCalldata).toBeDefined();
            expect(prepared.gasSwapCalldata).not.toBe("0x");
        });

        it("withdraw, bridge, and shield on the destination in one relayed transaction that leaves nothing in RelaySwaps", async () => {
            const relaySwapsBefore = await nativeBalance(ctx, ctx.network.relaySwapsAddress);

            const receipt = await session.relayReshieldCrosschain({
                inputCommitments: [note.commitment],
                amount: prepared.netAmount,
                tokenId: erc20,
                outputToken: erc20,
                toChainId: DESTINATION_CHAIN_ID,
                toChainType: "evm",
                fallbackAddress: prepared.fallbackAddress,
                swapCalldata: prepared.swapCalldata,
                selectedQuote: prepared.selectedQuote,
                dustRecipient: prepared.dustRecipient,
                swapTarget: prepared.swapTarget,
                approvalAddress: prepared.approvalAddress,
                depositNote: prepared.depositNote,
                swapValue: prepared.swapValue,
                gasSwapMaxInput: prepared.gasSwapMaxInput,
                gasSwapCalldata: prepared.gasSwapCalldata,
            });

            expect(receipt.status).toBe(true);
            // Delta-only invariant: RelaySwaps never retains ETH across a call, the B2 gas swap included.
            expect(await nativeBalance(ctx, ctx.network.relaySwapsAddress)).toBe(relaySwapsBefore);
        });

        it("make the destination note discoverable to the destination session", async () => {
            await settleFinality(ctx);
            const fresh = await selfSubmitSession(ctx, alice);

            const discovered = await fresh.discoverNotes({ fromBlock });

            expect(discovered.find((n) => n.commitment === prepared.depositNote.commitment)?.value).toBe(estimate.noteValue);
        });
    });
});

function hexToBytes(hex: Hex): Uint8Array {
    return Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
}
