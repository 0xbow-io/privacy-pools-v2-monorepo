import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    EstimateReshieldParams,
    Hex,
    IAddressEqualityComparator,
    IPoolSessionReshield,
    PreparedTransaction,
    PrepareReshieldQuoteParams,
    PrepareReshieldTransferDepositParams,
    ReshieldEstimate,
    ReshieldTransferParams,
    TxReceipt,
    YieldSwapDepositTarget,
} from "../../../src/internal.js";
import {
    InvalidTransactParams,
    PoolSessionReshieldTransfer,
    YieldTargetNotConfigured,
} from "../../../src/internal.js";

const SHARE = "0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6" as Address;
const UNCONFIGURED_TOKEN = "0x1111111111111111111111111111111111111111" as Address;
const RECIPIENT_ADDRESS = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const NOTE_ADDRESS_HASH =
    "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex;
const ROUTER = "0xe76E793d776c1e207aD7a7fa7C57d27420d85110" as Address;
const UNDERLYING = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const BUDGET = 1_000_000n;

const addressEqualityComparator: IAddressEqualityComparator<Address> = {
    equals: (a, b) => a.toLowerCase() === b.toLowerCase(),
};

function makeYieldTarget(): YieldSwapDepositTarget<PreparedTransaction, Address> & {
    forCalls: unknown[];
    selfCalls: unknown[];
} {
    const forCalls: unknown[] = [];
    const selfCalls: unknown[] = [];
    const pendingNote = { tokenId: SHARE, value: "0x1" as Hex };
    return {
        chainId: 1,
        shareToken: SHARE,
        router: ROUTER,
        fundingToken: UNDERLYING,
        forCalls,
        selfCalls,
        sizeSharesForBudget: vi.fn(async (budget: bigint) => ({ shares: budget })),
        prepareSwapDeposit: vi.fn(async (budget: bigint, headroomPpm: bigint | undefined, recipient: unknown) => {
            if (recipient === undefined) {
                selfCalls.push({ budget, headroomPpm });
            } else {
                forCalls.push(recipient);
            }
            return {
                pendingNote,
                depositTx: { to: ROUTER, data: "0xdead" as Hex, value: "0x0" as Hex },
                approvalTxs: [],
                approvalTx: null,
                noteSecret: undefined as Hex | undefined,
            };
        }),
        assertDepositMatches: vi.fn(),
    } as unknown as YieldSwapDepositTarget<PreparedTransaction, Address> & {
        forCalls: unknown[];
        selfCalls: unknown[];
    };
}

function mockReshieldDelegate(): IPoolSessionReshield {
    return {
        estimateReshieldAmount: vi.fn(async () => ({}) as ReshieldEstimate),
        prepareReshieldQuote: vi.fn(async () => ({}) as never),
        relayReshield: vi.fn(async () => ({ status: true }) as unknown as TxReceipt),
    };
}

describe("PoolSessionReshieldTransfer", () => {
    describe("estimateReshieldTransferAmount", () => {
        it("delegates to reshieldDelegate.estimateReshieldAmount when outputToken is configured", async () => {
            const target = makeYieldTarget();
            const reshieldDelegate = mockReshieldDelegate();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate,
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });
            const params = { outputToken: SHARE } as EstimateReshieldParams;

            await session.estimateReshieldTransferAmount(params);

            expect(reshieldDelegate.estimateReshieldAmount).toHaveBeenCalledWith(params);
        });

        it("throws YieldTargetNotConfigured and never calls the delegate for an unconfigured outputToken", async () => {
            const target = makeYieldTarget();
            const reshieldDelegate = mockReshieldDelegate();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate,
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await expect(
                session.estimateReshieldTransferAmount({
                    outputToken: UNCONFIGURED_TOKEN,
                } as EstimateReshieldParams),
            ).rejects.toBeInstanceOf(YieldTargetNotConfigured);
            expect(reshieldDelegate.estimateReshieldAmount).not.toHaveBeenCalled();
        });
    });

    describe("prepareReshieldTransferDeposit", () => {
        it("throws YieldTargetNotConfigured for an unconfigured outputToken", async () => {
            const target = makeYieldTarget();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate: mockReshieldDelegate(),
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await expect(
                session.prepareReshieldTransferDeposit({
                    outputToken: UNCONFIGURED_TOKEN,
                    totalDepositCost: BUDGET.toString(),
                    noteAddressHash: NOTE_ADDRESS_HASH,
                } as PrepareReshieldTransferDepositParams),
            ).rejects.toBeInstanceOf(YieldTargetNotConfigured);
        });

        it("routes a blind noteAddressHash recipient through prepareSwapDeposit with the budget sized", async () => {
            const target = makeYieldTarget();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate: mockReshieldDelegate(),
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });

            const result = await session.prepareReshieldTransferDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                noteAddressHash: NOTE_ADDRESS_HASH,
            } as PrepareReshieldTransferDepositParams);

            expect(target.forCalls).toHaveLength(1);
            expect(target.forCalls[0]).toMatchObject({
                noteAddressHash: NOTE_ADDRESS_HASH,
            });
            expect(target.selfCalls).toHaveLength(0);
            expect(result.depositTx.to).toBe(ROUTER);
        });

        it("routes a discoveryData recipient through prepareSwapDeposit", async () => {
            const target = makeYieldTarget();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate: mockReshieldDelegate(),
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });
            const discoveryData = { evmAddress: RECIPIENT_ADDRESS };

            await session.prepareReshieldTransferDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                discoveryData,
            } as PrepareReshieldTransferDepositParams);

            expect(target.forCalls[0]).toMatchObject({ discoveryData });
        });

        it("surfaces noteSecret on the result when the out-of-band fallback fired", async () => {
            const target = makeYieldTarget();
            const secret =
                "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
            (target.prepareSwapDeposit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                pendingNote: { tokenId: SHARE, value: "0x1" as Hex },
                depositTx: { to: ROUTER, data: "0xdead" as Hex, value: "0x0" as Hex },
                approvalTxs: [],
                approvalTx: null,
                noteSecret: secret,
            });
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate: mockReshieldDelegate(),
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });

            const result = await session.prepareReshieldTransferDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                discoveryData: { evmAddress: RECIPIENT_ADDRESS, allowOutOfBandFallback: true },
            } as PrepareReshieldTransferDepositParams);

            expect(result.noteSecret).toBe(secret);
        });

        it("never self-deposits — prepareSwapDeposit is always called with a recipient", async () => {
            const target = makeYieldTarget();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate: mockReshieldDelegate(),
                yieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await session.prepareReshieldTransferDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                noteAddressHash: NOTE_ADDRESS_HASH,
            } as PrepareReshieldTransferDepositParams);

            expect(target.selfCalls).toHaveLength(0);
        });
    });

    describe("prepareReshieldTransferQuote", () => {
        it("delegates verbatim to reshieldDelegate.prepareReshieldQuote", async () => {
            const reshieldDelegate = mockReshieldDelegate();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate,
                yieldDepositTargets: [makeYieldTarget()],
                addressEqualityComparator,
            });
            const params = {
                outputToken: SHARE,
                depositResult: {
                    pendingNote: { tokenId: SHARE, value: "0x1" as Hex, isOwned: false },
                },
            } as PrepareReshieldQuoteParams;

            await session.prepareReshieldTransferQuote(params);

            expect(reshieldDelegate.prepareReshieldQuote).toHaveBeenCalledWith(params);
        });

        it("throws InvalidTransactParams and never calls the delegate when depositResult is self-owned", async () => {
            const reshieldDelegate = mockReshieldDelegate();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate,
                yieldDepositTargets: [makeYieldTarget()],
                addressEqualityComparator,
            });
            const params = {
                outputToken: SHARE,
                depositResult: {
                    pendingNote: { tokenId: SHARE, value: "0x1" as Hex, isOwned: true },
                },
            } as PrepareReshieldQuoteParams;

            await expect(session.prepareReshieldTransferQuote(params)).rejects.toBeInstanceOf(
                InvalidTransactParams,
            );
            expect(reshieldDelegate.prepareReshieldQuote).not.toHaveBeenCalled();
        });
    });

    describe("relayReshieldTransfer", () => {
        it("delegates verbatim to reshieldDelegate.relayReshield", async () => {
            const reshieldDelegate = mockReshieldDelegate();
            const session = new PoolSessionReshieldTransfer({
                reshieldDelegate,
                yieldDepositTargets: [makeYieldTarget()],
                addressEqualityComparator,
            });
            const params = { outputToken: SHARE } as ReshieldTransferParams;

            const receipt = await session.relayReshieldTransfer(params);

            expect(reshieldDelegate.relayReshield).toHaveBeenCalledWith(params);
            expect(receipt.status).toBe(true);
        });
    });
});

// A plain (non-yield-share) output for a third-party recipient: the deposit is built with the
// session's own `prepareDepositFor`, and everything after it (quote, relay) is the same delegate.
describe("PoolSessionReshieldTransfer with a depositDelegate (plain output)", () => {
    const PLAIN_TOKEN = UNCONFIGURED_TOKEN;
    const NOTE_VALUE = "0xf3e58" as Hex;
    const NOTE_SECRET = "0x7777777777777777777777777777777777777777777777777777777777777777" as Hex;

    function makeDepositDelegate(isOwned = false) {
        const calls: unknown[] = [];
        return {
            calls,
            prepareDepositFor: vi.fn(async (params: unknown) => {
                calls.push(params);
                return {
                    pendingNote: { tokenId: PLAIN_TOKEN, value: NOTE_VALUE, isOwned },
                    depositTx: { to: ROUTER, data: "0xbeef" as Hex, value: "0x0" as Hex },
                    approvalTxs: [],
                    approvalTx: null,
                    noteSecret: undefined as Hex | undefined,
                };
            }),
        };
    }

    function make(over: { yieldTargets?: YieldSwapDepositTarget<PreparedTransaction, Address>[]; owned?: boolean } = {}) {
        const depositDelegate = makeDepositDelegate(over.owned);
        const reshieldDelegate = mockReshieldDelegate();
        const session = new PoolSessionReshieldTransfer({
            reshieldDelegate,
            yieldDepositTargets: over.yieldTargets ?? [],
            depositDelegate: depositDelegate as never,
            addressEqualityComparator,
        });
        return { session, depositDelegate, reshieldDelegate };
    }

    it("estimates a plain output through the reshield delegate instead of refusing it", async () => {
        const { session, reshieldDelegate } = make();
        const params = { outputToken: PLAIN_TOKEN } as EstimateReshieldParams;

        await session.estimateReshieldTransferAmount(params);

        expect(reshieldDelegate.estimateReshieldAmount).toHaveBeenCalledWith(params);
    });

    it("builds the plain deposit FOR the recipient, valued at the estimate's noteValue", async () => {
        const { session, depositDelegate } = make();

        const result = await session.prepareReshieldTransferDeposit({
            outputToken: PLAIN_TOKEN,
            totalDepositCost: BUDGET.toString(),
            noteValue: NOTE_VALUE,
            discoveryData: { evmAddress: RECIPIENT_ADDRESS },
        } as PrepareReshieldTransferDepositParams);

        expect(depositDelegate.calls).toEqual([
            { discoveryData: { evmAddress: RECIPIENT_ADDRESS }, tokenId: PLAIN_TOKEN, value: NOTE_VALUE },
        ]);
        expect(result.pendingNote.isOwned).toBe(false);
    });

    // totalDepositCost already carries the vetting fee; prepareReshieldQuote re-checks it against
    // noteValue + fee, so using it as the value would double-count the fee and be refused there.
    it("never uses the budget as the deposit value", async () => {
        const { session, depositDelegate } = make();

        await session.prepareReshieldTransferDeposit({
            outputToken: PLAIN_TOKEN,
            totalDepositCost: BUDGET.toString(),
            noteValue: NOTE_VALUE,
            discoveryData: { evmAddress: RECIPIENT_ADDRESS },
        } as PrepareReshieldTransferDepositParams);

        const sent = depositDelegate.calls[0] as { value: Hex };
        expect(sent.value).toBe(NOTE_VALUE);
        expect(sent.value).not.toBe(`0x${BUDGET.toString(16)}`);
    });

    it("passes a blind noteAddressHash recipient through unchanged", async () => {
        const { session, depositDelegate } = make();

        await session.prepareReshieldTransferDeposit({
            outputToken: PLAIN_TOKEN,
            totalDepositCost: BUDGET.toString(),
            noteValue: NOTE_VALUE,
            noteAddressHash: NOTE_ADDRESS_HASH,
            noteData: { hint: "0x01" as Hex, data: "0x02" as Hex },
            depositSecret: NOTE_SECRET,
        } as PrepareReshieldTransferDepositParams);

        expect(depositDelegate.calls).toEqual([
            {
                noteAddressHash: NOTE_ADDRESS_HASH,
                noteData: { hint: "0x01", data: "0x02" },
                depositSecret: NOTE_SECRET,
                tokenId: PLAIN_TOKEN,
                value: NOTE_VALUE,
            },
        ]);
    });

    it("requires noteValue for a plain output and builds nothing without it", async () => {
        const { session, depositDelegate } = make();

        await expect(
            session.prepareReshieldTransferDeposit({
                outputToken: PLAIN_TOKEN,
                totalDepositCost: BUDGET.toString(),
                discoveryData: { evmAddress: RECIPIENT_ADDRESS },
            } as PrepareReshieldTransferDepositParams),
        ).rejects.toBeInstanceOf(InvalidTransactParams);
        expect(depositDelegate.prepareDepositFor).not.toHaveBeenCalled();
    });

    it("refuses a deposit that came back owned by this session", async () => {
        const { session } = make({ owned: true });

        await expect(
            session.prepareReshieldTransferDeposit({
                outputToken: PLAIN_TOKEN,
                totalDepositCost: BUDGET.toString(),
                noteValue: NOTE_VALUE,
                discoveryData: { evmAddress: RECIPIENT_ADDRESS },
            } as PrepareReshieldTransferDepositParams),
        ).rejects.toBeInstanceOf(InvalidTransactParams);
    });

    it("lets a configured yield share win when both could serve the output", async () => {
        const target = makeYieldTarget();
        const { session, depositDelegate } = make({ yieldTargets: [target] });

        await session.prepareReshieldTransferDeposit({
            outputToken: SHARE,
            totalDepositCost: BUDGET.toString(),
            noteAddressHash: NOTE_ADDRESS_HASH,
        } as PrepareReshieldTransferDepositParams);

        expect(target.forCalls).toHaveLength(1);
        expect(depositDelegate.prepareDepositFor).not.toHaveBeenCalled();
    });

    it("keeps refusing a non-share output when there is no deposit delegate", async () => {
        const session = new PoolSessionReshieldTransfer({
            reshieldDelegate: mockReshieldDelegate(),
            yieldDepositTargets: [],
            addressEqualityComparator,
        });

        await expect(
            session.estimateReshieldTransferAmount({ outputToken: PLAIN_TOKEN } as EstimateReshieldParams),
        ).rejects.toBeInstanceOf(YieldTargetNotConfigured);
    });

    it("still refuses a self-owned deposit result at the quote step", async () => {
        const { session } = make();

        await expect(
            session.prepareReshieldTransferQuote({
                depositResult: { pendingNote: { isOwned: true } },
            } as unknown as PrepareReshieldQuoteParams<PreparedTransaction, Address>),
        ).rejects.toBeInstanceOf(InvalidTransactParams);
    });
});

describe("PoolSessionReshieldTransfer plain pool rule (funding token of a configured share)", () => {
    // Generic rule: the fixture share is funded by UNDERLYING; a token and a native with no share stay plain.
    const FUNDING = UNDERLYING;
    const NO_SHARE_TOKEN = "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409" as Address;
    const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as Address;
    const NOTE_VALUE = "0xf3e58" as Hex;

    function make(targets: YieldSwapDepositTarget<PreparedTransaction, Address>[]) {
        const depositDelegate = {
            prepareDepositFor: vi.fn(async () => ({
                pendingNote: { tokenId: NO_SHARE_TOKEN, value: NOTE_VALUE, isOwned: false },
                depositTx: { to: ROUTER, data: "0xbeef" as Hex, value: "0x0" as Hex },
                approvalTxs: [],
                approvalTx: null,
                noteSecret: undefined as Hex | undefined,
            })),
        };
        const reshieldDelegate = mockReshieldDelegate();
        const session = new PoolSessionReshieldTransfer({
            reshieldDelegate,
            yieldDepositTargets: targets,
            depositDelegate: depositDelegate as never,
            addressEqualityComparator,
        });
        return { session, depositDelegate, reshieldDelegate };
    }

    const depositParams = (outputToken: Address) =>
        ({
            outputToken,
            totalDepositCost: BUDGET.toString(),
            noteValue: NOTE_VALUE,
            discoveryData: { evmAddress: RECIPIENT_ADDRESS },
        }) as PrepareReshieldTransferDepositParams;

    it("refuses a plain output that is the underlying of a configured share, before any work", async () => {
        const target = makeYieldTarget();
        const { session, depositDelegate, reshieldDelegate } = make([target]);

        await expect(session.prepareReshieldTransferDeposit(depositParams(FUNDING.toLowerCase() as Address))).rejects.toThrow(
            InvalidTransactParams,
        );
        await expect(session.prepareReshieldTransferDeposit(depositParams(FUNDING))).rejects.toThrow(/pass the share/i);
        await expect(
            session.estimateReshieldTransferAmount({ outputToken: FUNDING } as EstimateReshieldParams),
        ).rejects.toBeInstanceOf(InvalidTransactParams);
        expect(depositDelegate.prepareDepositFor).not.toHaveBeenCalled();
        expect(reshieldDelegate.estimateReshieldAmount).not.toHaveBeenCalled();
        expect(target.forCalls).toHaveLength(0);
    });

    it("refuses plain native when a native-mode share is configured", async () => {
        const target = { ...makeYieldTarget(), fundingToken: NATIVE } as YieldSwapDepositTarget<PreparedTransaction, Address>;
        const { session, depositDelegate } = make([target]);

        await expect(session.prepareReshieldTransferDeposit(depositParams(NATIVE))).rejects.toBeInstanceOf(
            InvalidTransactParams,
        );
        expect(depositDelegate.prepareDepositFor).not.toHaveBeenCalled();
    });

    it("still deposits plain an asset with no share (NO_SHARE_TOKEN-like token, BNB-like native)", async () => {
        const { session, depositDelegate } = make([makeYieldTarget()]);

        await session.prepareReshieldTransferDeposit(depositParams(NO_SHARE_TOKEN));
        await session.prepareReshieldTransferDeposit(depositParams(NATIVE));

        expect(depositDelegate.prepareDepositFor).toHaveBeenCalledTimes(2);
        expect(depositDelegate.prepareDepositFor.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
            expect.objectContaining({ tokenId: NO_SHARE_TOKEN, value: NOTE_VALUE }),
            expect.objectContaining({ tokenId: NATIVE, value: NOTE_VALUE }),
        ]);
    });

    it("leaves a share output unchanged", async () => {
        const target = makeYieldTarget();
        const { session, depositDelegate } = make([target]);

        await session.prepareReshieldTransferDeposit({
            outputToken: SHARE,
            totalDepositCost: BUDGET.toString(),
            noteAddressHash: NOTE_ADDRESS_HASH,
        } as PrepareReshieldTransferDepositParams);

        expect(target.forCalls).toHaveLength(1);
        expect(depositDelegate.prepareDepositFor).not.toHaveBeenCalled();
    });
});

describe("PoolSessionReshieldTransfer plain pool rule at the quote step", () => {
    function quoteParams(outputToken: Address, tokenId: Address) {
        return {
            outputToken,
            depositResult: { pendingNote: { isOwned: false, tokenId } },
        } as unknown as PrepareReshieldQuoteParams<PreparedTransaction, Address>;
    }

    function make() {
        const reshieldDelegate = mockReshieldDelegate();
        const session = new PoolSessionReshieldTransfer({
            reshieldDelegate,
            yieldDepositTargets: [makeYieldTarget()],
            depositDelegate: { prepareDepositFor: vi.fn() } as never,
            addressEqualityComparator,
        });
        return { session, reshieldDelegate };
    }

    it("refuses a hand-built plain deposit for a share's underlying, without quoting", async () => {
        const { session, reshieldDelegate } = make();

        await expect(session.prepareReshieldTransferQuote(quoteParams(UNDERLYING, UNDERLYING))).rejects.toThrow(
            /pass the share/i,
        );
        await expect(
            session.prepareReshieldTransferQuote(quoteParams(UNCONFIGURED_TOKEN, UNDERLYING)),
        ).rejects.toBeInstanceOf(InvalidTransactParams);
        expect(reshieldDelegate.prepareReshieldQuote).not.toHaveBeenCalled();
    });

    it("quotes a share output and a no-share plain output unchanged", async () => {
        const { session, reshieldDelegate } = make();

        await session.prepareReshieldTransferQuote(quoteParams(SHARE, SHARE));
        await session.prepareReshieldTransferQuote(quoteParams(UNCONFIGURED_TOKEN, UNCONFIGURED_TOKEN));

        expect(reshieldDelegate.prepareReshieldQuote).toHaveBeenCalledTimes(2);
    });
});
