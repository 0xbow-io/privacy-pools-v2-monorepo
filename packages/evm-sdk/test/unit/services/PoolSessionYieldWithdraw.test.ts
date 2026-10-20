import {
    decodeAbiParameters,
    decodeFunctionData,
    encodeAbiParameters,
    encodeFunctionData,
} from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    Hash,
    Hex,
    ILogger,
    IPPRouterInteractor,
    ITransactOrchestrator,
    Note,
    PendingNote,
    PrepareTransactParams,
    WithdrawalFeeCommitment,
    YieldWithdrawParams,
    YieldWithdrawRelayParams,
} from "../../../src/internal.js";
import {
    bigintToHex,
    hasErrorAmounts,
    InvalidTransactParams,
    InvalidYieldAddress,
    InvalidYieldAmount,
    LOCAL_FORK_YIELD_DEPLOYMENT,
    PAYOUT_ROUTING_ABI,
    POOL_VAULT_TRANSACT_ABI,
    EvmPoolSessionYieldWithdraw,
    PP_ROUTER_WITHDRAW_ABI,
    UnexpectedWithdrawCalldata,
} from "../../../src/internal.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000" as Address;

const DEP = LOCAL_FORK_YIELD_DEPLOYMENT;
const RECIPIENT = "0x000000000000000000000000000000000000beef" as Address;
const COMMITMENT = "0x01" as Hash;

const PROOF = {
    pA: [1n, 2n],
    pB: [
        [3n, 4n],
        [5n, 6n],
    ],
    pC: [7n, 8n],
    pubSignals: [
        [9n, 10n],
        [11n, 12n],
    ],
} as const;
const NOTE_DATA = [{ hint: `0x${"22".repeat(32)}` as Hex, data: "0xbeef" as Hex }];
const CHANGE_NOTE = { commitment: "0x02" } as unknown as PendingNote;
const SPENT_NOTE = { commitment: "0x01" } as unknown as Note;

const AMOUNT_OUT = 1_000_000_000_000_000_000n; // 1 ppUSDC full withdrawal
const QUOTED_OUT = 1_020_000n; // 1.02 USDC after yield

function mockOrchestrator(): {
    orchestrator: ITransactOrchestrator;
    calls: PrepareTransactParams[];
} {
    const calls: PrepareTransactParams[] = [];
    const orchestrator = {
        prepareTransact: vi.fn(async (p: PrepareTransactParams) => {
            calls.push(p);
            return {
                changePendingNotes: [CHANGE_NOTE],
                recipientPendingNotes: [],
                spentNullifiers: [],
                // Echo the session's transactParams into the transact calldata (as the real pipeline does).
                transactTx: {
                    data: encodeFunctionData({
                        abi: POOL_VAULT_TRANSACT_ABI,
                        functionName: "transact",
                        args: [PROOF, p.transactParams, NOTE_DATA] as never,
                    }),
                    to: DEP.ppUSDC,
                    value: "0x0" as Hex,
                },
                spentNotes: [SPENT_NOTE],
                notesData: [],
                proof: {},
            };
        }),
        transact: vi.fn(),
    } as unknown as ITransactOrchestrator;
    return { orchestrator, calls };
}

function mockRouter(quoted: bigint): IPPRouterInteractor {
    return {
        getAddress: () => DEP.ppRouter,
        quote: vi.fn(async () => ({ underlyingNeeded: 0n, total: 0n })),
        quoteWithdraw: vi.fn(async () => quoted),
        supplyBufferUnits: vi.fn(async () => 2n),
    };
}

describe("PoolSessionYieldWithdraw", () => {
    let orchestrator: ITransactOrchestrator;
    let calls: PrepareTransactParams[];
    let router: IPPRouterInteractor;
    let session: EvmPoolSessionYieldWithdraw;

    beforeEach(() => {
        ({ orchestrator, calls } = mockOrchestrator());
        router = mockRouter(QUOTED_OUT);
        session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator, router });
    });

    function baseParams(): YieldWithdrawParams {
        return {
            inputCommitments: [COMMITMENT],
            amount: AMOUNT_OUT,
            amountOut: AMOUNT_OUT,
            recipient: RECIPIENT,
        };
    }

    it("drives prepareTransact with the router as processor and relay", async () => {
        await session.prepareYieldWithdraw(baseParams());
        const p = calls[0];
        expect(p.processorAddress).toBe(DEP.ppRouter);
        expect(p.relayAddress).toBe(DEP.ppRouter);
        expect(p.tokenId).toBe(DEP.ppUSDC);
        expect(p.recipientAddress).toBe(RECIPIENT);
        expect(p.transactParams?.processor).toBe(DEP.ppRouter);
    });

    it("binds the PayoutRouting into the proof context", async () => {
        await session.prepareYieldWithdraw(baseParams());
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_ABI, calls[0].transactParams!.data);
        expect((payout.recipient as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
        expect((payout.feeRecipient as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
        expect(payout.feeAmount).toBe(0n);
        expect(payout.nativeGas).toBe(0n);
    });

    it("re-encodes as withdrawToUnderlying with the decoded proof/params/notes", async () => {
        const result = await session.prepareYieldWithdraw(baseParams());
        expect(result.withdrawTx.to).toBe(DEP.ppRouter);
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_WITHDRAW_ABI,
            data: result.withdrawTx.data,
        });
        expect(decoded.functionName).toBe("withdrawToUnderlying");
        const [proof, transactParams, noteData, minUnderlyingOut] = decoded.args;
        expect(proof).toEqual(PROOF);
        expect((transactParams as { processor: string }).processor.toLowerCase()).toBe(
            DEP.ppRouter.toLowerCase(),
        );
        expect(noteData).toEqual(NOTE_DATA);
        expect(minUnderlyingOut).toBe(result.minUnderlyingOut);
    });

    it("sizes minUnderlyingOut with the default 1% floor off quoteWithdraw(recipientShares)", async () => {
        const result = await session.prepareYieldWithdraw(baseParams());
        expect(router.quoteWithdraw).toHaveBeenCalledWith(AMOUNT_OUT); // full recipient leg (fee 0)
        expect(result.quotedUnderlyingOut).toBe(QUOTED_OUT);
        // 1_020_000 * (10000 - 100) / 10000 = 1_009_800
        expect(result.minUnderlyingOut).toBe(1_009_800n);
    });

    it("honors a custom slippage floor", async () => {
        const result = await session.prepareYieldWithdraw({ ...baseParams(), slippageBps: 500n });
        // 1_020_000 * 9500 / 10000 = 969_000
        expect(result.minUnderlyingOut).toBe(969_000n);
    });

    it("quotes only the recipient leg when a fee is taken", async () => {
        const fee = 100_000_000_000_000_000n; // 0.1 ppUSDC fee
        const result = await session.prepareYieldWithdraw({
            ...baseParams(),
            feeAmount: fee,
        });
        expect(result.recipientShares).toBe(AMOUNT_OUT - fee);
        expect(router.quoteWithdraw).toHaveBeenCalledWith(AMOUNT_OUT - fee);
    });

    it("forwards nativeGas as the tx value", async () => {
        const result = await session.prepareYieldWithdraw({ ...baseParams(), nativeGas: 5n });
        expect(result.withdrawTx.value).toBe("0x5");
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_ABI, calls[0].transactParams!.data);
        expect(payout.nativeGas).toBe(5n);
    });

    it("passes change/spent notes through", async () => {
        const result = await session.prepareYieldWithdraw(baseParams());
        expect(result.changePendingNotes).toEqual([CHANGE_NOTE]);
        expect(result.spentNotes).toEqual([SPENT_NOTE]);
    });

    it("rejects a fee larger than amountOut", async () => {
        await expect(
            session.prepareYieldWithdraw({
                ...baseParams(),
                feeAmount: AMOUNT_OUT + 1n,
            }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("rejects a non-positive amountOut", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), amountOut: 0n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("rejects a slippageBps above 100%", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), slippageBps: 10_001n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
        // Rejected before the proof build.
        expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
    });

    it("preserves field-element-magnitude proof values through the uint256[][] re-encode", async () => {
        // Values near the BN254 field prime, exercising real magnitudes (not toy ints) and the
        // variable-length uint256[][] pubSignals shape that a real transact proof produces.
        const P =
            21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617n;
        const big = P - 1n;
        const bigProof = {
            pA: [big, big - 2n],
            pB: [
                [big - 3n, big - 4n],
                [big - 5n, big - 6n],
            ],
            pC: [big - 7n, big - 8n],
            pubSignals: [[big - 9n, big - 10n, big - 11n], [big - 12n], [big - 13n, big - 14n]],
        } as const;
        const bigOrchestrator = {
            prepareTransact: vi.fn(async (p: PrepareTransactParams) => ({
                changePendingNotes: [],
                recipientPendingNotes: [],
                spentNullifiers: [],
                transactTx: {
                    data: encodeFunctionData({
                        abi: POOL_VAULT_TRANSACT_ABI,
                        functionName: "transact",
                        args: [bigProof, p.transactParams, NOTE_DATA] as never,
                    }),
                    to: DEP.ppUSDC,
                    value: "0x0" as Hex,
                },
                spentNotes: [],
                notesData: [],
                proof: {},
            })),
            transact: vi.fn(),
        } as unknown as ITransactOrchestrator;
        session = new EvmPoolSessionYieldWithdraw({
            deployment: DEP,
            orchestrator: bigOrchestrator,
            router,
        });

        const result = await session.prepareYieldWithdraw(baseParams());
        const decoded = decodeFunctionData({
            abi: PP_ROUTER_WITHDRAW_ABI,
            data: result.withdrawTx.data,
        });
        expect(decoded.args[0]).toEqual(bigProof);
    });

    it("allows slippageBps = 0 (no floor: min == quote)", async () => {
        const result = await session.prepareYieldWithdraw({ ...baseParams(), slippageBps: 0n });
        expect(result.minUnderlyingOut).toBe(QUOTED_OUT);
    });

    it("allows slippageBps = 100% (floor of 0)", async () => {
        const result = await session.prepareYieldWithdraw({
            ...baseParams(),
            slippageBps: 10_000n,
        });
        expect(result.minUnderlyingOut).toBe(0n);
    });

    it("handles a full fee (recipientShares = 0, quotes 0)", async () => {
        router = mockRouter(0n);
        session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator, router });
        const result = await session.prepareYieldWithdraw({
            ...baseParams(),
            feeAmount: AMOUNT_OUT,
        });
        expect(result.recipientShares).toBe(0n);
        expect(router.quoteWithdraw).toHaveBeenCalledWith(0n);
        expect(result.minUnderlyingOut).toBe(0n);
    });

    it("floors minUnderlyingOut (integer bigint division)", async () => {
        router = mockRouter(999_999n);
        session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator, router });
        const result = await session.prepareYieldWithdraw(baseParams());
        // 999_999 * 9900 / 10000 = 989_999.01 -> floor 989_999
        expect(result.minUnderlyingOut).toBe(989_999n);
    });

    it("keeps amount independent of amountOut (partial pool release)", async () => {
        const partialAmount = AMOUNT_OUT / 2n;
        await session.prepareYieldWithdraw({ ...baseParams(), amount: partialAmount });
        expect(calls[0].amount).toBe(bigintToHex(partialAmount));
        expect(calls[0].amountOut).toBe(bigintToHex(AMOUNT_OUT));
    });

    it("uses recipient as the default feeRecipient", async () => {
        await session.prepareYieldWithdraw(baseParams());
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_ABI, calls[0].transactParams!.data);
        expect((payout.feeRecipient as string).toLowerCase()).toBe(RECIPIENT.toLowerCase());
    });

    it("honors an explicit feeRecipient override", async () => {
        const feeRecipient = "0x000000000000000000000000000000000000dead" as Address;
        await session.prepareYieldWithdraw({ ...baseParams(), feeRecipient });
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_ABI, calls[0].transactParams!.data);
        expect((payout.feeRecipient as string).toLowerCase()).toBe(feeRecipient.toLowerCase());
        expect(calls[0].feeRecipient).toBe(feeRecipient);
    });

    it("supports a relayed withdrawal (fee leg to the relayer, broadcastable withdrawTx)", async () => {
        // Relayed model: the relayer is paid via the fee leg and broadcasts withdrawTx on the
        // user's behalf. The user's protection (payout bound in the proof, minUnderlyingOut floor)
        // holds regardless of who submits.
        const relayerAddr = "0x000000000000000000000000000000000000a11a" as Address;
        const relayerFee = 50_000_000_000_000_000n; // 0.05 ppUSDC fee to the relayer
        const result = await session.prepareYieldWithdraw({
            ...baseParams(),
            feeRecipient: relayerAddr,
            feeAmount: relayerFee,
        });

        // Fee routed to the relayer; recipient leg excludes it.
        const [payout] = decodeAbiParameters(PAYOUT_ROUTING_ABI, calls[0].transactParams!.data);
        expect((payout.feeRecipient as string).toLowerCase()).toBe(relayerAddr.toLowerCase());
        expect(payout.feeAmount).toBe(relayerFee);
        expect(result.recipientShares).toBe(AMOUNT_OUT - relayerFee);
        // withdrawTx is the complete PPRouter call a relayer broadcasts.
        expect(result.withdrawTx.to).toBe(DEP.ppRouter);
        expect(
            decodeFunctionData({ abi: PP_ROUTER_WITHDRAW_ABI, data: result.withdrawTx.data })
                .functionName,
        ).toBe("withdrawToUnderlying");
    });

    it("rejects a zero recipient before building the proof", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), recipient: ZERO_ADDR }),
        ).rejects.toBeInstanceOf(InvalidYieldAddress);
        expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
    });

    it("rejects a negative nativeGas", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), nativeGas: -1n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("rejects a negative slippageBps", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), slippageBps: -1n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("rejects a negative amountOut", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), amountOut: -1n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("rejects a negative feeAmount", async () => {
        await expect(
            session.prepareYieldWithdraw({ ...baseParams(), feeAmount: -1n }),
        ).rejects.toBeInstanceOf(InvalidYieldAmount);
    });

    it("forwards a zero feeAmount by default", async () => {
        await session.prepareYieldWithdraw(baseParams());
        expect(BigInt(calls[0].feeAmount)).toBe(0n);
    });

    it("propagates an orchestrator error", async () => {
        const failing = {
            prepareTransact: vi.fn(async () => {
                throw new Error("proof failed");
            }),
            transact: vi.fn(),
        } as unknown as ITransactOrchestrator;
        session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator: failing, router });
        await expect(session.prepareYieldWithdraw(baseParams())).rejects.toThrow("proof failed");
    });

    it("propagates a router quoteWithdraw error", async () => {
        const badRouter = {
            getAddress: () => DEP.ppRouter,
            quote: vi.fn(async () => ({ underlyingNeeded: 0n, total: 0n })),
            quoteWithdraw: vi.fn(async () => {
                throw new Error("rpc down");
            }),
            supplyBufferUnits: vi.fn(async () => 2n),
        } as IPPRouterInteractor;
        session = new EvmPoolSessionYieldWithdraw({
            deployment: DEP,
            orchestrator,
            router: badRouter,
        });
        await expect(session.prepareYieldWithdraw(baseParams())).rejects.toThrow("rpc down");
    });

    it("logs the sizing when a logger is supplied", async () => {
        const debug = vi.fn();
        const logger = {
            debug,
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        } as unknown as ILogger;
        session = new EvmPoolSessionYieldWithdraw(
            { deployment: DEP, orchestrator, router },
            { logger },
        );
        await session.prepareYieldWithdraw(baseParams());
        expect(debug).toHaveBeenCalledWith("prepared yield withdraw", expect.any(Object));
    });

    it("throws UnexpectedWithdrawCalldata when the base calldata is not a transact", async () => {
        const bad = {
            prepareTransact: vi.fn(async () => ({
                changePendingNotes: [],
                recipientPendingNotes: [],
                spentNullifiers: [],
                // unknown selector -> decode throws
                transactTx: { data: "0xdeadbeef" as Hex, to: DEP.ppUSDC, value: "0x0" as Hex },
                spentNotes: [],
                notesData: [],
                proof: {},
            })),
            transact: vi.fn(),
        } as unknown as ITransactOrchestrator;
        session = new EvmPoolSessionYieldWithdraw({ deployment: DEP, orchestrator: bad, router });
        await expect(session.prepareYieldWithdraw(baseParams())).rejects.toBeInstanceOf(
            UnexpectedWithdrawCalldata,
        );
    });

    describe("prepareYieldWithdrawRelay", () => {
        const ATTACKER = "0x00000000000000000000000000000000deadbeef" as Address;

        // Build a relayer-signed withdrawal commitment. Defaults describe an HONEST relayer:
        // routing recipient == caller recipient, asset == ppUSDC, fee 0, no native gas, live.
        function makeCommitment(overrides?: {
            routingRecipient?: Address;
            feeAmount?: bigint;
            nativeGas?: bigint;
            asset?: Hex;
            commitmentFeeAmount?: string;
            amountSent?: string;
            amountReceived?: string;
        }): WithdrawalFeeCommitment {
            const routingRecipient = overrides?.routingRecipient ?? RECIPIENT;
            const feeAmount = overrides?.feeAmount ?? 0n;
            const data = encodeAbiParameters(PAYOUT_ROUTING_ABI, [
                {
                    recipient: routingRecipient,
                    feeRecipient: routingRecipient,
                    feeAmount,
                    nativeGas: overrides?.nativeGas ?? 0n,
                },
            ]) as Hex;
            return {
                data,
                asset: overrides?.asset ?? DEP.ppUSDC,
                expiration: Date.now() + 600_000,
                feeAmount: overrides?.commitmentFeeAmount ?? feeAmount.toString(),
                signedRelayerCommitment: "0xdead" as Hex,
                recipient: routingRecipient,
                amountSent: overrides?.amountSent ?? AMOUNT_OUT.toString(),
                amountReceived: overrides?.amountReceived ?? AMOUNT_OUT.toString(),
                extraGas: false,
            };
        }

        function relayParams(
            commitment: WithdrawalFeeCommitment,
            extraGas?: boolean,
        ): YieldWithdrawRelayParams {
            return {
                inputCommitments: [COMMITMENT],
                amount: AMOUNT_OUT,
                amountOut: AMOUNT_OUT,
                recipient: RECIPIENT,
                signedFeeCommitment: commitment,
                ...(extraGas === undefined ? {} : { extraGas }),
            };
        }

        it("returns relay params (processorAddress + minUnderlyingOut) for an honest routing", async () => {
            const res = await session.prepareYieldWithdrawRelay(relayParams(makeCommitment()));
            expect(res.relayParams.processorAddress).toBe(DEP.ppRouter);
            expect(res.relayParams.minUnderlyingOut).toBeDefined();
            expect(BigInt(res.relayParams.minUnderlyingOut ?? "0x0")).toBeGreaterThan(0n);
            expect(res.relayParams.signedFeeCommitment).toBeDefined();
        });

        // Theft guard: a malicious relayer names its OWN address as the routing recipient. The proof
        // would otherwise be authorized paying the attacker (supplying transactParams bypasses the
        // orchestrator's recipient handling). Must reject BEFORE any proof is built.
        it("rejects a routing recipient that is not the caller's recipient (theft)", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ routingRecipient: ATTACKER })),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
        });

        it("rejects a commitment for a non-ppUSDC asset", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ asset: ZERO_ADDR })),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
        });

        it("rejects when the routing feeAmount diverges from the committed feeAmount", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ feeAmount: 5n, commitmentFeeAmount: "6" })),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
        });

        it("rejects a routing that smuggles non-zero nativeGas when no top-up was requested", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(relayParams(makeCommitment({ nativeGas: 1n }))),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
        });

        // extraGas on the share route: the relayer attaches `nativeGas` as msg.value on
        // PPRouter.withdrawToUnderlying and the router forwards it to the recipient, so a user
        // exiting ppUSDC to a fresh address can be funded for gas. Only PRESENCE is pinned; the
        // amount is relayer-computed and already priced into the fee.
        it("accepts a routing carrying nativeGas when the top-up was requested", async () => {
            const res = await session.prepareYieldWithdrawRelay(
                relayParams(makeCommitment({ nativeGas: 34_883_848_200_000n }), true),
            );
            expect(res.relayParams.processorAddress).toBe(DEP.ppRouter);
            expect(orchestrator.prepareTransact).toHaveBeenCalled();
        });

        // The mirror case, and the reason presence is pinned at all: the top-up is priced into the
        // fee the user already agreed to, so a zeroed-out routing means paying for gas the recipient
        // never receives.
        it("rejects a zeroed nativeGas when the top-up was requested", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(relayParams(makeCommitment(), true)),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
        });

        it("defaults to no top-up when extraGas is omitted", async () => {
            const res = await session.prepareYieldWithdrawRelay(relayParams(makeCommitment()));
            expect(res.relayParams.processorAddress).toBe(DEP.ppRouter);
        });

        it("rejects an already-expired commitment before proving", async () => {
            const expired = { ...makeCommitment(), expiration: Date.now() - 1 };
            await expect(session.prepareYieldWithdrawRelay(relayParams(expired))).rejects.toThrow();
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
        });

        // M-1: the slippage floor must be sized from the caller's OWN recipient leg (amountOut - fee),
        // never from the relayer's unverified `amountReceived`. A relayer under-reports amountReceived
        // to "1"; the floor must still quote the real recipient leg (AMOUNT_OUT, fee 0), not 1.
        it("sizes minUnderlyingOut from amountOut-fee, ignoring the relayer's amountReceived", async () => {
            const res = await session.prepareYieldWithdrawRelay(
                relayParams(makeCommitment({ amountReceived: "1" })),
            );
            expect(router.quoteWithdraw).toHaveBeenCalledWith(AMOUNT_OUT);
            expect(router.quoteWithdraw).not.toHaveBeenCalledWith(1n);
            expect(res.recipientShares).toBe(AMOUNT_OUT);
        });

        // L-1: the committed total-out must equal the caller's amountOut, else the relayer's own
        // on-chain submit reverts after the expensive proof build. Fail fast, before proving.
        it("rejects when committed amountSent does not equal the caller's amountOut", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ amountSent: (AMOUNT_OUT + 1n).toString() })),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
            // Share-denominated: the relayer fee on this route is taken in ppUSDC
            // shares, so rendering these under the underlying would misname them.
            const error = await session
                .prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ amountSent: (AMOUNT_OUT + 1n).toString() })),
                )
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts).toEqual({
                code: "commitmentAmountSentMismatch",
                side: "spent",
                values: { amountSent: AMOUNT_OUT + 1n, expected: AMOUNT_OUT },
            });
        });

        it("rejects a committed fee that exceeds amountOut", async () => {
            const tooBig = (AMOUNT_OUT + 1n).toString();
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(
                        makeCommitment({ feeAmount: AMOUNT_OUT + 1n, commitmentFeeAmount: tooBig }),
                    ),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(orchestrator.prepareTransact).not.toHaveBeenCalled();
            const error = await session
                .prepareYieldWithdrawRelay(
                    relayParams(
                        makeCommitment({ feeAmount: AMOUNT_OUT + 1n, commitmentFeeAmount: tooBig }),
                    ),
                )
                .catch((e: unknown) => e);
            expect(hasErrorAmounts(error) && error.amounts).toEqual({
                code: "commitmentFeeExceedsAmountOut",
                side: "spent",
                values: { fee: AMOUNT_OUT + 1n, amountOut: AMOUNT_OUT },
            });
        });

        // L-2: relayer-supplied commitment amounts are decimal strings fed to BigInt(); malformed
        // input must yield a typed error (not a raw SyntaxError, and "" must not coerce to 0).
        it("rejects a malformed (non-numeric) committed feeAmount", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(
                    relayParams(makeCommitment({ commitmentFeeAmount: "abc" })),
                ),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
        });

        it("rejects an empty committed amountSent", async () => {
            await expect(
                session.prepareYieldWithdrawRelay(relayParams(makeCommitment({ amountSent: "" }))),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
        });
    });
});
