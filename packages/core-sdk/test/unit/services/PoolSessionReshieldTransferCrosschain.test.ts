import { describe, expect, it, vi } from "vitest";

import type {
    Address,
    EstimateReshieldCrosschainParams,
    Hex,
    IAddressEqualityComparator,
    IPoolSessionReshieldCrosschain,
    PreparedTransaction,
    PrepareReshieldCrosschainQuoteParams,
    PrepareReshieldTransferCrosschainDepositParams,
    ReshieldCrosschainEstimate,
    ReshieldTransferCrosschainParams,
    TxReceipt,
    YieldSwapDepositTarget,
} from "../../../src/internal.js";
import {
    CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
    InvalidTransactParams,
    PoolSessionReshieldTransferCrosschain,
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

function makeDestinationYieldTarget(): YieldSwapDepositTarget<PreparedTransaction, Address> & {
    forCalls: unknown[];
    selfCalls: unknown[];
    sizeSharesForBudget: ReturnType<typeof vi.fn>;
} {
    const forCalls: unknown[] = [];
    const selfCalls: unknown[] = [];
    const pendingNote = { tokenId: SHARE, value: "0x1" as Hex };
    return {
        chainId: 2,
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
                forCalls.push({ ...(recipient as object), headroomPpm });
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
        sizeSharesForBudget: ReturnType<typeof vi.fn>;
    };
}

function mockReshieldCrosschainDelegate(): IPoolSessionReshieldCrosschain {
    return {
        estimateReshieldCrosschainAmount: vi.fn(async () => ({}) as ReshieldCrosschainEstimate),
        prepareReshieldCrosschainQuote: vi.fn(async () => ({}) as never),
        relayReshieldCrosschain: vi.fn(async () => ({ status: true }) as unknown as TxReceipt),
    };
}

describe("PoolSessionReshieldTransferCrosschain", () => {
    describe("estimateReshieldTransferCrosschainAmount", () => {
        it("delegates to reshieldCrosschainDelegate.estimateReshieldCrosschainAmount when outputToken is configured", async () => {
            const target = makeDestinationYieldTarget();
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });
            const params = { outputToken: SHARE } as EstimateReshieldCrosschainParams;

            await session.estimateReshieldTransferCrosschainAmount(params);

            expect(
                reshieldCrosschainDelegate.estimateReshieldCrosschainAmount,
            ).toHaveBeenCalledWith(params);
        });

        it("throws YieldTargetNotConfigured and never calls the delegate for an unconfigured outputToken", async () => {
            const target = makeDestinationYieldTarget();
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await expect(
                session.estimateReshieldTransferCrosschainAmount({
                    outputToken: UNCONFIGURED_TOKEN,
                } as EstimateReshieldCrosschainParams),
            ).rejects.toBeInstanceOf(YieldTargetNotConfigured);
            expect(
                reshieldCrosschainDelegate.estimateReshieldCrosschainAmount,
            ).not.toHaveBeenCalled();
        });
    });

    describe("prepareReshieldTransferCrosschainDeposit", () => {
        it("throws YieldTargetNotConfigured for an unconfigured outputToken", async () => {
            const target = makeDestinationYieldTarget();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate: mockReshieldCrosschainDelegate(),
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await expect(
                session.prepareReshieldTransferCrosschainDeposit({
                    outputToken: UNCONFIGURED_TOKEN,
                    totalDepositCost: BUDGET.toString(),
                    noteAddressHash: NOTE_ADDRESS_HASH,
                } as PrepareReshieldTransferCrosschainDepositParams),
            ).rejects.toBeInstanceOf(YieldTargetNotConfigured);
        });

        it("sizes with the cross-chain headroom and routes a blind recipient through prepareSwapDeposit", async () => {
            const target = makeDestinationYieldTarget();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate: mockReshieldCrosschainDelegate(),
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });

            const result = await session.prepareReshieldTransferCrosschainDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                noteAddressHash: NOTE_ADDRESS_HASH,
            } as PrepareReshieldTransferCrosschainDepositParams);

            expect(target.forCalls).toHaveLength(1);
            expect(target.forCalls[0]).toMatchObject({
                noteAddressHash: NOTE_ADDRESS_HASH,
                headroomPpm: CROSS_CHAIN_DEPOSIT_RATE_HEADROOM_PPM,
            });
            expect(target.selfCalls).toHaveLength(0);
            expect(result.depositTx.to).toBe(ROUTER);
        });

        it("routes a discoveryData recipient through prepareSwapDeposit", async () => {
            const target = makeDestinationYieldTarget();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate: mockReshieldCrosschainDelegate(),
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });
            const discoveryData = { evmAddress: RECIPIENT_ADDRESS };

            await session.prepareReshieldTransferCrosschainDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                discoveryData,
            } as PrepareReshieldTransferCrosschainDepositParams);

            expect(target.forCalls[0]).toMatchObject({ discoveryData });
        });

        it("surfaces noteSecret on the result when the out-of-band fallback fired", async () => {
            const target = makeDestinationYieldTarget();
            const secret =
                "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;
            (target.prepareSwapDeposit as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
                pendingNote: { tokenId: SHARE, value: "0x1" as Hex },
                depositTx: { to: ROUTER, data: "0xdead" as Hex, value: "0x0" as Hex },
                approvalTxs: [],
                approvalTx: null,
                noteSecret: secret,
            });
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate: mockReshieldCrosschainDelegate(),
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });

            const result = await session.prepareReshieldTransferCrosschainDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                discoveryData: { evmAddress: RECIPIENT_ADDRESS, allowOutOfBandFallback: true },
            } as PrepareReshieldTransferCrosschainDepositParams);

            expect(result.noteSecret).toBe(secret);
        });

        it("never self-deposits — prepareSwapDeposit is always called with a recipient", async () => {
            const target = makeDestinationYieldTarget();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate: mockReshieldCrosschainDelegate(),
                destinationYieldDepositTargets: [target],
                addressEqualityComparator,
            });

            await session.prepareReshieldTransferCrosschainDeposit({
                outputToken: SHARE,
                totalDepositCost: BUDGET.toString(),
                noteAddressHash: NOTE_ADDRESS_HASH,
            } as PrepareReshieldTransferCrosschainDepositParams);

            expect(target.selfCalls).toHaveLength(0);
        });
    });

    describe("prepareReshieldTransferCrosschainQuote", () => {
        it("delegates verbatim to reshieldCrosschainDelegate.prepareReshieldCrosschainQuote", async () => {
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [makeDestinationYieldTarget()],
                addressEqualityComparator,
            });
            const params = {
                outputToken: SHARE,
                depositResult: {
                    pendingNote: { tokenId: SHARE, value: "0x1" as Hex, isOwned: false },
                },
            } as PrepareReshieldCrosschainQuoteParams;

            await session.prepareReshieldTransferCrosschainQuote(params);

            expect(reshieldCrosschainDelegate.prepareReshieldCrosschainQuote).toHaveBeenCalledWith(
                params,
            );
        });

        it("throws InvalidTransactParams and never calls the delegate when depositResult is self-owned", async () => {
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [makeDestinationYieldTarget()],
                addressEqualityComparator,
            });
            const params = {
                outputToken: SHARE,
                depositResult: {
                    pendingNote: { tokenId: SHARE, value: "0x1" as Hex, isOwned: true },
                },
            } as PrepareReshieldCrosschainQuoteParams;

            await expect(
                session.prepareReshieldTransferCrosschainQuote(params),
            ).rejects.toBeInstanceOf(InvalidTransactParams);
            expect(
                reshieldCrosschainDelegate.prepareReshieldCrosschainQuote,
            ).not.toHaveBeenCalled();
        });
    });

    describe("relayReshieldTransferCrosschain", () => {
        it("delegates verbatim to reshieldCrosschainDelegate.relayReshieldCrosschain", async () => {
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [makeDestinationYieldTarget()],
                addressEqualityComparator,
            });
            const params = { outputToken: SHARE } as ReshieldTransferCrosschainParams;

            const receipt = await session.relayReshieldTransferCrosschain(params);

            expect(reshieldCrosschainDelegate.relayReshieldCrosschain).toHaveBeenCalledWith(params);
            expect(receipt.status).toBe(true);
        });

        it("forwards a dustRescue opt-in verbatim (recipientIdentifier is the originator, not the deposit recipient)", async () => {
            const reshieldCrosschainDelegate = mockReshieldCrosschainDelegate();
            const session = new PoolSessionReshieldTransferCrosschain({
                reshieldCrosschainDelegate,
                destinationYieldDepositTargets: [makeDestinationYieldTarget()],
                addressEqualityComparator,
            });
            const dustRescue = {
                recipientIdentifier: { kind: "raw" as const, spendingPubKey: "0xabc" as Hex },
            };
            const params = { outputToken: SHARE, dustRescue } as ReshieldTransferCrosschainParams;

            await session.relayReshieldTransferCrosschain(params);

            expect(reshieldCrosschainDelegate.relayReshieldCrosschain).toHaveBeenCalledWith(
                expect.objectContaining({ dustRescue }),
            );
        });
    });
});
