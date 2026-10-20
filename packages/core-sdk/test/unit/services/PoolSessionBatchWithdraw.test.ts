import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
    Address,
    BatchPrepareResult,
    BatchWithdrawalRelayerQuote,
    Hash,
    Hex,
    IBatchWithdrawOrchestrator,
    INoteManager,
    IRelayerInteractor,
    IRPCInteractor,
    Label,
    Note,
    NoteData,
    PendingNote,
    PrepareBatchWithdrawResult,
    RelayerInfo,
    Secret,
    SelfSubmitBatchPrepareResult,
    TransactProof,
} from "../../../src/internal.js";
import {
    BatchTooLarge,
    FeeCommitmentExpired,
    NoteStatus,
    PoolSessionBatchWithdraw,
    RelayerRequestFailed,
} from "../../../src/internal.js";

// --- Constants ---

const VALID_OWNER = "0x1234567890abcdef1234567890abcdef12345678" as Address;
const TOKEN = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
const RECIPIENT = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
const RELAY = "0xdddddddddddddddddddddddddddddddddddddddd" as Address;
const PROCESSOR = "0xffffffffffffffffffffffffffffffffffffffff" as Address;
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

// Two single-label lineages -> two groups: A (value 100), B (value 50).
function twoGroupNotes(): Note[] {
    return [
        makeNote({ commitment: "0x01" as Hash, value: "0x64" as Hex, label: "0xaa" as Label }),
        makeNote({ commitment: "0x02" as Hash, value: "0x32" as Hex, label: "0xbb" as Label }),
    ];
}

const RELAYER: RelayerInfo = {
    url: "https://relay.test",
    name: "test-relay",
    chainId: 11155111,
    chainType: "evm",
    status: "active",
    address: RELAY,
    processorAddress: PROCESSOR,
};

function makeQuote(expiration = Date.now() + 3_600_000): BatchWithdrawalRelayerQuote {
    return {
        txCost: "0",
        gasPrice: "0",
        totalFee: "30",
        maxRelayFee: "100",
        feeCommitment: {
            data: "0xdead" as Hex,
            asset: TOKEN as Hex,
            expiration,
            totalFee: "30",
            maxRelayFee: "100",
            relayCost: "10",
            feeBps: "1000",
            flatFee: "0",
            signedRelayerCommitment: "0xsig" as Hex,
        },
    };
}

function makePreparedResult(): BatchPrepareResult {
    const spentNotes = twoGroupNotes();
    const changePendingNotes: PendingNote[] = [
        {
            noteAddressHash: MOCK_NOTE_ADDRESS_HASH,
            commitment: "0x99" as Hash,
            value: "0x0" as Hex,
            tokenId: TOKEN,
            label: "0xaa" as Label,
            ownerAddress: VALID_OWNER,
            noteSecret: MOCK_SECRET,
            isOwned: true,
            status: NoteStatus.PENDING,
        },
    ];
    return {
        items: [
            {
                proof: {} as TransactProof,
                transactParams: { processor: PROCESSOR, data: "0xaa" as Hex },
                noteData: [
                    { hint: `0x${"00".repeat(32)}` as Hex, data: "0xd1" as Hex },
                ] as NoteData[],
                amountOut: "0x64" as Hex,
                feeAmount: "0x1e" as Hex,
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            },
            {
                proof: {} as TransactProof,
                transactParams: { processor: PROCESSOR, data: "0xbb" as Hex },
                noteData: [
                    { hint: `0x${"00".repeat(32)}` as Hex, data: "0xd2" as Hex },
                ] as NoteData[],
                amountOut: "0x32" as Hex,
                feeAmount: "0x0" as Hex,
                inputNullifierNumber: 1,
                outputCommitmentNumber: 1,
            },
        ],
        totalAmountOut: "0x96" as Hex,
        totalFee: "0x1e" as Hex,
        spentNotes,
        spentNullifiers: [],
        changePendingNotes,
    };
}

const RELAY_CONTRACT = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as Address;

function makeSelfSubmitPrepared(): SelfSubmitBatchPrepareResult {
    const base = makePreparedResult();
    return {
        relayBatchTx: { to: RELAY_CONTRACT, data: "0xba7c4" as Hex, value: "0x0" as Hex },
        relayContractAddress: RELAY_CONTRACT,
        spentNotes: base.spentNotes,
        spentNullifiers: base.spentNullifiers,
        changePendingNotes: base.changePendingNotes,
    };
}

function createMockOrchestrator(
    prepared: BatchPrepareResult = makePreparedResult(),
): IBatchWithdrawOrchestrator {
    return {
        warmMerkleCaches: vi.fn(async () => undefined),
        prepareBatchWithdraw: vi.fn(async () => prepared),
        prepareSelfSubmitBatch: vi.fn(async () => makeSelfSubmitPrepared()),
        submitSelfSubmitBatch: vi.fn(async () => "0xtx" as Hash),
        persistBatchNoteUpdates: vi.fn(async () => undefined),
    } as unknown as IBatchWithdrawOrchestrator;
}

function createMockNoteManager(notes: Note[]): INoteManager {
    return { getNotes: vi.fn(() => notes) } as unknown as INoteManager;
}

function createMockRelayerInteractor(quote = makeQuote()): IRelayerInteractor {
    return {
        getRelayers: vi.fn(async () => [RELAYER]),
        getTransferQuote: vi.fn(),
        getWithdrawalQuote: vi.fn(),
        getBatchWithdrawalQuote: vi.fn(async () => quote),
        relayTransfer: vi.fn(),
        relayWithdrawal: vi.fn(),
        relayBatchWithdrawal: vi.fn(async () => "0xtx" as Hex),
    } as unknown as IRelayerInteractor;
}

function createMockRPCInteractor(status = true): IRPCInteractor {
    return {
        readContract: vi.fn(),
        getBlockNumber: vi.fn(),
        waitForTransactionReceipt: vi.fn(async () => ({
            status,
            blockNumber: "0x1" as Hex,
            txHash: "0xtx" as Hex,
            logs: [],
        })),
        getLogs: vi.fn(),
        getLogsPaginated: vi.fn(),
    } as unknown as IRPCInteractor;
}

// --- Tests ---

describe("PoolSessionBatchWithdraw", () => {
    describe("constructor", () => {
        it("create instance with valid config", () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator: createMockOrchestrator(),
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor: createMockRPCInteractor(),
            });
            expect(service).toBeInstanceOf(PoolSessionBatchWithdraw);
        });
    });

    describe("prepareBatchWithdraw", () => {
        let orchestrator: IBatchWithdrawOrchestrator;
        let relayerInteractor: IRelayerInteractor;
        let service: PoolSessionBatchWithdraw;

        beforeEach(() => {
            orchestrator = createMockOrchestrator();
            relayerInteractor = createMockRelayerInteractor();
            service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
            });
        });

        it("quote the per-group amounts in selection order", async () => {
            await service.prepareBatchWithdraw({ tokenId: TOKEN, recipientAddress: RECIPIENT });

            expect(relayerInteractor.getBatchWithdrawalQuote).toHaveBeenCalledWith(
                RELAYER,
                expect.objectContaining({
                    asset: TOKEN,
                    commit: true,
                    recipient: RECIPIENT,
                    extraGas: false,
                    amounts: ["100", "50"],
                }),
            );
        });

        it("bind the orchestrator to the relayer processor address and quote", async () => {
            await service.prepareBatchWithdraw({ tokenId: TOKEN, recipientAddress: RECIPIENT });

            expect(orchestrator.prepareBatchWithdraw).toHaveBeenCalledWith(
                expect.objectContaining({
                    tokenId: TOKEN,
                    recipientAddress: RECIPIENT,
                    relayAddress: PROCESSOR,
                    quote: expect.objectContaining({ totalFee: "30" }),  
                }),
            );
        });

        it("return the prepared batch plus the selected relayer and quote", async () => {
            const result = await service.prepareBatchWithdraw({
                tokenId: TOKEN,
                recipientAddress: RECIPIENT,
            });

            expect(result.items).toHaveLength(2);
            expect(result.relayerInfo).toEqual(RELAYER);
            expect(result.quote.totalFee).toBe("30");
        });

        it("throw RelayerRequestFailed when no relayer is available", async () => {
            vi.mocked(relayerInteractor.getRelayers).mockResolvedValueOnce([]);

            await expect(
                service.prepareBatchWithdraw({ tokenId: TOKEN, recipientAddress: RECIPIENT }),
            ).rejects.toThrow(RelayerRequestFailed);
            expect(orchestrator.prepareBatchWithdraw).not.toHaveBeenCalled();
        });

        it("throw BatchTooLarge before quoting a relayer when the selection exceeds MAX_BATCH", async () => {
            // BW-1: an oversized selection is always rejected downstream, so the session
            // fails fast BEFORE the relayer round-trip (no getRelayers / getBatchWithdrawalQuote).
            const oversized = Array.from({ length: 11 }, (_, i) =>
                makeNote({
                    commitment: `0x${(i + 1).toString(16).padStart(2, "0")}` as Hash,
                    value: "0x64" as Hex,
                    label: `0x${(0xa0 + i).toString(16)}` as Label,
                }),
            );
            const failFast = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(oversized),
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(),
            });

            await expect(
                failFast.prepareBatchWithdraw({ tokenId: TOKEN, recipientAddress: RECIPIENT }),
            ).rejects.toThrow(BatchTooLarge);
            expect(relayerInteractor.getRelayers).not.toHaveBeenCalled();
            expect(relayerInteractor.getBatchWithdrawalQuote).not.toHaveBeenCalled();
            expect(orchestrator.prepareBatchWithdraw).not.toHaveBeenCalled();
        });

        it("throw FeeCommitmentExpired before building proofs when the quote is expired", async () => {
            vi.mocked(relayerInteractor.getBatchWithdrawalQuote).mockResolvedValueOnce(
                makeQuote(Date.now() - 1000),
            );

            await expect(
                service.prepareBatchWithdraw({ tokenId: TOKEN, recipientAddress: RECIPIENT }),
            ).rejects.toThrow(FeeCommitmentExpired);
            expect(orchestrator.prepareBatchWithdraw).not.toHaveBeenCalled();
        });
    });

    describe("relayBatchWithdraw", () => {
        let orchestrator: IBatchWithdrawOrchestrator;
        let relayerInteractor: IRelayerInteractor;
        let rpcInteractor: IRPCInteractor;

        function buildResult(): PrepareBatchWithdrawResult {
            return { ...makePreparedResult(), relayerInfo: RELAYER, quote: makeQuote() };
        }

        beforeEach(() => {
            orchestrator = createMockOrchestrator();
            relayerInteractor = createMockRelayerInteractor();
            rpcInteractor = createMockRPCInteractor();
        });

        it("submit the mapped items and signed commitment to the relayer", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor,
            });
            const result = buildResult();

            await service.relayBatchWithdraw(result);

            expect(relayerInteractor.relayBatchWithdrawal).toHaveBeenCalledWith(
                RELAYER,
                expect.objectContaining({
                    items: [
                        expect.objectContaining({
                            inputNullifierNumber: 1,
                            outputCommitmentNumber: 1,
                        }),
                        expect.objectContaining({
                            inputNullifierNumber: 1,
                            outputCommitmentNumber: 1,
                        }),
                    ],
                    signedBatchFeeCommitment: result.quote.feeCommitment,
                }),
            );
        });

        it("persist the batch note updates once the receipt confirms", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor,
            });
            const result = buildResult();

            await service.relayBatchWithdraw(result);

            expect(orchestrator.persistBatchNoteUpdates).toHaveBeenCalledWith(
                result.spentNotes,
                result.changePendingNotes,
                "0xtx",
                { expectedNullifiers: result.spentNullifiers, receiptLogs: [] },
            );
        });

        it("thread the batch's spent nullifiers and receipt logs to persistBatchNoteUpdates for verification (AW-L-02)", async () => {
            const receiptLogs = [
                {
                    address: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address,
                    topics: [] as Hex[],
                    data: "0x" as Hex,
                    blockNumber: "0x1" as Hex,
                    transactionHash: "0xtx" as Hex,
                    logIndex: 0,
                },
            ];
            const rpc = {
                readContract: vi.fn(),
                getBlockNumber: vi.fn(),
                waitForTransactionReceipt: vi.fn(async () => ({
                    status: true,
                    blockNumber: "0x1" as Hex,
                    txHash: "0xtx" as Hex,
                    logs: receiptLogs,
                })),
                getLogs: vi.fn(),
                getLogsPaginated: vi.fn(),
            } as unknown as IRPCInteractor;
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor: rpc,
            });
            const result = { ...buildResult(), spentNullifiers: ["0xdead" as Hex] };

            await service.relayBatchWithdraw(result);

            expect(orchestrator.persistBatchNoteUpdates).toHaveBeenCalledWith(
                result.spentNotes,
                result.changePendingNotes,
                "0xtx",
                { expectedNullifiers: ["0xdead"], receiptLogs },
            );
        });

        it("not persist note updates when the receipt reports failure", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor: createMockRPCInteractor(false),
            });

            await service.relayBatchWithdraw(buildResult());

            expect(orchestrator.persistBatchNoteUpdates).not.toHaveBeenCalled();
        });

        it("throw FeeCommitmentExpired when the quote expired before submission", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor,
            });
            const result = {
                ...makePreparedResult(),
                relayerInfo: RELAYER,
                quote: makeQuote(Date.now() - 1000),
            };

            await expect(service.relayBatchWithdraw(result)).rejects.toThrow(FeeCommitmentExpired);
            expect(relayerInteractor.relayBatchWithdrawal).not.toHaveBeenCalled();
        });
    });

    // BW-2: the self-submit path — no relayer; the session submits the user's own relayBatch.
    describe("selfSubmitBatchWithdraw", () => {
        let orchestrator: IBatchWithdrawOrchestrator;
        let rpcInteractor: IRPCInteractor;

        const params = {
            tokenId: TOKEN,
            recipientAddress: RECIPIENT,
            relayContractAddress: RELAY_CONTRACT,
        };

        beforeEach(() => {
            orchestrator = createMockOrchestrator();
            rpcInteractor = createMockRPCInteractor();
        });

        it("prepare, submit, and persist without touching a relayer", async () => {
            const relayerInteractor = createMockRelayerInteractor();
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor,
                rpcInteractor,
            });

            const receipt = await service.selfSubmitBatchWithdraw(params);

            expect(orchestrator.prepareSelfSubmitBatch).toHaveBeenCalledWith(params);
            expect(orchestrator.submitSelfSubmitBatch).toHaveBeenCalledOnce();
            expect(orchestrator.persistBatchNoteUpdates).toHaveBeenCalledOnce();
            expect(receipt.status).toBe(true);
            // No relayer is consulted on the self-submit path.
            expect(relayerInteractor.getRelayers).not.toHaveBeenCalled();
            expect(relayerInteractor.relayBatchWithdrawal).not.toHaveBeenCalled();
        });

        it("not persist note updates when the receipt reports failure", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor: createMockRPCInteractor(false),
            });

            await service.selfSubmitBatchWithdraw(params);

            expect(orchestrator.submitSelfSubmitBatch).toHaveBeenCalledOnce();
            expect(orchestrator.persistBatchNoteUpdates).not.toHaveBeenCalled();
        });

        it("prepareSelfSubmitBatch delegates to the orchestrator", async () => {
            const service = new PoolSessionBatchWithdraw({
                orchestrator,
                noteManager: createMockNoteManager(twoGroupNotes()),
                relayerInteractor: createMockRelayerInteractor(),
                rpcInteractor,
            });

            const prepared: SelfSubmitBatchPrepareResult =
                await service.prepareSelfSubmitBatch(params);

            expect(orchestrator.prepareSelfSubmitBatch).toHaveBeenCalledWith(params);
            expect(prepared.relayBatchTx.to).toBe(RELAY_CONTRACT);
        });
    });
});
