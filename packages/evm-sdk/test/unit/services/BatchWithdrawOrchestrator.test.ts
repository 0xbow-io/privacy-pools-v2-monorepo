import type { Mock } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    BatchWithdrawalRelayerQuote,
    Hash,
    Hex,
    INoteManager,
    ITransactOrchestrator,
    Label,
    Note,
    NoteData,
    PendingNote,
    PrepareTransactParams,
    PrepareTransactResult,
    Secret,
    TransactProof,
} from "../../../src/internal.js";
import {
    BatchRoutingInvalid,
    BatchRoutingMismatch,
    BatchTooLarge,
    BatchWithdrawOrchestrator,
    computeBatchItemFee,
    EmptyBatchSelection,
    EvmAddressEqualityComparator,
    EvmPayoutRoutingCodec,
    EvmPreparedTxVerifier,
    NoteStatus,
    PAYOUT_ROUTING_ABI,
    PAYOUT_ROUTING_ARRAY_ABI,
    PP_RELAY_BATCH_ABI,
    UnexpectedTransactionTarget,
} from "../../../src/internal.js";

// --- Constants ---

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const VALID_POOL = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
const TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const RELAY = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const MOCK_SECRET = "0x1111111111111111111111111111111111111111111111111111111111111111" as Secret;
const MOCK_NOTE_ADDRESS_HASH =
    "0x5555555555555555555555555555555555555555555555555555555555555555" as Hash;

// --- Helpers ---

function makeNote(overrides: Partial<Note> & { commitment: Hash; value: Hex; label: Label }): Note {
    return {
        noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
        tokenId: TOKEN,
        status: NoteStatus.ACTIVE,
        ownerAddress: VALID_OWNER,
        noteSecret: MOCK_SECRET,
        isOwned: true,
        createdAtBlock: "0x1" as Hex,
        spentAtBlock: null,
        txHash: "0xab" as Hash,
        ...overrides,
    } as Note;
}

function zeroChangeNote(label: Label): PendingNote {
    return {
        noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
        commitment: "0x9999999999999999999999999999999999999999999999999999999999999999" as Hash,
        value: "0x0" as Hex,
        tokenId: TOKEN,
        label,
        ownerAddress: VALID_OWNER,
        noteSecret: MOCK_SECRET,
        isOwned: true,
        status: NoteStatus.PENDING,
    };
}

/**
 * A fake ITransactOrchestrator whose prepareTransact deterministically echoes its
 * inputs: it returns one spent note per input commitment and a single zero-value
 * change note, so the batch aggregation is fully observable.
 */
const RELAY_CONTRACT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;
/**
 * Real `relayBatch` calldata, not a stub: `submitSelfSubmitBatch` decodes what it is about
 * to hand the wallet, so the fixture has to be the shape the relay contract takes.
 */
function encodeSelfBatchCallData(processors: Address[]): Hex {
    return encodeFunctionData({
        abi: PP_RELAY_BATCH_ABI,
        functionName: "relayBatch",
        args: [
            processors.map(() => ({
                pA: [0n, 0n] as readonly [bigint, bigint],
                pB: [
                    [0n, 0n],
                    [0n, 0n],
                ] as readonly [readonly [bigint, bigint], readonly [bigint, bigint]],
                pC: [0n, 0n] as readonly [bigint, bigint],
                pubSignals: [[0n]] as readonly (readonly bigint[])[],
            })),
            processors.map((processor) => ({ processor, data: "0x" as Hex })),
            processors.map(() => []),
        ],
    }) as Hex;
}

const SELF_BATCH_CALLDATA = encodeSelfBatchCallData([RELAY_CONTRACT]);
const SELF_BATCH_TXHASH = "0xbeef" as Hash;

function createFakeCore(): {
    core: ITransactOrchestrator;
    prepareTransact: Mock<[PrepareTransactParams], Promise<PrepareTransactResult>>;
    persistNoteUpdates: Mock<[], Promise<undefined>>;
    encodeRelayBatch: Mock<[Address, unknown[]], { to: Address; data: Hex; value: Hex }>;
    submit: Mock<[{ to: Address; data: Hex; value: Hex }], Promise<Hash>>;
} {
    const prepareTransact = vi.fn(
        async (params: PrepareTransactParams): Promise<PrepareTransactResult> => {
            const spentNotes = params.inputCommitments.map((commitment) =>
                makeNote({ commitment, value: "0x1" as Hex, label: "0xaa" as Label }),
            );
            const change = zeroChangeNote("0xaa" as Label);
            return {
                changePendingNotes: [change],
                recipientPendingNotes: [],
                transactTx: { data: "0xabcdef" as Hex, to: VALID_POOL, value: "0x0" as Hex },
                spentNotes,
                spentNullifiers: [],
                notesData: [
                    { hint: `0x${"00".repeat(32)}` as Hex, data: "0xdead" as Hex },
                ] as NoteData[],
                proof: {} as TransactProof,
            };
        },
    );
    const persistNoteUpdates = vi.fn(async () => undefined);
    const encodeRelayBatch = vi.fn((to: Address, _items: unknown[]) => ({
        to,
        data: SELF_BATCH_CALLDATA,
        value: "0x0" as Hex,
    }));
    const submit = vi.fn(async (_tx: { to: Address; data: Hex; value: Hex }) => SELF_BATCH_TXHASH);

    const core = {
        ownerAddress: VALID_OWNER,
        poolAddress: VALID_POOL,
        prepareTransact,
        persistNoteUpdates,
        encodeRelayBatch,
        submit,
        prepareRecipientNotes: vi.fn(),
    } as unknown as ITransactOrchestrator;

    return { core, prepareTransact, persistNoteUpdates, encodeRelayBatch, submit };
}

function createFakeNoteManager(notes: Note[]): {
    noteManager: INoteManager;
    getNotes: Mock<[], Note[]>;
} {
    const getNotes = vi.fn(() => notes);
    const noteManager = { getNotes } as unknown as INoteManager;
    return { noteManager, getNotes };
}

const BASE_PARAMS = {
    tokenId: TOKEN,
    recipientAddress: RECIPIENT,
    relayAddress: RELAY,
};

/** One PayoutRouting slot as the relayer signs it into the batch fee commitment. */
interface Routing { recipient: Address; feeRecipient: Address; feeAmount: bigint; nativeGas: bigint }

// The signed fee model the relayer commits to. bps model: each item pays
// relayCost + amountOut*feeBps/10000, capped at maxRelayFee.
const FEE_MODEL = { relayCost: 10n, feeBps: 1000n, flatFee: 0n, maxRelayFee: 100n };

/**
 * Builds a fake relayer batch quote for the given per-group `amountOuts`. By
 * default each routing's `feeAmount` is the NORMAL single-tx fee the orchestrator
 * recomputes and verifies (`computeBatchItemFee`). Pass `overrideFees` to forge a
 * tampered/concentrated split the verification must reject.
 */
function makeQuote(amountOuts: bigint[], overrideFees?: bigint[]): BatchWithdrawalRelayerQuote {
    const fees =
        overrideFees ??
        amountOuts.map((amountOut) => computeBatchItemFee({ ...FEE_MODEL, amountOut }));
    const routings: Routing[] = fees.map((feeAmount) => ({
        recipient: RECIPIENT,
        feeRecipient: RELAY,
        feeAmount,
        nativeGas: 0n,
    }));
    const data = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [routings]) as Hex;
    const totalFee = fees.reduce((sum, fee) => sum + fee, 0n).toString();
    return {
        txCost: "0x0",
        gasPrice: "0x0",
        totalFee,
        maxRelayFee: FEE_MODEL.maxRelayFee.toString(),
        feeCommitment: {
            data,
            asset: TOKEN as Hex,
            expiration: Date.now() + 60_000,
            totalFee,
            maxRelayFee: FEE_MODEL.maxRelayFee.toString(),
            relayCost: FEE_MODEL.relayCost.toString(),
            feeBps: FEE_MODEL.feeBps.toString(),
            flatFee: FEE_MODEL.flatFee.toString(),
            signedRelayerCommitment: "0x" as Hex,
        },
    };
}

// --- Tests ---

describe("BatchWithdrawOrchestrator", () => {
    let core: ITransactOrchestrator;
    let prepareTransact: ReturnType<typeof createFakeCore>["prepareTransact"];
    let persistNoteUpdates: ReturnType<typeof createFakeCore>["persistNoteUpdates"];

    beforeEach(() => {
        ({ core, prepareTransact, persistNoteUpdates } = createFakeCore());
    });

    function twoGroupNotes(): Note[] {
        // Two single-label lineages -> two groups: A (value 100), B (value 50).
        return [
            makeNote({ commitment: "0x01" as Hash, value: "0x64" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x02" as Hash, value: "0x32" as Hex, label: "0xbb" as Label }),
        ];
    }

    it("build one item per selected note group", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote([100n, 50n]),
        });

        expect(result.items).toHaveLength(2);
        expect(prepareTransact).toHaveBeenCalledTimes(2);
    });

    it("bind each item's recomputed normal single-tx fee from the quote", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // Each item pays its own single-tx fee: A(100) -> 10+10=20, B(50) -> 10+5=15.
        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote([100n, 50n]),
        });

        expect(BigInt(result.items[0].feeAmount)).toBe(20n);
        expect(BigInt(result.items[1].feeAmount)).toBe(15n);

        const feeSum = result.items.reduce((sum, item) => sum + BigInt(item.feeAmount), 0n);
        expect(feeSum).toBe(35n);
    });

    it("sum item amounts into totalAmountOut and totalFee", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote([100n, 50n]),
        });

        expect(BigInt(result.totalAmountOut)).toBe(150n); // 100 + 50
        expect(BigInt(result.totalFee)).toBe(35n); // 20 + 15
        expect(result.spentNotes).toHaveLength(2);
        expect(result.changePendingNotes).toHaveLength(2);
    });

    it("pass per-group amountOut, amount, and feeAmount to prepareTransact", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([100n, 50n]) });

        // Group A (value 100) pays its single-tx fee 20: amountOut 100, fee 20, amount 80.
        const callA = prepareTransact.mock.calls[0][0] as PrepareTransactParams;
        expect(BigInt(callA.amountOut)).toBe(100n);
        expect(BigInt(callA.feeAmount)).toBe(20n);
        expect(BigInt(callA.amount)).toBe(80n);

        // Group B (value 50) pays its single-tx fee 15: amountOut 50, fee 15, amount 35.
        const callB = prepareTransact.mock.calls[1][0] as PrepareTransactParams;
        expect(BigInt(callB.amountOut)).toBe(50n);
        expect(BigInt(callB.feeAmount)).toBe(15n);
        expect(BigInt(callB.amount)).toBe(35n);
    });

    it("derive inputNullifierNumber and outputCommitmentNumber per item", async () => {
        const notes = [
            makeNote({ commitment: "0x01" as Hash, value: "0x0a" as Hex, label: "0xaa" as Label }),
            makeNote({ commitment: "0x02" as Hash, value: "0x14" as Hex, label: "0xaa" as Label }),
        ];
        const { noteManager } = createFakeNoteManager(notes);
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // Single group of two notes -> amountOut 10 + 20 = 30.
        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote([30n]),
        });

        expect(result.items).toHaveLength(1);
        expect(result.items[0].inputNullifierNumber).toBe(2); // two notes in the group
        expect(result.items[0].outputCommitmentNumber).toBe(1); // one change note
    });

    it("not persist note updates during prepareBatchWithdraw", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([100n, 50n]) });

        expect(persistNoteUpdates).not.toHaveBeenCalled();
    });

    it("throw BatchRoutingMismatch when the quote routings do not match the groups", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // Two groups but only one routing encoded in the quote.
        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([100n]) }),
        ).rejects.toBeInstanceOf(BatchRoutingMismatch);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("throw BatchRoutingInvalid when a routing recipient differs from the requested recipient", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // Two groups: item 0's routing points at a different recipient than requested.
        const routings: Routing[] = [
            {
                recipient: "0x9999999999999999999999999999999999999999" as Address,
                feeRecipient: RELAY,
                feeAmount: 20n,
                nativeGas: 0n,
            },
            { recipient: RECIPIENT, feeRecipient: RELAY, feeAmount: 15n, nativeGas: 0n },
        ];
        const data = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [routings]) as Hex;
        const quote = makeQuote([100n, 50n]);
        quote.feeCommitment.data = data;

        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote }),
        ).rejects.toBeInstanceOf(BatchRoutingInvalid);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("throw BatchRoutingInvalid when a routing feeRecipient is inconsistent across the batch", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // The contract requires one shared feeRecipient; item 1 diverges. Must fail fast
        // (before any proof) rather than reverting on-chain after N proofs are built.
        const routings: Routing[] = [
            { recipient: RECIPIENT, feeRecipient: RELAY, feeAmount: 20n, nativeGas: 0n },
            {
                recipient: RECIPIENT,
                feeRecipient: "0x8888888888888888888888888888888888888888" as Address,
                feeAmount: 15n,
                nativeGas: 0n,
            },
        ];
        const data = encodeAbiParameters(PAYOUT_ROUTING_ARRAY_ABI, [routings]) as Hex;
        const quote = makeQuote([100n, 50n]);
        quote.feeCommitment.data = data;

        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote }),
        ).rejects.toBeInstanceOf(BatchRoutingInvalid);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("throw BatchRoutingInvalid when a greedy relayer concentrates the fee onto one item", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        // Fair per-item fees are [20, 15] (Σ = 35). A greedy relayer re-concentrates
        // the whole 35 onto item 0 (so it can cherry-pick that single proof via
        // relay() and pocket it). item 0's routing (35) != recomputed fee (20).
        await expect(
            orchestrator.prepareBatchWithdraw({
                ...BASE_PARAMS,
                quote: makeQuote([100n, 50n], [35n, 0n]),
            }),
        ).rejects.toBeInstanceOf(BatchRoutingInvalid);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("throw EmptyBatchSelection when the asset has no active notes", async () => {
        const { noteManager } = createFakeNoteManager([]);
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([]) }),
        ).rejects.toBeInstanceOf(EmptyBatchSelection);
    });

    it("throw EmptyBatchSelection (not a TypeError) for an explicit empty precomputed groups array", async () => {
        // A caller that supplies `groups: []` (an empty precomputed selection) alongside a
        // quote with zero routings must hit the empty-selection contract, NOT slip past the
        // 0-vs-0 routing-length match and TypeError on routings[0]. Notes exist here, proving
        // the guard rejects the explicit empty selection rather than falling back to auto-select.
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await expect(
            orchestrator.prepareBatchWithdraw({
                ...BASE_PARAMS,
                groups: [],
                quote: makeQuote([]),
            }),
        ).rejects.toBeInstanceOf(EmptyBatchSelection);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("throw BatchTooLarge when the selection exceeds MAX_BATCH", async () => {
        // 11 distinct labels -> 11 single-note groups, one over MAX_BATCH (10).
        const notes = Array.from({ length: 11 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: `0x${(0xa0 + i).toString(16)}` as Label,
            }),
        );
        const { noteManager } = createFakeNoteManager(notes);
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([]) }),
        ).rejects.toBeInstanceOf(BatchTooLarge);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("accept a selection of exactly MAX_BATCH (10) groups", async () => {
        // GAP-2 pass side: 10 distinct single-note labels -> exactly 10 groups, the
        // boundary that MUST succeed (contrast the 11-group reject above).
        const notes = Array.from({ length: 10 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x64" as Hex,
                label: `0x${(0xa0 + i).toString(16)}` as Label,
            }),
        );
        const { noteManager } = createFakeNoteManager(notes);
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote(Array.from({ length: 10 }, () => 100n)),
        });

        expect(result.items).toHaveLength(10);
        expect(prepareTransact).toHaveBeenCalledTimes(10);
    });

    it("throw BatchTooLarge when a single lineage chunks past MAX_BATCH", async () => {
        // GAP-2 chunk-overflow: 51 SAME-label notes @ maxInputs=5 -> 11 chunks -> 11
        // groups > MAX_BATCH. Distinct from the 11-distinct-label path above: here the
        // overflow comes from chunking one lineage, not from many labels.
        const notes = Array.from({ length: 51 }, (_, i) =>
            makeNote({
                commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                value: "0x0a" as Hex,
                label: "0xaa" as Label,
            }),
        );
        const { noteManager } = createFakeNoteManager(notes);
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        await expect(
            orchestrator.prepareBatchWithdraw({ ...BASE_PARAMS, quote: makeQuote([]) }),
        ).rejects.toBeInstanceOf(BatchTooLarge);
        expect(prepareTransact).not.toHaveBeenCalled();
    });

    it("persist the whole batch once via persistBatchNoteUpdates", async () => {
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

        const result = await orchestrator.prepareBatchWithdraw({
            ...BASE_PARAMS,
            quote: makeQuote([100n, 50n]),
        });
        // `verification` is required (AW-L-02 / #1070): the batch orchestrator must forward the
        // receipt evidence through to the core persist, never call it bare.
        const verification = {
            expectedNullifiers: result.spentNullifiers,
            receiptLogs: [],
        };
        await orchestrator.persistBatchNoteUpdates(
            result.spentNotes,
            result.changePendingNotes,
            "0xfeed" as Hash,
            verification,
        );

        expect(persistNoteUpdates).toHaveBeenCalledTimes(1);
        expect(persistNoteUpdates).toHaveBeenCalledWith(
            result.spentNotes,
            result.changePendingNotes,
            "0xfeed",
            verification,
        );
    });

    it("forward the verification bundle to core.persistNoteUpdates when supplied (AW-L-02)", async () => {
        const persistNoteUpdates = vi.fn(async () => undefined);
        const core = { persistNoteUpdates } as unknown as ITransactOrchestrator;
        const { noteManager } = createFakeNoteManager(twoGroupNotes());
        const orchestrator = new BatchWithdrawOrchestrator({ core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });
        const verification = { expectedNullifiers: ["0xdead" as Hex], receiptLogs: [] };

        await orchestrator.persistBatchNoteUpdates([], [], "0xfeed" as Hash, verification);

        expect(persistNoteUpdates).toHaveBeenCalledWith([], [], "0xfeed", verification);
    });

    // BW-2: the SELF-SUBMIT batch path — a gas-paying user withdraws with no relayer.
    describe("prepareSelfSubmitBatch", () => {
        it("build one zero-fee item per note group and encode a relayBatch call", async () => {
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            const result = await orchestrator.prepareSelfSubmitBatch({
                tokenId: TOKEN,
                recipientAddress: RECIPIENT,
                relayContractAddress: RELAY_CONTRACT,
            });

            // Two groups -> two zero-fee transacts; each is a FULL withdrawal (amount == amountOut).
            expect(fake.prepareTransact).toHaveBeenCalledTimes(2);
            for (const call of fake.prepareTransact.mock.calls) {
                const params = call[0] as PrepareTransactParams;
                expect(BigInt(params.feeAmount)).toBe(0n);
                expect(params.amount).toBe(params.amountOut);
                expect(params.processorAddress).toBe(RELAY_CONTRACT);
                // The routing bound into the proof carries a zero fee to the user's own recipient.
                const [routing] = decodeAbiParameters(
                    PAYOUT_ROUTING_ABI,
                    params.transactParams!.data,
                );
                expect(routing.feeAmount).toBe(0n);
                expect(routing.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase());
            }

            // The relayBatch call targets the relay contract; the result echoes its calldata.
            expect(fake.encodeRelayBatch).toHaveBeenCalledTimes(1);
            expect(fake.encodeRelayBatch.mock.calls[0][0]).toBe(RELAY_CONTRACT);
            expect(fake.encodeRelayBatch.mock.calls[0][1]).toHaveLength(2);
            expect(result.relayBatchTx.to).toBe(RELAY_CONTRACT);
            expect(result.relayBatchTx.data).toBe(SELF_BATCH_CALLDATA);
            expect(result.relayBatchTx.value).toBe("0x0");
            expect(result.spentNotes).toHaveLength(2);
            expect(result.changePendingNotes).toHaveLength(2);
        });

        it("throw BatchTooLarge without proving when the selection exceeds MAX_BATCH", async () => {
            const fake = createFakeCore();
            const notes = Array.from({ length: 11 }, (_, i) =>
                makeNote({
                    commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                    value: "0x0a" as Hex,
                    label: `0x${(0xa0 + i).toString(16)}` as Label,
                }),
            );
            const { noteManager } = createFakeNoteManager(notes);
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.prepareSelfSubmitBatch({
                    tokenId: TOKEN,
                    recipientAddress: RECIPIENT,
                    relayContractAddress: RELAY_CONTRACT,
                }),
            ).rejects.toBeInstanceOf(BatchTooLarge);
            expect(fake.prepareTransact).not.toHaveBeenCalled();
            expect(fake.encodeRelayBatch).not.toHaveBeenCalled();
        });

        it("throw EmptyBatchSelection when the asset has no active notes", async () => {
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager([]);
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.prepareSelfSubmitBatch({
                    tokenId: TOKEN,
                    recipientAddress: RECIPIENT,
                    relayContractAddress: RELAY_CONTRACT,
                }),
            ).rejects.toBeInstanceOf(EmptyBatchSelection);
        });

        it("throw EmptyBatchSelection for an explicit empty precomputed groups array", async () => {
            // Same empty-selection contract as the relayed path: an explicitly-passed `[]`
            // must reject rather than silently encode an empty relayBatch. Notes exist, so
            // this proves the guard catches the explicit selection, not auto-select fallback.
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.prepareSelfSubmitBatch({
                    tokenId: TOKEN,
                    recipientAddress: RECIPIENT,
                    relayContractAddress: RELAY_CONTRACT,
                    groups: [],
                }),
            ).rejects.toBeInstanceOf(EmptyBatchSelection);
            expect(fake.prepareTransact).not.toHaveBeenCalled();
            expect(fake.encodeRelayBatch).not.toHaveBeenCalled();
        });
    });

    describe("submitSelfSubmitBatch", () => {
        it("submit the prepared relayBatch calldata to the relay contract", async () => {
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({
                core: fake.core,
                noteManager,
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
            });

            const hash = await orchestrator.submitSelfSubmitBatch({
                relayBatchTx: { to: RELAY_CONTRACT, data: SELF_BATCH_CALLDATA, value: "0x0" as Hex },
                relayContractAddress: RELAY_CONTRACT,
                spentNotes: [],
                spentNullifiers: [],
                changePendingNotes: [],
            });

            expect(fake.submit).toHaveBeenCalledWith({
                to: RELAY_CONTRACT,
                data: SELF_BATCH_CALLDATA,
                value: "0x0",
            });
            expect(hash).toBe(SELF_BATCH_TXHASH);
        });

        // A SelfSubmitBatchPrepareResult is plain data: it can be serialized, stored and
        // carried between the prepare and submit steps, which are separate public calls. The
        // single-transact submit sites decode what they are about to sign for the same reason.
        it("refuse calldata that is not a relayBatch call", async () => {
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.submitSelfSubmitBatch({
                    relayBatchTx: { to: RELAY_CONTRACT, data: "0xdeadbeef" as Hex, value: "0x0" as Hex },
                    relayContractAddress: RELAY_CONTRACT,
                    spentNotes: [],
                    spentNullifiers: [],
                    changePendingNotes: [],
                }),
            ).rejects.toBeInstanceOf(UnexpectedTransactionTarget);
            expect(fake.submit).not.toHaveBeenCalled();
        });

        it("refuse a batch whose item routes to a processor other than the target", async () => {
            // Routing is bound into each proof and the vault checks it, so a mismatch is a
            // transaction that cannot succeed and must not be signed.
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.submitSelfSubmitBatch({
                    relayBatchTx: { to: RELAY_CONTRACT, data: encodeSelfBatchCallData([RELAY_CONTRACT, RELAY]), value: "0x0" as Hex },
                    relayContractAddress: RELAY_CONTRACT,
                    spentNotes: [],
                    spentNullifiers: [],
                    changePendingNotes: [],
                }),
            ).rejects.toBeInstanceOf(UnexpectedTransactionTarget);
            expect(fake.submit).not.toHaveBeenCalled();
        });

        it("refuse a batch carrying value", async () => {
            // Self-submit pays no relayer and funds no gas top-up, so any value attached is
            // value the caller did not intend to spend.
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.submitSelfSubmitBatch({
                    relayBatchTx: { to: RELAY_CONTRACT, data: SELF_BATCH_CALLDATA, value: "0x1" as Hex },
                    relayContractAddress: RELAY_CONTRACT,
                    spentNotes: [],
                    spentNullifiers: [],
                    changePendingNotes: [],
                }),
            ).rejects.toBeInstanceOf(UnexpectedTransactionTarget);
            expect(fake.submit).not.toHaveBeenCalled();
        });

        it("refuse an empty relayBatch", async () => {
            const fake = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const orchestrator = new BatchWithdrawOrchestrator({ core: fake.core, noteManager, payoutRoutingCodec: new EvmPayoutRoutingCodec(), addressEqualityComparator: new EvmAddressEqualityComparator(), preparedTxVerifier: new EvmPreparedTxVerifier() });

            await expect(
                orchestrator.submitSelfSubmitBatch({
                    relayBatchTx: { to: RELAY_CONTRACT, data: encodeSelfBatchCallData([]), value: "0x0" as Hex },
                    relayContractAddress: RELAY_CONTRACT,
                    spentNotes: [],
                    spentNullifiers: [],
                    changePendingNotes: [],
                }),
            ).rejects.toBeInstanceOf(UnexpectedTransactionTarget);
            expect(fake.submit).not.toHaveBeenCalled();
        });

        it("submit a batch prepared by a different orchestrator instance", async () => {
            // A prepared batch has to stay transportable: binding it to the instance that
            // prepared it would break handing it to another process or another session.
            const preparing = createFakeCore();
            const { noteManager } = createFakeNoteManager(twoGroupNotes());
            const prepared = await new BatchWithdrawOrchestrator({
                core: preparing.core,
                noteManager,
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
            }).prepareSelfSubmitBatch({
                tokenId: TOKEN,
                recipientAddress: RECIPIENT,
                relayContractAddress: RELAY_CONTRACT,
            });

            const submitting = createFakeCore();
            const other = new BatchWithdrawOrchestrator({
                core: submitting.core,
                noteManager: createFakeNoteManager([]).noteManager,
                payoutRoutingCodec: new EvmPayoutRoutingCodec(),
                addressEqualityComparator: new EvmAddressEqualityComparator(),
                preparedTxVerifier: new EvmPreparedTxVerifier(),
            });

            await expect(other.submitSelfSubmitBatch(prepared)).resolves.toBe(SELF_BATCH_TXHASH);
        });
    });
});
